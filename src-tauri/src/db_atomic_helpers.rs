use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub id: String,
    pub deleted_at: String,
}

pub fn get_setting_tx(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

pub fn set_setting_tx(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_records_generation(conn: &Connection) -> Result<i64, AppError> {
    let Some(value) = get_setting_tx(conn, "records_generation")? else {
        return Ok(0);
    };
    let generation = value
        .parse::<i64>()
        .map_err(|_| AppError::General(format!("Invalid records_generation value: {value}")))?;
    if generation < 0 {
        return Err(AppError::General(format!(
            "Invalid negative records_generation: {generation}"
        )));
    }
    Ok(generation)
}

pub fn mark_records_mutated(conn: &Connection) -> Result<i64, AppError> {
    let next = get_records_generation(conn)?
        .checked_add(1)
        .ok_or_else(|| AppError::General("records_generation overflow".to_string()))?;
    set_setting_tx(conn, "records_generation", &next.to_string())?;
    Ok(next)
}

pub fn get_tombstones_tx(conn: &Connection) -> Result<Vec<Tombstone>, AppError> {
    match get_setting_tx(conn, "sync_tombstones")? {
        Some(value) => serde_json::from_str(&value)
            .map_err(|error| AppError::General(format!("Invalid sync_tombstones: {error}"))),
        None => Ok(Vec::new()),
    }
}

pub fn set_tombstones_tx(conn: &Connection, tombstones: &[Tombstone]) -> Result<(), AppError> {
    let value = serde_json::to_string(tombstones)
        .map_err(|error| AppError::General(format!("Could not serialize tombstones: {error}")))?;
    set_setting_tx(conn, "sync_tombstones", &value)?;
    Ok(())
}
