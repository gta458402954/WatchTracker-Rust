//! Projection-bound, zero-network ordinary outbound freezing.
//!
//! This is intentionally the last local step before a later publication
//! checkpoint. It never accepts a remote, performs PUT/GET, creates receipts,
//! acknowledges staging, or advances the published writer head.

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::json;

use super::canonical::{jcs_bytes, ProtocolError, Result};
use super::durable_persistence::{
    OutboundBatchMutationV1, OutboundBatchV1, OutboundFreezeTransactionContextV1,
    OutboundFreezeTransactionPlanV1, OutboundFreezeTransactionResultV1, SqliteS2LiteStoreV1,
};
use super::immutable_publish::{prepare_commit_intent_v1, PreparedIntentV1};
use super::materialized_projection::{
    resolve_ordinary_causal_base_v1, OrdinaryCausalBaseResolutionV1,
};
use super::ordinary_mutation::{
    map_ordinary_mutation_v1, sort_ordinary_mutations_v1, DeleteDescriptorV1,
    LocalCollectionMemberV1, LocalCollectionV1, LocalEntityValueV1, LocalEpisodeCompletionV1,
    LocalRecordV1, OrdinaryMutationRequestV1, OrdinaryPayloadV1,
};
use super::types::CommitRef;

const FREEZE_FAILURE: ProtocolError = ProtocolError("S2_OUTBOUND_FREEZE_FAILURE");

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutboundFreezeResultV1 {
    Frozen {
        batch: Box<OutboundBatchV1>,
        intent: Box<PreparedIntentV1>,
    },
    ExistingPendingOutbound,
    NoSemanticMutation,
    TargetChanged,
    Blocked,
}

fn staged_payload(entry: &crate::sync_staging::StagedRecord) -> Result<OrdinaryPayloadV1> {
    if entry.operation == "delete" {
        let descriptor = entry.delete_descriptor.as_ref().ok_or(FREEZE_FAILURE)?;
        let tombstone = match descriptor {
            crate::sync_staging::StagedDeleteDescriptor::Record {
                id,
                deleted_at,
                rev,
                rev_actor,
            } => DeleteDescriptorV1::Record {
                id: id.clone(),
                deleted_at: deleted_at.clone(),
                rev: *rev,
                rev_actor: rev_actor.clone(),
            },
            crate::sync_staging::StagedDeleteDescriptor::Collection {
                id,
                deleted_at,
                rev,
                rev_actor,
            } => DeleteDescriptorV1::Collection {
                id: id.clone(),
                deleted_at: deleted_at.clone(),
                rev: *rev,
                rev_actor: rev_actor.clone(),
            },
            crate::sync_staging::StagedDeleteDescriptor::CollectionMember {
                id,
                collection_id,
                record_id,
                deleted_at,
                rev,
                rev_actor,
            } => DeleteDescriptorV1::CollectionMember {
                id: id.clone(),
                collection_id: collection_id.clone(),
                record_id: record_id.clone(),
                deleted_at: deleted_at.clone(),
                rev: *rev,
                rev_actor: rev_actor.clone(),
            },
            crate::sync_staging::StagedDeleteDescriptor::EpisodeCompletion {
                id,
                record_id,
                episode_number,
                deleted_at,
                rev,
                rev_actor,
            } => DeleteDescriptorV1::EpisodeCompletion {
                id: id.clone(),
                record_id: record_id.clone(),
                episode_number: *episode_number,
                deleted_at: deleted_at.clone(),
                rev: *rev,
                rev_actor: rev_actor.clone(),
            },
        };
        return Ok(OrdinaryPayloadV1::Tombstone(tombstone));
    }
    let local = entry.local.clone().ok_or(FREEZE_FAILURE)?;
    let value = match entry.entity_kind.as_str() {
        "record" => LocalEntityValueV1::Record(Box::new(
            serde_json::from_value::<LocalRecordV1>(local).map_err(|_| FREEZE_FAILURE)?,
        )),
        "collection" => LocalEntityValueV1::Collection(
            serde_json::from_value::<LocalCollectionV1>(local).map_err(|_| FREEZE_FAILURE)?,
        ),
        "collection-member" => LocalEntityValueV1::CollectionMember(
            serde_json::from_value::<LocalCollectionMemberV1>(local).map_err(|_| FREEZE_FAILURE)?,
        ),
        "episode-completion" => LocalEntityValueV1::EpisodeCompletion(
            serde_json::from_value::<LocalEpisodeCompletionV1>(local)
                .map_err(|_| FREEZE_FAILURE)?,
        ),
        _ => return Err(FREEZE_FAILURE),
    };
    Ok(OrdinaryPayloadV1::Upsert(value))
}

fn commit_bytes(
    writer_id: String,
    writer_seq: u64,
    commit_id: String,
    previous_writer_commit: Option<CommitRef>,
    basis_clock: Vec<CommitRef>,
    mutations: Vec<super::types::CommitMutationV1>,
    created_at: &str,
) -> Result<Vec<u8>> {
    // The frozen decoder derives contentHash from the exact bytes; it must not
    // appear in the self-hashed wire object.
    let value = json!({
        "protocol": "watchtracker-s2-lite",
        "protocolVersion": 1,
        "s2SemanticProfileVersion": 1,
        "requiredFeatures": [],
        "writerId": writer_id,
        "writerSeq": writer_seq.to_string(),
        "commitId": commit_id,
        "previousWriterCommit": previous_writer_commit,
        "basisClock": basis_clock,
        "commitKind": "mutation",
        "createdAt": created_at,
        "source": { "type": "native" },
        "mutations": mutations,
    });
    jcs_bytes(&value)
}

/// Freezes one root-bound batch. It uses no remote type and therefore cannot
/// make a network call. A later checkpoint alone may consume the resulting
/// intent.
pub fn freeze_active_outbound_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
    created_at_diagnostic: &str,
) -> Result<OutboundFreezeResultV1> {
    let root_id = match active_root_id(conn, target_id, target_epoch) {
        Ok(value) => value,
        Err(_) => return Ok(OutboundFreezeResultV1::TargetChanged),
    };
    let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let result = store.run_outbound_freeze_transaction(target_id, target_epoch, |context| {
        build_freeze_plan(context, created_at_diagnostic)
    })?;
    Ok(map_transaction_result(result))
}

fn active_root_id(conn: &Mutex<Connection>, target_id: &str, target_epoch: u64) -> Result<String> {
    let guard = conn.lock().map_err(|_| FREEZE_FAILURE)?;
    let registry = crate::sync_targets::registry(&guard).map_err(|_| FREEZE_FAILURE)?;
    let registry = registry.ok_or(FREEZE_FAILURE)?;
    if registry.active_target_id.as_deref() != Some(target_id)
        || registry.target_epoch != target_epoch
    {
        return Err(FREEZE_FAILURE);
    }
    let target = registry
        .targets
        .iter()
        .find(|target| target.id == target_id)
        .ok_or(FREEZE_FAILURE)?;
    Ok(
        super::webdav_adapter::webdav_root_v1(&target.normalized_url, &target.username)
            .map_err(|_| FREEZE_FAILURE)?
            .physical_root_id,
    )
}

fn build_freeze_plan(
    context: &OutboundFreezeTransactionContextV1,
    created_at_diagnostic: &str,
) -> Result<OutboundFreezeTransactionPlanV1> {
    let mut mutations = Vec::new();
    let mut covered = Vec::new();
    let mut basis_clock: Option<Vec<CommitRef>> = None;
    for entry in &context.staging.entries {
        let key =
            crate::sync_staging::staged_entry_entity_key(entry).map_err(|_| FREEZE_FAILURE)?;
        let resolution = resolve_ordinary_causal_base_v1(&context.projection.state, &key)?;
        let OrdinaryCausalBaseResolutionV1::Ready {
            causal_base,
            base_frontier,
            basis_clock: entity_basis,
        } = resolution
        else {
            return Ok(OutboundFreezeTransactionPlanV1::Blocked);
        };
        if let Some(expected) = &basis_clock {
            if expected != &entity_basis {
                return Err(FREEZE_FAILURE);
            }
        } else {
            basis_clock = Some(entity_basis);
        }
        // A locally-created entity which is deleted before it ever enters the
        // projection has no remote semantic state to tombstone.  Its durable
        // delete evidence remains in staging for local bookkeeping, but it
        // must not manufacture a remote deletion.
        if entry.operation == "delete"
            && matches!(
                causal_base,
                super::ordinary_mutation::OrdinaryCausalBaseV1::Absent
            )
        {
            continue;
        }
        let local_mutation_id = uuid::Uuid::new_v4().to_string();
        let mapped = map_ordinary_mutation_v1(&OrdinaryMutationRequestV1 {
            local_mutation_id: local_mutation_id.clone(),
            payload: staged_payload(entry)?,
            causal_base,
            base_frontier,
        })?;
        if let Some(mapped) = mapped {
            covered.push(OutboundBatchMutationV1 {
                entity_kind: entry.entity_kind.clone(),
                entity_id: entry.id.clone(),
                entity_key: key,
                captured_last_generation: entry.last_generation,
                local_mutation_id,
            });
            mutations.push(mapped);
        }
    }
    if mutations.is_empty() {
        return Ok(OutboundFreezeTransactionPlanV1::NoSemanticMutation);
    }
    sort_ordinary_mutations_v1(&mut mutations)?;
    covered.sort_by(|left, right| {
        super::canonical::compare_entity_key_v1(&left.entity_key, &right.entity_key)
    });
    let basis_clock = basis_clock.ok_or(FREEZE_FAILURE)?;
    let writer_seq = context.root_state.next_writer_sequence;
    let previous = context.root_state.writer_head.clone();
    if writer_seq == 1 {
        if previous.is_some()
            || basis_clock
                .iter()
                .any(|item| item.writer_id == context.root_state.local_writer_id)
        {
            return Ok(OutboundFreezeTransactionPlanV1::Blocked);
        }
    } else {
        let previous = previous.as_ref().ok_or(FREEZE_FAILURE)?;
        if previous.writer_id != context.root_state.local_writer_id
            || !basis_clock.iter().any(|item| item == previous)
        {
            return Ok(OutboundFreezeTransactionPlanV1::Blocked);
        }
    }
    let exact_bytes = commit_bytes(
        context.root_state.local_writer_id.clone(),
        writer_seq,
        uuid::Uuid::new_v4().to_string(),
        previous.clone(),
        basis_clock.clone(),
        mutations,
        created_at_diagnostic,
    )?;
    let intent = prepare_commit_intent_v1(&exact_bytes, created_at_diagnostic)?;
    let batch = OutboundBatchV1 {
        state_version: 1,
        batch_id: uuid::Uuid::new_v4().to_string(),
        target_id: context.binding.target_id.clone(),
        target_epoch: context.binding.target_epoch,
        physical_root_id: context.binding.physical_root_id.clone(),
        projection_generation: context.projection.projection_generation,
        source_discovery_generation: context.discovery_generation,
        source_root_safety_generation: context.root_safety_generation,
        captured_local_generation: covered
            .iter()
            .map(|item| item.captured_last_generation)
            .max()
            .unwrap_or(0),
        mutations: covered,
        basis_clock,
        writer_id: context.root_state.local_writer_id.clone(),
        writer_sequence: writer_seq,
        previous_writer_ref: previous,
        commit_ref: intent.commit_ref.clone(),
        prepared_intent_path: intent.remote_path.clone(),
        prepared_intent_fingerprint: intent.intent_fingerprint.clone(),
        state: "frozen".into(),
        bookkeeping_completed: false,
        bookkeeping_generation: 0,
    };
    Ok(OutboundFreezeTransactionPlanV1::Frozen {
        batch: Box::new(batch),
        intent: Box::new(intent),
    })
}

fn map_transaction_result(result: OutboundFreezeTransactionResultV1) -> OutboundFreezeResultV1 {
    match result {
        OutboundFreezeTransactionResultV1::Frozen { batch, intent } => {
            OutboundFreezeResultV1::Frozen { batch, intent }
        }
        OutboundFreezeTransactionResultV1::ExistingPendingOutbound => {
            OutboundFreezeResultV1::ExistingPendingOutbound
        }
        OutboundFreezeTransactionResultV1::NoSemanticMutation => {
            OutboundFreezeResultV1::NoSemanticMutation
        }
        OutboundFreezeTransactionResultV1::TargetChanged => OutboundFreezeResultV1::TargetChanged,
        OutboundFreezeTransactionResultV1::Blocked => OutboundFreezeResultV1::Blocked,
    }
}

#[cfg(test)]
fn freeze_active_outbound_with_fault_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
    created_at_diagnostic: &str,
    fault: super::durable_persistence::OutboundFreezeFaultV1,
) -> Result<OutboundFreezeResultV1> {
    let root_id = active_root_id(conn, target_id, target_epoch)?;
    let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let result = store.run_outbound_freeze_transaction_with_fault(
        target_id,
        target_epoch,
        fault,
        |context| build_freeze_plan(context, created_at_diagnostic),
    )?;
    Ok(map_transaction_result(result))
}

#[cfg(test)]
mod tests {
    use super::super::durable_persistence::{
        DesktopRootStateV1, DurableMaterializedProjectionV1, OutboundFreezeFaultV1,
        SqliteS2LiteStoreV1,
    };
    use super::super::materialized_projection::{
        MaterializedProjectionEntityV1, MaterializedProjectionStateV1,
        MaterializedProjectionStatusV1,
    };
    use super::super::remote_discovery::create_discovery_state_v1;
    use super::super::semantic::canonical_semantic_value;
    use super::super::types::CommitRef;
    use super::*;
    use crate::sync_staging::{set_staging, StagedDeleteDescriptor, StagedRecord, SyncStaging};
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry};

    const TIME: &str = "2026-09-17T00:00:00.000Z";

    fn record(id: &str) -> serde_json::Value {
        json!({"id":id,"originalName":"name","chineseName":"","progress":"","totalEpisodes":2,"episodeTrackingEnabled":false,"nextEpisode":null,"movieProgress":null,"movieDuration":null,"releaseYear":null,"posterPath":null,"status":"未看","platform":"","rating":null,"startDate":null,"endDate":null,"notes":"","createdAt":TIME,"updatedAt":null,"imdbId":null,"isLocked":false,"genres":null,"originCountry":null,"imdbRating":null,"tmdbStatus":null,"interestLevel":null,"episodeRuntime":null,"mediaType":"剧集","contentTags":null,"tmdbMediaKind":null,"tmdbId":null,"tmdbParentId":null,"tmdbSeasonNumber":null,"seriesRecordKind":null,"rev":1,"revActor":"local"})
    }

    fn setup() -> (Mutex<Connection>, String, String) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        let conn = Mutex::new(conn);
        let url = sync_targets::normalize_url("https://dav.example.test/root/").unwrap();
        let target = SyncTarget {
            id: sync_targets::target_id(&url, "Alice"),
            normalized_url: url,
            username: "Alice".into(),
            created_at: TIME.into(),
            last_activated_at: TIME.into(),
        };
        let registry = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(target.id.clone()),
            target_epoch: 1,
            targets: vec![target.clone()],
        };
        conn.lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)",
                [
                    sync_targets::REGISTRY_KEY,
                    &serde_json::to_string(&registry).unwrap(),
                ],
            )
            .unwrap();
        super::super::target_root_binding::resolve_active_target_root_authority_v1(
            &conn, &target.id, 1,
        )
        .unwrap();
        let root =
            super::super::webdav_adapter::webdav_root_v1(&target.normalized_url, &target.username)
                .unwrap()
                .physical_root_id;
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        assert!(store
            .compare_and_swap_discovery_state(None, &create_discovery_state_v1())
            .unwrap());
        let projection = DurableMaterializedProjectionV1 {
            projection_version: 1,
            physical_root_id: root.clone(),
            projection_generation: 1,
            source_discovery_generation: 0,
            source_root_safety_generation: 0,
            replay_input_fingerprint: "a".repeat(64),
            business_projection_applied_generation: Some(1),
            state: MaterializedProjectionStateV1 {
                state_version: 1,
                status: MaterializedProjectionStatusV1::Complete,
                basis_clock: vec![],
                entities: vec![],
                relation_blocked_entity_keys: vec![],
                replay_input_fingerprint: "a".repeat(64),
            },
        };
        assert!(store
            .compare_and_swap_materialized_projection(None, &projection)
            .unwrap());
        store
            .persist_desktop_root_state(&DesktopRootStateV1 {
                state_version: 1,
                physical_root_id: root.clone(),
                local_writer_id: "30000000-0000-4000-8000-000000000001".into(),
                next_writer_sequence: 1,
                writer_head: None,
                lifecycle_generation: 0,
                materialized_projection_generation: Some(1),
                business_applied_projection_generation: Some(1),
            })
            .unwrap();
        (conn, target.id, root)
    }

    fn stage_one_record(conn: &Mutex<Connection>) {
        stage_entries(
            conn,
            vec![StagedRecord {
                entity_kind: "record".into(),
                id: "record-1".into(),
                operation: "upsert".into(),
                base: None,
                local: Some(record("record-1")),
                first_generation: 4,
                last_generation: 5,
                delete_descriptor: None,
            }],
        );
    }

    fn stage_entries(conn: &Mutex<Connection>, entries: Vec<StagedRecord>) {
        set_staging(
            &conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries,
            },
        )
        .unwrap();
    }

    fn reference(sequence: u64) -> CommitRef {
        CommitRef {
            writer_id: "10000000-0000-4000-8000-000000000001".into(),
            writer_seq: sequence.to_string(),
            commit_id: format!("20000000-0000-4000-8000-{sequence:012}"),
            content_hash: format!("{sequence:064x}"),
        }
    }

    fn local_reference(sequence: u64) -> CommitRef {
        CommitRef {
            writer_id: "30000000-0000-4000-8000-000000000001".into(),
            writer_seq: sequence.to_string(),
            commit_id: format!("40000000-0000-4000-8000-{sequence:012}"),
            content_hash: format!("{:064x}", sequence + 10_000),
        }
    }

    fn replace_projection_state(
        conn: &Mutex<Connection>,
        root: &str,
        state: MaterializedProjectionStateV1,
    ) {
        let mut store = SqliteS2LiteStoreV1::open(conn, root).unwrap();
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        let generation = projection.projection_generation;
        projection.state = state;
        assert!(store
            .compare_and_swap_materialized_projection(Some(generation), &projection)
            .unwrap());
    }

    fn projection_state(
        status: MaterializedProjectionStatusV1,
        basis_clock: Vec<CommitRef>,
        entities: Vec<MaterializedProjectionEntityV1>,
    ) -> MaterializedProjectionStateV1 {
        MaterializedProjectionStateV1 {
            state_version: 1,
            status,
            basis_clock,
            entities,
            relation_blocked_entity_keys: vec![],
            replay_input_fingerprint: "a".repeat(64),
        }
    }

    fn live_entity(
        key: serde_json::Value,
        frontier: Vec<CommitRef>,
        value: serde_json::Value,
    ) -> MaterializedProjectionEntityV1 {
        MaterializedProjectionEntityV1 {
            entity_key: key,
            semantic_state: Some(json!({"state":"live"})),
            business_value: Some(value),
            frontier,
            conflict: false,
        }
    }

    fn decoded(intent: &PreparedIntentV1) -> super::super::types::CommitV1 {
        super::super::causal::decode_frozen_wire_commit_v1(&intent.exact_bytes).unwrap()
    }

    fn assert_no_outbound_state(conn: &Mutex<Connection>, root: &str) {
        let mut store = SqliteS2LiteStoreV1::open(conn, root).unwrap();
        assert_eq!(store.load_unfinished_outbound_batch().unwrap(), None);
        assert!(store
            .list_prepared_unreceipted_intents()
            .unwrap()
            .is_empty());
        let root_state = store.load_desktop_root_state().unwrap().unwrap();
        assert_eq!(root_state.next_writer_sequence, 1);
        assert!(root_state.writer_head.is_none());
    }

    #[test]
    fn record_freeze_is_real_phase_3e_and_restart_preserves_exact_identity() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        let frozen = freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap();
        let OutboundFreezeResultV1::Frozen { batch, intent } = frozen else {
            panic!("expected freeze")
        };
        assert_eq!(batch.writer_sequence, 1);
        assert!(batch.previous_writer_ref.is_none());
        assert_eq!(batch.projection_generation, 1);
        assert_eq!(batch.mutations.len(), 1);
        let commit = decoded(&intent);
        assert_eq!(commit.commit_kind, "mutation");
        assert_eq!(commit.mutations.len(), 1);
        assert_eq!(commit.mutations[0].entity_type, "record");
        assert_eq!(commit.mutations[0].operation, "upsert");
        assert_eq!(
            commit.mutations[0].entity_key,
            json!(["record", "record-1"])
        );
        assert_eq!(commit.previous_writer_commit, None);
        let mut reopened = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        let durable_batch = reopened.load_unfinished_outbound_batch().unwrap().unwrap();
        let durable_intent = reopened
            .load_prepared_intent(&intent.remote_path)
            .unwrap()
            .unwrap();
        assert_eq!(durable_batch, *batch);
        assert_eq!(durable_intent, *intent);
        assert_eq!(durable_batch.target_id, batch.target_id);
        assert_eq!(durable_batch.target_epoch, batch.target_epoch);
        assert_eq!(durable_batch.physical_root_id, batch.physical_root_id);
        assert_eq!(
            durable_batch.projection_generation,
            batch.projection_generation
        );
        assert_eq!(durable_batch.basis_clock, batch.basis_clock);
        assert_eq!(
            durable_batch
                .mutations
                .iter()
                .map(|mutation| mutation.local_mutation_id.clone())
                .collect::<Vec<_>>(),
            batch
                .mutations
                .iter()
                .map(|mutation| mutation.local_mutation_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(durable_batch.writer_id, batch.writer_id);
        assert_eq!(durable_batch.writer_sequence, batch.writer_sequence);
        assert_eq!(durable_batch.previous_writer_ref, batch.previous_writer_ref);
        assert_eq!(durable_batch.commit_ref, batch.commit_ref);
        assert_eq!(durable_intent.remote_path, intent.remote_path);
        assert_eq!(durable_intent.content_hash, intent.content_hash);
        assert_eq!(durable_intent.exact_bytes, intent.exact_bytes);
        let root_state = reopened.load_desktop_root_state().unwrap().unwrap();
        assert_eq!(root_state.next_writer_sequence, 2);
        assert!(root_state.writer_head.is_none());
    }

    #[test]
    fn business_applied_projection_generation_mismatch_does_not_freeze() {
        let (conn, target_id, root) = setup();
        set_staging(
            &conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries: vec![StagedRecord {
                    entity_kind: "record".into(),
                    id: "record-1".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(record("record-1")),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                }],
            },
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        let state = DesktopRootStateV1 {
            state_version: 1,
            physical_root_id: root.clone(),
            local_writer_id: "30000000-0000-4000-8000-000000000001".into(),
            next_writer_sequence: 1,
            writer_head: None,
            lifecycle_generation: 0,
            materialized_projection_generation: Some(1),
            business_applied_projection_generation: Some(0),
        };
        store.persist_desktop_root_state(&state).unwrap();
        assert!(matches!(
            freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap(),
            OutboundFreezeResultV1::Blocked
        ));
        assert_no_outbound_state(&conn, &root);
    }

    #[test]
    fn causal_basis_and_every_mutation_frontier_are_from_projection_generation() {
        let (conn, target_id, root) = setup();
        let basis = reference(4);
        let mut changed = record("record-1");
        changed["originalName"] = json!("changed name");
        replace_projection_state(
            &conn,
            &root,
            projection_state(
                MaterializedProjectionStatusV1::Complete,
                vec![basis.clone()],
                vec![live_entity(
                    json!(["record", "record-1"]),
                    vec![basis.clone()],
                    canonical_semantic_value(&record("record-1")).unwrap(),
                )],
            ),
        );
        stage_entries(
            &conn,
            vec![StagedRecord {
                entity_kind: "record".into(),
                id: "record-1".into(),
                operation: "upsert".into(),
                base: None,
                local: Some(changed),
                first_generation: 4,
                last_generation: 5,
                delete_descriptor: None,
            }],
        );
        let OutboundFreezeResultV1::Frozen { batch, intent } =
            freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap()
        else {
            panic!("expected freeze")
        };
        let commit = decoded(&intent);
        assert_eq!(batch.projection_generation, 1);
        assert_eq!(batch.basis_clock, vec![basis.clone()]);
        assert_eq!(commit.basis_clock, vec![basis.clone()]);
        assert_eq!(commit.mutations[0].base_frontier, vec![basis]);
    }

    #[test]
    fn pending_dependencies_and_conflicts_block_without_selecting_a_winner() {
        let (pending_conn, pending_target, pending_root) = setup();
        replace_projection_state(
            &pending_conn,
            &pending_root,
            projection_state(
                MaterializedProjectionStatusV1::PendingDependencies {
                    pending_refs: vec![reference(3)],
                },
                vec![],
                vec![],
            ),
        );
        stage_one_record(&pending_conn);
        assert!(matches!(
            freeze_active_outbound_v1(&pending_conn, &pending_target, 1, TIME).unwrap(),
            OutboundFreezeResultV1::Blocked
        ));
        assert_no_outbound_state(&pending_conn, &pending_root);

        let (conflict_conn, conflict_target, conflict_root) = setup();
        let conflict = MaterializedProjectionEntityV1 {
            entity_key: json!(["record", "record-1"]),
            semantic_state: None,
            business_value: None,
            frontier: vec![reference(3)],
            conflict: true,
        };
        replace_projection_state(
            &conflict_conn,
            &conflict_root,
            projection_state(
                MaterializedProjectionStatusV1::Complete,
                vec![reference(3)],
                vec![conflict],
            ),
        );
        stage_one_record(&conflict_conn);
        assert!(matches!(
            freeze_active_outbound_v1(&conflict_conn, &conflict_target, 1, TIME).unwrap(),
            OutboundFreezeResultV1::Blocked
        ));
        assert_no_outbound_state(&conflict_conn, &conflict_root);
    }

    #[test]
    fn metadata_only_edit_and_absent_local_delete_produce_no_commit() {
        let (metadata_conn, metadata_target, metadata_root) = setup();
        let basis = reference(3);
        replace_projection_state(
            &metadata_conn,
            &metadata_root,
            projection_state(
                MaterializedProjectionStatusV1::Complete,
                vec![basis.clone()],
                vec![live_entity(
                    json!(["record", "record-1"]),
                    vec![basis.clone()],
                    canonical_semantic_value(&record("record-1")).unwrap(),
                )],
            ),
        );
        stage_one_record(&metadata_conn);
        assert!(matches!(
            freeze_active_outbound_v1(&metadata_conn, &metadata_target, 1, TIME).unwrap(),
            OutboundFreezeResultV1::NoSemanticMutation
        ));
        assert_no_outbound_state(&metadata_conn, &metadata_root);

        let (delete_conn, delete_target, delete_root) = setup();
        stage_entries(
            &delete_conn,
            vec![StagedRecord {
                entity_kind: "record".into(),
                id: "record-local".into(),
                operation: "delete".into(),
                base: None,
                local: None,
                first_generation: 1,
                last_generation: 2,
                delete_descriptor: Some(StagedDeleteDescriptor::Record {
                    id: "record-local".into(),
                    deleted_at: TIME.into(),
                    rev: 2,
                    rev_actor: "local".into(),
                }),
            }],
        );
        assert!(matches!(
            freeze_active_outbound_v1(&delete_conn, &delete_target, 1, TIME).unwrap(),
            OutboundFreezeResultV1::NoSemanticMutation
        ));
        assert_no_outbound_state(&delete_conn, &delete_root);
    }

    #[test]
    fn episode_null_completion_is_live_and_composite_delete_uses_durable_identity() {
        let (episode_conn, episode_target, _episode_root) = setup();
        let episode_id =
            super::super::canonical::sha256_hex(b"episode-completion:v1\0record-1\x002");
        stage_entries(
            &episode_conn,
            vec![StagedRecord {
                entity_kind: "episode-completion".into(),
                id: episode_id.clone(),
                operation: "upsert".into(),
                base: None,
                local: Some(json!({
                    "id":episode_id, "recordId":"record-1", "episodeNumber":2,
                    "completedAt":null, "createdAt":TIME, "updatedAt":TIME,
                    "rev":1, "revActor":"local"
                })),
                first_generation: 1,
                last_generation: 2,
                delete_descriptor: None,
            }],
        );
        let OutboundFreezeResultV1::Frozen { intent, .. } =
            freeze_active_outbound_v1(&episode_conn, &episode_target, 1, TIME).unwrap()
        else {
            panic!("expected episode freeze")
        };
        let mutation = &decoded(&intent).mutations[0];
        assert_eq!(mutation.operation, "upsert");
        assert_eq!(
            mutation.entity_key,
            json!(["episode-completion", "record-1", 2])
        );
        assert_eq!(mutation.value["completedAt"], serde_json::Value::Null);

        let (delete_conn, delete_target, delete_root) = setup();
        let key = json!(["collection-member", "collection-1", "record-1"]);
        let member_id =
            super::super::canonical::sha256_hex(b"collection-member:v1\0collection-1\0record-1");
        replace_projection_state(
            &delete_conn,
            &delete_root,
            projection_state(
                MaterializedProjectionStatusV1::Complete,
                vec![],
                vec![live_entity(key.clone(), vec![], json!({}))],
            ),
        );
        stage_entries(
            &delete_conn,
            vec![StagedRecord {
                entity_kind: "collection-member".into(),
                id: member_id.clone(),
                operation: "delete".into(),
                base: None,
                local: None,
                first_generation: 8,
                last_generation: 9,
                delete_descriptor: Some(StagedDeleteDescriptor::CollectionMember {
                    id: member_id.clone(),
                    collection_id: "collection-1".into(),
                    record_id: "record-1".into(),
                    deleted_at: TIME.into(),
                    rev: 7,
                    rev_actor: "local".into(),
                }),
            }],
        );
        let OutboundFreezeResultV1::Frozen { intent, .. } =
            freeze_active_outbound_v1(&delete_conn, &delete_target, 1, TIME).unwrap()
        else {
            panic!("expected delete freeze")
        };
        let mutation = &decoded(&intent).mutations[0];
        assert_eq!(mutation.operation, "tombstone");
        assert_eq!(mutation.entity_key, key);
        assert_eq!(mutation.value["id"], member_id);
        assert_eq!(mutation.value["collectionId"], "collection-1");
        assert_eq!(mutation.value["recordId"], "record-1");
    }

    #[test]
    fn existing_writer_head_and_staging_order_are_preserved_deterministically() {
        let (head_conn, head_target, head_root) = setup();
        let previous = local_reference(7);
        let mut store = SqliteS2LiteStoreV1::open(&head_conn, &head_root).unwrap();
        store
            .persist_desktop_root_state(&DesktopRootStateV1 {
                state_version: 1,
                physical_root_id: head_root.clone(),
                local_writer_id: "30000000-0000-4000-8000-000000000001".into(),
                next_writer_sequence: 8,
                writer_head: Some(previous.clone()),
                lifecycle_generation: 0,
                materialized_projection_generation: Some(1),
                business_applied_projection_generation: Some(1),
            })
            .unwrap();
        replace_projection_state(
            &head_conn,
            &head_root,
            projection_state(
                MaterializedProjectionStatusV1::Complete,
                vec![previous.clone()],
                vec![],
            ),
        );
        stage_one_record(&head_conn);
        let OutboundFreezeResultV1::Frozen { batch, intent } =
            freeze_active_outbound_v1(&head_conn, &head_target, 1, TIME).unwrap()
        else {
            panic!("expected successor freeze")
        };
        assert_eq!(batch.writer_sequence, 8);
        assert_eq!(batch.previous_writer_ref, Some(previous.clone()));
        assert_eq!(decoded(&intent).previous_writer_commit, Some(previous));

        let (order_conn, order_target, _order_root) = setup();
        let mut a = record("record-a");
        a["originalName"] = json!("a");
        let mut b = record("record-b");
        b["originalName"] = json!("b");
        stage_entries(
            &order_conn,
            vec![
                StagedRecord {
                    entity_kind: "record".into(),
                    id: "record-b".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(b),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                },
                StagedRecord {
                    entity_kind: "record".into(),
                    id: "record-a".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(a),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                },
            ],
        );
        let OutboundFreezeResultV1::Frozen { intent, .. } =
            freeze_active_outbound_v1(&order_conn, &order_target, 1, TIME).unwrap()
        else {
            panic!("expected ordered freeze")
        };
        assert_eq!(
            decoded(&intent)
                .mutations
                .iter()
                .map(|mutation| mutation.entity_key.clone())
                .collect::<Vec<_>>(),
            vec![json!(["record", "record-a"]), json!(["record", "record-b"])]
        );
    }

    #[test]
    fn atomic_freeze_failure_after_writer_reservation_rolls_back_every_fact() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        assert!(freeze_active_outbound_with_fault_v1(
            &conn,
            &target_id,
            1,
            TIME,
            OutboundFreezeFaultV1::AfterWriterReservation,
        )
        .is_err());
        assert_no_outbound_state(&conn, &root);
    }

    #[test]
    fn atomic_freeze_failure_after_batch_persistence_rolls_back_every_fact() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        assert!(freeze_active_outbound_with_fault_v1(
            &conn,
            &target_id,
            1,
            TIME,
            OutboundFreezeFaultV1::AfterBatchPersistence,
        )
        .is_err());
        assert_no_outbound_state(&conn, &root);
    }

    #[test]
    fn atomic_freeze_discovery_projection_mismatch_leaves_no_outbound_state() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        let discovery = store.load_discovery_state().unwrap().unwrap();
        assert!(store
            .compare_and_swap_discovery_state(Some(discovery.storage_generation), &discovery.state)
            .unwrap());
        assert!(matches!(
            freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap(),
            OutboundFreezeResultV1::Blocked
        ));
        assert_no_outbound_state(&conn, &root);
    }

    #[test]
    fn atomic_freeze_target_epoch_mismatch_leaves_zero_outbound_state() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        assert!(matches!(
            freeze_active_outbound_v1(&conn, &target_id, 2, TIME).unwrap(),
            OutboundFreezeResultV1::TargetChanged
        ));
        assert_no_outbound_state(&conn, &root);
    }

    #[test]
    fn atomic_freeze_unresolved_prior_outbound_prevents_successor_allocation() {
        let (conn, target_id, root) = setup();
        stage_one_record(&conn);
        let first = freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap();
        assert!(matches!(first, OutboundFreezeResultV1::Frozen { .. }));
        assert!(matches!(
            freeze_active_outbound_v1(&conn, &target_id, 1, TIME).unwrap(),
            OutboundFreezeResultV1::ExistingPendingOutbound
        ));
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        assert_eq!(
            store
                .load_desktop_root_state()
                .unwrap()
                .unwrap()
                .next_writer_sequence,
            2
        );
    }
}
