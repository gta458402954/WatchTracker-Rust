# Desktop S2 local business reconstruction

Baseline: `e4cb5c4a89e6191e766f9aed02f9149f323c7a3a`.

The three-record, one-A/zero-B migration regression first failed with
`projector_record_value_invalid` on the baseline. Frozen replay deliberately
separates semantic `businessValue` from `metadataVariants`. A semantic value is
not a full SQLite row.

## Adapter representation and authority

`MaterializedProjectionEntityV1.metadata_variants` is a local cache of the exact
metadata and CommitRefs emitted by frozen replay. It adds no wire fields. The
replay input fingerprint still hashes the original retained exact commit bytes;
`business_value`, `semantic_state`, basis and frontier are unchanged.

For a live, resolved entity, the shared local adapter requires:

- `semanticState.value == businessValue`;
- nonempty metadata evidence matching every frontier reference exactly, with no
  duplicate or invalid reference;
- exactly `id`, `createdAt`, `updatedAt`, `rev`, `revActor` in each metadata variant;
- disjoint semantic/metadata fields;
- every reconstructed variant passing the frozen native entity/schema validator,
  including consistency with the verified canonical entity key.

The adapter creates a separate temporary local row value. It never inserts
metadata into the frozen semantic value. INT64 decimal strings (`rev`, member
`position`, nullable `tmdbId`/`tmdbParentId`) are parsed exactly into SQLite-model
i64 values. Safe numeric fields and finite f64 values are copied without conversion.

When a non-conflicting semantic frontier has multiple metadata variants, the local
row uses the **first complete variant in frozen canonical CommitRef order**. This
is a deterministic local metadata representation, not a semantic winner or a
protocol conflict-resolution rule. All variants remain durable and all are
validated, including later variants. Fields from different variants are never
mixed. No metadata is taken from the old local row or generated from the clock.

The added cache field defaults to an empty list when reading an older cache.
An unapplied live entity without this evidence fails closed; normal discovery
rebuilds the cache from retained verified commits. No SQLite schema/table/version
change is required. Existing applied-generation idempotence is preserved.

## Every WatchRecord field

| Fields | Authoritative source | Local conversion |
| --- | --- | --- |
| `id` | A: selected verified metadata variant, checked against `entityKey[1]` | Exact string; no allocation |
| `createdAt` | B: same complete verified metadata variant | Exact origin timestamp; no `now` or old-row fallback |
| `updatedAt` | B: same variant | Exact timestamp or null |
| `rev` | B: same variant | Canonical INT64 string to i64, no float intermediate |
| `revActor` | B: same variant | Exact string |
| `originalName`, `chineseName`, `progress`, `totalEpisodes`, `episodeTrackingEnabled`, `nextEpisode`, `movieProgress`, `movieDuration`, `releaseYear`, `posterPath`, `status`, `platform`, `rating`, `startDate`, `endDate`, `notes` | C: frozen `businessValue` | Exact validated semantic values/nulls |
| `imdbId`, `isLocked`, `genres`, `originCountry`, `imdbRating`, `tmdbStatus`, `interestLevel`, `episodeRuntime`, `mediaType`, `contentTags`, `tmdbMediaKind`, `tmdbSeasonNumber`, `seriesRecordKind` | C: frozen `businessValue` | Exact validated semantic values/nulls; f64 bits preserved |
| `tmdbId`, `tmdbParentId` | C: frozen `businessValue` | Nullable canonical positive INT64 strings to i64 |

D: an existing local staging overlay preserves the entire matching local row and
its staged values/first causal basis. Reconstruction does not remote-author the
overlay. There are no additional invented local-only WatchRecord fields. Poster
files, staging, outbox and records generation remain outside remote reconstruction.

## Other entity types

All four live adapters had the same architectural defect and now share the same
reconstruction boundary:

| Entity | Verified identity | Semantic payload | Metadata |
| --- | --- | --- | --- |
| collection | metadata `id` equals key ID | name, normalizedName, description, sourceKind, sourceKey, collectionKind, orderMode | createdAt, updatedAt, rev, revActor |
| collection member | metadata `id` must match frozen composite ID; collectionId/recordId equal key components | collectionId, recordId, position, sourceKind | createdAt, updatedAt, rev, revActor |
| episode completion | metadata `id` must match frozen composite ID; recordId/episodeNumber equal key components | recordId, episodeNumber, completedAt (including null) | createdAt, updatedAt, rev, revActor |

Composite IDs are verified against the frozen deterministic identity rule, never
replaced with newly generated IDs. The S2 collection/member/completion upserts
now also update createdAt from verified evidence instead of retaining stale
local-row origin metadata. Record upsert already wrote verified createdAt.

## Transaction and non-live behavior

The existing root/generation-checked SQLite immediate transaction remains the
application boundary. Any reconstruction or SQL failure rolls back all business
writes and both applied-generation markers. Projection/conflict evidence survives
unchanged; reopening observes the same unresolved generation.

Tombstones use the existing canonical-key deletion path and never enter live row
decode. Entity/relation conflicts preserve local working rows and conflict facts.
Staging overlays preserve their full rows and durable causal bases. Reapplying an
already applied generation is a no-op; rebuilding/applying the same verified
evidence at a later generation retains identical IDs, timestamps and semantics.

Focused SQLite tests cover the real bootstrap shape, close/reopen before apply,
same/new-generation idempotence, partial-write rollback after invalid evidence,
all four types with stale local metadata, INT64 values beyond 2^53 and at i64::MAX,
finite f64 bits, frozen tombstone/conflict cases, multiple metadata variants in
opposite observation order, and unchanged local staging overlays.

Frozen contracts/reducer/scalar modules and Android are unchanged. No provider
requests are part of this repair verification.

## Verification commands

Baseline reproduction (before the adapter repair):

```text
cargo test --locked --lib migrated_three_record_bootstrap_reconstructs_real_sqlite_business_rows
FAILED: ProtocolError("projector_record_value_invalid")
```

Focused verification from `src-tauri`:

```text
cargo test --locked --lib business_projection
cargo test --locked --lib s2_lite::materialized_projection_tests
cargo test --locked --lib s2_lite::desktop_lifecycle_tests
cargo test --locked --lib s2_lite::outbound_freeze::tests
cargo test --locked --lib s2_lite::outbound_completion::tests
cargo test --locked --lib s2_lite::bootstrap_execution::tests
cargo test --locked --lib s2_lite::migration_orchestration_tests
cargo test --locked --lib s2_lite::activation_cutover_tests
cargo test --locked --lib s2_lite::durable_persistence_tests
```

The metadata inconsistency regression also injects a malformed CommitRef into
a later variant: reference validation occurs before the frozen comparator,
so invalid durable evidence returns an error without a comparator panic.

| Focused group | Passed |
| --- | ---: |
| Business projection, including 7 new reconstruction regressions | 16 |
| Materialized projection | 7 |
| Desktop lifecycle | 33 |
| Outbound freeze | 19 |
| Outbound completion | 9 |
| Bootstrap execution | 39 |
| Migration orchestration | 22 |
| Activation/cutover | 7 |
| Durable persistence | 22 |
| Total distinct focused tests | 174 |

Static gates passed:

```text
cargo fmt -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
git diff --check
```

Verification used local SQLite and existing fake transports only. No full suite,
real-provider rerun, Android modification, or push was performed.
