# Desktop S2 business application dependency ordering

Repair baseline: `75d410ca31e0dc4ddd84dec93971d9be7264b46a`.
Previous pushed baseline: `e4cb5c4a89e6191e766f9aed02f9149f323c7a3a`.

## Baseline reproduction

The new real-SQLite regression
`astra_empty_business_database_applies_member_after_both_verified_parents`
first failed on the repair baseline with
`ProtocolError("business_projection_failed")`.
Business tables were empty, production schemas were installed, and
`PRAGMA foreign_keys=ON`. Verified bootstrap replay produced Complete projection
order `collection -> collection-member -> record`. The member's correct frozen
composite ID and valid metadata could not compensate for its missing record
parent at insertion time.

## Actual business dependency graph

Production DDL is in `db.rs` and `collections.rs`:

| Dependent column | Parent column | Existing delete action |
| --- | --- | --- |
| collection_members.collectionId | collections.id | CASCADE |
| collection_members.recordId | records.id | CASCADE |
| episode_completions.recordId | records.id | CASCADE |

There are no other production business-table foreign keys reachable from these
four types. Record and collection have no business parent FK. S2 durable root,
intent, receipt and migration FK tables are outside the business application
graph and remain unchanged.

No schema, foreign-key setting or delete action was changed. Existing record
and other live upserts use `ON CONFLICT ... DO UPDATE`, not row replacement.
Collection also has unique `normalizedName` and `(sourceKind, sourceKey)`
constraints. A legal deleted-old/new-live collection replacement can reuse
these keys. The mixed-generation regression reproduces the same-name replacement
failure when live parents run before deleted parents.

## Deterministic application plan

The complete generation still runs inside the existing immediate SQLite
transaction, with unchanged root/generation admission and applied-generation
commit rules.

Before any application SQL write, classify every entity using the existing
conflict/relation-conflict and staging-overlay rules. Reconstruct and deserialize
every applicable live entity using the unchanged verified metadata adapter.
Validate every applicable tombstone key's type, arity and components. Conflicts
and overlays remain preserved and do not select or decode a live winner.

Execute the local plan in these phases:

1. Delete explicit dependent tombstones: members and episode completions.
2. Delete parent tombstones: records and collections, only after checking that
   no dependent row remains in the business database. This also releases the
   deleted collections' unique keys before new live rows are inserted.
3. Upsert live parents: records and collections.
4. Upsert live dependents: members and episode completions.
5. Complete overlay bookkeeping, then let the existing transaction commit
   both applied-generation markers.

Within each phase use canonical entity-key bytes as a deterministic tie-breaker.
The frozen projection vector is never reordered or mutated. Diagnostic outcomes
remain aligned with its original iteration order.

Parent deletion returns `projector_parent_delete_has_dependents` if a local child
remains. This prevents existing SQL cascades or the collection helper's child
cleanup from silently substituting for a missing or preserved dependent
tombstone. A conflict, overlay, or unobserved local child is never deleted by
this generation's parent operation. The entire transaction rolls back, including
earlier dependent deletes, and the unresolved generation remains restart-safe.

No parent placeholders, fallback inserts, retries or ID/timestamp allocation are
introduced. Missing parent rows for an applicable live dependent remain an SQL
failure and roll back the generation. Existing single-entity explicit staging
resolution is not expanded into a generation planner by this focused repair.

## Focused regressions

Seven new regressions cover:

- Astra's exact canonical-order empty database, including both parent rows,
  member identity, applied generation, restart and same/new-generation reapply;
- empty episode database, restart before apply, same/new-generation reapply,
  exact timestamp/ID preservation and zero FK violations;
- real verified ordinary tombstones for all four types, with SQL triggers
  rejecting parent deletion if children have not already been removed;
- mixed verified live/delete generations after restart, including reuse of a
  deleted collection's unique normalized name by a new collection ID;
- exact mixed-generation final state with reversed projection iteration order;
- invalid reconstruction detected before any application SQL phase, proven with
  a trigger that would reject an attempted earlier parent insert;
- parent deletion with conflicted, overlaid or unobserved children: fail closed,
  all earlier deletes rolled back, and the same unresolved state after restart.

Mixed/delete evidence is built from native frozen wire mutations and replayed
through the unchanged frozen core. The helper asserts Complete before applying.
All new production-boundary cases enable foreign keys on every reopened
connection. Existing reconstruction, scalar, metadata, conflict, overlay and
rollback regressions remain in place.

No frozen protocol, contracts, reconstruction metadata policy, Android code or
provider state is changed. No real-provider rerun or push is part of this repair.

## Verification results

| Focused group | Passed |
| --- | ---: |
| Business projection, including existing reconstruction and 7 new ordering tests | 23 |
| Materialized projection | 7 |
| Outbound freeze | 19 |
| Desktop lifecycle | 33 |
| Bootstrap execution | 39 |
| Migration orchestration | 22 |
| Activation/cutover | 7 |
| Total distinct focused tests | 150 |

All focused commands used `cargo test --locked --lib` with the corresponding
module filter. The final ordering change was verified by rerunning all 23
business projection tests, including normalized-name reuse and reversed input
order. No full repository suite was run.

Static gates passed from `src-tauri`:

```text
cargo fmt -- --check
cargo check --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
git diff --check
```
