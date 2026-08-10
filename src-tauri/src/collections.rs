use crate::db_atomic_helpers::mark_local_records_mutated;
use crate::error::AppError;
use crate::models::WatchRecord;
use crate::record_validation::{prepare_record, RecordWriteContext};
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
    #[serde(default = "manual_collection_kind")]
    pub collection_kind: String,
    #[serde(default = "manual_order_mode")]
    pub order_mode: String,
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
    #[serde(default)]
    pub collection_kind: Option<String>,
    #[serde(default)]
    pub order_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCollectionInput {
    pub name: String,
    pub description: Option<String>,
    pub expected_rev: i64,
    #[serde(default)]
    pub order_mode: Option<String>,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_key: Option<String>,
    #[serde(default)]
    pub collection_kind: Option<String>,
}

fn manual_source() -> String {
    "manual".to_string()
}

fn manual_collection_kind() -> String {
    "manual".to_string()
}
fn manual_order_mode() -> String {
    "manual".to_string()
}

fn collection_behavior(
    source_kind: &str,
    collection_kind: Option<String>,
    order_mode: Option<String>,
) -> Result<(String, String), AppError> {
    let inferred_kind = match source_kind {
        "tmdb-tv-show" => "tv-series",
        "tmdb-movie-collection" => "movie-series",
        _ => "manual",
    };
    let kind = collection_kind.unwrap_or_else(|| inferred_kind.to_string());
    if !matches!(
        kind.as_str(),
        "manual" | "tv-series" | "movie-series" | "universe"
    ) {
        return Err(AppError::General("collection_kind_invalid".into()));
    }
    let mode = order_mode.unwrap_or_else(|| {
        if source_kind == "manual" {
            "manual"
        } else {
            "chronological"
        }
        .to_string()
    });
    if !matches!(mode.as_str(), "manual" | "chronological") {
        return Err(AppError::General("collection_order_mode_invalid".into()));
    }
    Ok((kind, mode))
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
    let identity_marker = conn
        .query_row(
            "SELECT value FROM settings WHERE key='tmdb_identity_schema_version'",
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
    let columns = if tables.contains("collections") {
        let mut statement = conn.prepare("SELECT name FROM pragma_table_info('collections')")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        values
    } else {
        HashSet::new()
    };
    let record_columns = {
        let mut statement = conn.prepare("SELECT name FROM pragma_table_info('records')")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        values
    };
    Ok(marker.as_deref() == Some("2")
        && identity_marker.as_deref() == Some("1")
        && required.iter().all(|name| tables.contains(*name))
        && columns.contains("collectionKind")
        && columns.contains("orderMode")
        && [
            "tmdbMediaKind",
            "tmdbId",
            "tmdbParentId",
            "tmdbSeasonNumber",
            "seriesRecordKind",
        ]
        .iter()
        .all(|name| record_columns.contains(*name)))
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
           collectionKind TEXT NOT NULL DEFAULT 'manual' CHECK(collectionKind IN ('manual','tv-series','movie-series','universe')),
           orderMode TEXT NOT NULL DEFAULT 'manual' CHECK(orderMode IN ('manual','chronological')),
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
         ",
    )?;
    let columns = {
        let mut statement =
            transaction.prepare("SELECT name FROM pragma_table_info('collections')")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        values
    };
    if !columns.contains("collectionKind") {
        transaction.execute("ALTER TABLE collections ADD COLUMN collectionKind TEXT NOT NULL DEFAULT 'manual' CHECK(collectionKind IN ('manual','tv-series','movie-series','universe'))", [])?;
    }
    if !columns.contains("orderMode") {
        transaction.execute("ALTER TABLE collections ADD COLUMN orderMode TEXT NOT NULL DEFAULT 'manual' CHECK(orderMode IN ('manual','chronological'))", [])?;
    }
    let record_columns = {
        let mut statement = transaction.prepare("SELECT name FROM pragma_table_info('records')")?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        values
    };
    for (name, definition) in [
        (
            "tmdbMediaKind",
            "TEXT CHECK(tmdbMediaKind IN ('movie','tv','tv-season'))",
        ),
        ("tmdbId", "INTEGER"),
        ("tmdbParentId", "INTEGER"),
        ("tmdbSeasonNumber", "INTEGER CHECK(tmdbSeasonNumber >= 0)"),
        (
            "seriesRecordKind",
            "TEXT CHECK(seriesRecordKind IN ('season','whole-series','single-work'))",
        ),
    ] {
        if !record_columns.contains(name) {
            transaction.execute(
                &format!("ALTER TABLE records ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    transaction.execute("INSERT INTO settings(key,value) VALUES('tmdb_identity_schema_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])?;
    transaction.execute("UPDATE collections SET collectionKind=CASE sourceKind WHEN 'tmdb-tv-show' THEN 'tv-series' WHEN 'tmdb-movie-collection' THEN 'movie-series' ELSE collectionKind END, orderMode=CASE WHEN sourceKind='manual' THEN orderMode ELSE 'chronological' END", [])?;
    transaction.execute("INSERT INTO settings(key,value) VALUES('collections_schema_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])?;
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
    if !features.iter().any(|feature| feature == "collections-v2") {
        features.push("collections-v2".into());
    }
    if !features
        .iter()
        .any(|feature| feature == "series-identity-v1")
    {
        features.push("series-identity-v1".into());
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
        collection_kind: row
            .get("collectionKind")
            .unwrap_or_else(|_| "manual".to_string()),
        order_mode: row
            .get("orderMode")
            .unwrap_or_else(|_| "manual".to_string()),
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
    let (collection_kind, order_mode) =
        collection_behavior(&source_kind, input.collection_kind, input.order_mode)?;
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
    tx.execute("INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,collectionKind,orderMode,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,1,?10)", params![id,name,normalized,description,source_kind,source_key,collection_kind,order_mode,timestamp,actor])?;
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

pub fn create_for_record(
    conn: &mut Connection,
    input: CreateCollectionInput,
    record_id: &str,
    actor: &str,
) -> Result<Collection, AppError> {
    let (name, normalized) = normalized_name(&input.name)?;
    let description = description(input.description)?;
    let (source_kind, source_key) = validate_source(&input.source_kind, input.source_key)?;
    let (collection_kind, order_mode) =
        collection_behavior(&source_kind, input.collection_kind, input.order_mode)?;
    let timestamp = now();
    let id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
        [record_id],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::General("collection_reference_invalid".into()));
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE normalizedName=?1)",
        [&normalized],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::General("collection_name_duplicate".into()));
    }
    tx.execute("INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,collectionKind,orderMode,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,1,?10)", params![id,name,normalized,description,source_kind,source_key,collection_kind,order_mode,timestamp,actor])?;
    let member_id = member_id(&id, record_id);
    tx.execute("INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,0,'manual',?4,?4,1,?5)", params![member_id,id,record_id,timestamp,actor])?;
    tx.execute("DELETE FROM collection_tombstones WHERE id=?1", [&id])?;
    tx.execute(
        "DELETE FROM collection_member_tombstones WHERE id=?1",
        [&member_id],
    )?;
    let generation = mark_local_records_mutated(&tx, "collection-create-for-record")?;
    let value = get(&tx, &id)?;
    let member = tx.query_row(
        "SELECT * FROM collection_members WHERE id=?1",
        [&member_id],
        map_member,
    )?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        &id,
        serde_json::to_value(&value).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection-member",
        &member_id,
        serde_json::to_value(&member).map_err(|error| AppError::General(error.to_string()))?,
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
    let source_kind = input
        .source_kind
        .unwrap_or_else(|| current.source_kind.clone());
    let source_key = if source_kind == current.source_kind && input.source_key.is_none() {
        current.source_key.clone()
    } else {
        input.source_key
    };
    let (source_kind, source_key) = validate_source(&source_kind, source_key)?;
    let (collection_kind, order_mode) = collection_behavior(
        &source_kind,
        Some(
            input
                .collection_kind
                .unwrap_or_else(|| current.collection_kind.clone()),
        ),
        Some(
            input
                .order_mode
                .unwrap_or_else(|| current.order_mode.clone()),
        ),
    )?;
    if current.name == name
        && current.description == description
        && current.source_kind == source_kind
        && current.source_key == source_key
        && current.collection_kind == collection_kind
        && current.order_mode == order_mode
    {
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
    tx.execute("UPDATE collections SET name=?2, normalizedName=?3, description=?4, sourceKind=?5, sourceKey=?6, collectionKind=?7, orderMode=?8, updatedAt=?9, rev=rev+1, revActor=?10 WHERE id=?1", params![id,name,normalized,description,source_kind,source_key,collection_kind,order_mode,timestamp,actor])?;
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
    // Preserve the caller's order while still dropping duplicate IDs.
    let mut seen = HashSet::new();
    let unique = record_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect::<Vec<_>>();
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

pub fn create_records_with_members(
    conn: &mut Connection,
    collection_id: &str,
    records: Vec<WatchRecord>,
    expected_rev: i64,
    actor: &str,
) -> Result<Vec<WatchRecord>, AppError> {
    if records.is_empty() || records.len() > 100 {
        return Err(AppError::General("missing_seasons_batch_invalid".into()));
    }
    let timestamp = now();
    let tx = conn.transaction()?;
    let collection = get(&tx, collection_id)?;
    if collection.rev != expected_rev {
        return Err(AppError::General("stale_collection".into()));
    }
    let mut seen_ids = HashSet::new();
    let mut prepared = Vec::with_capacity(records.len());
    for record in records {
        let mut record = prepare_record(record, RecordWriteContext::Local)?;
        if !seen_ids.insert(record.id.clone())
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
                [&record.id],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Err(AppError::General("missing_season_duplicate".into()));
        }
        if let (Some(parent_id), Some(season_number)) =
            (record.tmdb_parent_id, record.tmdb_season_number)
        {
            let duplicate = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM records r JOIN collection_members m ON m.recordId=r.id WHERE m.collectionId=?1 AND r.tmdbParentId=?2 AND r.tmdbSeasonNumber=?3)",
                params![collection_id, parent_id, season_number],
                |row| row.get::<_, bool>(0),
            )?;
            if duplicate
                || prepared.iter().any(|item: &WatchRecord| {
                    item.tmdb_parent_id == Some(parent_id)
                        && item.tmdb_season_number == Some(season_number)
                })
            {
                return Err(AppError::General("missing_season_duplicate".into()));
            }
        }
        record.rev = 1;
        record.rev_actor = actor.to_string();
        record.updated_at = Some(timestamp.clone());
        prepared.push(record);
    }
    let mut position = tx.query_row(
        "SELECT COALESCE(MAX(position),-1024)+1024 FROM collection_members WHERE collectionId=?1",
        [collection_id],
        |row| row.get::<_, i64>(0),
    )?;
    let mut created_members = Vec::with_capacity(prepared.len());
    for record in &prepared {
        crate::db::insert_record(&tx, record.clone())?;
        let id = member_id(collection_id, &record.id);
        tx.execute("INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,'tmdb',?5,?5,1,?6)", params![id, collection_id, record.id, position, timestamp, actor])?;
        created_members.push(tx.query_row(
            "SELECT * FROM collection_members WHERE id=?1",
            [&id],
            map_member,
        )?);
        position += 1024;
    }
    let collection = bump_collection(&tx, collection_id, actor, &timestamp)?;
    let generation = mark_local_records_mutated(&tx, "series-completion")?;
    crate::sync_staging::stage_entity_upsert(
        &tx,
        "collection",
        collection_id,
        serde_json::to_value(collection).map_err(|error| AppError::General(error.to_string()))?,
        generation,
    )?;
    for record in &prepared {
        crate::sync_staging::stage_upsert(&tx, record, generation)?;
    }
    for member in &created_members {
        crate::sync_staging::stage_entity_upsert(
            &tx,
            "collection-member",
            &member.id,
            serde_json::to_value(member).map_err(|error| AppError::General(error.to_string()))?,
            generation,
        )?;
    }
    tx.commit()?;
    Ok(prepared)
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
        let (collection_kind, order_mode) = collection_behavior(
            &source_kind,
            Some(item.collection_kind.clone()),
            Some(item.order_mode.clone()),
        )?;
        conn.execute("INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,collectionKind,orderMode,createdAt,updatedAt,rev,revActor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)", params![item.id,name,normalized,desc,source_kind,source_key,collection_kind,order_mode,item.created_at,item.updated_at,item.rev,item.rev_actor])?;
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
                collection_kind: None,
                order_mode: None,
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
    fn record_editor_collection_creation_commits_collection_and_member_together() {
        let mut conn = database();
        let collection = create_for_record(
            &mut conn,
            CreateCollectionInput {
                name: "权力的游戏".into(),
                description: None,
                source_kind: "manual".into(),
                source_key: None,
                collection_kind: Some("tv-series".into()),
                order_mode: Some("chronological".into()),
            },
            "one",
            "device",
        )
        .unwrap();
        assert_eq!(collection.collection_kind, "tv-series");
        let members = all_members(&conn).unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].record_id, "one");
        let before = all(&conn).unwrap();
        let error = create_for_record(
            &mut conn,
            CreateCollectionInput {
                name: "无效引用".into(),
                description: None,
                source_kind: "manual".into(),
                source_key: None,
                collection_kind: None,
                order_mode: None,
            },
            "missing",
            "device",
        )
        .unwrap_err();
        assert!(error.to_string().contains("collection_reference_invalid"));
        assert_eq!(all(&conn).unwrap(), before);
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
                collection_kind: None,
                order_mode: None,
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
                collection_kind: None,
                order_mode: None,
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
                order_mode: None,
                source_kind: None,
                source_key: None,
                collection_kind: None,
            },
            "device",
        )
        .unwrap_err();
        assert!(stale.to_string().contains("stale_collection"));
        assert_eq!(all(&conn).unwrap()[0].name, "系列");
    }

    #[test]
    fn missing_seasons_create_atomically_and_reject_stable_identity_duplicates() {
        let mut conn = database();
        let collection = create(
            &mut conn,
            CreateCollectionInput {
                name: "测试剧".into(),
                description: None,
                source_kind: "tmdb-tv-show".into(),
                source_key: Some("tmdb:tv-show:42".into()),
                collection_kind: None,
                order_mode: None,
            },
            "device",
        )
        .unwrap();
        let before_generation = crate::db_atomic_helpers::get_records_generation(&conn).unwrap();
        let mut first = record("season-1");
        first.media_type = "剧集".into();
        first.tmdb_media_kind = Some("tv-season".into());
        first.tmdb_id = Some(101);
        first.tmdb_parent_id = Some(42);
        first.tmdb_season_number = Some(1);
        first.series_record_kind = Some("season".into());
        let created = create_records_with_members(
            &mut conn,
            &collection.id,
            vec![first],
            collection.rev,
            "device",
        )
        .unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(
            crate::db_atomic_helpers::get_records_generation(&conn).unwrap(),
            before_generation + 1
        );
        let current = all(&conn)
            .unwrap()
            .into_iter()
            .find(|item| item.id == collection.id)
            .unwrap();
        let before_count = crate::db::get_all_records(&conn).unwrap().len();
        let before_generation = crate::db_atomic_helpers::get_records_generation(&conn).unwrap();
        let mut duplicate = record("season-1-copy");
        duplicate.media_type = "剧集".into();
        duplicate.tmdb_media_kind = Some("tv-season".into());
        duplicate.tmdb_id = Some(999);
        duplicate.tmdb_parent_id = Some(42);
        duplicate.tmdb_season_number = Some(1);
        duplicate.series_record_kind = Some("season".into());
        assert!(create_records_with_members(
            &mut conn,
            &current.id,
            vec![duplicate],
            current.rev,
            "device"
        )
        .is_err());
        assert_eq!(
            crate::db::get_all_records(&conn).unwrap().len(),
            before_count
        );
        assert_eq!(
            crate::db_atomic_helpers::get_records_generation(&conn).unwrap(),
            before_generation
        );
    }
}
