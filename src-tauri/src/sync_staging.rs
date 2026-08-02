use crate::db;
use crate::db_atomic_helpers::{get_setting_tx, set_setting_tx};
use crate::error::AppError;
use crate::models::WatchRecord;
use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const STAGING_KEY: &str = "sync_staging_v1";
pub const PUBLISH_INTENT_KEY: &str = "sync_publish_intent_v1";
const BASELINE_KEY: &str = "sync_v3_baseline";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedRecord {
    pub id: String,
    pub operation: String,
    pub base: Option<Value>,
    pub local: Option<Value>,
    pub first_generation: i64,
    pub last_generation: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncStaging {
    pub version: u8,
    #[serde(default)]
    pub entries: Vec<StagedRecord>,
}

impl Default for SyncStaging {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishIntentEntry {
    pub id: String,
    pub last_generation: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncPublishIntent {
    pub version: u8,
    pub commit_id: String,
    pub previous_commit_id: Option<String>,
    pub expected_generation: i64,
    #[serde(default)]
    pub included_entries: Vec<PublishIntentEntry>,
    pub payload_fingerprint: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparePublishIntentInput {
    pub commit_id: String,
    pub previous_commit_id: Option<String>,
    pub expected_generation: i64,
    pub payload_fingerprint: String,
}

fn baseline_records(conn: &Connection) -> Result<BTreeMap<String, Value>, AppError> {
    let Some(raw) = get_setting_tx(conn, BASELINE_KEY)? else {
        return Ok(BTreeMap::new());
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {BASELINE_KEY}: {error}")))?;
    let records = value
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let id = record.get("id")?.as_str()?.to_string();
            Some((id, record))
        })
        .collect())
}

pub fn get_staging(conn: &Connection) -> Result<SyncStaging, AppError> {
    let Some(raw) = get_setting_tx(conn, STAGING_KEY)? else {
        return Ok(SyncStaging::default());
    };
    let mut staging: SyncStaging = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {STAGING_KEY}: {error}")))?;
    if staging.version != 1
        || staging.entries.iter().any(|entry| {
            entry.id.trim().is_empty()
                || entry.first_generation < 0
                || entry.last_generation < entry.first_generation
                || !matches!(entry.operation.as_str(), "upsert" | "delete")
        })
    {
        return Err(AppError::General(format!("Invalid {STAGING_KEY} state")));
    }
    staging
        .entries
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(staging)
}

pub fn set_staging(conn: &Connection, staging: &SyncStaging) -> Result<(), AppError> {
    let raw = serde_json::to_string(staging).map_err(|error| {
        AppError::General(format!("Could not serialize {STAGING_KEY}: {error}"))
    })?;
    set_setting_tx(conn, STAGING_KEY, &raw)?;
    Ok(())
}

fn stage_value(
    conn: &Connection,
    id: &str,
    local: Option<Value>,
    generation: i64,
) -> Result<(), AppError> {
    let mut staging = get_staging(conn)?;
    let existing = staging.entries.iter().position(|entry| entry.id == id);
    let base = if let Some(position) = existing {
        staging.entries[position].base.clone()
    } else {
        baseline_records(conn)?.remove(id)
    };
    if base.is_none() && local.is_none() {
        if let Some(position) = existing {
            staging.entries.remove(position);
        }
        return set_staging(conn, &staging);
    }
    let entry = StagedRecord {
        id: id.to_string(),
        operation: if local.is_some() { "upsert" } else { "delete" }.to_string(),
        base,
        local,
        first_generation: existing
            .map(|position| staging.entries[position].first_generation)
            .unwrap_or(generation),
        last_generation: generation,
    };
    if let Some(position) = existing {
        staging.entries[position] = entry;
    } else {
        staging.entries.push(entry);
    }
    staging
        .entries
        .sort_by(|left, right| left.id.cmp(&right.id));
    set_staging(conn, &staging)
}

pub fn stage_upsert(
    conn: &Connection,
    record: &WatchRecord,
    generation: i64,
) -> Result<(), AppError> {
    let value = serde_json::to_value(record)
        .map_err(|error| AppError::General(format!("Could not stage record: {error}")))?;
    stage_value(conn, &record.id, Some(value), generation)
}

pub fn stage_delete(conn: &Connection, id: &str, generation: i64) -> Result<(), AppError> {
    stage_value(conn, id, None, generation)
}

pub fn rebuild_from_current(conn: &Connection, generation: i64) -> Result<SyncStaging, AppError> {
    let baseline = baseline_records(conn)?;
    let current: BTreeMap<String, Value> = db::get_all_records(conn)?
        .into_iter()
        .map(|record| {
            let id = record.id.clone();
            serde_json::to_value(record)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(format!("Could not stage records: {error}")))
        })
        .collect::<Result<_, _>>()?;
    let ids: HashSet<_> = baseline.keys().chain(current.keys()).cloned().collect();
    let mut entries = Vec::new();
    for id in ids {
        let base = baseline.get(&id);
        let local = current.get(&id);
        if base == local {
            continue;
        }
        entries.push(StagedRecord {
            id,
            operation: if local.is_some() { "upsert" } else { "delete" }.to_string(),
            base: base.cloned(),
            local: local.cloned(),
            first_generation: generation,
            last_generation: generation,
        });
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    let staging = SyncStaging {
        version: 1,
        entries,
    };
    set_staging(conn, &staging)?;
    Ok(staging)
}

pub fn get_publish_intent(conn: &Connection) -> Result<Option<SyncPublishIntent>, AppError> {
    let Some(raw) = get_setting_tx(conn, PUBLISH_INTENT_KEY)? else {
        return Ok(None);
    };
    let intent: SyncPublishIntent = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {PUBLISH_INTENT_KEY}: {error}")))?;
    if intent.version != 1
        || intent.commit_id.trim().is_empty()
        || intent.expected_generation < 0
        || intent.payload_fingerprint.trim().is_empty()
    {
        return Err(AppError::General(format!(
            "Invalid {PUBLISH_INTENT_KEY} state"
        )));
    }
    Ok(Some(intent))
}

pub fn prepare_publish_intent(
    conn: &Connection,
    current_generation: i64,
    input: PreparePublishIntentInput,
) -> Result<SyncPublishIntent, AppError> {
    if input.expected_generation != current_generation
        || input.commit_id.trim().is_empty()
        || input.payload_fingerprint.trim().is_empty()
    {
        return Err(AppError::General("stale_local_snapshot".to_string()));
    }
    let included_entries = get_staging(conn)?
        .entries
        .into_iter()
        .filter(|entry| entry.last_generation <= input.expected_generation)
        .map(|entry| PublishIntentEntry {
            id: entry.id,
            last_generation: entry.last_generation,
        })
        .collect();
    let intent = SyncPublishIntent {
        version: 1,
        commit_id: input.commit_id,
        previous_commit_id: input.previous_commit_id,
        expected_generation: input.expected_generation,
        included_entries,
        payload_fingerprint: input.payload_fingerprint,
        created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let raw = serde_json::to_string(&intent).map_err(|error| {
        AppError::General(format!("Could not serialize {PUBLISH_INTENT_KEY}: {error}"))
    })?;
    set_setting_tx(conn, PUBLISH_INTENT_KEY, &raw)?;
    Ok(intent)
}

pub fn finish_publish(
    conn: &Connection,
    committed_id: &str,
    expected_generation: i64,
) -> Result<SyncStaging, AppError> {
    let intent = get_publish_intent(conn)?;
    let mut staging = get_staging(conn)?;
    if let Some(intent) = intent {
        if intent.commit_id == committed_id {
            let included: BTreeMap<_, _> = intent
                .included_entries
                .into_iter()
                .map(|entry| (entry.id, entry.last_generation))
                .collect();
            staging.entries.retain(|entry| {
                included
                    .get(&entry.id)
                    .map_or(true, |generation| entry.last_generation > *generation)
            });
        } else {
            // A newer confirmed remote commit superseded the uncertain publish. The
            // successful merge/commit is now the acknowledgement boundary.
            staging
                .entries
                .retain(|entry| entry.last_generation > expected_generation);
        }
        conn.execute("DELETE FROM settings WHERE key = ?1", [PUBLISH_INTENT_KEY])?;
    } else {
        staging
            .entries
            .retain(|entry| entry.last_generation > expected_generation);
    }
    set_staging(conn, &staging)?;
    Ok(staging)
}
