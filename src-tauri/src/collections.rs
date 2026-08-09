use crate::db_atomic_helpers::mark_local_records_mutated;
use crate::error::AppError;
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub normalized_name: String,
    pub description: Option<String>,
    pub source_kind: String,
    pub source_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub rev: i64,
    pub rev_actor: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionMember {
    pub id: String,
    pub collection_id: String,
    pub record_id: String,
    pub position: i64,
    pub source_kind: String,
    pub created_at: String,
    pub updated_at: String,
    pub rev: i64,
    pub rev_actor: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionTombstone {
    pub id: String,
    pub deleted_at: String,
    pub rev: i64,
    pub rev_actor: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionMemberTombstone {
    pub id: String,
    pub collection_id: String,
    pub record_id: String,
    pub deleted_at: String,
    pub rev: i64,
    pub rev_actor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCollectionInput {
    pub name: String,
    pub description: Option<String>,
    #[serde(default = "manual_source")]
    pub source_kind: String,
    pub source_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCollectionInput {
    pub name: String,
    pub description: Option<String>,
    pub expected_rev: i64,
}

fn manual_source() -> String {
    "manual".to_string()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalized_name(value: &str) -> Result<(String, String), AppError> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = name.chars().count();
    if length == 0 {
        return Err(AppError::General("collection_name_required".into()));
    }
    if length > 80 || name.chars().any(char::is_control) {
        return Err(AppError::General("collection_name_invalid".into()));
    }
    Ok((name.clone(), name.to_lowercase()))
}

fn description(value: Option<String>) -> Result<Option<String>, AppError> {
    let value = value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
    if value
        .as_ref()
        .is_some_and(|item| item.chars().count() > 500 || item.chars().any(char::is_control))
    {
        return Err(AppError::General("collection_description_invalid".into()));
    }
    Ok(value)
}

fn validate_source(kind: &str, key: Option<String>) -> Result<(String, Option<String>), AppError> {
    if !matches!(kind, "manual" | "tmdb-movie-collection" | "tmdb-tv-show") {
        return Err(AppError::General("collection_source_invalid".into()));
    }
    let key = key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if kind == "manual" && key.is_some() || kind != "manual" && key.is_none() {
        return Err(AppError::General("collection_source_invalid".into()));
    }
    Ok((kind.to_string(), key))
}

pub fn member_id(collection_id: &str, record_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"collection-member:v1\0");
    digest.update(collection_id.as_bytes());
    digest.update(b"\0");
    digest.update(record_id.as_bytes());
    format!("{:x}", digest.finalize())
}

pub fn schema_ready(conn: &Connection) -> rusqlite::Result<bool> {
    let marker = conn
        .query_row(
            "SELECT value FROM settings WHERE key='collections_schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let required = [
        "collections",
        "collection_members",
        "collection_tombstones",
        "collection_member_tombstones",
    ];
    let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(marker.as_deref() == Some("1") && required.iter().all(|name| tables.contains(*name)))
}

pub fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS collections (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           normalizedName TEXT NOT NULL UNIQUE,
           description TEXT,
           sourceKind TEXT NOT NULL DEFAULT 'manual' CHECK(sourceKind IN ('manual','tmdb-movie-collection','tmdb-tv-show')),
           sourceKey TEXT,
           createdAt TEXT NOT NULL,
           updatedAt TEXT NOT NULL,
           rev INTEGER NOT NULL DEFAULT 0,
           revActor TEXT NOT NULL DEFAULT '',
           UNIQUE(sourceKind, sourceKey)
         );
         CREATE TABLE IF NOT EXISTS collection_members (
           id TEXT PRIMARY KEY,
           collectionId TEXT NOT NULL,
           recordId TEXT NOT NULL,
           position INTEGER NOT NULL CHECK(position >= 0),
           sourceKind TEXT NOT NULL DEFAULT 'manual' CHECK(sourceKind IN ('manual','tmdb')),
           createdAt TEXT NOT NULL,
           updatedAt TEXT NOT NULL,
           rev INTEGER NOT NULL DEFAULT 0,
           revActor TEXT NOT NULL DEFAULT '',
           UNIQUE(collectionId, recordId),
           FOREIGN KEY(collectionId) REFERENCES collections(id) ON DELETE CASCADE,
           FOREIGN KEY(recordId) REFERENCES records(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS collection_members_order ON collection_members(collectionId, position, id);
         CREATE INDEX IF NOT EXISTS collection_members_record ON collection_members(recordId, collectionId);
         CREATE TABLE IF NOT EXISTS collection_tombstones (
           id TEXT PRIMARY KEY, deletedAt TEXT NOT NULL, rev INTEGER NOT NULL, revActor TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS collection_member_tombstones (
           id TEXT PRIMARY KEY, collectionId TEXT NOT NULL, recordId TEXT NOT NULL,
           deletedAt TEXT NOT NULL, rev INTEGER NOT NULL, revActor TEXT NOT NULL
         );
         INSERT INTO settings(key,value) VALUES('collections_schema_version','1')
           ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
    )?;
    let raw = transaction
        .query_row(
            "SELECT value FROM settings WHERE key='required_app_features_v1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "[]".to_string());
    let mut features = serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default();
    if !features
        .iter()
        .any(|feature| feature == "episode-history-v1")
    {
        features.push("episode-history-v1".into());
    }
    if !features.iter().any(|feature| feature == "collections-v1") {
        features.push("collections-v1".into());
    }
    features.sort();
    transaction.execute(
        "INSERT INTO settings(key,value) VALUES('required_app_features_v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&features).unwrap_or_else(|_| "[]".to_string())],
    )?;
    transaction.commit()
}

fn map_collection(row: &Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get("id")?,
        name: row.get("name")?,
        normalized_name: row.get("normalizedName")?,
        description: row.get("description")?,
        source_kind: row.get("sourceKind")?,
        source_key: row.get("sourceKey")?,
        created_at: row.get("createdAt")?,
        updated_at: row.get("updatedAt")?,
        rev: row.get("rev")?,
        rev_actor: row.get("revActor")?,
    })
}

fn map_member(row: &Row<'_>) -> rusqlite::Result<CollectionMember> {
    Ok(CollectionMember {
        id: row.get("id")?,
        collection_id: row.get("collectionId")?,
        record_id: row.get("recordId")?,
        position: row.get("position")?,
        source_kind: row.get("sourceKind")?,
        created_at: row.get("createdAt")?,
        updated_at: row.get("updatedAt")?,
        rev: row.get("rev")?,
        rev_actor: row.get("revActor")?,
    })
}

pub fn all(conn: &Connection) -> Result<Vec<Collection>, AppError> {
    let mut statement = conn.prepare("SELECT * FROM collections ORDER BY normalizedName, id")?;
    let values = statement
        .query_map([], map_collection)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(values)
}

pub fn all_members(conn: &Connection) -> Result<Vec<CollectionMember>, AppError> {
    let mut statement =
        conn.prepare("SELECT * FROM collection_members ORDER BY collectionId, position, id")?;
    let values = statement
        .query_map([], map_member)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(values)
}

pub fn collection_tombstones(conn: &Connection) -> Result<Vec<CollectionTombstone>, AppError> {
    let mut statement =
        conn.prepare("SELECT id, deletedAt, rev, revActor FROM collection_tombstones ORDER BY id")?;
    let values = statement
        .query_map([], |row| {
            Ok(CollectionTombstone {
                id: row.get(0)?,
                deleted_at: row.get(1)?,
                rev: row.get(2)?,
                rev_actor: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(values)
}

pub fn member_tombstones(conn: &Connection) -> Result<Vec<CollectionMemberTombstone>, AppError> {
    let mut statement = conn.prepare("SELECT id, collectionId, recordId, deletedAt, rev, revActor FROM collection_member_tombstones ORDER BY id")?;
    let values = statement
        .query_map([], |row| {
            Ok(CollectionMemberTombstone {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                record_id: row.get(2)?,
                deleted_at: row.get(3)?,
                rev: row.get(4)?,
                rev_actor: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(values)
}

fn get(conn: &Connection, id: &str) -> Result<Collection, AppError> {
    conn.query_row(
        "SELECT * FROM collections WHERE id=?1",
        [id],
        map_collection,
    )
    .optional()?
    .ok_or_else(|| AppError::General("collection_not_found".into()))
}

fn bump_collection(
    conn: &Connection,
    id: &str,
    actor: &str,
    timestamp: &str,
) -> Result<Collection, AppError> {
    conn.execute(
        "UPDATE collections SET updatedAt=?2, rev=rev+1, revActor=?3 WHERE id=?1",
        params![id, timestamp, actor],
    )?;
    get(conn, id)
}

pub fn create(
    conn: &mut Connection,
    input: CreateCollectionInput,
    actor: &str,
) -> Result<Collection, AppError> {
    let (name, normalized) = normalized_name(&input.name)?;
    let description = description(input.description)?;
    let (source_kind, source_key) = validate_source(&input.source_kind, input.source_key)?;
    let timestamp = now();
    let id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE normalizedName=?1)",
        [&normalized],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::General("collection_name_duplicate".into()));
    }
    tx.execute("INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,1,?8)", params![id,name,normalized,description,source_kind,source_key,timestamp,actor])?;
    tx.execute("DELETE FROM collection_tombstones WHERE id=?1", [&id])?;
    let generation = mark_local_records_mutated(&tx, "collection-create")?;
    let value = get(&tx, &id)?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        &id,
        serde_json::to_value(&value).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    tx.commit()?;
    Ok(value)
}

pub fn update(
    conn: &mut Connection,
    id: &str,
    input: UpdateCollectionInput,
    actor: &str,
) -> Result<Collection, AppError> {
    let (name, normalized) = normalized_name(&input.name)?;
    let description = description(input.description)?;
    let timestamp = now();
    let tx = conn.transaction()?;
    let current = get(&tx, id)?;
    if current.rev != input.expected_rev {
        return Err(AppError::General("stale_collection".into()));
    }
    if current.name == name && current.description == description {
        tx.commit()?;
        return Ok(current);
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE normalizedName=?1 AND id<>?2)",
        params![normalized, id],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::General("collection_name_duplicate".into()));
    }
    tx.execute("UPDATE collections SET name=?2, normalizedName=?3, description=?4, updatedAt=?5, rev=rev+1, revActor=?6 WHERE id=?1", params![id,name,normalized,description,timestamp,actor])?;
    let generation = mark_local_records_mutated(&tx, "collection-update")?;
    let value = get(&tx, id)?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        id,
        serde_json::to_value(&value).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    tx.commit()?;
    Ok(value)
}

pub fn add_members(
    conn: &mut Connection,
    collection_id: &str,
    record_ids: Vec<String>,
    source_kind: &str,
    expected_rev: i64,
    actor: &str,
) -> Result<Vec<CollectionMember>, AppError> {
    if !matches!(source_kind, "manual" | "tmdb") {
        return Err(AppError::General("collection_source_invalid".into()));
    }
    let unique = record_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    let timestamp = now();
    let tx = conn.transaction()?;
    let collection = get(&tx, collection_id)?;
    if collection.rev != expected_rev {
        return Err(AppError::General("stale_collection".into()));
    }
    let existing_ids = all_members(&tx)?
        .into_iter()
        .filter(|item| item.collection_id == collection_id)
        .map(|item| item.record_id)
        .collect::<HashSet<_>>();
    let mut position = tx.query_row(
        "SELECT COALESCE(MAX(position),-1024)+1024 FROM collection_members WHERE collectionId=?1",
        [collection_id],
        |row| row.get::<_, i64>(0),
    )?;
    let mut added = Vec::new();
    for record_id in unique.into_iter().filter(|id| !existing_ids.contains(id)) {
        let exists = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
            [&record_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(AppError::General("collection_reference_invalid".into()));
        }
        let id = member_id(collection_id, &record_id);
        tx.execute("INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?6,1,?7)", params![id,collection_id,record_id,position,source_kind,timestamp,actor])?;
        tx.execute(
            "DELETE FROM collection_member_tombstones WHERE id=?1",
            [&id],
        )?;
        added.push(id);
        position += 1024;
    }
    if added.is_empty() {
        tx.commit()?;
        return Ok(all_members(conn)?
            .into_iter()
            .filter(|item| item.collection_id == collection_id)
            .collect());
    }
    let collection = bump_collection(&tx, collection_id, actor, &timestamp)?;
    let generation = mark_local_records_mutated(&tx, "collection-members-add")?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        collection_id,
        serde_json::to_value(&collection).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    for id in added {
        let member = tx.query_row(
            "SELECT * FROM collection_members WHERE id=?1",
            [&id],
            map_member,
        )?;
        crate::sync_staging::stage_entity_upsert(
            &tx,
            "collection-member",
            &id,
            serde_json::to_value(&member).map_err(|error| AppError::General(error.to_string()))?,
            generation,
        )?;
    }
    let result = all_members(&tx)?
        .into_iter()
        .filter(|item| item.collection_id == collection_id)
        .collect();
    tx.commit()?;
    Ok(result)
}

pub fn remove_member(
    conn: &mut Connection,
    collection_id: &str,
    record_id: &str,
    expected_rev: i64,
    actor: &str,
) -> Result<(), AppError> {
    let id = member_id(collection_id, record_id);
    let timestamp = now();
    let tx = conn.transaction()?;
    let member = tx
        .query_row(
            "SELECT * FROM collection_members WHERE id=?1",
            [&id],
            map_member,
        )
        .optional()?
        .ok_or_else(|| AppError::General("collection_member_not_found".into()))?;
    if member.rev != expected_rev {
        return Err(AppError::General("stale_collection_member".into()));
    }
    tx.execute("DELETE FROM collection_members WHERE id=?1", [&id])?;
    tx.execute("INSERT INTO collection_member_tombstones(id,collectionId,recordId,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET deletedAt=excluded.deletedAt,rev=excluded.rev,revActor=excluded.revActor", params![id,collection_id,record_id,timestamp,member.rev+1,actor])?;
    let collection = bump_collection(&tx, collection_id, actor, &timestamp)?;
    let generation = mark_local_records_mutated(&tx, "collection-member-remove")?;
    crate::sync_staging::stage_entity_delete(&tx, "collection-member", &id, generation)?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        collection_id,
        serde_json::to_value(&collection).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    tx.commit()?;
    Ok(())
}

pub fn reorder(
    conn: &mut Connection,
    collection_id: &str,
    record_ids: Vec<String>,
    expected_rev: i64,
    actor: &str,
) -> Result<Vec<CollectionMember>, AppError> {
    let tx = conn.transaction()?;
    let collection = get(&tx, collection_id)?;
    if collection.rev != expected_rev {
        return Err(AppError::General("stale_collection".into()));
    }
    let current = all_members(&tx)?
        .into_iter()
        .filter(|item| item.collection_id == collection_id)
        .collect::<Vec<_>>();
    let current_ids = current
        .iter()
        .map(|item| item.record_id.clone())
        .collect::<HashSet<_>>();
    let requested = record_ids.iter().cloned().collect::<HashSet<_>>();
    if requested.len() != record_ids.len() || requested != current_ids {
        return Err(AppError::General("collection_order_invalid".into()));
    }
    let timestamp = now();
    let mut changed = Vec::new();
    let by_record = current
        .into_iter()
        .map(|item| (item.record_id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    for (index, record_id) in record_ids.iter().enumerate() {
        let member = &by_record[record_id];
        let position = index as i64 * 1024;
        if member.position != position {
            tx.execute("UPDATE collection_members SET position=?2,updatedAt=?3,rev=rev+1,revActor=?4 WHERE id=?1", params![member.id,position,timestamp,actor])?;
            changed.push(member.id.clone());
        }
    }
    if changed.is_empty() {
        tx.commit()?;
        return Ok(all_members(conn)?
            .into_iter()
            .filter(|item| item.collection_id == collection_id)
            .collect());
    }
    let collection = bump_collection(&tx, collection_id, actor, &timestamp)?;
    let generation = mark_local_records_mutated(&tx, "collection-members-reorder")?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        collection_id,
        serde_json::to_value(&collection).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    for id in changed {
        let member = tx.query_row(
            "SELECT * FROM collection_members WHERE id=?1",
            [&id],
            map_member,
        )?;
        crate::sync_staging::stage_entity_upsert(
            &tx,
            "collection-member",
            &id,
            serde_json::to_value(&member).map_err(|error| AppError::General(error.to_string()))?,
            generation,
        )?;
    }
    let result = all_members(&tx)?
        .into_iter()
        .filter(|item| item.collection_id == collection_id)
        .collect();
    tx.commit()?;
    Ok(result)
}

pub fn delete(
    conn: &mut Connection,
    id: &str,
    expected_rev: i64,
    actor: &str,
) -> Result<(), AppError> {
    let timestamp = now();
    let tx = conn.transaction()?;
    let collection = get(&tx, id)?;
    if collection.rev != expected_rev {
        return Err(AppError::General("stale_collection".into()));
    }
    let members = all_members(&tx)?
        .into_iter()
        .filter(|item| item.collection_id == id)
        .collect::<Vec<_>>();
    tx.execute("DELETE FROM collections WHERE id=?1", [id])?;
    tx.execute("INSERT INTO collection_tombstones(id,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET deletedAt=excluded.deletedAt,rev=excluded.rev,revActor=excluded.revActor", params![id,timestamp,collection.rev+1,actor])?;
    for member in &members {
        tx.execute("INSERT INTO collection_member_tombstones(id,collectionId,recordId,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET deletedAt=excluded.deletedAt,rev=excluded.rev,revActor=excluded.revActor", params![member.id,member.collection_id,member.record_id,timestamp,member.rev+1,actor])?;
    }
    let generation = mark_local_records_mutated(&tx, "collection-delete")?;
    crate::sync_staging::stage_entity_delete(&tx, "collection", id, generation)?;
    for member in members {
        crate::sync_staging::stage_entity_delete(&tx, "collection-member", &member.id, generation)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn detach_record_tx(
    conn: &Connection,
    record_id: &str,
    actor: &str,
) -> Result<(Vec<String>, Vec<Collection>), AppError> {
    let timestamp = now();
    let members = all_members(conn)?
        .into_iter()
        .filter(|item| item.record_id == record_id)
        .collect::<Vec<_>>();
    let mut changed_collections = Vec::new();
    for member in &members {
        conn.execute("DELETE FROM collection_members WHERE id=?1", [&member.id])?;
        conn.execute("INSERT INTO collection_member_tombstones(id,collectionId,recordId,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET deletedAt=excluded.deletedAt,rev=excluded.rev,revActor=excluded.revActor", params![member.id,member.collection_id,member.record_id,timestamp,member.rev+1,actor])?;
        changed_collections.push(bump_collection(
            conn,
            &member.collection_id,
            actor,
            &timestamp,
        )?);
    }
    Ok((
        members.into_iter().map(|item| item.id).collect(),
        changed_collections,
    ))
}

pub fn reconcile_after_record_replace_tx(
    conn: &Connection,
    previous: &[CollectionMember],
    actor: &str,
) -> Result<(), AppError> {
    let timestamp = now();
    let record_ids = crate::db::get_all_records(conn)?
        .into_iter()
        .map(|item| item.id)
        .collect::<HashSet<_>>();
    for member in previous {
        if record_ids.contains(&member.record_id) {
            conn.execute("INSERT OR IGNORE INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![member.id,member.collection_id,member.record_id,member.position,member.source_kind,member.created_at,member.updated_at,member.rev,member.rev_actor])?;
        } else {
            conn.execute("INSERT INTO collection_member_tombstones(id,collectionId,recordId,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET deletedAt=excluded.deletedAt,rev=excluded.rev,revActor=excluded.revActor", params![member.id,member.collection_id,member.record_id,timestamp,member.rev+1,actor])?;
            bump_collection(conn, &member.collection_id, actor, &timestamp)?;
        }
    }
    Ok(())
}

pub fn replace_all_tx(
    conn: &Connection,
    collections: &[Collection],
    members: &[CollectionMember],
    tombstones: &[CollectionTombstone],
    member_tombstones: &[CollectionMemberTombstone],
) -> Result<(), AppError> {
    let record_ids = crate::db::get_all_records(conn)?
        .into_iter()
        .map(|item| item.id)
        .collect::<HashSet<_>>();
    let collection_ids = collections
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    if collection_ids.len() != collections.len()
        || members.iter().any(|item| {
            !collection_ids.contains(&item.collection_id)
                || !record_ids.contains(&item.record_id)
                || item.id != member_id(&item.collection_id, &item.record_id)
                || item.position < 0
        })
    {
        return Err(AppError::General("collection_reference_invalid".into()));
    }
    conn.execute("DELETE FROM collection_members", [])?;
    conn.execute("DELETE FROM collections", [])?;
    conn.execute("DELETE FROM collection_tombstones", [])?;
    conn.execute("DELETE FROM collection_member_tombstones", [])?;
    for item in collections {
        let (name, normalized) = normalized_name(&item.name)?;
        let desc = description(item.description.clone())?;
        let (source_kind, source_key) =
            validate_source(&item.source_kind, item.source_key.clone())?;
        conn.execute("INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![item.id,name,normalized,desc,source_kind,source_key,item.created_at,item.updated_at,item.rev,item.rev_actor])?;
    }
    for item in members {
        conn.execute("INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![item.id,item.collection_id,item.record_id,item.position,item.source_kind,item.created_at,item.updated_at,item.rev,item.rev_actor])?;
    }
    for item in tombstones {
        conn.execute(
            "INSERT INTO collection_tombstones(id,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4)",
            params![item.id, item.deleted_at, item.rev, item.rev_actor],
        )?;
    }
    for item in member_tombstones {
        conn.execute("INSERT INTO collection_member_tombstones(id,collectionId,recordId,deletedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6)", params![item.id,item.collection_id,item.record_id,item.deleted_at,item.rev,item.rev_actor])?;
    }
    Ok(())
}

pub fn replace_library_atomic(
    conn: &mut Connection,
    records: Vec<crate::models::WatchRecord>,
    completions: Vec<crate::episode_history::EpisodeCompletion>,
    collections: Vec<Collection>,
    members: Vec<CollectionMember>,
) -> Result<(), AppError> {
    let transaction = conn.transaction()?;
    let locked_ids = transaction
        .prepare("SELECT id FROM records WHERE isLocked=1")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<HashSet<String>>>()?;
    let records = crate::record_validation::prepare_import_batch(
        records
            .into_iter()
            .filter(|record| !locked_ids.contains(&record.id))
            .collect(),
    )?;
    crate::db::replace_all_records_tx(&transaction, records)?;
    crate::episode_history::replace_completions_tx(&transaction, &completions, &locked_ids)?;
    replace_all_tx(&transaction, &collections, &members, &[], &[])?;
    let generation = mark_local_records_mutated(&transaction, "library-import-v3")?;
    crate::sync_staging::rebuild_from_current(&transaction, generation)?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> crate::models::WatchRecord {
        serde_json::from_value(serde_json::json!({
            "id": id, "originalName": "", "chineseName": id, "progress": "",
            "status": "未看", "platform": "", "startDate": "", "endDate": "",
            "notes": "", "createdAt": "2026-01-01T00:00:00Z", "mediaType": "电影",
            "rev": 1, "revActor": "fixture"
        }))
        .unwrap()
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::setup_db(&conn).unwrap();
        crate::db::insert_record(&conn, record("one")).unwrap();
        crate::db::insert_record(&conn, record("two")).unwrap();
        conn
    }

    #[test]
    fn schema_is_v18_feature_migration() {
        let conn = database();
        assert!(schema_ready(&conn).unwrap());
        assert_eq!(
            crate::db::get_setting(&conn, "db_version".into())
                .unwrap()
                .as_deref(),
            Some("18")
        );
        assert!(
            crate::db::get_setting(&conn, "required_app_features_v1".into())
                .unwrap()
                .unwrap()
                .contains("collections-v1")
        );
    }

    #[test]
    fn collection_crud_membership_and_order_are_atomic() {
        let mut conn = database();
        let collection = create(
            &mut conn,
            CreateCollectionInput {
                name: "  诺兰   作品 ".into(),
                description: None,
                source_kind: "manual".into(),
                source_key: None,
            },
            "device",
        )
        .unwrap();
        assert_eq!(collection.name, "诺兰 作品");
        let members = add_members(
            &mut conn,
            &collection.id,
            vec!["one".into(), "two".into()],
            "manual",
            collection.rev,
            "device",
        )
        .unwrap();
        assert_eq!(members.len(), 2);
        let current = all(&conn).unwrap().remove(0);
        let reordered = reorder(
            &mut conn,
            &current.id,
            vec!["two".into(), "one".into()],
            current.rev,
            "device",
        )
        .unwrap();
        assert_eq!(reordered[0].record_id, "two");
        let current = all(&conn).unwrap().remove(0);
        delete(&mut conn, &current.id, current.rev, "device").unwrap();
        assert!(all(&conn).unwrap().is_empty());
        assert_eq!(crate::db::get_all_records(&conn).unwrap().len(), 2);
        assert_eq!(collection_tombstones(&conn).unwrap().len(), 1);
        assert_eq!(member_tombstones(&conn).unwrap().len(), 2);
    }

    #[test]
    fn duplicate_name_and_stale_revision_do_not_write() {
        let mut conn = database();
        let collection = create(
            &mut conn,
            CreateCollectionInput {
                name: "系列".into(),
                description: None,
                source_kind: "manual".into(),
                source_key: None,
            },
            "device",
        )
        .unwrap();
        let duplicate = create(
            &mut conn,
            CreateCollectionInput {
                name: " 系列 ".into(),
                description: None,
                source_kind: "manual".into(),
                source_key: None,
            },
            "device",
        )
        .unwrap_err();
        assert!(duplicate.to_string().contains("collection_name_duplicate"));
        let stale = update(
            &mut conn,
            &collection.id,
            UpdateCollectionInput {
                name: "新名称".into(),
                description: None,
                expected_rev: 0,
            },
            "device",
        )
        .unwrap_err();
        assert!(stale.to_string().contains("stale_collection"));
        assert_eq!(all(&conn).unwrap()[0].name, "系列");
    }
}
