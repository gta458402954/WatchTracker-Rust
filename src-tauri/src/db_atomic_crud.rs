use crate::db;
use crate::db_atomic_helpers::{
    get_tombstones_tx, mark_records_mutated, set_tombstones_tx, Tombstone,
};
use crate::error::AppError;
use crate::models::WatchRecord;
use chrono::Utc;
use rusqlite::Connection;

pub fn insert_record_atomic(conn: &mut Connection, record: WatchRecord) -> Result<(), AppError> {
    let transaction = conn.transaction()?;
    let id = record.id.clone();
    db::insert_record(&transaction, record)?;

    let mut tombstones = get_tombstones_tx(&transaction)?;
    if tombstones.iter().any(|tombstone| tombstone.id == id) {
        tombstones.retain(|tombstone| tombstone.id != id);
        set_tombstones_tx(&transaction, &tombstones)?;
    }
    mark_records_mutated(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn delete_record_atomic(conn: &mut Connection, id: &str) -> Result<(), AppError> {
    let transaction = conn.transaction()?;
    if transaction.execute("DELETE FROM records WHERE id = ?1", [id])? == 0 {
        return Err(AppError::General(format!("Record not found: {id}")));
    }

    let mut tombstones = get_tombstones_tx(&transaction)?;
    tombstones.retain(|tombstone| tombstone.id != id);
    tombstones.push(Tombstone {
        id: id.to_string(),
        deleted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
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
    db::replace_all_records_tx(&transaction, records)?;
    mark_records_mutated(&transaction)?;
    transaction.commit()?;
    Ok(())
}
