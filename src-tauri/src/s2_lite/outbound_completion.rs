//! Generation-safe local completion for an already receipted outbound batch.
//!
//! This boundary has no remote collaborator. It can only consume the durable
//! receipt written by publication recovery, then atomically acknowledge the
//! exact captured staging tokens and advance the local writer head.

use std::sync::Mutex;

use rusqlite::Connection;

use super::canonical::Result;
use super::durable_persistence::{OutboundCompletionResultV1, SqliteS2LiteStoreV1};

pub fn complete_verified_outbound_batch_v1(
    conn: &Mutex<Connection>,
    physical_root_id: &str,
) -> Result<OutboundCompletionResultV1> {
    SqliteS2LiteStoreV1::open(conn, physical_root_id)?.complete_verified_outbound_batch()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use rusqlite::Connection;
    use serde_json::json;

    use super::super::durable_persistence::{
        DesktopRootStateV1, DurableMaterializedProjectionV1, OutboundCompletionFaultV1,
        OutboundCompletionResultV1, SqliteS2LiteStoreV1,
    };
    use super::super::immutable_publish::{
        ImmutableObjectRemoteV1, RemoteExactGetResultV1, RemotePutResultV1,
    };
    use super::super::materialized_projection::{
        MaterializedProjectionEntityV1, MaterializedProjectionStateV1,
        MaterializedProjectionStatusV1,
    };
    use super::super::outbound_freeze::{freeze_active_outbound_v1, OutboundFreezeResultV1};
    use super::super::remote_discovery::create_discovery_state_v1;
    use super::*;
    use crate::sync_staging::{
        capture_staged_causal_anchor_v1, get_staging, get_staging_for_target, set_staging,
        set_staging_for_target, StagedCausalAnchorV1, StagedDeleteDescriptor, StagedRecord,
        SyncStaging,
    };
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry};

    const TIME: &str = "2026-09-18T00:00:00.000Z";

    struct TempDatabase {
        path: PathBuf,
    }

    impl TempDatabase {
        fn new(name: &str) -> Self {
            Self {
                path: std::env::temp_dir().join(format!(
                    "watchtracker-s2-completion-{name}-{}.db",
                    uuid::Uuid::new_v4()
                )),
            }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                PathBuf::from(format!("{}-wal", self.path.display())),
                PathBuf::from(format!("{}-shm", self.path.display())),
            ] {
                let _ = fs::remove_file(path);
            }
        }
    }

    struct ExactRemote {
        root: String,
        path: String,
        bytes: Vec<u8>,
    }

    impl ImmutableObjectRemoteV1 for ExactRemote {
        fn physical_root_id(&self) -> Option<&str> {
            Some(&self.root)
        }

        fn get_exact(&mut self, path: &str) -> RemoteExactGetResultV1 {
            if path == self.path {
                RemoteExactGetResultV1::DefinitelyPresent(self.bytes.clone())
            } else {
                RemoteExactGetResultV1::DefinitelyAbsent
            }
        }

        fn put_exact(&mut self, _: &str, _: &[u8], _: bool) -> RemotePutResultV1 {
            panic!("local completion must not publish")
        }
    }

    struct Fixture {
        conn: Mutex<Connection>,
        target_id: String,
        root: String,
    }

    fn record(id: &str) -> serde_json::Value {
        json!({"id":id,"originalName":"name","chineseName":"","progress":"","totalEpisodes":2,"episodeTrackingEnabled":false,"nextEpisode":null,"movieProgress":null,"movieDuration":null,"releaseYear":null,"posterPath":null,"status":"未看","platform":"","rating":null,"startDate":null,"endDate":null,"notes":"","createdAt":TIME,"updatedAt":null,"imdbId":null,"isLocked":false,"genres":null,"originCountry":null,"imdbRating":null,"tmdbStatus":null,"interestLevel":null,"episodeRuntime":null,"mediaType":"剧集","contentTags":null,"tmdbMediaKind":null,"tmdbId":null,"tmdbParentId":null,"tmdbSeasonNumber":null,"seriesRecordKind":null,"rev":1,"revActor":"local"})
    }

    fn staged_record(id: &str, generation: i64) -> StagedRecord {
        StagedRecord {
            entity_kind: "record".into(),
            id: id.into(),
            operation: "upsert".into(),
            base: None,
            local: Some(record(id)),
            first_generation: generation,
            last_generation: generation,
            delete_descriptor: None,
            causal_anchor: StagedCausalAnchorV1::Unavailable {
                reason: "test".into(),
            },
        }
    }

    fn setup() -> Fixture {
        setup_with_connection(Connection::open_in_memory().unwrap())
    }

    fn setup_with_connection(conn: Connection) -> Fixture {
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
        Fixture {
            conn,
            target_id: target.id,
            root,
        }
    }

    fn freeze(
        fixture: &Fixture,
        mut entries: Vec<StagedRecord>,
    ) -> super::super::durable_persistence::OutboundBatchV1 {
        for entry in &mut entries {
            entry.causal_anchor =
                capture_staged_causal_anchor_v1(&fixture.conn.lock().unwrap(), entry);
        }
        set_staging(
            &fixture.conn.lock().unwrap(),
            &SyncStaging {
                version: 3,
                entries,
            },
        )
        .unwrap();
        let OutboundFreezeResultV1::Frozen { batch, intent } =
            freeze_active_outbound_v1(&fixture.conn, &fixture.target_id, 1, TIME).unwrap()
        else {
            panic!("expected frozen outbound batch")
        };
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let mut remote = ExactRemote {
            root: fixture.root.clone(),
            path: intent.remote_path.clone(),
            bytes: intent.exact_bytes.clone(),
        };
        store
            .verify_and_persist_commit_receipt(&intent, &mut remote, TIME)
            .unwrap();
        *batch
    }

    fn set_anchored_staging(fixture: &Fixture, mut entries: Vec<StagedRecord>) {
        for entry in &mut entries {
            entry.causal_anchor =
                capture_staged_causal_anchor_v1(&fixture.conn.lock().unwrap(), entry);
        }
        set_staging(
            &fixture.conn.lock().unwrap(),
            &SyncStaging {
                version: 3,
                entries,
            },
        )
        .unwrap();
    }

    fn state(fixture: &Fixture) -> DesktopRootStateV1 {
        SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root)
            .unwrap()
            .load_desktop_root_state()
            .unwrap()
            .unwrap()
    }

    fn persist_projection_generation(fixture: &Fixture, generation: u64) {
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        let expected = projection.projection_generation;
        projection.projection_generation = generation;
        assert!(store
            .compare_and_swap_materialized_projection(Some(expected), &projection)
            .unwrap());
    }

    fn two_connection_fixture(name: &str) -> (TempDatabase, Fixture, Mutex<Connection>) {
        let database = TempDatabase::new(name);
        let fixture = setup_with_connection(Connection::open(database.path()).unwrap());
        let second = Mutex::new(Connection::open(database.path()).unwrap());
        (database, fixture, second)
    }

    fn switch_active_target(fixture: &Fixture, target: SyncTarget, epoch: u64) {
        let mut registry = sync_targets::registry(&fixture.conn.lock().unwrap())
            .unwrap()
            .unwrap();
        if !registry.targets.iter().any(|item| item.id == target.id) {
            registry.targets.push(target.clone());
        }
        registry.active_target_id = Some(target.id);
        registry.target_epoch = epoch;
        fixture
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE settings SET value=?2 WHERE key=?1",
                [
                    sync_targets::REGISTRY_KEY,
                    &serde_json::to_string(&registry).unwrap(),
                ],
            )
            .unwrap();
    }

    fn target(url: &str, username: &str) -> SyncTarget {
        let normalized_url = sync_targets::normalize_url(url).unwrap();
        SyncTarget {
            id: sync_targets::target_id(&normalized_url, username),
            normalized_url,
            username: username.into(),
            created_at: TIME.into(),
            last_activated_at: TIME.into(),
        }
    }

    #[test]
    fn receipt_acknowledges_staging_advances_head_and_is_idempotent_after_restart() {
        let fixture = setup();
        let batch = freeze(&fixture, vec![staged_record("record-1", 7)]);
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::Completed
        );
        assert!(get_staging(&fixture.conn.lock().unwrap())
            .unwrap()
            .entries
            .is_empty());
        assert_eq!(state(&fixture).writer_head, Some(batch.commit_ref.clone()));
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::AlreadyCompleted
        );
        assert_eq!(state(&fixture).writer_head, Some(batch.commit_ref));
    }

    #[test]
    fn newer_staging_survives_and_mixed_tokens_acknowledge_independently() {
        let fixture = setup();
        let batch = freeze(
            &fixture,
            vec![staged_record("record-1", 7), staged_record("record-2", 7)],
        );
        let mut staging = get_staging(&fixture.conn.lock().unwrap()).unwrap();
        staging.entries[1].last_generation = 8;
        staging.entries[1].local = Some(record("record-2-newer"));
        set_staging(&fixture.conn.lock().unwrap(), &staging).unwrap();
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::Completed
        );
        let staging = get_staging(&fixture.conn.lock().unwrap()).unwrap();
        assert_eq!(staging.entries.len(), 1);
        assert_eq!(staging.entries[0].id, "record-2");
        assert_eq!(staging.entries[0].last_generation, 8);
        assert_eq!(state(&fixture).writer_head, Some(batch.commit_ref));
    }

    #[test]
    fn no_receipt_or_writer_head_mismatch_changes_no_local_state() {
        let fixture = setup();
        set_anchored_staging(&fixture, vec![staged_record("record-1", 7)]);
        let OutboundFreezeResultV1::Frozen { batch, .. } =
            freeze_active_outbound_v1(&fixture.conn, &fixture.target_id, 1, TIME).unwrap()
        else {
            panic!("expected frozen batch")
        };
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::PendingReceipt
        );
        assert_eq!(
            get_staging(&fixture.conn.lock().unwrap())
                .unwrap()
                .entries
                .len(),
            1
        );
        assert_eq!(state(&fixture).writer_head, None);
        assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root)
            .unwrap()
            .load_unfinished_outbound_batch()
            .unwrap()
            .is_some());
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let intent = store
            .load_prepared_intent(&batch.prepared_intent_path)
            .unwrap()
            .unwrap();
        let mut remote = ExactRemote {
            root: fixture.root.clone(),
            path: intent.remote_path.clone(),
            bytes: intent.exact_bytes.clone(),
        };
        store
            .verify_and_persist_commit_receipt(&intent, &mut remote, TIME)
            .unwrap();
        let mut root = state(&fixture);
        root.writer_head = Some(batch.commit_ref.clone());
        store.persist_desktop_root_state(&root).unwrap();
        assert!(complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).is_err());
        assert_eq!(
            get_staging(&fixture.conn.lock().unwrap())
                .unwrap()
                .entries
                .len(),
            1
        );
        assert_eq!(state(&fixture).writer_head, Some(batch.commit_ref.clone()));
        assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root)
            .unwrap()
            .load_unfinished_outbound_batch()
            .unwrap()
            .is_some());
    }

    #[test]
    fn injected_completion_failures_roll_back_staging_head_and_batch() {
        for fault in [
            OutboundCompletionFaultV1::AfterStagingAcknowledgement,
            OutboundCompletionFaultV1::AfterWriterHeadAdvance,
        ] {
            let fixture = setup();
            freeze(&fixture, vec![staged_record("record-1", 7)]);
            let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
            assert!(store
                .complete_verified_outbound_batch_with_fault(fault)
                .is_err());
            assert_eq!(
                get_staging(&fixture.conn.lock().unwrap())
                    .unwrap()
                    .entries
                    .len(),
                1
            );
            assert_eq!(state(&fixture).writer_head, None);
            assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root)
                .unwrap()
                .load_unfinished_outbound_batch()
                .unwrap()
                .is_some());
        }
    }

    #[test]
    fn completed_batch_admits_successor_with_next_writer_sequence() {
        let fixture = setup();
        let batch = freeze(&fixture, vec![staged_record("record-1", 7)]);
        complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        projection.state.basis_clock = vec![batch.commit_ref.clone()];
        assert!(store
            .compare_and_swap_materialized_projection(Some(1), &projection)
            .unwrap());
        set_anchored_staging(&fixture, vec![staged_record("record-2", 8)]);
        let OutboundFreezeResultV1::Frozen {
            batch: successor, ..
        } = freeze_active_outbound_v1(&fixture.conn, &fixture.target_id, 1, TIME).unwrap()
        else {
            panic!("expected successor freeze")
        };
        assert_eq!(successor.writer_sequence, 2);
        assert_eq!(successor.previous_writer_ref, Some(batch.commit_ref));
    }

    #[test]
    fn historical_target_completion_acks_only_original_staging_after_switch_and_restart() {
        let fixture = setup();
        let batch = freeze(
            &fixture,
            vec![staged_record("a-covered", 7), staged_record("a-newer", 7)],
        );
        let mut a_staging =
            get_staging_for_target(&fixture.conn.lock().unwrap(), &fixture.target_id)
                .unwrap()
                .unwrap();
        let preserved_anchor = a_staging.entries[1].causal_anchor.clone();
        a_staging.entries[1].last_generation = 8;
        a_staging.entries[1].local = Some(record("a-newer-after-freeze"));
        set_staging_for_target(
            &fixture.conn.lock().unwrap(),
            &fixture.target_id,
            &a_staging,
        )
        .unwrap();

        let target_b = target("https://dav.example.test/other/", "Bob");
        switch_active_target(&fixture, target_b.clone(), 2);
        let b_staging = SyncStaging {
            version: 3,
            entries: vec![staged_record("b-untouched", 12)],
        };
        set_staging_for_target(&fixture.conn.lock().unwrap(), &target_b.id, &b_staging).unwrap();

        // Reopening the durable store models lifecycle restart after the
        // active target changed. Completion must still use batch target A.
        let mut restarted = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        assert_eq!(
            restarted.complete_verified_outbound_batch().unwrap(),
            OutboundCompletionResultV1::Completed
        );
        assert_eq!(
            get_staging_for_target(&fixture.conn.lock().unwrap(), &fixture.target_id)
                .unwrap()
                .unwrap()
                .entries,
            vec![StagedRecord {
                entity_kind: "record".into(),
                id: "a-newer".into(),
                operation: "upsert".into(),
                base: None,
                local: Some(record("a-newer-after-freeze")),
                first_generation: 7,
                last_generation: 8,
                delete_descriptor: None,
                causal_anchor: preserved_anchor,
            }]
        );
        assert_eq!(
            get_staging(&fixture.conn.lock().unwrap()).unwrap(),
            b_staging,
            "current target B staging must never be used for historical completion"
        );
        assert_eq!(state(&fixture).writer_head, Some(batch.commit_ref.clone()));
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::AlreadyCompleted
        );

        switch_active_target(
            &fixture,
            target("https://dav.example.test/root/", "Alice"),
            3,
        );
        super::super::target_root_binding::resolve_active_target_root_authority_v1(
            &fixture.conn,
            &fixture.target_id,
            3,
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        projection.state.basis_clock = vec![batch.commit_ref.clone()];
        assert!(store
            .compare_and_swap_materialized_projection(Some(1), &projection)
            .unwrap());
        let OutboundFreezeResultV1::Frozen {
            batch: successor, ..
        } = freeze_active_outbound_v1(&fixture.conn, &fixture.target_id, 3, TIME).unwrap()
        else {
            panic!("historical completion must unblock successor freeze")
        };
        assert_eq!(successor.writer_sequence, 2);
        assert_eq!(successor.previous_writer_ref, Some(batch.commit_ref));
    }

    #[test]
    fn historical_completion_uses_composite_delete_descriptor_identity() {
        let fixture = setup();
        let member_id =
            super::super::canonical::sha256_hex(b"collection-member:v1\0collection-a\0record-a");
        let entity_key = json!(["collection-member", "collection-a", "record-a"]);
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        projection
            .state
            .entities
            .push(MaterializedProjectionEntityV1 {
                entity_key: entity_key.clone(),
                semantic_state: Some(json!({"state":"live"})),
                business_value: Some(json!({})),
                frontier: vec![],
                conflict: false,
            });
        assert!(store
            .compare_and_swap_materialized_projection(Some(1), &projection)
            .unwrap());
        let batch = freeze(
            &fixture,
            vec![StagedRecord {
                entity_kind: "collection-member".into(),
                id: member_id.clone(),
                operation: "delete".into(),
                base: None,
                local: None,
                first_generation: 7,
                last_generation: 7,
                delete_descriptor: Some(StagedDeleteDescriptor::CollectionMember {
                    id: member_id,
                    collection_id: "collection-a".into(),
                    record_id: "record-a".into(),
                    deleted_at: TIME.into(),
                    rev: 1,
                    rev_actor: "local".into(),
                }),
                causal_anchor: StagedCausalAnchorV1::Unavailable {
                    reason: "test".into(),
                },
            }],
        );
        assert_eq!(batch.mutations[0].entity_key, entity_key);
        let target_b = target("https://dav.example.test/other/", "Bob");
        switch_active_target(&fixture, target_b.clone(), 2);
        let b_staging = SyncStaging {
            version: 3,
            entries: vec![staged_record("b-untouched", 12)],
        };
        set_staging_for_target(&fixture.conn.lock().unwrap(), &target_b.id, &b_staging).unwrap();
        assert_eq!(
            complete_verified_outbound_batch_v1(&fixture.conn, &fixture.root).unwrap(),
            OutboundCompletionResultV1::Completed
        );
        assert!(
            get_staging_for_target(&fixture.conn.lock().unwrap(), &fixture.target_id)
                .unwrap()
                .unwrap()
                .entries
                .is_empty()
        );
        assert_eq!(
            get_staging(&fixture.conn.lock().unwrap()).unwrap(),
            b_staging
        );
    }

    #[test]
    fn projection_bookkeeping_after_receipt_completion_preserves_new_writer_authority() {
        let (_database, fixture, second_connection) = two_connection_fixture("projection-after");
        let batch = freeze(&fixture, vec![staged_record("record-1", 7)]);
        let stale_root_snapshot = state(&fixture);
        persist_projection_generation(&fixture, 2);

        let mut completion = SqliteS2LiteStoreV1::open(&second_connection, &fixture.root).unwrap();
        assert_eq!(
            completion.complete_verified_outbound_batch().unwrap(),
            OutboundCompletionResultV1::Completed
        );
        let mut projection = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        projection
            .update_materialized_projection_generation(2)
            .unwrap();

        let final_state = state(&fixture);
        assert_eq!(final_state.writer_head, Some(batch.commit_ref));
        assert_eq!(final_state.next_writer_sequence, 2);
        assert_eq!(
            final_state.local_writer_id,
            stale_root_snapshot.local_writer_id
        );
        assert_eq!(final_state.materialized_projection_generation, Some(2));
        assert_eq!(
            final_state.business_applied_projection_generation,
            stale_root_snapshot.business_applied_projection_generation
        );
    }

    #[test]
    fn receipt_completion_after_projection_bookkeeping_preserves_both_updates() {
        let (_database, fixture, second_connection) = two_connection_fixture("projection-before");
        let batch = freeze(&fixture, vec![staged_record("record-1", 7)]);
        persist_projection_generation(&fixture, 2);
        let mut projection = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root).unwrap();
        projection
            .update_materialized_projection_generation(2)
            .unwrap();

        let mut completion = SqliteS2LiteStoreV1::open(&second_connection, &fixture.root).unwrap();
        assert_eq!(
            completion.complete_verified_outbound_batch().unwrap(),
            OutboundCompletionResultV1::Completed
        );
        let final_state = state(&fixture);
        assert_eq!(final_state.writer_head, Some(batch.commit_ref));
        assert_eq!(final_state.next_writer_sequence, 2);
        assert_eq!(final_state.materialized_projection_generation, Some(2));
    }
}
