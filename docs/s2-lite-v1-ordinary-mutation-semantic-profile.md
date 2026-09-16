# S2 Lite v1 Ordinary Mutation Semantic Profile

This addendum freezes only the producer mapping from typed WatchTracker business state to an ordinary `CommitMutationV1`. The existing S2 Lite v1 entity validators, scalar rules, EntityKey codec, JCS/hash pipeline, causal reducer, publication protocol, discovery, activation, and migration state machines remain unchanged.

Normative terms **MUST**, **MUST NOT**, and **SHOULD** have their usual protocol meanings.

## Boundary

The producer consumes typed business values or a durable delete descriptor. It MUST NOT treat an S1 `sync_staging` JSON object as a Native S2 value and MUST NOT use `sync_staging.base` as an S2 causal base. The causal base supplied here is the exact reducer-derived state under the commit's frozen `basisClock`.

The producer outputs either one complete `CommitMutationV1` or no mutation for a business no-op. Commit construction, UUID allocation, writer sequencing, and publication are outside this mapping.

## Entity mapping

| Business entity | `entityType` | `entityKey` | Upsert identity |
| --- | --- | --- | --- |
| Record | `record` | `["record", id]` | `value.id == id` |
| Collection | `collection` | `["collection", id]` | `value.id == id` |
| CollectionMember | `collection-member` | `["collection-member", collectionId, recordId]` | `value.id == sha256("collection-member:v1" || 0x00 || collectionId || 0x00 || recordId)` |
| EpisodeCompletion | `episode-completion` | `["episode-completion", recordId, episodeNumber]` | `value.id == sha256("episode-completion:v1" || 0x00 || recordId || 0x00 || decimal(episodeNumber))` |

CollectionMember and EpisodeCompletion are independent logical entities.

A Record or Collection create/update, CollectionMember add/re-add, and EpisodeCompletion state change use `operation="upsert"` and the complete existing Native S2 entity value. A Collection's `normalizedName` MUST already equal frozen `NormalizeV1(name)`; the producer validates and does not repair it.

Episode completion uses a canonical Timestamp in `completedAt`. Episode uncompletion is an upsert whose complete value has `completedAt=null`; it MUST NOT be encoded as a tombstone. A true entity deletion or cascade uses a tombstone.

## Typed-to-wire scalar mapping

The typed producer MUST emit every required Native field. A nullable field is still required and MUST be emitted as either its value or explicit JSON `null`; missing and `null` are distinct.

Typed i64 fields become canonical base-10 JSON strings with no leading plus sign, no leading zero except `"0"`, and no `"-0"`. This includes `rev`, CollectionMember `position`, and Record `tmdbId`/`tmdbParentId` when non-null. Safe integers remain JSON numbers. Float64, Date, Timestamp, text, enums, cross-field predicates, and nullability are validated by the existing Semantic Profile v1.

A typed Float64 supplied to the ordinary semantic adapter MUST be finite before conversion to a JSON/Native value. For a nullable Float64, `None`/absent optional value maps to semantic `null`, a finite value maps to the same numeric value, and `NaN`, positive infinity, or negative infinity produces `invalid_float64`. A producer MUST NOT let a generic JSON serializer turn a non-finite value into `null`, zero, a string, a missing field, a clamped value, or any other repair. Existing business-range validation remains a separate subsequent check.

The producer MUST NOT trim text, normalize Unicode, synthesize defaults, repair `normalizedName`, or canonicalize a non-canonical Native timestamp. It MUST NOT use generic `serde_json::to_value()` or an equivalent platform serializer as the semantic mapping. Native values must already meet the frozen profile. Object insertion order has no semantic meaning; existing JCS performs wire canonicalization.

## Deletes and tombstones

A delete descriptor MUST be captured durably in the same business transaction that removes the source row. `deletedAt`, `rev`, `revActor`, and all identity components are allocated/captured once and MUST remain byte-stable through crash, timeout, restart, and response-loss recovery.

Canonical tombstones are:

```text
Record/Collection:
{ id, deletedAt, rev, revActor }

CollectionMember:
{ id, collectionId, recordId, deletedAt, rev, revActor }

EpisodeCompletion:
{ id, recordId, episodeNumber, deletedAt, rev, revActor }
```

Here `rev` is the canonical i64 decimal string. An opaque staging ID alone is not a valid delete descriptor for either composite-key entity.

## Causal base and `changedFields`

`changedFields` means business fields differing from the frozen causal base. It is not an S1 JSON diff, UI patch list, or list of every field present in the outgoing object.

- For a resolved live base, compare its business-only `CanonicalSemanticValue` with the outgoing `CanonicalSemanticValue`, field by field in existing frozen `BUSINESS_FIELD_ORDER`.
- For an absent or tombstone base, use every business field in `BUSINESS_FIELD_ORDER`.
- For a tombstone mutation, use exactly `["$tombstone"]`.
- Exclude `id`, `createdAt`, `updatedAt`, `rev`, and `revActor`.
- If a live-base upsert has no business differences, emit zero mutation. Metadata-only ordinary mutation is forbidden.

`baseFrontier` is the exact expected frontier for this EntityKey under the frozen commit basis. Existing causal validation remains authoritative and rejects a stale, incomplete, conflicting, or otherwise incorrect base.

## Mutation identity and coalescing

Each retained ordinary logical outgoing mutation receives a new lowercase canonical UUIDv4. Allocation occurs exactly once after pre-freeze coalescing, when the outbound batch and its `PreparedIntent` are frozen. The UUID and exact mutation bytes are then durable and MUST be reused for every retry and recovery attempt.

Before freeze, multiple local edits to the same EntityKey coalesce to the final complete value/delete descriptor; last local state wins. If that final upsert equals the causal base, it emits no mutation and consumes no outgoing mutation identity. After freeze, an additional edit MUST NOT alter the frozen intent: it belongs to a successor batch with a new mutation UUID.

Each commit contains at most one mutation per EntityKey and mutation IDs are unique within that commit.

## Deterministic ordering

After no-op removal, ordinary mutations MUST be ordered by frozen `compareEntityKeyV1`. `changedFields` MUST follow frozen `BUSINESS_FIELD_ORDER`. Implementations MUST NOT depend on SQLite row order, Rust map/debug order, JavaScript property insertion order, locale, or platform timestamp formatting.

## Bootstrap compatibility

Bootstrap and ordinary publication share exactly the same canonical Native entity representation and validation. Existing bootstrap bytes remain unchanged.

Ordinary publication does not inherit bootstrap-only semantics: empty `baseFrontier`, all-fields-changed, migration-derived UUIDs, Stage A/Stage B ordering, bootstrap chunking, or live-only input assumptions.

## Shared contract

`contracts/s2-lite/v1/ordinary-mutation-semantic-golden-v1.json` is the cross-language pre-hash contract. Its decimal strings are a language-neutral fixture carrier for typed i64 values; Rust parses them to `i64`, TypeScript to `bigint`, and future Kotlin to `Long` before invoking the producer. References inside the compact fixture expand to the named local values, delete descriptors, and commit refs in the same file.
