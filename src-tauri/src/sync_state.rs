use crate::app_paths::AppPaths;
use crate::db;
use crate::db_atomic_helpers::{
    acknowledge_sync_outbox, get_records_generation, get_setting_tx, get_sync_outbox,
    get_tombstones_tx, mark_local_records_mutated, mark_records_mutated, set_setting_tx,
    set_sync_outbox, set_tombstones_tx, SyncOutbox, Tombstone,
};
use crate::error::AppError;
use crate::models::WatchRecord;
use crate::record_validation::prepare_import_batch;
use crate::recovery_points;
use crate::sync_staging::{SyncPublishIntent, SyncStaging};
use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

const DEVICE_ID_KEY: &str = "sync_device_id_v1";
const BASELINE_KEY: &str = "sync_v3_baseline";
const ETAG_KEY: &str = "sync_v3_remote_etag";
const CONFLICTS_KEY: &str = "sync_v3_conflicts";
const LAST_COMMIT_KEY: &str = "sync_v3_last_commit";
const V2_FINGERPRINT_KEY: &str = "sync_v2_source_fingerprint";
const SCHEDULER_KEY: &str = "sync_scheduler_v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSchedulerState {
    pub version: u8,
    pub paused: bool,
    pub consecutive_failures: u32,
    pub next_attempt_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error_code: Option<String>,
    pub last_remote_check_at: Option<String>,
}

impl Default for SyncSchedulerState {
    fn default() -> Self {
        Self {
            version: 1,
            paused: false,
            consecutive_failures: 0,
            next_attempt_at: None,
            last_attempt_at: None,
            last_success_at: None,
            last_error_code: None,
            last_remote_check_at: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRuntimeState {
    pub outbox: SyncOutbox,
    pub scheduler: SyncSchedulerState,
    pub conflict_count: usize,
    pub last_commit: Option<Value>,
    pub staged_count: usize,
    pub publish_pending: bool,
}

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
    pub outbox: SyncOutbox,
    pub scheduler: SyncSchedulerState,
    pub staging: SyncStaging,
    pub publish_intent: Option<SyncPublishIntent>,
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
    #[serde(default)]
    pub acknowledge_outbox: bool,
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

fn scheduler_state(conn: &Connection) -> Result<SyncSchedulerState, AppError> {
    let Some(raw) = get_setting_tx(conn, SCHEDULER_KEY)? else {
        return Ok(SyncSchedulerState::default());
    };
    let state: SyncSchedulerState = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {SCHEDULER_KEY}: {error}")))?;
    if state.version != 1 {
        return Err(AppError::General(format!(
            "Invalid {SCHEDULER_KEY} version"
        )));
    }
    Ok(state)
}

fn set_scheduler_state(conn: &Connection, state: &SyncSchedulerState) -> Result<(), AppError> {
    let raw = serde_json::to_string(state).map_err(|error| {
        AppError::General(format!("Could not serialize sync scheduler: {error}"))
    })?;
    set_setting_tx(conn, SCHEDULER_KEY, &raw)?;
    Ok(())
}

fn state_without_conflicts(value: &Value, conflicts: &[Value]) -> Value {
    let conflict_ids = conflicts
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    let mut items = value.as_array().cloned().unwrap_or_default();
    items.retain(|item| {
        item.get("id")
            .and_then(Value::as_str)
            .map_or(true, |id| !conflict_ids.contains(id))
    });
    items.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    Value::Array(items)
}

fn initialize_outbox(
    conn: &Connection,
    generation: i64,
    records: &[WatchRecord],
    tombstones: &[Tombstone],
    baseline: Option<&Value>,
    conflicts: &[Value],
) -> Result<SyncOutbox, AppError> {
    if let Some(outbox) = get_sync_outbox(conn)? {
        return Ok(outbox);
    }
    let mut outbox = SyncOutbox::clean(generation);
    if let Some(baseline) = baseline {
        let local_records = state_without_conflicts(
            &serde_json::to_value(records).map_err(|error| {
                AppError::General(format!("Could not serialize local sync records: {error}"))
            })?,
            conflicts,
        );
        let local_tombstones = state_without_conflicts(
            &serde_json::to_value(tombstones).map_err(|error| {
                AppError::General(format!("Could not serialize local tombstones: {error}"))
            })?,
            conflicts,
        );
        let remote_records = state_without_conflicts(
            baseline.get("records").unwrap_or(&Value::Array(Vec::new())),
            conflicts,
        );
        let remote_tombstones = state_without_conflicts(
            baseline
                .get("tombstones")
                .unwrap_or(&Value::Array(Vec::new())),
            conflicts,
        );
        if local_records != remote_records || local_tombstones != remote_tombstones {
            let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            outbox.pending = true;
            outbox.reasons.push("upgrade-bootstrap".to_string());
            outbox.first_queued_at = Some(now.clone());
            outbox.last_queued_at = Some(now);
        }
    }
    set_sync_outbox(conn, &outbox)?;
    Ok(outbox)
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
    let records = db::get_all_records(conn)?;
    let tombstones = get_tombstones_tx(conn)?;
    let records_generation = get_records_generation(conn)?;
    let baseline = parse_optional_json(get_setting_tx(conn, BASELINE_KEY)?, BASELINE_KEY)?;
    let outbox = initialize_outbox(
        conn,
        records_generation,
        &records,
        &tombstones,
        baseline.as_ref(),
        &conflicts,
    )?;
    Ok(SyncSnapshot {
        records,
        tombstones,
        records_generation,
        baseline,
        device_id: device_id(conn)?,
        conflicts,
        remote_etag: get_setting_tx(conn, ETAG_KEY)?,
        last_commit: parse_optional_json(get_setting_tx(conn, LAST_COMMIT_KEY)?, LAST_COMMIT_KEY)?,
        v2_source_fingerprint: get_setting_tx(conn, V2_FINGERPRINT_KEY)?,
        outbox,
        scheduler: scheduler_state(conn)?,
        staging: crate::sync_staging::get_staging(conn)?,
        publish_intent: crate::sync_staging::get_publish_intent(conn)?,
    })
}

pub fn runtime_state(conn: &Connection) -> Result<SyncRuntimeState, AppError> {
    let Some(outbox) = get_sync_outbox(conn)? else {
        let state = snapshot(conn)?;
        return Ok(SyncRuntimeState {
            outbox: state.outbox,
            scheduler: state.scheduler,
            conflict_count: state.conflicts.len(),
            last_commit: state.last_commit,
            staged_count: state.staging.entries.len(),
            publish_pending: state.publish_intent.is_some(),
        });
    };
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
    Ok(SyncRuntimeState {
        outbox,
        scheduler: scheduler_state(conn)?,
        conflict_count: conflicts.len(),
        last_commit: parse_optional_json(get_setting_tx(conn, LAST_COMMIT_KEY)?, LAST_COMMIT_KEY)?,
        staged_count: crate::sync_staging::get_staging(conn)?.entries.len(),
        publish_pending: crate::sync_staging::get_publish_intent(conn)?.is_some(),
    })
}

pub fn prepare_publish_intent(
    conn: &Connection,
    input: crate::sync_staging::PreparePublishIntentInput,
) -> Result<SyncPublishIntent, AppError> {
    let generation = get_records_generation(conn)?;
    crate::sync_staging::prepare_publish_intent(conn, generation, input)
}

pub fn set_paused(conn: &Connection, paused: bool) -> Result<SyncRuntimeState, AppError> {
    let mut scheduler = scheduler_state(conn)?;
    scheduler.paused = paused;
    if !paused {
        scheduler.next_attempt_at = None;
    }
    set_scheduler_state(conn, &scheduler)?;
    runtime_state(conn)
}

pub fn record_failure(
    conn: &Connection,
    code: &str,
    next_attempt_at: Option<String>,
) -> Result<SyncRuntimeState, AppError> {
    let code = code.trim();
    if code.is_empty() || code.len() > 80 {
        return Err(AppError::General("Invalid sync error code".to_string()));
    }
    let mut scheduler = scheduler_state(conn)?;
    scheduler.consecutive_failures = scheduler.consecutive_failures.saturating_add(1);
    scheduler.last_attempt_at =
        Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    scheduler.last_error_code = Some(code.to_string());
    scheduler.next_attempt_at = next_attempt_at;
    set_scheduler_state(conn, &scheduler)?;
    runtime_state(conn)
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
    let existing_records = db::get_all_records(conn)?;
    let existing_tombstones = get_tombstones_tx(conn)?;
    let existing_by_id: BTreeMap<_, _> = existing_records
        .iter()
        .map(|record| (record.id.clone(), record))
        .collect();
    let incoming_by_id: BTreeMap<_, _> = records
        .iter()
        .map(|record| (record.id.clone(), record))
        .collect();
    let locked_ids: HashSet<_> = existing_records
        .iter()
        .filter(|record| record.is_locked.unwrap_or(false))
        .map(|record| record.id.clone())
        .collect();
    let mut upserts = Vec::new();
    for (id, incoming) in &incoming_by_id {
        if locked_ids.contains(id) {
            continue;
        }
        let changed = existing_by_id.get(id).map_or(true, |existing| {
            serde_json::to_value(*existing).ok() != serde_json::to_value(*incoming).ok()
        });
        if changed {
            upserts.push((*incoming).clone());
        }
    }
    let deletes: Vec<_> = existing_by_id
        .keys()
        .filter(|id| !locked_ids.contains(*id) && !incoming_by_id.contains_key(*id))
        .cloned()
        .collect();
    let tombstone_values = |items: &[Tombstone]| -> BTreeMap<String, Value> {
        items
            .iter()
            .filter_map(|item| {
                serde_json::to_value(item)
                    .ok()
                    .map(|value| (item.id.clone(), value))
            })
            .collect()
    };
    let tombstones_changed =
        tombstone_values(&existing_tombstones) != tombstone_values(&input.tombstones);
    let business_state_changed = !upserts.is_empty() || !deletes.is_empty() || tombstones_changed;
    let upsert_count = upserts.len();
    let delete_count = deletes.len();
    let unchanged_count = incoming_by_id.len().saturating_sub(upsert_count);
    let baseline = serde_json::to_string(&input.baseline).map_err(|error| {
        AppError::General(format!("Could not serialize sync baseline: {error}"))
    })?;
    let conflicts = serde_json::to_string(&input.conflicts).map_err(|error| {
        AppError::General(format!("Could not serialize sync conflicts: {error}"))
    })?;
    let last_commit = serde_json::to_string(&input.last_commit).map_err(|error| {
        AppError::General(format!("Could not serialize last sync commit: {error}"))
    })?;
    let committed_id = input
        .baseline
        .get("commitId")
        .and_then(Value::as_str)
        .map(str::to_string);

    if business_state_changed {
        recovery_points::create(conn, paths, "sync")?;
    }
    let transaction = conn.transaction()?;
    if get_records_generation(&transaction)? != input.expected_generation {
        return Err(AppError::General("stale_local_snapshot".to_string()));
    }
    if business_state_changed {
        for id in &deletes {
            transaction.execute(
                "DELETE FROM records WHERE id = ?1 AND (isLocked IS NULL OR isLocked = 0)",
                [id],
            )?;
        }
        for record in upserts {
            db::insert_record(&transaction, record)?;
        }
        if tombstones_changed {
            set_tombstones_tx(&transaction, &input.tombstones)?;
        }
        log::info!(
            "[Sync] Applied record delta: {} upserts, {} deletes, {} unchanged",
            upsert_count,
            delete_count,
            unchanged_count,
        );
    }
    set_setting_tx(&transaction, BASELINE_KEY, &baseline)?;
    set_setting_tx(&transaction, CONFLICTS_KEY, &conflicts)?;
    set_setting_tx(&transaction, ETAG_KEY, &input.remote_etag)?;
    set_setting_tx(&transaction, LAST_COMMIT_KEY, &last_commit)?;
    if let Some(fingerprint) = input.v2_source_fingerprint {
        set_setting_tx(&transaction, V2_FINGERPRINT_KEY, &fingerprint)?;
    }
    let generation = if business_state_changed {
        mark_records_mutated(&transaction)?
    } else {
        input.expected_generation
    };
    if input.acknowledge_outbox {
        if let Some(committed_id) = committed_id.as_deref() {
            crate::sync_staging::finish_publish(
                &transaction,
                committed_id,
                input.expected_generation,
            )?;
        } else if crate::sync_staging::get_publish_intent(&transaction)?.is_some() {
            return Err(AppError::General("Missing committed sync ID".to_string()));
        }
        acknowledge_sync_outbox(&transaction, input.expected_generation)?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut scheduler = scheduler_state(&transaction)?;
        scheduler.consecutive_failures = 0;
        scheduler.next_attempt_at = None;
        scheduler.last_attempt_at = Some(now.clone());
        scheduler.last_success_at = Some(now.clone());
        scheduler.last_remote_check_at = Some(now);
        scheduler.last_error_code = None;
        set_scheduler_state(&transaction, &scheduler)?;
    }
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
    let generation = mark_local_records_mutated(&transaction, "conflict-resolution")?;
    if let Some(record) = db::get_record(&transaction, id)? {
        crate::sync_staging::stage_upsert(&transaction, &record, generation)?;
    } else {
        crate::sync_staging::stage_delete(&transaction, id, generation)?;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::db;
    use crate::db_atomic_crud::insert_record_atomic;
    use crate::db_atomic_helpers::set_setting_tx;
    use crate::sync_staging::{get_publish_intent, get_staging, PreparePublishIntentInput};
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
                acknowledge_outbox: true,
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
    fn clean_remote_check_does_not_advance_generation_or_create_another_recovery_point() {
        let mut test = TestDatabase::new("clean-check");
        let first_input = test.input(0);
        commit(&mut test.conn, &test.paths, first_input).unwrap();
        let backups_before = fs::read_dir(test.paths.backups())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("db"))
            .count();
        let input = test.input(1);
        let result = commit(&mut test.conn, &test.paths, input).unwrap();
        assert_eq!(result.records_generation, 1);
        assert_eq!(
            fs::read_dir(test.paths.backups())
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("db")
                )
                .count(),
            backups_before
        );
    }

    #[test]
    fn publish_intent_survives_until_matching_commit_and_clears_captured_staging() {
        let mut test = TestDatabase::new("publish-intent");
        let staged = insert_record_atomic(
            &mut test.conn,
            TestDatabase::record("staged"),
            "fixture-device",
        )
        .unwrap();
        let intent = prepare_publish_intent(
            &test.conn,
            PreparePublishIntentInput {
                commit_id: "recoverable-commit".into(),
                previous_commit_id: Some("previous".into()),
                expected_generation: 1,
                payload_fingerprint: "payload-sha".into(),
            },
        )
        .unwrap();
        assert_eq!(intent.included_entries.len(), 1);
        assert!(get_publish_intent(&test.conn).unwrap().is_some());

        let mut input = test.input(1);
        input.records = vec![staged];
        input.baseline = serde_json::json!({
            "schemaVersion": 3,
            "commitId": "recoverable-commit",
            "records": input.records.clone(),
            "tombstones": []
        });
        input.last_commit = serde_json::json!({"commitId": "recoverable-commit"});
        commit(&mut test.conn, &test.paths, input).unwrap();

        assert!(get_publish_intent(&test.conn).unwrap().is_none());
        assert!(get_staging(&test.conn).unwrap().entries.is_empty());
    }

    #[test]
    fn newer_confirmed_remote_commit_supersedes_an_uncertain_publish_intent() {
        let mut test = TestDatabase::new("superseded-publish-intent");
        let staged = insert_record_atomic(
            &mut test.conn,
            TestDatabase::record("staged"),
            "fixture-device",
        )
        .unwrap();
        prepare_publish_intent(
            &test.conn,
            PreparePublishIntentInput {
                commit_id: "uncertain-commit".into(),
                previous_commit_id: Some("previous".into()),
                expected_generation: 1,
                payload_fingerprint: "payload-sha".into(),
            },
        )
        .unwrap();

        let mut input = test.input(1);
        input.records = vec![staged];
        input.baseline["commitId"] = serde_json::json!("newer-confirmed-commit");
        commit(&mut test.conn, &test.paths, input).unwrap();

        assert!(get_publish_intent(&test.conn).unwrap().is_none());
        assert!(get_staging(&test.conn).unwrap().entries.is_empty());
    }

    #[test]
    fn sync_record_comparison_is_independent_of_array_order() {
        let mut test = TestDatabase::new("record-order");
        let mut first = test.input(0);
        first.records = vec![TestDatabase::record("a"), TestDatabase::record("b")];
        commit(&mut test.conn, &test.paths, first).unwrap();
        let generation = get_records_generation(&test.conn).unwrap();

        let mut reordered = test.input(generation);
        reordered.records = vec![TestDatabase::record("b"), TestDatabase::record("a")];
        let result = commit(&mut test.conn, &test.paths, reordered).unwrap();

        assert_eq!(result.records_generation, generation);
    }

    #[test]
    fn stale_generation_rejects_every_change_without_creating_a_snapshot() {
        let mut test = TestDatabase::new("stale");
        mark_local_records_mutated(&test.conn, "record-update").unwrap();
        mark_local_records_mutated(&test.conn, "record-update").unwrap();
        let input = test.input(1);
        assert!(commit(&mut test.conn, &test.paths, input)
            .unwrap_err()
            .to_string()
            .contains("stale_local_snapshot"));
        assert!(db::get_all_records(&test.conn).unwrap().is_empty());
        let outbox = get_sync_outbox(&test.conn).unwrap().unwrap();
        assert!(outbox.pending);
        assert_eq!(outbox.dirty_generation, 2);
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

    #[test]
    fn successful_sync_acknowledges_only_the_captured_outbox_generation() {
        let mut test = TestDatabase::new("outbox-ack");
        mark_local_records_mutated(&test.conn, "record-update").unwrap();
        let input = test.input(1);
        let result = commit(&mut test.conn, &test.paths, input).unwrap();
        assert_eq!(result.records_generation, 2);
        let state = snapshot(&test.conn).unwrap();
        assert!(!state.outbox.pending);
        assert_eq!(state.outbox.dirty_generation, 2);
        assert!(state.scheduler.last_success_at.is_some());
        assert_eq!(state.scheduler.consecutive_failures, 0);
    }

    #[test]
    fn non_acknowledging_commit_preserves_pending_outbox() {
        let mut test = TestDatabase::new("outbox-preserve");
        mark_local_records_mutated(&test.conn, "record-update").unwrap();
        let mut input = test.input(1);
        input.acknowledge_outbox = false;
        commit(&mut test.conn, &test.paths, input).unwrap();
        let state = snapshot(&test.conn).unwrap();
        assert!(state.outbox.pending);
        assert_eq!(state.outbox.dirty_generation, 1);
        assert!(state.scheduler.last_success_at.is_none());
    }

    #[test]
    fn pause_and_failure_backoff_survive_runtime_state_reads() {
        let test = TestDatabase::new("scheduler");
        let paused = set_paused(&test.conn, true).unwrap();
        assert!(paused.scheduler.paused);
        let failed = record_failure(
            &test.conn,
            "http_503",
            Some("2026-08-02T12:15:00.000Z".to_string()),
        )
        .unwrap();
        assert!(failed.scheduler.paused);
        assert_eq!(failed.scheduler.consecutive_failures, 1);
        assert_eq!(
            failed.scheduler.last_error_code.as_deref(),
            Some("http_503")
        );
        assert_eq!(
            runtime_state(&test.conn)
                .unwrap()
                .scheduler
                .next_attempt_at
                .as_deref(),
            Some("2026-08-02T12:15:00.000Z")
        );
    }

    #[test]
    fn malformed_outbox_is_never_treated_as_clean() {
        let test = TestDatabase::new("bad-outbox");
        set_setting_tx(
            &test.conn,
            crate::db_atomic_helpers::SYNC_OUTBOX_KEY,
            "{bad",
        )
        .unwrap();
        assert!(snapshot(&test.conn)
            .unwrap_err()
            .to_string()
            .contains("Invalid sync_outbox_v1"));
    }
}
