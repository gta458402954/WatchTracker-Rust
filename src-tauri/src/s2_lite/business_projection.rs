//! Explicit remote S2 business-table writes. None of these functions stage a
//! local mutation, advance `records_generation`, or create S1 publish state.

use std::collections::BTreeSet;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::collections::{Collection, CollectionMember};
use crate::episode_history::EpisodeCompletion;
use crate::error::AppError;
use crate::models::WatchRecord;

use super::canonical::{jcs_bytes, ProtocolError, Result as ProtocolResult};
use super::durable_persistence::{
    BusinessProjectionTransactionResultV1, DurableMaterializedProjectionV1, SqliteS2LiteStoreV1,
};
use super::materialized_projection::MaterializedProjectionEntityV1;

/// Local-only diagnostic for every canonical entity processed by the business
/// projector. These outcomes have no protocol or receipt authority.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BusinessProjectionOutcomeV1 {
    AppliedRemoteValue,
    AppliedRemoteTombstone,
    OverlayPreserved,
    ConflictPreserved,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BusinessProjectionReportV1 {
    pub generation: u64,
    pub outcomes: Vec<BusinessProjectionOutcomeV1>,
}

fn failure(_: crate::error::AppError) -> ProtocolError {
    ProtocolError("business_projection_failed")
}

fn key_id(key: &Value) -> ProtocolResult<Vec<u8>> {
    jcs_bytes(key)
}

fn key_parts(key: &Value) -> ProtocolResult<(&str, &[Value])> {
    let values = key
        .as_array()
        .ok_or(ProtocolError("projector_invalid_entity_key"))?;
    let (kind, rest) = values
        .split_first()
        .ok_or(ProtocolError("projector_invalid_entity_key"))?;
    Ok((
        kind.as_str()
            .ok_or(ProtocolError("projector_invalid_entity_key"))?,
        rest,
    ))
}

fn key_string(value: &Value) -> ProtocolResult<&str> {
    value
        .as_str()
        .ok_or(ProtocolError("projector_invalid_entity_key"))
}

fn key_episode(value: &Value) -> ProtocolResult<i32> {
    value
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(ProtocolError("projector_invalid_entity_key"))
}

fn apply_live(conn: &Connection, entity: &MaterializedProjectionEntityV1) -> ProtocolResult<()> {
    let value = entity
        .business_value
        .clone()
        .ok_or(ProtocolError("projector_live_value_missing"))?;
    let (kind, key) = key_parts(&entity.entity_key)?;
    match kind {
        "record" if key.len() == 1 => remote_upsert_record_no_stage_tx(
            conn,
            serde_json::from_value(value)
                .map_err(|_| ProtocolError("projector_record_value_invalid"))?,
        )
        .map_err(failure),
        "collection" if key.len() == 1 => remote_upsert_collection_no_stage_tx(
            conn,
            &serde_json::from_value(value)
                .map_err(|_| ProtocolError("projector_collection_value_invalid"))?,
        )
        .map_err(failure),
        "collection-member" if key.len() == 2 => remote_upsert_member_no_stage_tx(
            conn,
            &serde_json::from_value(value)
                .map_err(|_| ProtocolError("projector_member_value_invalid"))?,
        )
        .map_err(failure),
        "episode-completion" if key.len() == 2 => remote_upsert_episode_completion_no_stage_tx(
            conn,
            &serde_json::from_value(value)
                .map_err(|_| ProtocolError("projector_completion_value_invalid"))?,
        )
        .map_err(failure),
        _ => Err(ProtocolError("projector_invalid_entity_key")),
    }
}

fn apply_tombstone(
    conn: &Connection,
    entity: &MaterializedProjectionEntityV1,
) -> ProtocolResult<()> {
    let (kind, key) = key_parts(&entity.entity_key)?;
    match kind {
        "record" if key.len() == 1 => {
            remote_delete_record_no_stage_tx(conn, key_string(&key[0])?).map_err(failure)
        }
        "collection" if key.len() == 1 => {
            remote_delete_collection_no_stage_tx(conn, key_string(&key[0])?).map_err(failure)
        }
        "collection-member" if key.len() == 2 => {
            remote_delete_member_no_stage_tx(conn, key_string(&key[0])?, key_string(&key[1])?)
                .map_err(failure)
        }
        "episode-completion" if key.len() == 2 => remote_delete_episode_completion_no_stage_tx(
            conn,
            key_string(&key[0])?,
            key_episode(&key[1])?,
        )
        .map_err(failure),
        _ => Err(ProtocolError("projector_invalid_entity_key")),
    }
}

/// Applies exactly one complete durable projection. Local staging is an
/// overlay: it blocks the matching canonical entity but is never modified or
/// acknowledged here.
pub fn apply_complete_projection_v1(
    store: &mut SqliteS2LiteStoreV1<'_>,
    expected_projection_generation: u64,
) -> ProtocolResult<(
    BusinessProjectionTransactionResultV1,
    Option<BusinessProjectionReportV1>,
)> {
    store.run_business_projection_transaction(
        expected_projection_generation,
        |conn, projection: &DurableMaterializedProjectionV1| {
            let staging = crate::sync_staging::get_staging(conn).map_err(failure)?;
            let overlays = staging
                .entries
                .iter()
                .map(|entry| {
                    crate::sync_staging::staged_entry_entity_key(entry)
                        .map_err(failure)
                        .and_then(|key| key_id(&key))
                })
                .collect::<ProtocolResult<BTreeSet<_>>>()?;
            let relation_conflicts = projection
                .state
                .relation_blocked_entity_keys
                .iter()
                .map(key_id)
                .collect::<ProtocolResult<BTreeSet<_>>>()?;
            let mut outcomes = Vec::with_capacity(projection.state.entities.len());
            for entity in &projection.state.entities {
                let id = key_id(&entity.entity_key)?;
                let outcome = if entity.conflict || relation_conflicts.contains(&id) {
                    BusinessProjectionOutcomeV1::ConflictPreserved
                } else if overlays.contains(&id) {
                    BusinessProjectionOutcomeV1::OverlayPreserved
                } else if entity
                    .semantic_state
                    .as_ref()
                    .is_some_and(|state| state["state"] == "live")
                {
                    apply_live(conn, entity)?;
                    BusinessProjectionOutcomeV1::AppliedRemoteValue
                } else if entity
                    .semantic_state
                    .as_ref()
                    .is_some_and(|state| state["state"] == "tombstone")
                {
                    apply_tombstone(conn, entity)?;
                    BusinessProjectionOutcomeV1::AppliedRemoteTombstone
                } else {
                    return Err(ProtocolError("projector_unresolved_entity"));
                };
                outcomes.push(outcome);
            }
            Ok(BusinessProjectionReportV1 {
                generation: expected_projection_generation,
                outcomes,
            })
        },
    )
}

pub fn remote_upsert_record_no_stage_tx(
    conn: &Connection,
    value: WatchRecord,
) -> Result<(), AppError> {
    crate::db::insert_record(conn, value)?;
    Ok(())
}

pub fn remote_delete_record_no_stage_tx(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM records WHERE id=?1", [id])?;
    Ok(())
}

pub fn remote_upsert_collection_no_stage_tx(
    conn: &Connection,
    value: &Collection,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO collections(id,name,normalizedName,description,sourceKind,sourceKey,collectionKind,orderMode,createdAt,updatedAt,rev,revActor)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalizedName=excluded.normalizedName,description=excluded.description,sourceKind=excluded.sourceKind,sourceKey=excluded.sourceKey,collectionKind=excluded.collectionKind,orderMode=excluded.orderMode,updatedAt=excluded.updatedAt,rev=excluded.rev,revActor=excluded.revActor",
        params![value.id,value.name,value.normalized_name,value.description,value.source_kind,value.source_key,value.collection_kind,value.order_mode,value.created_at,value.updated_at,value.rev,value.rev_actor],
    )?;
    Ok(())
}

pub fn remote_delete_collection_no_stage_tx(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM collection_members WHERE collectionId=?1", [id])?;
    conn.execute("DELETE FROM collections WHERE id=?1", [id])?;
    Ok(())
}

pub fn remote_upsert_member_no_stage_tx(
    conn: &Connection,
    value: &CollectionMember,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO collection_members(id,collectionId,recordId,position,sourceKind,createdAt,updatedAt,rev,revActor)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET collectionId=excluded.collectionId,recordId=excluded.recordId,position=excluded.position,sourceKind=excluded.sourceKind,updatedAt=excluded.updatedAt,rev=excluded.rev,revActor=excluded.revActor",
        params![value.id,value.collection_id,value.record_id,value.position,value.source_kind,value.created_at,value.updated_at,value.rev,value.rev_actor],
    )?;
    Ok(())
}

pub fn remote_delete_member_no_stage_tx(
    conn: &Connection,
    collection_id: &str,
    record_id: &str,
) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM collection_members WHERE collectionId=?1 AND recordId=?2",
        params![collection_id, record_id],
    )?;
    Ok(())
}

pub fn remote_upsert_episode_completion_no_stage_tx(
    conn: &Connection,
    value: &EpisodeCompletion,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO episode_completions(id,recordId,episodeNumber,completedAt,createdAt,updatedAt,rev,revActor)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(recordId,episodeNumber) DO UPDATE SET id=excluded.id,completedAt=excluded.completedAt,updatedAt=excluded.updatedAt,rev=excluded.rev,revActor=excluded.revActor",
        params![value.id,value.record_id,value.episode_number,value.completed_at,value.created_at,value.updated_at,value.rev,value.rev_actor],
    )?;
    Ok(())
}

pub fn remote_delete_episode_completion_no_stage_tx(
    conn: &Connection,
    record_id: &str,
    episode_number: i32,
) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM episode_completions WHERE recordId=?1 AND episodeNumber=?2",
        params![record_id, episode_number],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::Connection;
    use serde_json::json;

    use super::super::durable_persistence::{DesktopRootStateV1, DurableMaterializedProjectionV1};
    use super::super::materialized_projection::{
        MaterializedProjectionEntityV1, MaterializedProjectionStateV1,
        MaterializedProjectionStatusV1,
    };
    use super::super::remote_discovery::create_discovery_state_v1;
    use super::*;
    use crate::sync_staging::{set_staging, StagedRecord, SyncStaging};

    const ROOT: &str = "s2-root-v1:business-projection-test";

    fn entity(
        key: Value,
        semantic: Value,
        business: Option<Value>,
    ) -> MaterializedProjectionEntityV1 {
        MaterializedProjectionEntityV1 {
            entity_key: key,
            semantic_state: Some(semantic),
            business_value: business,
            frontier: vec![],
            conflict: false,
        }
    }

    fn record(id: &str, name: &str) -> Value {
        json!({"id":id,"originalName":name,"chineseName":"","progress":"","totalEpisodes":2,"episodeTrackingEnabled":false,"nextEpisode":null,"movieProgress":null,"movieDuration":null,"releaseYear":null,"posterPath":null,"status":"未看","platform":"","rating":null,"startDate":null,"endDate":null,"notes":"","createdAt":"2026-09-17T00:00:00Z","updatedAt":null,"imdbId":null,"isLocked":false,"genres":null,"originCountry":null,"imdbRating":null,"tmdbStatus":null,"interestLevel":null,"episodeRuntime":null,"mediaType":"剧集","contentTags":null,"tmdbMediaKind":null,"tmdbId":null,"tmdbParentId":null,"tmdbSeasonNumber":null,"seriesRecordKind":null,"rev":1,"revActor":"remote"})
    }

    fn collection(id: &str, name: &str) -> Value {
        json!({"id":id,"name":name,"normalizedName":name.to_lowercase(),"description":"","sourceKind":"manual","sourceKey":null,"collectionKind":"manual","orderMode":"manual","createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"})
    }

    fn member(id: &str, collection_id: &str, record_id: &str) -> Value {
        json!({"id":id,"collectionId":collection_id,"recordId":record_id,"position":0,"sourceKind":"manual","createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"})
    }

    fn completion(id: &str, record_id: &str, episode: i32, completed_at: Option<&str>) -> Value {
        json!({"id":id,"recordId":record_id,"episodeNumber":episode,"completedAt":completed_at,"createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"})
    }

    fn store_with_projection(
        entities: Vec<MaterializedProjectionEntityV1>,
    ) -> (Mutex<Connection>, u64) {
        store_with_projection_and_relations(entities, vec![])
    }

    fn store_with_projection_and_relations(
        entities: Vec<MaterializedProjectionEntityV1>,
        relation_blocked_entity_keys: Vec<Value>,
    ) -> (Mutex<Connection>, u64) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        let conn = Mutex::new(conn);
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert!(store
            .compare_and_swap_discovery_state(None, &create_discovery_state_v1())
            .unwrap());
        let projection = DurableMaterializedProjectionV1 {
            projection_version: 1,
            physical_root_id: ROOT.into(),
            projection_generation: 7,
            source_discovery_generation: 0,
            source_root_safety_generation: 0,
            replay_input_fingerprint: "a".repeat(64),
            business_projection_applied_generation: None,
            state: MaterializedProjectionStateV1 {
                state_version: 1,
                status: MaterializedProjectionStatusV1::Complete,
                basis_clock: vec![],
                entities,
                relation_blocked_entity_keys,
                replay_input_fingerprint: "a".repeat(64),
            },
        };
        assert!(store
            .compare_and_swap_materialized_projection(None, &projection)
            .unwrap());
        store
            .persist_desktop_root_state(&DesktopRootStateV1 {
                state_version: 1,
                physical_root_id: ROOT.into(),
                local_writer_id: "30000000-0000-4000-8000-000000000001".into(),
                next_writer_sequence: 0,
                writer_head: None,
                lifecycle_generation: 0,
                materialized_projection_generation: Some(7),
                business_applied_projection_generation: None,
            })
            .unwrap();
        (conn, 7)
    }

    #[test]
    fn record_live_tombstone_and_idempotence_are_transactional_and_no_stage() {
        let live = record("remote-record", "remote");
        let (conn, generation) = store_with_projection(vec![entity(
            json!(["record", "remote-record"]),
            json!({"state":"live","value":live}),
            Some(record("remote-record", "remote")),
        )]);
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        let (result, report) = apply_complete_projection_v1(&mut store, generation).unwrap();
        assert_eq!(result, BusinessProjectionTransactionResultV1::Applied);
        assert_eq!(
            report.unwrap().outcomes,
            vec![BusinessProjectionOutcomeV1::AppliedRemoteValue]
        );
        assert!(
            crate::db::get_record(&conn.lock().unwrap(), "remote-record")
                .unwrap()
                .is_some()
        );
        assert!(crate::sync_staging::get_staging(&conn.lock().unwrap())
            .unwrap()
            .entries
            .is_empty());
        // Simulated restart: a fresh durable-store handle observes the
        // committed applied generation and must not replay the same N.
        let mut restarted = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert_eq!(
            apply_complete_projection_v1(&mut restarted, generation)
                .unwrap()
                .0,
            BusinessProjectionTransactionResultV1::AlreadyApplied
        );
    }

    #[test]
    fn staged_overlay_and_incomplete_composite_staging_fail_closed() {
        let remote = record("same", "remote");
        let (conn, generation) = store_with_projection(vec![entity(
            json!(["record", "same"]),
            json!({"state":"live","value":remote}),
            Some(record("same", "remote")),
        )]);
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("same", "local")).unwrap(),
        )
        .unwrap();
        set_staging(
            &conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries: vec![StagedRecord {
                    entity_kind: "record".into(),
                    id: "same".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(record("same", "local")),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                }],
            },
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        let report = apply_complete_projection_v1(&mut store, generation)
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            report.outcomes,
            vec![BusinessProjectionOutcomeV1::OverlayPreserved]
        );
        assert_eq!(
            crate::db::get_record(&conn.lock().unwrap(), "same")
                .unwrap()
                .unwrap()
                .original_name,
            "local"
        );
        assert_eq!(
            apply_complete_projection_v1(&mut store, generation)
                .unwrap()
                .0,
            BusinessProjectionTransactionResultV1::AlreadyApplied
        );
    }

    #[test]
    fn incomplete_composite_overlay_aborts_without_advancing_generation() {
        let (conn, generation) = store_with_projection(vec![entity(
            json!(["record", "must-not-apply"]),
            json!({"state":"live"}),
            Some(record("must-not-apply", "remote")),
        )]);
        set_staging(
            &conn.lock().unwrap(),
            &SyncStaging {
                version: 2,
                entries: vec![StagedRecord {
                    entity_kind: "collection-member".into(),
                    id: "opaque".into(),
                    operation: "delete".into(),
                    base: None,
                    local: None,
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                }],
            },
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert!(apply_complete_projection_v1(&mut store, generation).is_err());
        assert!(
            crate::db::get_record(&conn.lock().unwrap(), "must-not-apply")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .load_desktop_root_state()
                .unwrap()
                .unwrap()
                .business_applied_projection_generation,
            None
        );
    }

    #[test]
    fn tombstones_apply_but_entity_and_relation_conflicts_preserve_working_values() {
        let (conn, generation) = store_with_projection_and_relations(
            vec![
                MaterializedProjectionEntityV1 {
                    entity_key: json!(["record", "conflict"]),
                    semantic_state: None,
                    business_value: None,
                    frontier: vec![],
                    conflict: true,
                },
                entity(
                    json!(["record", "relation-conflict"]),
                    json!({"state":"tombstone"}),
                    None,
                ),
                entity(
                    json!(["record", "deleted"]),
                    json!({"state":"tombstone"}),
                    None,
                ),
            ],
            vec![json!(["record", "relation-conflict"])],
        );
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("conflict", "local")).unwrap(),
        )
        .unwrap();
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("deleted", "old")).unwrap(),
        )
        .unwrap();
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("relation-conflict", "local")).unwrap(),
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        let report = apply_complete_projection_v1(&mut store, generation)
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            report.outcomes,
            vec![
                BusinessProjectionOutcomeV1::ConflictPreserved,
                BusinessProjectionOutcomeV1::ConflictPreserved,
                BusinessProjectionOutcomeV1::AppliedRemoteTombstone
            ]
        );
        assert!(crate::db::get_record(&conn.lock().unwrap(), "conflict")
            .unwrap()
            .is_some());
        assert!(crate::db::get_record(&conn.lock().unwrap(), "deleted")
            .unwrap()
            .is_none());
        assert!(
            crate::db::get_record(&conn.lock().unwrap(), "relation-conflict")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn collection_member_and_uncompleted_episode_are_live_values() {
        let collection = json!({"id":"collection-1","name":"C","normalizedName":"c","description":"","sourceKind":"manual","sourceKey":null,"collectionKind":"manual","orderMode":"manual","createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"});
        let member = json!({"id":"member-1","collectionId":"collection-1","recordId":"record-1","position":0,"sourceKind":"manual","createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"});
        let completion = json!({"id":"completion-1","recordId":"record-1","episodeNumber":1,"completedAt":null,"createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00Z","rev":1,"revActor":"remote"});
        let (conn, generation) = store_with_projection(vec![
            entity(
                json!(["record", "record-1"]),
                json!({"state":"live"}),
                Some(record("record-1", "remote")),
            ),
            entity(
                json!(["collection", "collection-1"]),
                json!({"state":"live"}),
                Some(collection),
            ),
            entity(
                json!(["collection-member", "collection-1", "record-1"]),
                json!({"state":"live"}),
                Some(member),
            ),
            entity(
                json!(["episode-completion", "record-1", 1]),
                json!({"state":"live"}),
                Some(completion),
            ),
        ]);
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        let report = apply_complete_projection_v1(&mut store, generation)
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            report.outcomes,
            vec![BusinessProjectionOutcomeV1::AppliedRemoteValue; 4]
        );
        assert_eq!(
            crate::episode_history::completions(&conn.lock().unwrap(), "record-1").unwrap()[0]
                .completed_at,
            None
        );
    }

    #[test]
    fn sqlite_failure_after_first_no_stage_write_rolls_back_everything() {
        let (conn, generation) = store_with_projection(vec![
            entity(
                json!(["record", "first"]),
                json!({"state":"live"}),
                Some(record("first", "remote")),
            ),
            entity(
                json!(["collection", "second"]),
                json!({"state":"live"}),
                Some(collection("second", "Second")),
            ),
        ]);
        conn.lock().unwrap().execute_batch("CREATE TRIGGER projector_fail_collection BEFORE INSERT ON collections BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert!(apply_complete_projection_v1(&mut store, generation).is_err());
        assert!(crate::db::get_record(&conn.lock().unwrap(), "first")
            .unwrap()
            .is_none());
        assert!(crate::collections::all(&conn.lock().unwrap())
            .unwrap()
            .is_empty());
        assert!(crate::sync_staging::get_staging(&conn.lock().unwrap())
            .unwrap()
            .entries
            .is_empty());
        assert_eq!(
            store
                .load_desktop_root_state()
                .unwrap()
                .unwrap()
                .business_applied_projection_generation,
            None
        );
    }

    #[test]
    fn collection_tombstone_and_overlay_preserve_staging() {
        let (conn, generation) = store_with_projection(vec![entity(
            json!(["collection", "collection-1"]),
            json!({"state":"tombstone"}),
            None,
        )]);
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("record-1", "r")).unwrap(),
        )
        .unwrap();
        remote_upsert_collection_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(collection("collection-1", "local")).unwrap(),
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert_eq!(
            apply_complete_projection_v1(&mut store, generation)
                .unwrap()
                .1
                .unwrap()
                .outcomes,
            vec![BusinessProjectionOutcomeV1::AppliedRemoteTombstone]
        );
        assert!(crate::collections::all(&conn.lock().unwrap())
            .unwrap()
            .is_empty());

        let (conn, generation) = store_with_projection(vec![entity(
            json!(["collection", "collection-2"]),
            json!({"state":"tombstone"}),
            None,
        )]);
        remote_upsert_collection_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(collection("collection-2", "local")).unwrap(),
        )
        .unwrap();
        let staging = SyncStaging {
            version: 2,
            entries: vec![StagedRecord {
                entity_kind: "collection".into(),
                id: "collection-2".into(),
                operation: "upsert".into(),
                base: None,
                local: Some(collection("collection-2", "local")),
                first_generation: 1,
                last_generation: 1,
                delete_descriptor: None,
            }],
        };
        set_staging(&conn.lock().unwrap(), &staging).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert_eq!(
            apply_complete_projection_v1(&mut store, generation)
                .unwrap()
                .1
                .unwrap()
                .outcomes,
            vec![BusinessProjectionOutcomeV1::OverlayPreserved]
        );
        assert_eq!(
            crate::collections::all(&conn.lock().unwrap()).unwrap()[0].name,
            "local"
        );
        assert_eq!(
            crate::sync_staging::get_staging(&conn.lock().unwrap()).unwrap(),
            staging
        );
    }

    #[test]
    fn composite_member_and_episode_tombstone_overlays_preserve_local_rows() {
        let (conn, generation) = store_with_projection(vec![
            entity(
                json!(["record", "record-1"]),
                json!({"state":"live"}),
                Some(record("record-1", "r")),
            ),
            entity(
                json!(["collection", "collection-1"]),
                json!({"state":"live"}),
                Some(collection("collection-1", "c")),
            ),
            entity(
                json!(["collection-member", "collection-1", "record-1"]),
                json!({"state":"tombstone"}),
                None,
            ),
            entity(
                json!(["episode-completion", "record-1", 1]),
                json!({"state":"tombstone"}),
                None,
            ),
        ]);
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("record-1", "r")).unwrap(),
        )
        .unwrap();
        remote_upsert_collection_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(collection("collection-1", "c")).unwrap(),
        )
        .unwrap();
        remote_upsert_member_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(member("member-1", "collection-1", "record-1")).unwrap(),
        )
        .unwrap();
        remote_upsert_episode_completion_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(completion(
                "completion-1",
                "record-1",
                1,
                Some("2026-09-17T00:00:00Z"),
            ))
            .unwrap(),
        )
        .unwrap();
        let staging = SyncStaging {
            version: 2,
            entries: vec![
                StagedRecord {
                    entity_kind: "collection-member".into(),
                    id: "member-1".into(),
                    operation: "delete".into(),
                    base: Some(member("member-1", "collection-1", "record-1")),
                    local: None,
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: Some(
                        crate::sync_staging::StagedDeleteDescriptor::CollectionMember {
                            id: "member-1".into(),
                            collection_id: "collection-1".into(),
                            record_id: "record-1".into(),
                            deleted_at: "2026-09-17T00:00:00Z".into(),
                            rev: 2,
                            rev_actor: "local".into(),
                        },
                    ),
                },
                StagedRecord {
                    entity_kind: "episode-completion".into(),
                    id: "completion-1".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(completion(
                        "completion-1",
                        "record-1",
                        1,
                        Some("2026-09-17T00:00:00Z"),
                    )),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                },
            ],
        };
        set_staging(&conn.lock().unwrap(), &staging).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert_eq!(
            apply_complete_projection_v1(&mut store, generation)
                .unwrap()
                .1
                .unwrap()
                .outcomes,
            vec![
                BusinessProjectionOutcomeV1::AppliedRemoteValue,
                BusinessProjectionOutcomeV1::AppliedRemoteValue,
                BusinessProjectionOutcomeV1::OverlayPreserved,
                BusinessProjectionOutcomeV1::OverlayPreserved
            ]
        );
        assert_eq!(
            crate::collections::all_members(&conn.lock().unwrap())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::episode_history::completions(&conn.lock().unwrap(), "record-1")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::sync_staging::get_staging(&conn.lock().unwrap()).unwrap(),
            staging
        );
    }

    #[test]
    fn episode_tombstone_without_overlay_removes_only_the_live_entity() {
        let (conn, generation) = store_with_projection(vec![
            entity(
                json!(["record", "record-1"]),
                json!({"state":"live"}),
                Some(record("record-1", "r")),
            ),
            entity(
                json!(["episode-completion", "record-1", 1]),
                json!({"state":"tombstone"}),
                None,
            ),
        ]);
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(record("record-1", "r")).unwrap(),
        )
        .unwrap();
        remote_upsert_episode_completion_no_stage_tx(
            &conn.lock().unwrap(),
            &serde_json::from_value(completion(
                "completion-1",
                "record-1",
                1,
                Some("2026-09-17T00:00:00Z"),
            ))
            .unwrap(),
        )
        .unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
        assert_eq!(
            apply_complete_projection_v1(&mut store, generation)
                .unwrap()
                .1
                .unwrap()
                .outcomes,
            vec![
                BusinessProjectionOutcomeV1::AppliedRemoteValue,
                BusinessProjectionOutcomeV1::AppliedRemoteTombstone
            ]
        );
        assert!(
            crate::episode_history::completions(&conn.lock().unwrap(), "record-1")
                .unwrap()
                .is_empty()
        );
        assert!(crate::sync_staging::get_staging(&conn.lock().unwrap())
            .unwrap()
            .entries
            .is_empty());
    }
}
