//! Local-only admission for a frozen legacy bootstrap migration.
//!
//! This module translates the four production business entities through the
//! existing ordinary frozen scalar mapping. It deliberately has no remote,
//! activation, or ordinary-writer collaborator.

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value;

use super::canonical::{ProtocolError, Result};
use super::durable_persistence::{
    MigrationAdmissionInputV1, MigrationAdmissionResultV1, SqliteS2LiteStoreV1,
};
use super::migration_orchestration::{
    capture_legacy_snapshot_v1, CapturedLegacySnapshotV1, LegacySnapshotEntryV1,
};
use super::ordinary_mutation::{
    LocalCollectionMemberV1, LocalCollectionV1, LocalEntityValueV1, LocalEpisodeCompletionV1,
    LocalRecordV1,
};
use super::semantic::validate_native_entity;
use super::target_root_binding::{
    load_historical_target_root_binding_v1, resolve_active_target_root_binding_v1,
};
use super::types::{BootstrapEntity, LegacySemanticAdapterV1};

const ADMISSION_FAILURE: ProtocolError = ProtocolError("S2_MIGRATION_ADMISSION_FAILURE");

/// The production adapter is intentionally typed: source rows are converted
/// to their established local entity representation before the same frozen
/// wire/value validation used by ordinary S2 mutations.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProductionLegacySemanticAdapterV1;

impl LegacySemanticAdapterV1 for ProductionLegacySemanticAdapterV1 {
    fn adapt_live_entity(
        &self,
        entity_type: &str,
        legacy_value: &Value,
    ) -> std::result::Result<BootstrapEntity, String> {
        let local = match entity_type {
            "record" => LocalEntityValueV1::Record(Box::new(
                serde_json::from_value::<LocalRecordV1>(legacy_value.clone())
                    .map_err(|_| "invalid_record".to_string())?,
            )),
            "episode-completion" => LocalEntityValueV1::EpisodeCompletion(
                serde_json::from_value::<LocalEpisodeCompletionV1>(legacy_value.clone())
                    .map_err(|_| "invalid_episode_completion".to_string())?,
            ),
            "collection" => LocalEntityValueV1::Collection(
                serde_json::from_value::<LocalCollectionV1>(legacy_value.clone())
                    .map_err(|_| "invalid_collection".to_string())?,
            ),
            "collection-member" => LocalEntityValueV1::CollectionMember(
                serde_json::from_value::<LocalCollectionMemberV1>(legacy_value.clone())
                    .map_err(|_| "invalid_collection_member".to_string())?,
            ),
            _ => return Err("unsupported_entity_type".to_string()),
        };
        let entity = BootstrapEntity {
            entity_type: local.entity_type().to_string(),
            entity_key: local.entity_key(),
            value: local
                .wire_value()
                .map_err(|_| "invalid_entity".to_string())?,
        };
        validate_native_entity(&entity.entity_key, &entity.value)
            .map_err(|_| "invalid_entity".to_string())?;
        Ok(entity)
    }
}

fn record_status(value: &crate::models::RecordStatus) -> &'static str {
    match value {
        crate::models::RecordStatus::Watched => "已看",
        crate::models::RecordStatus::Watching => "在看",
        crate::models::RecordStatus::Unwatched => "未看",
    }
}

fn record(value: crate::models::WatchRecord) -> LocalRecordV1 {
    LocalRecordV1 {
        id: value.id,
        original_name: value.original_name,
        chinese_name: value.chinese_name,
        progress: value.progress,
        total_episodes: value.total_episodes,
        episode_tracking_enabled: value.episode_tracking_enabled,
        next_episode: value.next_episode,
        movie_progress: value.movie_progress,
        movie_duration: value.movie_duration,
        release_year: value.release_year,
        poster_path: value.poster_path,
        status: record_status(&value.status).to_string(),
        platform: value.platform,
        rating: value.rating,
        start_date: value.start_date,
        end_date: value.end_date,
        notes: value.notes,
        created_at: value.created_at,
        updated_at: value.updated_at,
        imdb_id: value.imdb_id,
        is_locked: value.is_locked,
        genres: value.genres,
        origin_country: value.origin_country,
        imdb_rating: value.imdb_rating,
        tmdb_status: value.tmdb_status,
        interest_level: value.interest_level,
        episode_runtime: value.episode_runtime,
        media_type: value.media_type,
        content_tags: value.content_tags,
        tmdb_media_kind: value.tmdb_media_kind,
        tmdb_id: value.tmdb_id,
        tmdb_parent_id: value.tmdb_parent_id,
        tmdb_season_number: value.tmdb_season_number,
        series_record_kind: value.series_record_kind,
        rev: value.rev,
        rev_actor: value.rev_actor,
    }
}

fn collection(value: crate::collections::Collection) -> LocalCollectionV1 {
    LocalCollectionV1 {
        id: value.id,
        name: value.name,
        normalized_name: value.normalized_name,
        description: value.description,
        source_kind: value.source_kind,
        source_key: value.source_key,
        collection_kind: value.collection_kind,
        order_mode: value.order_mode,
        created_at: value.created_at,
        updated_at: value.updated_at,
        rev: value.rev,
        rev_actor: value.rev_actor,
    }
}

fn member(value: crate::collections::CollectionMember) -> LocalCollectionMemberV1 {
    LocalCollectionMemberV1 {
        id: value.id,
        collection_id: value.collection_id,
        record_id: value.record_id,
        position: value.position,
        source_kind: value.source_kind,
        created_at: value.created_at,
        updated_at: value.updated_at,
        rev: value.rev,
        rev_actor: value.rev_actor,
    }
}

fn episode(value: crate::episode_history::EpisodeCompletion) -> LocalEpisodeCompletionV1 {
    LocalEpisodeCompletionV1 {
        id: value.id,
        record_id: value.record_id,
        episode_number: value.episode_number,
        completed_at: value.completed_at,
        created_at: value.created_at,
        updated_at: value.updated_at,
        rev: value.rev,
        rev_actor: value.rev_actor,
    }
}

/// Reads only the four frozen bootstrap entity classes from one SQLite view.
pub fn capture_production_legacy_snapshot_v1(
    conn: &Connection,
) -> Result<(i64, CapturedLegacySnapshotV1)> {
    let mut entries = Vec::new();
    for value in crate::db::get_all_records(conn).map_err(|_| ADMISSION_FAILURE)? {
        entries.push(LegacySnapshotEntryV1 {
            entity_type: "record".to_string(),
            value: serde_json::to_value(record(value)).map_err(|_| ADMISSION_FAILURE)?,
        });
    }
    for value in crate::episode_history::all_completions(conn).map_err(|_| ADMISSION_FAILURE)? {
        entries.push(LegacySnapshotEntryV1 {
            entity_type: "episode-completion".to_string(),
            value: serde_json::to_value(episode(value)).map_err(|_| ADMISSION_FAILURE)?,
        });
    }
    for value in crate::collections::all(conn).map_err(|_| ADMISSION_FAILURE)? {
        entries.push(LegacySnapshotEntryV1 {
            entity_type: "collection".to_string(),
            value: serde_json::to_value(collection(value)).map_err(|_| ADMISSION_FAILURE)?,
        });
    }
    for value in crate::collections::all_members(conn).map_err(|_| ADMISSION_FAILURE)? {
        entries.push(LegacySnapshotEntryV1 {
            entity_type: "collection-member".to_string(),
            value: serde_json::to_value(member(value)).map_err(|_| ADMISSION_FAILURE)?,
        });
    }
    let generation =
        crate::db_atomic_helpers::get_records_generation(conn).map_err(|_| ADMISSION_FAILURE)?;
    let snapshot = capture_legacy_snapshot_v1(&entries, &ProductionLegacySemanticAdapterV1)?;
    Ok((generation, snapshot))
}

/// Admits a migration against the current active target and captures the
/// immutable production snapshot. The store revalidates the active/bound
/// identity in its single `BEGIN IMMEDIATE` transaction before capture.
pub fn admit_and_capture_migration_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
    migration_id: &str,
    migration_writer_id: &str,
    created_at: &str,
) -> Result<MigrationAdmissionResultV1> {
    // A durable historical binding is sufficient only for re-attaching to an
    // already-owned guard; the store still requires a current active binding
    // before it can perform a fresh capture.
    let binding = load_historical_target_root_binding_v1(conn, target_id, target_epoch)?
        .map_or_else(
            || {
                resolve_active_target_root_binding_v1(conn, target_id, target_epoch)
                    .map(|bound| bound.binding)
            },
            Ok,
        )?;
    let root_id = binding.physical_root_id.clone();
    let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    store.admit_and_capture_migration_v1(
        &MigrationAdmissionInputV1 {
            target_binding: binding,
            migration_id: migration_id.to_string(),
            migration_writer_id: migration_writer_id.to_string(),
            created_at: created_at.to_string(),
        },
        capture_production_legacy_snapshot_v1,
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;
    use crate::db_atomic_helpers::set_setting_tx;
    use crate::s2_lite::durable_persistence::LegacyS1PublishAdmissionV1;
    use crate::s2_lite::migration_orchestration::MigrationStateStoreV1;
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry, REGISTRY_KEY};
    use serde_json::json;

    const CREATED: &str = "2026-09-20T00:00:00.000Z";
    const MIGRATION: &str = "80000000-0000-4000-8000-000000000001";
    const WRITER: &str = "81000000-0000-4000-8000-000000000001";

    fn connection() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        Mutex::new(conn)
    }

    fn activate(conn: &Mutex<Connection>, url: &str, username: &str, epoch: u64) -> String {
        let normalized_url = sync_targets::normalize_url(url).unwrap();
        let id = sync_targets::target_id(&normalized_url, username);
        let target = SyncTarget {
            id: id.clone(),
            normalized_url,
            username: username.to_string(),
            created_at: CREATED.to_string(),
            last_activated_at: CREATED.to_string(),
        };
        let guard = conn.lock().unwrap();
        set_setting_tx(
            &guard,
            REGISTRY_KEY,
            &serde_json::to_string(&SyncTargetRegistry {
                version: 1,
                active_target_id: Some(id.clone()),
                target_epoch: epoch,
                targets: vec![target],
            })
            .unwrap(),
        )
        .unwrap();
        id
    }

    fn record_value() -> LocalRecordV1 {
        LocalRecordV1 {
            id: "record-1".into(),
            original_name: "Original".into(),
            chinese_name: "".into(),
            progress: "".into(),
            total_episodes: Some(1),
            episode_tracking_enabled: false,
            next_episode: None,
            movie_progress: None,
            movie_duration: None,
            release_year: None,
            poster_path: None,
            status: "未看".into(),
            platform: "".into(),
            rating: None,
            start_date: None,
            end_date: None,
            notes: "".into(),
            created_at: CREATED.into(),
            updated_at: None,
            imdb_id: None,
            is_locked: None,
            genres: None,
            origin_country: None,
            imdb_rating: None,
            tmdb_status: None,
            interest_level: None,
            episode_runtime: None,
            media_type: "剧集".into(),
            content_tags: None,
            tmdb_media_kind: None,
            tmdb_id: None,
            tmdb_parent_id: None,
            tmdb_season_number: None,
            series_record_kind: None,
            rev: 0,
            rev_actor: "".into(),
        }
    }

    fn deterministic_id(domain: &str, values: &[&str]) -> String {
        let mut bytes = domain.as_bytes().to_vec();
        for value in values {
            bytes.push(0);
            bytes.extend_from_slice(value.as_bytes());
        }
        super::super::canonical::sha256_hex(&bytes)
    }

    #[test]
    fn production_adapter_maps_each_frozen_entity_deterministically() {
        let adapter = ProductionLegacySemanticAdapterV1;
        let episode_id = deterministic_id("episode-completion:v1", &["record-1", "1"]);
        let member_id = deterministic_id("collection-member:v1", &["collection-1", "record-1"]);
        let entries = [
            ("record", serde_json::to_value(record_value()).unwrap()),
            (
                "episode-completion",
                json!({"id":episode_id, "recordId":"record-1", "episodeNumber":1, "completedAt":null, "createdAt":CREATED, "updatedAt":CREATED, "rev":0, "revActor":""}),
            ),
            (
                "collection",
                json!({"id":"collection-1", "name":"Collection", "normalizedName":"collection", "description":null, "sourceKind":"manual", "sourceKey":null, "collectionKind":"manual", "orderMode":"manual", "createdAt":CREATED, "updatedAt":CREATED, "rev":0, "revActor":""}),
            ),
            (
                "collection-member",
                json!({"id":member_id, "collectionId":"collection-1", "recordId":"record-1", "position":0, "sourceKind":"manual", "createdAt":CREATED, "updatedAt":CREATED, "rev":0, "revActor":""}),
            ),
        ];
        let first = entries
            .iter()
            .map(|(kind, value)| adapter.adapt_live_entity(kind, value).unwrap())
            .collect::<Vec<_>>();
        let second = entries
            .iter()
            .rev()
            .map(|(kind, value)| adapter.adapt_live_entity(kind, value).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(first[0].entity_key, json!(["record", "record-1"]));
        assert_eq!(
            first[1].entity_key,
            json!(["episode-completion", "record-1", 1])
        );
        assert_eq!(first[2].entity_key, json!(["collection", "collection-1"]));
        assert_eq!(
            first[3].entity_key,
            json!(["collection-member", "collection-1", "record-1"])
        );
        assert_eq!(first[0].value, second[3].value);
    }

    #[test]
    fn admission_captures_once_guards_source_and_never_initializes_ordinary_writer() {
        let conn = connection();
        let id = activate(&conn, "https://example.test/dav", "alice", 1);
        {
            let guard = conn.lock().unwrap();
            crate::db::insert_record(
                &guard,
                crate::models::WatchRecord {
                    id: "record-1".into(),
                    original_name: "Original".into(),
                    chinese_name: "".into(),
                    progress: "".into(),
                    total_episodes: Some(1),
                    episode_tracking_enabled: false,
                    next_episode: None,
                    movie_progress: None,
                    movie_duration: None,
                    release_year: None,
                    poster_path: None,
                    status: crate::models::RecordStatus::Unwatched,
                    platform: "".into(),
                    rating: None,
                    start_date: None,
                    end_date: None,
                    notes: "".into(),
                    created_at: CREATED.into(),
                    updated_at: None,
                    imdb_id: None,
                    is_locked: None,
                    genres: None,
                    origin_country: None,
                    imdb_rating: None,
                    tmdb_status: None,
                    interest_level: None,
                    episode_runtime: None,
                    media_type: "剧集".into(),
                    content_tags: None,
                    tmdb_media_kind: None,
                    tmdb_id: None,
                    tmdb_parent_id: None,
                    tmdb_season_number: None,
                    series_record_kind: None,
                    rev: 0,
                    rev_actor: "".into(),
                },
            )
            .unwrap();
        }
        let admitted =
            admit_and_capture_migration_v1(&conn, &id, 1, MIGRATION, WRITER, CREATED).unwrap();
        assert!(!admitted.attached_existing);
        assert_eq!(admitted.execution_binding.captured_records_generation, 0);
        assert_eq!(
            admitted.state.snapshot.as_ref().unwrap().legacy_fingerprint,
            admitted
                .execution_binding
                .legacy_fingerprint
                .clone()
                .unwrap()
        );
        assert_eq!(
            admitted.state.status,
            super::super::migration_orchestration::MigrationStatusV1::BootstrapPlanned
        );
        let root = admitted.execution_binding.physical_root_id.clone();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        assert!(store.load_desktop_root_state().unwrap().is_none());
        assert!(store.migration_source_protected_v1().unwrap());
        assert_eq!(
            store
                .run_legacy_s1_publish_exclusive(&root, || Ok(()))
                .unwrap(),
            LegacyS1PublishAdmissionV1::RejectedMigrationSourceProtected
        );
        assert!(conn
            .lock()
            .unwrap()
            .execute("UPDATE records SET notes='blocked' WHERE id='record-1'", [])
            .is_err());
        let guard = conn.lock().unwrap();
        for statement in [
            "INSERT INTO episode_completions(id,recordId,episodeNumber,completedAt,createdAt,updatedAt,rev,revActor) VALUES('x','record-1',1,NULL,'2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z',0,'')",
            "INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,collectionKind,orderMode,createdAt,updatedAt,rev,revActor) VALUES('x','X','x',NULL,'manual',NULL,'manual','manual','2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z',0,'')",
            "INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES('x','x','record-1',0,'manual','2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z',0,'')",
        ] {
            assert!(guard.execute(statement, []).is_err());
        }
        drop(guard);
        let attached =
            admit_and_capture_migration_v1(&conn, &id, 1, MIGRATION, WRITER, CREATED).unwrap();
        assert!(attached.attached_existing);
        assert_eq!(attached.execution_binding, admitted.execution_binding);
    }

    #[test]
    fn failed_capture_rolls_back_all_migration_facts() {
        let conn = connection();
        let id = activate(&conn, "https://example.test/dav", "alice", 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &id, 1).unwrap();
        let root_id = bound.binding.physical_root_id.clone();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root_id).unwrap();
        assert!(store
            .admit_and_capture_migration_v1(
                &MigrationAdmissionInputV1 {
                    target_binding: bound.binding,
                    migration_id: MIGRATION.into(),
                    migration_writer_id: WRITER.into(),
                    created_at: CREATED.into(),
                },
                |_| Err(ProtocolError("INJECTED_CAPTURE_FAILURE"))
            )
            .is_err());
        assert!(store
            .load_migration_execution_binding_v1()
            .unwrap()
            .is_none());
        assert!(store.load(&root_id).unwrap().is_none());
        assert!(!store.migration_source_protected_v1().unwrap());
    }

    #[test]
    fn historical_binding_and_fingerprint_survive_an_active_target_switch() {
        let conn = connection();
        let target_a = activate(&conn, "https://example.test/a", "alice", 1);
        let admitted =
            admit_and_capture_migration_v1(&conn, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();
        let target_b = activate(&conn, "https://example.test/b", "bob", 2);
        assert_ne!(target_a, target_b);
        let mut historical =
            SqliteS2LiteStoreV1::open(&conn, &admitted.execution_binding.physical_root_id).unwrap();
        let reloaded = historical
            .load_migration_execution_binding_v1()
            .unwrap()
            .unwrap();
        assert_eq!(reloaded.target_id, target_a);
        assert_eq!(reloaded.target_epoch, 1);
        assert_eq!(
            reloaded.physical_root_id,
            admitted.execution_binding.physical_root_id
        );
        assert_eq!(
            reloaded.legacy_fingerprint,
            admitted.execution_binding.legacy_fingerprint
        );
        assert_eq!(
            reloaded.captured_records_generation,
            admitted.execution_binding.captured_records_generation
        );
    }

    #[test]
    fn source_guard_is_database_wide_but_exact_historical_owner_can_resume() {
        let conn = connection();
        let target_a = activate(&conn, "https://example.test/a", "alice", 1);
        let admitted =
            admit_and_capture_migration_v1(&conn, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();
        let target_b = activate(&conn, "https://example.test/b", "bob", 2);
        let bound_b = resolve_active_target_root_binding_v1(&conn, &target_b, 2).unwrap();
        let root_b = bound_b.binding.physical_root_id;
        let mut store_b = SqliteS2LiteStoreV1::open(&conn, &root_b).unwrap();
        let mut puts = 0;
        assert_eq!(
            store_b
                .run_legacy_s1_publish_exclusive(&root_b, || {
                    puts += 1;
                    Ok(())
                })
                .unwrap(),
            LegacyS1PublishAdmissionV1::RejectedMigrationSourceProtected
        );
        assert_eq!(puts, 0);
        assert!(admit_and_capture_migration_v1(
            &conn,
            &target_b,
            2,
            "80000000-0000-4000-8000-000000000002",
            WRITER,
            CREATED,
        )
        .is_err());
        assert!(store_b
            .load_migration_execution_binding_v1()
            .unwrap()
            .is_none());
        assert!(store_b.load(&root_b).unwrap().is_none());

        let resumed =
            admit_and_capture_migration_v1(&conn, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();
        assert!(resumed.attached_existing);
        assert_eq!(resumed.execution_binding, admitted.execution_binding);
    }

    #[test]
    fn second_connection_cannot_bypass_database_wide_source_owner() {
        let path = std::env::temp_dir().join(format!(
            "watchtracker-migration-source-owner-{}.db",
            uuid::Uuid::new_v4()
        ));
        let connection_a = Connection::open(&path).unwrap();
        connection_a
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        crate::db::setup_db(&connection_a).unwrap();
        let connection_a = Mutex::new(connection_a);
        let target_a = activate(&connection_a, "https://example.test/a", "alice", 1);
        let admitted =
            admit_and_capture_migration_v1(&connection_a, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();

        let connection_b = Connection::open(&path).unwrap();
        connection_b
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        let connection_b = Mutex::new(connection_b);
        let target_b = activate(&connection_b, "https://example.test/b", "bob", 2);
        let bound_b = resolve_active_target_root_binding_v1(&connection_b, &target_b, 2).unwrap();
        let root_b = bound_b.binding.physical_root_id;
        let mut store_b = SqliteS2LiteStoreV1::open(&connection_b, &root_b).unwrap();
        let mut puts = 0;
        assert_eq!(
            store_b
                .run_legacy_s1_publish_exclusive(&root_b, || {
                    puts += 1;
                    Ok(())
                })
                .unwrap(),
            LegacyS1PublishAdmissionV1::RejectedMigrationSourceProtected
        );
        assert_eq!(puts, 0);
        assert!(admit_and_capture_migration_v1(
            &connection_b,
            &target_b,
            2,
            "80000000-0000-4000-8000-000000000002",
            WRITER,
            CREATED,
        )
        .is_err());
        assert!(store_b
            .load_migration_execution_binding_v1()
            .unwrap()
            .is_none());
        let resumed =
            admit_and_capture_migration_v1(&connection_b, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();
        assert!(resumed.attached_existing);
        assert_eq!(resumed.execution_binding, admitted.execution_binding);

        drop(connection_b);
        drop(connection_a);
        for file in [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            let _ = fs::remove_file(file);
        }
    }

    fn assert_source_authority_corruption_fails_closed(statements: &[&str]) {
        const ROOT_A: &str = "root://migration-source-corruption-a";
        const ROOT_B: &str = "root://migration-source-corruption-b";
        let conn = connection();
        let store_a = SqliteS2LiteStoreV1::open(&conn, ROOT_A).unwrap();
        // Both roots must exist so a mismatch cannot be mistaken for a missing
        // root-authority row.
        SqliteS2LiteStoreV1::open(&conn, ROOT_B).unwrap();
        let guard = conn.lock().unwrap();
        guard.pragma_update(None, "foreign_keys", "OFF").unwrap();
        guard
            .pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        for statement in statements {
            guard.execute_batch(statement).unwrap();
        }
        drop(guard);

        assert!(store_a.migration_source_protected_v1().is_err());
        assert!(SqliteS2LiteStoreV1::open(&conn, ROOT_A).is_err());
    }

    #[test]
    fn malformed_source_owner_guard_pairs_fail_closed_without_repair() {
        const ROOT_A: &str = "root://migration-source-corruption-a";
        const ROOT_B: &str = "root://migration-source-corruption-b";
        const MIGRATION_B: &str = "80000000-0000-4000-8000-000000000002";

        for statements in [
            vec![format!(
                "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(1, '{ROOT_A}', '{MIGRATION}')"
            )],
            vec![format!(
                "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
            )],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(1, '{ROOT_B}', '{MIGRATION}')"
                ),
            ],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(1, '{ROOT_A}', '{MIGRATION_B}')"
                ),
            ],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(2, '{ROOT_A}', '{MIGRATION}')"
                ),
            ],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(1, '{ROOT_A}', '{MIGRATION}')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(2, '{ROOT_B}', '{MIGRATION_B}')"
                ),
            ],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '0')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_B}', '{MIGRATION_B}', '0')"
                ),
            ],
            vec![
                format!(
                    "INSERT INTO s2_lite_migration_source_guard_v1(root_id, migration_id, captured_records_generation) VALUES('{ROOT_A}', '{MIGRATION}', '01')"
                ),
                format!(
                    "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id) VALUES(1, '{ROOT_A}', '{MIGRATION}')"
                ),
            ],
        ] {
            let statements = statements.iter().map(String::as_str).collect::<Vec<_>>();
            assert_source_authority_corruption_fails_closed(&statements);
        }
    }

    #[test]
    fn orphan_source_authority_denies_all_production_paths_without_network() {
        for orphan_owner in [true, false] {
            let conn = connection();
            let target = activate(
                &conn,
                "https://example.test/migration-source-corruption",
                "alice",
                1,
            );
            let bound = resolve_active_target_root_binding_v1(&conn, &target, 1).unwrap();
            let root = bound.binding.physical_root_id;
            let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
            {
                let guard = conn.lock().unwrap();
                guard.pragma_update(None, "foreign_keys", "OFF").unwrap();
                if orphan_owner {
                    guard.execute(
                        "INSERT INTO s2_lite_migration_source_owner_v1(owner_key, root_id, migration_id)
                         VALUES(1, ?1, ?2)",
                        [&root, MIGRATION],
                    )
                } else {
                    guard.execute(
                        "INSERT INTO s2_lite_migration_source_guard_v1(
                             root_id, migration_id, captured_records_generation
                         ) VALUES(?1, ?2, '0')",
                        [&root, MIGRATION],
                    )
                }
                .unwrap();
            }

            let mut puts = 0;
            assert!(store
                .run_legacy_s1_publish_exclusive(&root, || {
                    puts += 1;
                    Ok(())
                })
                .is_err());
            assert_eq!(puts, 0);
            assert!(
                admit_and_capture_migration_v1(&conn, &target, 1, MIGRATION, WRITER, CREATED)
                    .is_err()
            );
            assert!(conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO records(
                    id, originalName, chineseName, progress, totalEpisodes,
                    episodeTrackingEnabled, status, platform, createdAt, rev, revActor, mediaType
                 ) VALUES(
                    'blocked', 'Blocked', '', '', 1, 0, '未看', '',
                    '2026-09-20T00:00:00.000Z', 0, '', '剧集'
                 )",
                    [],
                )
                .is_err());
        }
    }
}
