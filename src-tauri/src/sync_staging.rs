use crate::db;
use crate::db_atomic_helpers::{get_setting_tx, set_setting_tx};
use crate::error::AppError;
use crate::models::WatchRecord;
use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

use crate::s2_lite::canonical::{jcs_bytes, sha256_hex};
use crate::s2_lite::materialized_projection::{
    resolve_ordinary_causal_base_v1, OrdinaryCausalBaseResolutionV1,
};
use crate::s2_lite::ordinary_mutation::OrdinaryCausalBaseV1;
use crate::s2_lite::types::CommitRef;

pub const STAGING_KEY: &str = "sync_staging_v1";
pub const PUBLISH_INTENT_KEY: &str = "sync_publish_intent_v1";
const BASELINE_KEY: &str = "sync_v3_baseline";

fn key(conn: &Connection, legacy: &str, suffix: &str) -> Result<String, AppError> {
    crate::sync_targets::active_key(conn, legacy, suffix)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedRecord {
    #[serde(default = "record_entity_kind")]
    pub entity_kind: String,
    pub id: String,
    pub operation: String,
    pub base: Option<Value>,
    pub local: Option<Value>,
    pub first_generation: i64,
    pub last_generation: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_descriptor: Option<StagedDeleteDescriptor>,
    /// Immutable S2 causal authority captured when this local entity first
    /// enters staging. `Unavailable` is deliberate fail-closed state, never a
    /// reason to infer a new base later.
    #[serde(default = "legacy_causal_anchor")]
    pub causal_anchor: StagedCausalAnchorV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state", deny_unknown_fields)]
pub enum S2CausalAnchorBaseStateV1 {
    Absent,
    Tombstone,
    Live { value: Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status", deny_unknown_fields)]
pub enum StagedCausalAnchorV1 {
    Ready {
        physical_root_id: String,
        entity_key: Value,
        base_state: S2CausalAnchorBaseStateV1,
        base_frontier: Vec<CommitRef>,
        fingerprint: String,
        projection_generation: u64,
    },
    Unavailable {
        reason: String,
    },
}

fn legacy_causal_anchor() -> StagedCausalAnchorV1 {
    StagedCausalAnchorV1::Unavailable {
        reason: "legacy_staging_without_causal_origin".into(),
    }
}

/// Stable identity retained when a composite source row has been deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum StagedDeleteDescriptor {
    Record {
        id: String,
        deleted_at: String,
        rev: i64,
        rev_actor: String,
    },
    Collection {
        id: String,
        deleted_at: String,
        rev: i64,
        rev_actor: String,
    },
    CollectionMember {
        id: String,
        collection_id: String,
        record_id: String,
        deleted_at: String,
        rev: i64,
        rev_actor: String,
    },
    EpisodeCompletion {
        id: String,
        record_id: String,
        episode_number: i32,
        deleted_at: String,
        rev: i64,
        rev_actor: String,
    },
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
            version: 3,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishIntentEntry {
    #[serde(default = "record_entity_kind")]
    pub entity_kind: String,
    pub id: String,
    pub last_generation: i64,
}

fn record_entity_kind() -> String {
    "record".to_string()
}

fn valid_entity_kind(value: &str) -> bool {
    matches!(
        value,
        "record" | "collection" | "collection-member" | "episode-completion"
    )
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
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub target_epoch: Option<u64>,
    pub commit_id: String,
    pub previous_commit_id: Option<String>,
    pub expected_generation: i64,
    pub payload_fingerprint: String,
}

fn baseline_entities(
    conn: &Connection,
    entity_kind: &str,
) -> Result<BTreeMap<String, Value>, AppError> {
    let baseline_key = key(conn, BASELINE_KEY, "baseline_v3")?;
    let Some(raw) = get_setting_tx(conn, &baseline_key)? else {
        return Ok(BTreeMap::new());
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {BASELINE_KEY}: {error}")))?;
    let field = match entity_kind {
        "record" => "records",
        "collection" => "collections",
        "collection-member" => "collectionMembers",
        "episode-completion" => "episodeCompletions",
        _ => return Err(AppError::General("Invalid staging entity kind".into())),
    };
    let records = value
        .get(field)
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
    get_staging_for_key(conn, &key(conn, STAGING_KEY, "staging_v1")?)
}

/// Loads staging for one explicit target without consulting the active-target
/// registry.  Historical S2 completion uses this to acknowledge the authority
/// captured by its frozen batch rather than whatever target became active
/// later.
pub fn get_staging_for_target(
    conn: &Connection,
    target_id: &str,
) -> Result<Option<SyncStaging>, AppError> {
    if target_id.is_empty() {
        return Err(AppError::General("Invalid staging target".into()));
    }
    let staging_key = crate::sync_targets::scoped_key(target_id, "staging_v1");
    if get_setting_tx(conn, &staging_key)?.is_none() {
        return Ok(None);
    }
    Ok(Some(get_staging_for_key(conn, &staging_key)?))
}

fn get_staging_for_key(conn: &Connection, staging_key: &str) -> Result<SyncStaging, AppError> {
    let Some(raw) = get_setting_tx(conn, staging_key)? else {
        return Ok(SyncStaging::default());
    };
    let mut staging: SyncStaging = serde_json::from_str(&raw)
        .map_err(|error| AppError::General(format!("Invalid {STAGING_KEY}: {error}")))?;
    if !matches!(staging.version, 1..=3)
        || staging.entries.iter().any(|entry| {
            !valid_entity_kind(&entry.entity_kind)
                || entry.id.trim().is_empty()
                || entry.first_generation < 0
                || entry.last_generation < entry.first_generation
                || !matches!(entry.operation.as_str(), "upsert" | "delete")
                || (entry.operation == "upsert" && entry.delete_descriptor.is_some())
                || (entry.operation == "delete"
                    && entry
                        .delete_descriptor
                        .as_ref()
                        .is_some_and(|descriptor| descriptor.id() != entry.id))
        })
    {
        return Err(AppError::General(format!("Invalid {STAGING_KEY} state")));
    }
    let migrated_legacy = staging.version < 3;
    for entry in &staging.entries {
        staged_entry_entity_key(entry)?;
        if !migrated_legacy {
            validate_staged_causal_anchor(entry)?;
        }
    }
    if migrated_legacy {
        for entry in &mut staging.entries {
            entry.causal_anchor = legacy_causal_anchor();
        }
        staging.version = 3;
        let migrated = serde_json::to_string(&staging)
            .map_err(|error| AppError::General(format!("Invalid {STAGING_KEY}: {error}")))?;
        set_setting_tx(conn, staging_key, &migrated)?;
    }
    staging
        .entries
        .sort_by(|left, right| (&left.entity_kind, &left.id).cmp(&(&right.entity_kind, &right.id)));
    Ok(staging)
}

impl StagedDeleteDescriptor {
    pub fn id(&self) -> &str {
        match self {
            Self::Record { id, .. }
            | Self::Collection { id, .. }
            | Self::CollectionMember { id, .. }
            | Self::EpisodeCompletion { id, .. } => id,
        }
    }
    pub fn entity_key(&self) -> Value {
        match self {
            Self::Record { id, .. } => serde_json::json!(["record", id]),
            Self::Collection { id, .. } => serde_json::json!(["collection", id]),
            Self::CollectionMember {
                collection_id,
                record_id,
                ..
            } => serde_json::json!(["collection-member", collection_id, record_id]),
            Self::EpisodeCompletion {
                record_id,
                episode_number,
                ..
            } => serde_json::json!(["episode-completion", record_id, episode_number]),
        }
    }
}

/// Resolves local staging identity using the Phase 3E logical key shape. A
/// composite deletion without a descriptor is deliberately rejected rather
/// than guessed from its opaque row id.
pub fn staged_entry_entity_key(entry: &StagedRecord) -> Result<Value, AppError> {
    if let Some(descriptor) = &entry.delete_descriptor {
        return Ok(descriptor.entity_key());
    }
    match entry.entity_kind.as_str() {
        "record" => Ok(serde_json::json!(["record", entry.id])),
        "collection" => Ok(serde_json::json!(["collection", entry.id])),
        "collection-member" | "episode-completion" if entry.operation == "delete" => Err(
            AppError::General("staging_composite_delete_evidence_missing".into()),
        ),
        "collection-member" | "episode-completion" => {
            let value = entry
                .local
                .as_ref()
                .ok_or_else(|| AppError::General("staging_composite_identity_missing".into()))?;
            let record_id = value
                .get("recordId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::General("staging_composite_identity_missing".into()))?;
            if entry.entity_kind == "collection-member" {
                let collection_id = value
                    .get("collectionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::General("staging_composite_identity_missing".into())
                    })?;
                Ok(serde_json::json!([
                    "collection-member",
                    collection_id,
                    record_id
                ]))
            } else {
                let episode = value
                    .get("episodeNumber")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        AppError::General("staging_composite_identity_missing".into())
                    })?;
                Ok(serde_json::json!([
                    "episode-completion",
                    record_id,
                    episode
                ]))
            }
        }
        _ => Err(AppError::General("Invalid staging entity kind".into())),
    }
}

fn anchor_base_state(base: &OrdinaryCausalBaseV1) -> S2CausalAnchorBaseStateV1 {
    match base {
        OrdinaryCausalBaseV1::Absent => S2CausalAnchorBaseStateV1::Absent,
        OrdinaryCausalBaseV1::Tombstone => S2CausalAnchorBaseStateV1::Tombstone,
        OrdinaryCausalBaseV1::Live(value) => S2CausalAnchorBaseStateV1::Live {
            value: value.clone(),
        },
    }
}

fn anchor_fingerprint(
    physical_root_id: &str,
    entity_key: &Value,
    base_state: &S2CausalAnchorBaseStateV1,
    base_frontier: &[CommitRef],
) -> Result<String, AppError> {
    let value = serde_json::json!({
        "physicalRootId": physical_root_id,
        "entityKey": entity_key,
        "baseState": base_state,
        "baseFrontier": base_frontier,
    });
    jcs_bytes(&value)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| AppError::General(error.0.into()))
}

/// Captures an entity-local causal anchor while the caller's local mutation
/// transaction is still open. Failure to obtain exact causal authority is
/// retained as explicit unavailable state rather than guessed later.
pub fn capture_staged_causal_anchor_v1(
    conn: &Connection,
    entry: &StagedRecord,
) -> StagedCausalAnchorV1 {
    let unavailable = |reason: &str| StagedCausalAnchorV1::Unavailable {
        reason: reason.to_string(),
    };
    let Ok(entity_key) = staged_entry_entity_key(entry) else {
        return unavailable("entity_key_unavailable");
    };
    let Ok(Some(registry)) = crate::sync_targets::registry(conn) else {
        return unavailable("active_target_unavailable");
    };
    let Some(target_id) = registry.active_target_id.as_deref() else {
        return unavailable("active_target_unavailable");
    };
    let Some(target) = registry
        .targets
        .iter()
        .find(|target| target.id == target_id)
    else {
        return unavailable("active_target_unavailable");
    };
    let Ok(root) =
        crate::s2_lite::webdav_adapter::webdav_root_v1(&target.normalized_url, &target.username)
    else {
        return unavailable("root_unavailable");
    };
    let Ok(Some(projection)) =
        crate::s2_lite::durable_persistence::load_materialized_projection_for_staging_v1(
            conn,
            &root.physical_root_id,
        )
    else {
        return unavailable("projection_unavailable");
    };
    let Ok(resolution) = resolve_ordinary_causal_base_v1(&projection.state, &entity_key) else {
        return unavailable("causal_base_unavailable");
    };
    let OrdinaryCausalBaseResolutionV1::Ready {
        causal_base,
        base_frontier,
        ..
    } = resolution
    else {
        return unavailable("causal_base_not_ready");
    };
    let base_state = anchor_base_state(&causal_base);
    let Ok(fingerprint) = anchor_fingerprint(
        &root.physical_root_id,
        &entity_key,
        &base_state,
        &base_frontier,
    ) else {
        return unavailable("anchor_fingerprint_unavailable");
    };
    StagedCausalAnchorV1::Ready {
        physical_root_id: root.physical_root_id,
        entity_key,
        base_state,
        base_frontier,
        fingerprint,
        projection_generation: projection.projection_generation,
    }
}

pub fn validate_staged_causal_anchor(entry: &StagedRecord) -> Result<(), AppError> {
    match &entry.causal_anchor {
        StagedCausalAnchorV1::Unavailable { reason } if !reason.trim().is_empty() => Ok(()),
        StagedCausalAnchorV1::Unavailable { .. } => {
            Err(AppError::General("Invalid causal staging anchor".into()))
        }
        StagedCausalAnchorV1::Ready {
            physical_root_id,
            entity_key,
            base_state,
            base_frontier,
            fingerprint,
            ..
        } => {
            if physical_root_id.is_empty()
                || staged_entry_entity_key(entry)? != *entity_key
                || anchor_fingerprint(physical_root_id, entity_key, base_state, base_frontier)?
                    != *fingerprint
            {
                return Err(AppError::General("Invalid causal staging anchor".into()));
            }
            Ok(())
        }
    }
}

pub fn staged_anchor_matches_current_causal_base_v1(
    entry: &StagedRecord,
    physical_root_id: &str,
    causal_base: &OrdinaryCausalBaseV1,
    base_frontier: &[CommitRef],
) -> Result<bool, AppError> {
    validate_staged_causal_anchor(entry)?;
    let StagedCausalAnchorV1::Ready {
        physical_root_id: anchored_root,
        entity_key,
        base_state,
        base_frontier: anchored_frontier,
        ..
    } = &entry.causal_anchor
    else {
        return Ok(false);
    };
    Ok(anchored_root == physical_root_id
        && *entity_key == staged_entry_entity_key(entry)?
        && *base_state == anchor_base_state(causal_base)
        && *anchored_frontier == base_frontier)
}

pub fn set_staging(conn: &Connection, staging: &SyncStaging) -> Result<(), AppError> {
    let raw = serde_json::to_string(staging).map_err(|error| {
        AppError::General(format!("Could not serialize {STAGING_KEY}: {error}"))
    })?;
    set_setting_tx(conn, &key(conn, STAGING_KEY, "staging_v1")?, &raw)?;
    Ok(())
}

/// Persists staging for one explicit historical target.  This intentionally
/// does not resolve, validate, or switch the currently active target.
pub fn set_staging_for_target(
    conn: &Connection,
    target_id: &str,
    staging: &SyncStaging,
) -> Result<(), AppError> {
    if target_id.is_empty() {
        return Err(AppError::General("Invalid staging target".into()));
    }
    let raw = serde_json::to_string(staging).map_err(|error| {
        AppError::General(format!("Could not serialize {STAGING_KEY}: {error}"))
    })?;
    set_setting_tx(
        conn,
        &crate::sync_targets::scoped_key(target_id, "staging_v1"),
        &raw,
    )?;
    Ok(())
}

fn stage_value(
    conn: &Connection,
    entity_kind: &str,
    id: &str,
    local: Option<Value>,
    generation: i64,
) -> Result<(), AppError> {
    if !valid_entity_kind(entity_kind) {
        return Err(AppError::General("Invalid staging entity kind".into()));
    }
    if crate::sync_targets::registry_exists_without_active_target(conn)? {
        return Ok(());
    }
    let mut staging = get_staging(conn)?;
    let existing = staging
        .entries
        .iter()
        .position(|entry| entry.entity_kind == entity_kind && entry.id == id);
    let base = if let Some(position) = existing {
        staging.entries[position].base.clone()
    } else {
        baseline_entities(conn, entity_kind)?.remove(id)
    };
    if base.is_none() && local.is_none() {
        if let Some(position) = existing {
            staging.entries.remove(position);
        }
        return set_staging(conn, &staging);
    }
    let is_delete = local.is_none();
    let entry = StagedRecord {
        entity_kind: entity_kind.to_string(),
        id: id.to_string(),
        operation: if local.is_some() { "upsert" } else { "delete" }.to_string(),
        base,
        local,
        first_generation: existing
            .map(|position| staging.entries[position].first_generation)
            .unwrap_or(generation),
        last_generation: generation,
        // A retry of a durable delete must not discard its descriptor before
        // `stage_entity_delete_with_descriptor` compares the retry evidence.
        delete_descriptor: if is_delete {
            existing.and_then(|position| staging.entries[position].delete_descriptor.clone())
        } else {
            None
        },
        causal_anchor: existing
            .map(|position| staging.entries[position].causal_anchor.clone())
            .unwrap_or_else(legacy_causal_anchor),
    };
    let mut entry = entry;
    if existing.is_none() {
        entry.causal_anchor = capture_staged_causal_anchor_v1(conn, &entry);
    }
    if let Some(position) = existing {
        staging.entries[position] = entry;
    } else {
        staging.entries.push(entry);
    }
    staging
        .entries
        .sort_by(|left, right| (&left.entity_kind, &left.id).cmp(&(&right.entity_kind, &right.id)));
    set_staging(conn, &staging)
}

pub fn stage_upsert(
    conn: &Connection,
    record: &WatchRecord,
    generation: i64,
) -> Result<(), AppError> {
    let value = serde_json::to_value(record)
        .map_err(|error| AppError::General(format!("Could not stage record: {error}")))?;
    stage_value(conn, "record", &record.id, Some(value), generation)
}

pub fn stage_entity_upsert(
    conn: &Connection,
    entity_kind: &str,
    id: &str,
    value: Value,
    generation: i64,
) -> Result<(), AppError> {
    stage_value(conn, entity_kind, id, Some(value), generation)
}

pub fn stage_entity_delete_with_descriptor(
    conn: &Connection,
    entity_kind: &str,
    descriptor: StagedDeleteDescriptor,
    generation: i64,
) -> Result<(), AppError> {
    if !valid_entity_kind(entity_kind) || !descriptor_matches_entity_kind(entity_kind, &descriptor)
    {
        return Err(AppError::General(
            "Invalid staging delete descriptor".into(),
        ));
    }
    if crate::sync_targets::registry_exists_without_active_target(conn)? {
        return Ok(());
    }
    let mut staging = get_staging(conn)?;
    // A locally-created, never-baselined entity can cancel itself out on
    // deletion. There is then no logical remote entity to tombstone. Any
    // retained deletion entry, however, must carry the descriptor below.
    let existing = staging
        .entries
        .iter()
        .position(|entry| entry.entity_kind == entity_kind && entry.id == descriptor.id());
    let base = if let Some(position) = existing {
        staging.entries[position].base.clone()
    } else {
        baseline_entities(conn, entity_kind)?.remove(descriptor.id())
    };
    if base.is_none() {
        if let Some(position) = existing {
            staging.entries.remove(position);
        }
        return set_staging(conn, &staging);
    }
    if let Some(position) = existing {
        if let Some(previous) = &staging.entries[position].delete_descriptor {
            if previous != &descriptor {
                return Err(AppError::General(
                    "staging_delete_descriptor_changed".into(),
                ));
            }
        }
        staging.entries[position] = StagedRecord {
            entity_kind: entity_kind.to_string(),
            id: descriptor.id().to_string(),
            operation: "delete".into(),
            base,
            local: None,
            first_generation: staging.entries[position].first_generation,
            last_generation: generation,
            delete_descriptor: Some(descriptor),
            causal_anchor: staging.entries[position].causal_anchor.clone(),
        };
    } else {
        staging.entries.push(StagedRecord {
            entity_kind: entity_kind.to_string(),
            id: descriptor.id().to_string(),
            operation: "delete".into(),
            base,
            local: None,
            first_generation: generation,
            last_generation: generation,
            delete_descriptor: Some(descriptor),
            causal_anchor: legacy_causal_anchor(),
        });
        let position = staging.entries.len() - 1;
        staging.entries[position].causal_anchor =
            capture_staged_causal_anchor_v1(conn, &staging.entries[position]);
    }
    staging
        .entries
        .sort_by(|left, right| (&left.entity_kind, &left.id).cmp(&(&right.entity_kind, &right.id)));
    set_staging(conn, &staging)
}

fn descriptor_matches_entity_kind(entity_kind: &str, descriptor: &StagedDeleteDescriptor) -> bool {
    match (entity_kind, descriptor) {
        (
            "record",
            StagedDeleteDescriptor::Record {
                id,
                deleted_at,
                rev,
                rev_actor,
            },
        )
        | (
            "collection",
            StagedDeleteDescriptor::Collection {
                id,
                deleted_at,
                rev,
                rev_actor,
            },
        ) => {
            !id.trim().is_empty()
                && !deleted_at.trim().is_empty()
                && *rev >= 0
                && !rev_actor.trim().is_empty()
        }
        (
            "collection-member",
            StagedDeleteDescriptor::CollectionMember {
                id,
                collection_id,
                record_id,
                deleted_at,
                rev,
                rev_actor,
            },
        ) => {
            !id.trim().is_empty()
                && !collection_id.trim().is_empty()
                && !record_id.trim().is_empty()
                && !deleted_at.trim().is_empty()
                && *rev >= 0
                && !rev_actor.trim().is_empty()
        }
        (
            "episode-completion",
            StagedDeleteDescriptor::EpisodeCompletion {
                id,
                record_id,
                episode_number,
                deleted_at,
                rev,
                rev_actor,
            },
        ) => {
            !id.trim().is_empty()
                && !record_id.trim().is_empty()
                && *episode_number > 0
                && !deleted_at.trim().is_empty()
                && *rev >= 0
                && !rev_actor.trim().is_empty()
        }
        _ => false,
    }
}

/// Episode completion staging is deliberately an entity entry, not an update
/// to the parent record. It shares the same committed generation as the
/// business mutation so an S2 batch can acknowledge it independently.
pub fn stage_episode_completion_upsert(
    conn: &Connection,
    completion: &crate::episode_history::EpisodeCompletion,
    generation: i64,
) -> Result<(), AppError> {
    let value = serde_json::to_value(completion).map_err(|error| {
        AppError::General(format!("Could not stage episode completion: {error}"))
    })?;
    stage_value(
        conn,
        "episode-completion",
        &completion.id,
        Some(value),
        generation,
    )
}

#[allow(dead_code)] // Composite deletes must use descriptor-bearing staging.
pub fn stage_episode_completion_delete(
    conn: &Connection,
    id: &str,
    generation: i64,
) -> Result<(), AppError> {
    stage_value(conn, "episode-completion", id, None, generation)
}

fn rebuild_delete_descriptor(
    entity_kind: &str,
    id: &str,
    baseline: &Value,
    deleted_at: &str,
    rev_actor: &str,
) -> Result<StagedDeleteDescriptor, AppError> {
    let rev = baseline
        .get("rev")
        .and_then(Value::as_i64)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| AppError::General("staging_rebuild_delete_evidence_missing".into()))?;
    let missing = || AppError::General("staging_rebuild_delete_evidence_missing".into());
    match entity_kind {
        "record" => Ok(StagedDeleteDescriptor::Record {
            id: id.to_string(),
            deleted_at: deleted_at.to_string(),
            rev,
            rev_actor: rev_actor.to_string(),
        }),
        "collection" => Ok(StagedDeleteDescriptor::Collection {
            id: id.to_string(),
            deleted_at: deleted_at.to_string(),
            rev,
            rev_actor: rev_actor.to_string(),
        }),
        "collection-member" => Ok(StagedDeleteDescriptor::CollectionMember {
            id: id.to_string(),
            collection_id: baseline
                .get("collectionId")
                .and_then(Value::as_str)
                .ok_or_else(missing)?
                .to_string(),
            record_id: baseline
                .get("recordId")
                .and_then(Value::as_str)
                .ok_or_else(missing)?
                .to_string(),
            deleted_at: deleted_at.to_string(),
            rev,
            rev_actor: rev_actor.to_string(),
        }),
        "episode-completion" => Ok(StagedDeleteDescriptor::EpisodeCompletion {
            id: id.to_string(),
            record_id: baseline
                .get("recordId")
                .and_then(Value::as_str)
                .ok_or_else(missing)?
                .to_string(),
            episode_number: baseline
                .get("episodeNumber")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or_else(missing)?,
            deleted_at: deleted_at.to_string(),
            rev,
            rev_actor: rev_actor.to_string(),
        }),
        _ => Err(AppError::General("Invalid staging entity kind".into())),
    }
}

fn append_entity_diff(
    entity_kind: &str,
    baseline: BTreeMap<String, Value>,
    current: BTreeMap<String, Value>,
    generation: i64,
    deleted_at: &str,
    rev_actor: &str,
    entries: &mut Vec<StagedRecord>,
) -> Result<(), AppError> {
    let ids: HashSet<_> = baseline.keys().chain(current.keys()).cloned().collect();
    for id in ids {
        let base = baseline.get(&id);
        let local = current.get(&id);
        if base == local {
            continue;
        }
        let delete_descriptor = match (base, local) {
            (Some(base), None) => Some(rebuild_delete_descriptor(
                entity_kind,
                &id,
                base,
                deleted_at,
                rev_actor,
            )?),
            _ => None,
        };
        entries.push(StagedRecord {
            entity_kind: entity_kind.to_string(),
            id,
            operation: if local.is_some() { "upsert" } else { "delete" }.into(),
            base: base.cloned(),
            local: local.cloned(),
            first_generation: generation,
            last_generation: generation,
            delete_descriptor,
            causal_anchor: legacy_causal_anchor(),
        });
    }
    Ok(())
}

fn append_collection_entries(
    conn: &Connection,
    generation: i64,
    deleted_at: &str,
    rev_actor: &str,
    entries: &mut Vec<StagedRecord>,
) -> Result<(), AppError> {
    let collections = crate::collections::all(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let members = crate::collections::all_members(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    append_entity_diff(
        "collection",
        baseline_entities(conn, "collection")?,
        collections,
        generation,
        deleted_at,
        rev_actor,
        entries,
    )?;
    append_entity_diff(
        "collection-member",
        baseline_entities(conn, "collection-member")?,
        members,
        generation,
        deleted_at,
        rev_actor,
        entries,
    )?;
    Ok(())
}

fn append_episode_completion_entries(
    conn: &Connection,
    generation: i64,
    deleted_at: &str,
    rev_actor: &str,
    entries: &mut Vec<StagedRecord>,
) -> Result<(), AppError> {
    let completions = crate::episode_history::all_completions(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    append_entity_diff(
        "episode-completion",
        baseline_entities(conn, "episode-completion")?,
        completions,
        generation,
        deleted_at,
        rev_actor,
        entries,
    )?;
    Ok(())
}

pub fn rebuild_from_current(conn: &Connection, generation: i64) -> Result<SyncStaging, AppError> {
    let deleted_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rev_actor = crate::sync_state::device_id(conn)?;
    let baseline = baseline_entities(conn, "record")?;
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
        let delete_descriptor = match (base, local) {
            (Some(base), None) => Some(rebuild_delete_descriptor(
                "record",
                &id,
                base,
                &deleted_at,
                &rev_actor,
            )?),
            _ => None,
        };
        entries.push(StagedRecord {
            entity_kind: "record".into(),
            id,
            operation: if local.is_some() { "upsert" } else { "delete" }.to_string(),
            base: base.cloned(),
            local: local.cloned(),
            first_generation: generation,
            last_generation: generation,
            delete_descriptor,
            causal_anchor: legacy_causal_anchor(),
        });
    }
    append_collection_entries(conn, generation, &deleted_at, &rev_actor, &mut entries)?;
    append_episode_completion_entries(conn, generation, &deleted_at, &rev_actor, &mut entries)?;
    entries
        .sort_by(|left, right| (&left.entity_kind, &left.id).cmp(&(&right.entity_kind, &right.id)));
    let staging = SyncStaging {
        version: 3,
        entries,
    };
    set_staging(conn, &staging)?;
    Ok(staging)
}

pub fn rebuild_from_current_for_target(
    conn: &Connection,
    generation: i64,
    target_id: &str,
) -> Result<SyncStaging, AppError> {
    let deleted_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rev_actor = crate::sync_state::device_id(conn)?;
    let baseline_key = crate::sync_targets::scoped_key(target_id, "baseline_v3");
    let baseline_value = get_setting_tx(conn, &baseline_key)?
        .map(|raw| {
            serde_json::from_str::<Value>(&raw)
                .map_err(|error| AppError::General(format!("Invalid {baseline_key}: {error}")))
        })
        .transpose()?;
    let baseline = match baseline_value.as_ref() {
        Some(value) => value
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|record| Some((record.get("id")?.as_str()?.to_string(), record)))
            .collect(),
        None => BTreeMap::new(),
    };
    let current: BTreeMap<String, Value> = db::get_all_records(conn)?
        .into_iter()
        .map(|record| {
            let id = record.id.clone();
            serde_json::to_value(record)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
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
        let delete_descriptor = match (base, local) {
            (Some(base), None) => Some(rebuild_delete_descriptor(
                "record",
                &id,
                base,
                &deleted_at,
                &rev_actor,
            )?),
            _ => None,
        };
        entries.push(StagedRecord {
            entity_kind: "record".into(),
            id,
            operation: if local.is_some() { "upsert" } else { "delete" }.into(),
            base: base.cloned(),
            local: local.cloned(),
            first_generation: generation,
            last_generation: generation,
            delete_descriptor,
            causal_anchor: legacy_causal_anchor(),
        });
    }
    let baseline_map = |field: &str| -> BTreeMap<String, Value> {
        baseline_value
            .as_ref()
            .and_then(|value| value.get(field))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item)))
            .collect()
    };
    let current_collections = crate::collections::all(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let current_members = crate::collections::all_members(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    append_entity_diff(
        "collection",
        baseline_map("collections"),
        current_collections,
        generation,
        &deleted_at,
        &rev_actor,
        &mut entries,
    )?;
    append_entity_diff(
        "collection-member",
        baseline_map("collectionMembers"),
        current_members,
        generation,
        &deleted_at,
        &rev_actor,
        &mut entries,
    )?;
    let current_completions = crate::episode_history::all_completions(conn)?
        .into_iter()
        .map(|item| {
            let id = item.id.clone();
            serde_json::to_value(item)
                .map(|value| (id, value))
                .map_err(|error| AppError::General(error.to_string()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    append_entity_diff(
        "episode-completion",
        baseline_map("episodeCompletions"),
        current_completions,
        generation,
        &deleted_at,
        &rev_actor,
        &mut entries,
    )?;
    entries
        .sort_by(|left, right| (&left.entity_kind, &left.id).cmp(&(&right.entity_kind, &right.id)));
    let staging = SyncStaging {
        version: 3,
        entries,
    };
    let raw =
        serde_json::to_string(&staging).map_err(|error| AppError::General(error.to_string()))?;
    set_setting_tx(
        conn,
        &crate::sync_targets::scoped_key(target_id, "staging_v1"),
        &raw,
    )?;
    Ok(staging)
}

pub fn get_publish_intent(conn: &Connection) -> Result<Option<SyncPublishIntent>, AppError> {
    let intent_key = key(conn, PUBLISH_INTENT_KEY, "publish_intent_v1")?;
    let Some(raw) = get_setting_tx(conn, &intent_key)? else {
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
            entity_kind: entry.entity_kind,
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
    set_setting_tx(
        conn,
        &key(conn, PUBLISH_INTENT_KEY, "publish_intent_v1")?,
        &raw,
    )?;
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
                .map(|entry| ((entry.entity_kind, entry.id), entry.last_generation))
                .collect();
            staging.entries.retain(|entry| {
                included
                    .get(&(entry.entity_kind.clone(), entry.id.clone()))
                    .map_or(true, |generation| entry.last_generation > *generation)
            });
        } else {
            // A newer confirmed remote commit superseded the uncertain publish. The
            // successful merge/commit is now the acknowledgement boundary.
            staging
                .entries
                .retain(|entry| entry.last_generation > expected_generation);
        }
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            [key(conn, PUBLISH_INTENT_KEY, "publish_intent_v1")?],
        )?;
    } else {
        staging
            .entries
            .retain(|entry| entry.last_generation > expected_generation);
    }
    set_staging(conn, &staging)?;
    Ok(staging)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        conn
    }

    fn baseline_with_member(conn: &Connection) {
        set_setting_tx(
            conn,
            BASELINE_KEY,
            r#"{"collectionMembers":[{"id":"member-1","collectionId":"collection-1","recordId":"record-1"}]}"#,
        )
        .unwrap();
    }

    fn member_descriptor(deleted_at: &str, rev: i64, rev_actor: &str) -> StagedDeleteDescriptor {
        StagedDeleteDescriptor::CollectionMember {
            id: "member-1".into(),
            collection_id: "collection-1".into(),
            record_id: "record-1".into(),
            deleted_at: deleted_at.into(),
            rev,
            rev_actor: rev_actor.into(),
        }
    }

    #[test]
    fn delete_descriptor_retry_is_stable_and_replacement_fails_closed() {
        let conn = database();
        baseline_with_member(&conn);
        let descriptor = member_descriptor("2026-09-17T00:00:00.000Z", 4, "device-a");
        stage_entity_delete_with_descriptor(&conn, "collection-member", descriptor.clone(), 8)
            .unwrap();
        stage_entity_delete_with_descriptor(&conn, "collection-member", descriptor.clone(), 9)
            .unwrap();
        let entry = get_staging(&conn).unwrap().entries.pop().unwrap();
        assert_eq!(entry.delete_descriptor, Some(descriptor));
        assert_eq!(entry.last_generation, 9);
        assert!(stage_entity_delete_with_descriptor(
            &conn,
            "collection-member",
            member_descriptor("2026-09-18T00:00:00.000Z", 4, "device-a"),
            10,
        )
        .unwrap_err()
        .to_string()
        .contains("staging_delete_descriptor_changed"));
    }

    #[test]
    fn incomplete_legacy_composite_delete_fails_closed() {
        let conn = database();
        set_staging(
            &conn,
            &SyncStaging {
                version: 2,
                entries: vec![StagedRecord {
                    entity_kind: "collection-member".into(),
                    id: "opaque-id".into(),
                    operation: "delete".into(),
                    base: None,
                    local: None,
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                    causal_anchor: legacy_causal_anchor(),
                }],
            },
        )
        .unwrap();
        assert!(get_staging(&conn)
            .unwrap_err()
            .to_string()
            .contains("staging_composite_delete_evidence_missing"));
    }

    #[test]
    fn locally_created_entity_can_self_cancel_without_a_tombstone() {
        let conn = database();
        stage_entity_upsert(
            &conn,
            "episode-completion",
            "completion-1",
            serde_json::json!({"id":"completion-1","recordId":"record-1","episodeNumber":1}),
            1,
        )
        .unwrap();
        stage_entity_delete_with_descriptor(
            &conn,
            "episode-completion",
            StagedDeleteDescriptor::EpisodeCompletion {
                id: "completion-1".into(),
                record_id: "record-1".into(),
                episode_number: 1,
                deleted_at: "2026-09-17T00:00:00.000Z".into(),
                rev: 2,
                rev_actor: "device-a".into(),
            },
            2,
        )
        .unwrap();
        assert!(get_staging(&conn).unwrap().entries.is_empty());
    }

    #[test]
    fn descriptor_recovers_composite_key_without_source_row() {
        let entry = StagedRecord {
            entity_kind: "episode-completion".into(),
            id: "completion-1".into(),
            operation: "delete".into(),
            base: None,
            local: None,
            first_generation: 1,
            last_generation: 1,
            delete_descriptor: Some(StagedDeleteDescriptor::EpisodeCompletion {
                id: "completion-1".into(),
                record_id: "record-1".into(),
                episode_number: 7,
                deleted_at: "2026-09-17T00:00:00.000Z".into(),
                rev: 2,
                rev_actor: "device-a".into(),
            }),
            causal_anchor: legacy_causal_anchor(),
        };
        assert_eq!(
            staged_entry_entity_key(&entry).unwrap(),
            serde_json::json!(["episode-completion", "record-1", 7])
        );
    }

    #[test]
    fn rebuild_retains_composite_delete_evidence_from_the_durable_baseline() {
        let conn = database();
        set_setting_tx(&conn, "sync_device_id_v1", "device-a").unwrap();
        set_setting_tx(
            &conn,
            BASELINE_KEY,
            r#"{"collectionMembers":[{"id":"member-1","collectionId":"collection-1","recordId":"record-1","rev":3,"revActor":"remote"}],"episodeCompletions":[{"id":"completion-1","recordId":"record-1","episodeNumber":2,"rev":5,"revActor":"remote"}]}"#,
        )
        .unwrap();
        let staging = rebuild_from_current(&conn, 6).unwrap();
        let member = staging
            .entries
            .iter()
            .find(|entry| entry.id == "member-1")
            .unwrap();
        let completion = staging
            .entries
            .iter()
            .find(|entry| entry.id == "completion-1")
            .unwrap();
        assert!(member.delete_descriptor.is_some());
        assert_eq!(
            staged_entry_entity_key(completion).unwrap(),
            serde_json::json!(["episode-completion", "record-1", 2])
        );
    }
}
