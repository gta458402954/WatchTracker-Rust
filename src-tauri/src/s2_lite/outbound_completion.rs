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
    use std::sync::Mutex;

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
        MaterializedProjectionStateV1, MaterializedProjectionStatusV1,
    };
    use super::super::outbound_freeze::{freeze_active_outbound_v1, OutboundFreezeResultV1};
    use super::super::remote_discovery::create_discovery_state_v1;
    use super::*;
    use crate::sync_staging::{get_staging, set_staging, StagedRecord, SyncStaging};
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry};

    const TIME: &str = "2026-09-18T00:00:00.000Z";

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
        }
    }

    fn setup() -> Fixture {
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
        Fixture {
            conn,
            target_id: target.id,
            root,
        }
    }

    fn freeze(
        fixture: &Fixture,
        entries: Vec<StagedRecord>,
    ) -> super::super::durable_persistence::OutboundBatchV1 {
        set_staging(
            &fixture.conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
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

    fn state(fixture: &Fixture) -> DesktopRootStateV1 {
        SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root)
            .unwrap()
            .load_desktop_root_state()
            .unwrap()
            .unwrap()
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
        set_staging(
            &fixture.conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries: vec![staged_record("record-1", 7)],
            },
        )
        .unwrap();
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
        set_staging(
            &fixture.conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries: vec![staged_record("record-2", 8)],
            },
        )
        .unwrap();
        let OutboundFreezeResultV1::Frozen {
            batch: successor, ..
        } = freeze_active_outbound_v1(&fixture.conn, &fixture.target_id, 1, TIME).unwrap()
        else {
            panic!("expected successor freeze")
        };
        assert_eq!(successor.writer_sequence, 2);
        assert_eq!(successor.previous_writer_ref, Some(batch.commit_ref));
    }
}
