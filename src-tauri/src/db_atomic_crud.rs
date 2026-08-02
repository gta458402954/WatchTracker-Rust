use crate::db;
use crate::db_atomic_helpers::{
    get_tombstones_tx, mark_records_mutated, set_tombstones_tx, Tombstone,
};
use crate::error::AppError;
use crate::models::WatchRecord;
use crate::record_validation::{prepare_import_batch, prepare_record, RecordWriteContext};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

pub fn insert_record_atomic(
    conn: &mut Connection,
    record: WatchRecord,
    actor_id: &str,
) -> Result<WatchRecord, AppError> {
    if actor_id.trim().is_empty() {
        return Err(AppError::General("Missing revision actor ID".to_string()));
    }
    let mut record = prepare_record(record, RecordWriteContext::Local)?;
    let transaction = conn.transaction()?;
    let id = record.id.clone();
    let previous_revision = transaction
        .query_row("SELECT rev FROM records WHERE id = ?1", [&id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .unwrap_or(0);
    record.updated_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    record.rev = previous_revision
        .checked_add(1)
        .ok_or_else(|| AppError::General("Record revision overflow".to_string()))?;
    record.rev_actor = actor_id.to_string();
    db::insert_record(&transaction, record)?;

    let mut tombstones = get_tombstones_tx(&transaction)?;
    if tombstones.iter().any(|tombstone| tombstone.id == id) {
        tombstones.retain(|tombstone| tombstone.id != id);
        set_tombstones_tx(&transaction, &tombstones)?;
    }
    mark_records_mutated(&transaction)?;
    let persisted = db::get_record(&transaction, &id)?
        .ok_or_else(|| AppError::General(format!("Record not found after upsert: {id}")))?;
    transaction.commit()?;
    Ok(persisted)
}

pub fn delete_record_atomic(
    conn: &mut Connection,
    id: &str,
    actor_id: &str,
) -> Result<(), AppError> {
    if actor_id.trim().is_empty() {
        return Err(AppError::General("Missing revision actor ID".to_string()));
    }
    let transaction = conn.transaction()?;
    let previous_revision = transaction.query_row(
        "SELECT COALESCE(rev, 0) FROM records WHERE id = ?1",
        [id],
        |row| row.get::<_, i64>(0),
    )?;
    if transaction.execute("DELETE FROM records WHERE id = ?1", [id])? == 0 {
        return Err(AppError::General(format!("Record not found: {id}")));
    }

    let mut tombstones = get_tombstones_tx(&transaction)?;
    tombstones.retain(|tombstone| tombstone.id != id);
    tombstones.push(Tombstone {
        id: id.to_string(),
        deleted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        rev: previous_revision
            .checked_add(1)
            .ok_or_else(|| AppError::General("Record revision overflow".to_string()))?,
        rev_actor: actor_id.to_string(),
    });
    set_tombstones_tx(&transaction, &tombstones)?;
    mark_records_mutated(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn replace_all_records_atomic(
    conn: &mut Connection,
    records: Vec<WatchRecord>,
) -> Result<(), AppError> {
    let transaction = conn.transaction()?;
    let locked_ids = {
        let mut statement = transaction.prepare("SELECT id FROM records WHERE isLocked = 1")?;
        let ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<HashSet<String>, _>>()?;
        ids
    };
    let records = prepare_import_batch(
        records
            .into_iter()
            .filter(|record| !locked_ids.contains(record.id.trim()))
            .collect(),
    )?;
    db::replace_all_records_tx(&transaction, records)?;
    mark_records_mutated(&transaction)?;
    transaction.commit()?;
    Ok(())
}
