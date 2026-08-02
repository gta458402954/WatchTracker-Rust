use crate::app_paths::AppPaths;
use crate::db;
use crate::db_atomic_helpers::{
    get_records_generation, get_setting_tx, get_tombstones_tx, mark_records_mutated,
    set_setting_tx, set_tombstones_tx, Tombstone,
};
use crate::error::AppError;
use crate::models::WatchRecord;
use crate::record_validation::prepare_import_batch;
use crate::recovery_points;
use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const DEVICE_ID_KEY: &str = "sync_device_id_v1";
const BASELINE_KEY: &str = "sync_v3_baseline";
const ETAG_KEY: &str = "sync_v3_remote_etag";
const CONFLICTS_KEY: &str = "sync_v3_conflicts";
const LAST_COMMIT_KEY: &str = "sync_v3_last_commit";
const V2_FINGERPRINT_KEY: &str = "sync_v2_source_fingerprint";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub records: Vec<WatchRecord>,
    pub tombstones: Vec<Tombstone>,
    pub records_generation: i64,
    pub baseline: Option<Value>,
    pub device_id: String,
    pub conflicts: Vec<Value>,
    pub remote_etag: Option<String>,
    pub last_commit: Option<Value>,
    pub v2_source_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCommitInput {
    pub expected_generation: i64,
    pub records: Vec<WatchRecord>,
    pub tombstones: Vec<Tombstone>,
    pub baseline: Value,
    #[serde(default)]
    pub conflicts: Vec<Value>,
    pub remote_etag: String,
    pub last_commit: Value,
    pub v2_source_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCommitResult {
    pub records_generation: i64,
    pub record_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncConflictResolution {
    Local,
    Remote,
    Keep,
    Delete,
}

fn parse_optional_json(raw: Option<String>, key: &str) -> Result<Option<Value>, AppError> {
    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|error| AppError::General(format!("Invalid {key}: {error}")))
    })
    .transpose()
}

pub(crate) fn device_id(conn: &Connection) -> Result<String, AppError> {
    if let Some(existing) = get_setting_tx(conn, DEVICE_ID_KEY)? {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let generated = Uuid::new_v4().to_string();
    set_setting_tx(conn, DEVICE_ID_KEY, &generated)?;
    Ok(generated)
}

pub fn snapshot(conn: &Connection) -> Result<SyncSnapshot, AppError> {
    let conflicts = match parse_optional_json(get_setting_tx(conn, CONFLICTS_KEY)?, CONFLICTS_KEY)?
    {
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(AppError::General(
                "Invalid sync_v3_conflicts: expected array".into(),
            ))
        }
        None => Vec::new(),
    };
    Ok(SyncSnapshot {
        records: db::get_all_records(conn)?,
        tombstones: get_tombstones_tx(conn)?,
        records_generation: get_records_generation(conn)?,
        baseline: parse_optional_json(get_setting_tx(conn, BASELINE_KEY)?, BASELINE_KEY)?,
        device_id: device_id(conn)?,
        conflicts,
        remote_etag: get_setting_tx(conn, ETAG_KEY)?,
        last_commit: parse_optional_json(get_setting_tx(conn, LAST_COMMIT_KEY)?, LAST_COMMIT_KEY)?,
        v2_source_fingerprint: get_setting_tx(conn, V2_FINGERPRINT_KEY)?,
    })
}

pub fn commit(
    conn: &mut Connection,
    paths: &AppPaths,
    input: SyncCommitInput,
) -> Result<SyncCommitResult, AppError> {
    if input.expected_generation < 0 || get_records_generation(conn)? != input.expected_generation {
        return Err(AppError::General("stale_local_snapshot".to_string()));
    }
    if input.remote_etag.trim().is_empty() {
        return Err(AppError::General("Missing remote ETag".to_string()));
    }
    let records = prepare_import_batch(input.records)?;
    let baseline = serde_json::to_string(&input.baseline).map_err(|error| {
        AppError::General(format!("Could not serialize sync baseline: {error}"))
    })?;
    let conflicts = serde_json::to_string(&input.conflicts).map_err(|error| {
        AppError::General(format!("Could not serialize sync conflicts: {error}"))
    })?;
    let last_commit = serde_json::to_string(&input.last_commit).map_err(|error| {
        AppError::General(format!("Could not serialize last sync commit: {error}"))
    })?;

    recovery_points::create(conn, paths, "sync")?;
    let transaction = conn.transaction()?;
    if get_records_generation(&transaction)? != input.expected_generation {
        return Err(AppError::General("stale_local_snapshot".to_string()));
    }
    db::replace_all_records_tx(&transaction, records)?;
    set_tombstones_tx(&transaction, &input.tombstones)?;
    set_setting_tx(&transaction, BASELINE_KEY, &baseline)?;
    set_setting_tx(&transaction, CONFLICTS_KEY, &conflicts)?;
    set_setting_tx(&transaction, ETAG_KEY, &input.remote_etag)?;
    set_setting_tx(&transaction, LAST_COMMIT_KEY, &last_commit)?;
    if let Some(fingerprint) = input.v2_source_fingerprint {
        set_setting_tx(&transaction, V2_FINGERPRINT_KEY, &fingerprint)?;
    }
    let generation = mark_records_mutated(&transaction)?;
    let record_count = db::get_all_records(&transaction)?.len();
    transaction.commit()?;
    Ok(SyncCommitResult {
        records_generation: generation,
        record_count,
    })
}

pub fn resolve_conflict(
    conn: &mut Connection,
    id: &str,
    resolution: SyncConflictResolution,
) -> Result<(), AppError> {
    let raw = get_setting_tx(conn, CONFLICTS_KEY)?.unwrap_or_else(|| "[]".to_string());
    let mut conflicts = serde_json::from_str::<Vec<Value>>(&raw)
        .map_err(|error| AppError::General(format!("Invalid {CONFLICTS_KEY}: {error}")))?;
    let position = conflicts
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::General(format!("Sync conflict not found: {id}")))?;
    let conflict = conflicts[position].clone();
    let local = conflict
        .get("local")
        .cloned()
        .filter(|value| !value.is_null());
    let remote = conflict
        .get("remote")
        .cloned()
        .filter(|value| !value.is_null());
    let selected = match resolution {
        SyncConflictResolution::Local => local,
        SyncConflictResolution::Remote => remote,
        SyncConflictResolution::Keep => local.or(remote),
        SyncConflictResolution::Delete => None,
    };
    let selected = selected
        .map(serde_json::from_value::<WatchRecord>)
        .transpose()
        .map_err(|error| AppError::General(format!("Invalid conflict record: {error}")))?
        .map(|record| prepare_import_batch(vec![record]))
        .transpose()?
        .and_then(|mut records| records.pop());

    let transaction = conn.transaction()?;
    let mut tombstones = get_tombstones_tx(&transaction)?;
    if let Some(record) = selected {
        db::insert_record(&transaction, record)?;
        tombstones.retain(|item| item.id != id);
    } else {
        transaction.execute("DELETE FROM records WHERE id = ?1", [id])?;
        tombstones.retain(|item| item.id != id);
        tombstones.push(Tombstone {
            id: id.to_string(),
            deleted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            rev: 0,
            rev_actor: device_id(&transaction)?,
        });
    }
    set_tombstones_tx(&transaction, &tombstones)?;
    conflicts.remove(position);
    set_setting_tx(
        &transaction,
        CONFLICTS_KEY,
        &serde_json::to_string(&conflicts).map_err(|error| {
            AppError::General(format!("Could not serialize conflicts: {error}"))
        })?,
    )?;
    mark_records_mutated(&transaction)?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::db;
    use crate::db_atomic_helpers::set_setting_tx;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDatabase {
        root: PathBuf,
        paths: AppPaths,
        conn: Connection,
    }

    impl TestDatabase {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "watchtracker-sync-state-{}-{name}-{id}",
                std::process::id()
            ));
            let paths = AppPaths::resolve_from(None, &root).unwrap();
            let conn = Connection::open(paths.database()).unwrap();
            db::setup_db(&conn).unwrap();
            Self { root, paths, conn }
        }

        fn record(id: &str) -> WatchRecord {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "originalName": "",
                "chineseName": id,
                "progress": "",
                "status": "未看",
                "platform": "",
                "startDate": "",
                "endDate": "",
                "notes": "",
                "createdAt": "2026-01-01T00:00:00Z",
                "mediaType": "电影",
                "rev": 1,
                "revActor": "fixture"
            }))
            .unwrap()
        }

        fn input(&self, expected_generation: i64) -> SyncCommitInput {
            SyncCommitInput {
                expected_generation,
                records: vec![Self::record("synced")],
                tombstones: vec![Tombstone {
                    id: "deleted".into(),
                    deleted_at: "2026-08-02T00:00:00Z".into(),
                    rev: 2,
                    rev_actor: "fixture".into(),
                }],
                baseline: serde_json::json!({"schemaVersion": 3, "records": []}),
                conflicts: vec![serde_json::json!({"id": "conflict"})],
                remote_etag: "\"etag-1\"".into(),
                last_commit: serde_json::json!({"commitId": "commit-1"}),
                v2_source_fingerprint: Some("legacy-sha".into()),
            }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn snapshot_creates_one_stable_device_id() {
        let test = TestDatabase::new("snapshot");
        let first = snapshot(&test.conn).unwrap();
        let second = snapshot(&test.conn).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.records_generation, 0);
        assert!(first.baseline.is_none());
    }

    #[test]
    fn commit_persists_records_and_all_sync_state_atomically() {
        let mut test = TestDatabase::new("commit");
        let input = test.input(0);
        let result = commit(&mut test.conn, &test.paths, input).unwrap();
        assert_eq!(result.records_generation, 1);
        assert_eq!(result.record_count, 1);
        let state = snapshot(&test.conn).unwrap();
        assert_eq!(state.records[0].id, "synced");
        assert_eq!(state.tombstones[0].id, "deleted");
        assert_eq!(state.remote_etag.as_deref(), Some("\"etag-1\""));
        assert_eq!(state.conflicts[0]["id"], "conflict");
        assert_eq!(state.v2_source_fingerprint.as_deref(), Some("legacy-sha"));
    }

    #[test]
    fn stale_generation_rejects_every_change_without_creating_a_snapshot() {
        let mut test = TestDatabase::new("stale");
        set_setting_tx(&test.conn, "records_generation", "2").unwrap();
        let input = test.input(1);
        assert!(commit(&mut test.conn, &test.paths, input)
            .unwrap_err()
            .to_string()
            .contains("stale_local_snapshot"));
        assert!(db::get_all_records(&test.conn).unwrap().is_empty());
        assert!(fs::read_dir(test.paths.backups()).unwrap().next().is_none());
    }

    #[test]
    fn commit_failure_rolls_back_records_and_all_sync_settings() {
        let mut test = TestDatabase::new("rollback");
        db::insert_record(&test.conn, TestDatabase::record("original")).unwrap();
        test.conn
            .execute_batch(
                "CREATE TRIGGER fail_sync_baseline BEFORE INSERT ON settings
             WHEN NEW.key = 'sync_v3_baseline'
             BEGIN SELECT RAISE(ABORT, 'injected sync state failure'); END;",
            )
            .unwrap();
        let input = test.input(0);
        assert!(commit(&mut test.conn, &test.paths, input).is_err());
        let records = db::get_all_records(&test.conn).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "original");
        assert_eq!(get_records_generation(&test.conn).unwrap(), 0);
        assert!(get_setting_tx(&test.conn, BASELINE_KEY).unwrap().is_none());
        assert_eq!(
            fs::read_dir(test.paths.backups())
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("db")
                )
                .count(),
            1,
        );
    }

    #[test]
    fn explicit_remote_conflict_choice_updates_record_and_unfreezes_id_atomically() {
        let mut test = TestDatabase::new("resolve");
        db::insert_record(&test.conn, TestDatabase::record("choice")).unwrap();
        let mut remote = TestDatabase::record("choice");
        remote.notes = "remote selected".to_string();
        set_setting_tx(
            &test.conn,
            CONFLICTS_KEY,
            &serde_json::json!([{
                "id": "choice",
                "kind": "edit-edit",
                "fields": ["notes"],
                "base": TestDatabase::record("choice"),
                "local": TestDatabase::record("choice"),
                "remote": remote,
                "localDeleted": false,
                "remoteDeleted": false,
                "detectedAt": "2026-08-02T00:00:00Z"
            }])
            .to_string(),
        )
        .unwrap();

        resolve_conflict(&mut test.conn, "choice", SyncConflictResolution::Remote).unwrap();
        assert_eq!(
            db::get_record(&test.conn, "choice").unwrap().unwrap().notes,
            "remote selected"
        );
        assert_eq!(
            get_setting_tx(&test.conn, CONFLICTS_KEY)
                .unwrap()
                .as_deref(),
            Some("[]")
        );
        assert_eq!(get_records_generation(&test.conn).unwrap(), 1);
    }

    #[test]
    fn explicit_delete_conflict_choice_creates_a_versioned_tombstone() {
        let mut test = TestDatabase::new("resolve-delete");
        let current = TestDatabase::record("delete-choice");
        db::insert_record(&test.conn, current.clone()).unwrap();
        set_setting_tx(
            &test.conn,
            CONFLICTS_KEY,
            &serde_json::json!([{
                "id": "delete-choice",
                "kind": "delete-edit",
                "fields": [],
                "base": current,
                "local": TestDatabase::record("delete-choice"),
                "remote": null,
                "localDeleted": false,
                "remoteDeleted": true,
                "detectedAt": "2026-08-02T00:00:00Z"
            }])
            .to_string(),
        )
        .unwrap();

        resolve_conflict(
            &mut test.conn,
            "delete-choice",
            SyncConflictResolution::Delete,
        )
        .unwrap();
        assert!(db::get_record(&test.conn, "delete-choice")
            .unwrap()
            .is_none());
        let tombstones = get_tombstones_tx(&test.conn).unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].id, "delete-choice");
        assert!(!tombstones[0].rev_actor.is_empty());
    }
}
