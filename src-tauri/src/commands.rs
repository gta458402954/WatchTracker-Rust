use crate::app_paths::AppPaths;
use crate::db::{self, DatabaseCompatibilityIssue, DbState};
use crate::models::{UpdateWatchRecord, WatchRecord};
use crate::{auth, net};
use serde_json::Value;
use tauri::State;

fn lock_database(
    state: &DbState,
) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, crate::error::AppError> {
    if let Some(issue) = &state.compatibility_issue {
        return Err(crate::error::AppError::General(format!(
            "database_compatibility:{}:V{}:V{}",
            issue.code, issue.detected_version, issue.supported_version,
        )));
    }
    state
        .conn
        .lock()
        .map_err(|error| crate::error::AppError::ConcurrencyError(error.to_string()))
}

#[tauri::command]
pub fn get_database_compatibility(state: State<DbState>) -> Option<DatabaseCompatibilityIssue> {
    state.compatibility_issue.clone()
}

#[tauri::command]
pub fn get_all_records(state: State<DbState>) -> Result<Vec<WatchRecord>, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    Ok(db::get_all_records(&conn)?)
}

#[tauri::command]
pub fn insert_record(state: State<DbState>, r: WatchRecord) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    crate::db_atomic_crud::insert_record_atomic(&mut conn, r)
}

#[tauri::command]
pub fn update_record(
    state: State<DbState>,
    id: String,
    updates: UpdateWatchRecord,
    actor_id: Option<String>,
) -> Result<WatchRecord, crate::error::AppError> {
    log::info!("[Commands] update_record called for id: {}", id);
    let mut conn = lock_database(state.inner())?;
    crate::db_atomic_update::update_record_atomic(
        &mut conn,
        &id,
        &updates,
        actor_id.as_deref().unwrap_or("local"),
    )
}

#[tauri::command]
pub fn delete_record(state: State<DbState>, id: String) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    crate::db_atomic_crud::delete_record_atomic(&mut conn, &id)
}

#[tauri::command]
pub fn replace_all_records(
    state: State<DbState>,
    records: Vec<WatchRecord>,
) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    crate::db_atomic_crud::replace_all_records_atomic(&mut conn, records)
}

#[tauri::command]
pub fn vacuum_db(state: State<DbState>) -> Result<(), crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    Ok(db::vacuum_db(&conn)?)
}

#[tauri::command]
pub fn get_setting(
    state: State<DbState>,
    key: String,
) -> Result<Option<String>, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    Ok(db::get_setting(&conn, key)?)
}

#[tauri::command]
pub fn set_setting(
    state: State<DbState>,
    key: String,
    value: String,
) -> Result<(), crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    Ok(db::set_setting(&conn, key, value)?)
}

#[tauri::command]
pub fn encrypt(text: String, tag: Option<String>) -> Result<String, crate::error::AppError> {
    auth::encrypt(&text, tag.as_deref().unwrap_or("webdav_creds"))
        .map_err(crate::error::AppError::General)
}

#[tauri::command]
pub fn decrypt(id: String) -> Result<String, crate::error::AppError> {
    auth::decrypt(&id).map_err(crate::error::AppError::General)
}

#[tauri::command]
pub async fn search_tmdb(
    api_key: String,
    query: String,
    language: Option<String>,
    proxy: Option<String>,
) -> Result<Value, crate::error::AppError> {
    net::search_tmdb(
        api_key,
        query,
        language.unwrap_or("zh-CN".to_string()),
        proxy,
    )
    .await
    .map_err(crate::error::AppError::General)
}

#[tauri::command]
pub async fn get_tmdb_detail(
    api_key: String,
    id: i32,
    media_type: String,
    language: Option<String>,
    proxy: Option<String>,
) -> Result<Value, crate::error::AppError> {
    net::get_tmdb_detail(
        api_key,
        id,
        media_type,
        language.unwrap_or("zh-CN".to_string()),
        proxy,
    )
    .await
    .map_err(crate::error::AppError::General)
}

#[tauri::command]
pub async fn download_poster(
    paths: State<'_, AppPaths>,
    path: String,
    proxy: Option<String>,
) -> Result<bool, crate::error::AppError> {
    net::download_poster(&paths, path, proxy)
        .await
        .map_err(crate::error::AppError::General)
}

#[tauri::command]
pub async fn webdav_request(
    method: String,
    url: String,
    username: String,
    password: String,
    body: Option<String>,
    proxy: Option<String>,
) -> Result<Value, crate::error::AppError> {
    if !matches!(method.as_str(), "GET" | "PUT" | "MKCOL") {
        return Err(crate::error::AppError::General(
            "Unsupported WebDAV method".to_string(),
        ));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(crate::error::AppError::General(
            "Invalid WebDAV URL".to_string(),
        ));
    }
    net::webdav_request(&method, &url, &username, &password, body, proxy)
        .await
        .map_err(crate::error::AppError::General)
}
