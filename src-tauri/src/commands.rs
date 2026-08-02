use crate::app_paths::AppPaths;
use crate::db::{self, DatabaseCompatibilityIssue, DbState};
use crate::models::{UpdateWatchRecord, WatchRecord};
use crate::recovery_points;
use crate::sync_state;
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

fn validate_webdav_conditions(
    method: &str,
    if_match: Option<&str>,
    if_none_match: Option<&str>,
    if_dav_etag: Option<&str>,
) -> Result<(), crate::error::AppError> {
    if (if_match.is_some() || if_none_match.is_some() || if_dav_etag.is_some()) && method != "PUT" {
        return Err(crate::error::AppError::General(
            "Conditional headers are only allowed for WebDAV PUT".to_string(),
        ));
    }
    if [
        if_match.is_some(),
        if_none_match.is_some(),
        if_dav_etag.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count()
        > 1
    {
        return Err(crate::error::AppError::General(
            "WebDAV write preconditions cannot be combined".to_string(),
        ));
    }
    if let Some(value) = if_match {
        let valid = value.starts_with('"')
            && value.ends_with('"')
            && value.len() >= 2
            && !value.starts_with("W/")
            && !value.contains(['\r', '\n']);
        if !valid {
            return Err(crate::error::AppError::General(
                "Invalid strong If-Match value".to_string(),
            ));
        }
    }
    if if_none_match.is_some_and(|value| value != "*") {
        return Err(crate::error::AppError::General(
            "Invalid If-None-Match value".to_string(),
        ));
    }
    if let Some(value) = if_dav_etag {
        let opaque = value
            .strip_prefix("W/\"")
            .or_else(|| value.strip_prefix('"'))
            .and_then(|rest| rest.strip_suffix('"'));
        let valid = opaque.is_some_and(|inner| {
            !inner.is_empty()
                && !inner.contains('"')
                && !inner.chars().any(|character| character.is_control())
        });
        if !valid {
            return Err(crate::error::AppError::General(
                "Invalid WebDAV entity tag".to_string(),
            ));
        }
    }
    Ok(())
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
pub fn insert_record(
    state: State<DbState>,
    r: WatchRecord,
) -> Result<WatchRecord, crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    let actor_id = sync_state::device_id(&conn)?;
    crate::db_atomic_crud::insert_record_atomic(&mut conn, r, &actor_id)
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
    let actor_id = match actor_id {
        Some(value) => value,
        None => sync_state::device_id(&conn)?,
    };
    let result = crate::db_atomic_update::update_record_atomic(&mut conn, &id, &updates, &actor_id);
    if let Err(error) = &result {
        log::warn!("[Commands] update_record rejected for id {id}: {error}");
    }
    result
}

#[tauri::command]
pub fn delete_record(state: State<DbState>, id: String) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    let actor_id = sync_state::device_id(&conn)?;
    crate::db_atomic_crud::delete_record_atomic(&mut conn, &id, &actor_id)
}

#[tauri::command]
pub fn replace_all_records(
    state: State<DbState>,
    paths: State<AppPaths>,
    records: Vec<WatchRecord>,
    reason: String,
) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    recovery_points::create(&conn, paths.inner(), &reason)?;
    crate::db_atomic_crud::replace_all_records_atomic(&mut conn, records)
}

#[tauri::command]
pub fn get_sync_snapshot(
    state: State<DbState>,
) -> Result<sync_state::SyncSnapshot, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    sync_state::snapshot(&conn)
}

#[tauri::command]
pub fn get_sync_runtime_state(
    state: State<DbState>,
) -> Result<sync_state::SyncRuntimeState, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    sync_state::runtime_state(&conn)
}

#[tauri::command]
pub fn set_auto_sync_paused(
    state: State<DbState>,
    paused: bool,
) -> Result<sync_state::SyncRuntimeState, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    sync_state::set_paused(&conn, paused)
}

#[tauri::command]
pub fn record_sync_failure(
    state: State<DbState>,
    code: String,
    next_attempt_at: Option<String>,
) -> Result<sync_state::SyncRuntimeState, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    sync_state::record_failure(&conn, &code, next_attempt_at)
}

#[tauri::command]
pub fn commit_sync_result(
    state: State<DbState>,
    paths: State<AppPaths>,
    input: sync_state::SyncCommitInput,
) -> Result<sync_state::SyncCommitResult, crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    sync_state::commit(&mut conn, paths.inner(), input)
}

#[tauri::command]
pub fn prepare_sync_publish_intent(
    state: State<DbState>,
    input: crate::sync_staging::PreparePublishIntentInput,
) -> Result<crate::sync_staging::SyncPublishIntent, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    sync_state::prepare_publish_intent(&conn, input)
}

#[tauri::command]
pub fn resolve_sync_conflict(
    state: State<DbState>,
    id: String,
    resolution: sync_state::SyncConflictResolution,
) -> Result<(), crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    sync_state::resolve_conflict(&mut conn, &id, resolution)
}

#[tauri::command]
pub fn create_recovery_point(
    state: State<DbState>,
    paths: State<AppPaths>,
    reason: String,
) -> Result<recovery_points::RecoveryPoint, crate::error::AppError> {
    let conn = lock_database(state.inner())?;
    recovery_points::create(&conn, paths.inner(), &reason)
}

#[tauri::command]
pub fn list_recovery_points(
    paths: State<AppPaths>,
) -> Result<recovery_points::RecoveryPointList, crate::error::AppError> {
    recovery_points::list(paths.inner())
}

#[tauri::command]
pub fn set_recovery_point_retained(
    paths: State<AppPaths>,
    id: String,
    retained: bool,
) -> Result<(), crate::error::AppError> {
    recovery_points::set_retained(paths.inner(), &id, retained)
}

#[tauri::command]
pub fn delete_recovery_point(
    paths: State<AppPaths>,
    id: String,
) -> Result<(), crate::error::AppError> {
    recovery_points::delete(paths.inner(), &id)
}

#[tauri::command]
pub fn restore_recovery_point(
    state: State<DbState>,
    paths: State<AppPaths>,
    id: String,
) -> Result<recovery_points::RecoveryResult, crate::error::AppError> {
    let mut conn = lock_database(state.inner())?;
    recovery_points::restore(&mut conn, paths.inner(), &id)
}

#[tauri::command]
pub fn open_backup_directory(paths: State<AppPaths>) -> Result<(), crate::error::AppError> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(paths.backups())
            .spawn()?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = paths;
        Err(crate::error::AppError::General(
            "Opening the backup directory is only supported on Windows".to_string(),
        ))
    }
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
    request: net::WebDavRequest,
) -> Result<net::WebDavResponse, crate::error::AppError> {
    if !matches!(
        request.method.as_str(),
        "GET" | "PUT" | "MKCOL" | "PROPFIND"
    ) {
        return Err(crate::error::AppError::General(
            "Unsupported WebDAV method".to_string(),
        ));
    }
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        return Err(crate::error::AppError::General(
            "Invalid WebDAV URL".to_string(),
        ));
    }
    validate_webdav_conditions(
        &request.method,
        request.if_match.as_deref(),
        request.if_none_match.as_deref(),
        request.if_dav_etag.as_deref(),
    )?;
    net::webdav_request(request)
        .await
        .map_err(crate::error::AppError::General)
}

#[cfg(test)]
mod command_tests {
    use super::validate_webdav_conditions;

    #[test]
    fn webdav_condition_headers_accept_only_safe_put_preconditions() {
        assert!(validate_webdav_conditions("PUT", Some("\"etag\""), None, None).is_ok());
        assert!(validate_webdav_conditions("PUT", None, Some("*"), None).is_ok());
        assert!(validate_webdav_conditions("PUT", None, None, Some("\"strong\"")).is_ok());
        assert!(validate_webdav_conditions("PUT", None, None, Some("W/\"weak\"")).is_ok());
        assert!(validate_webdav_conditions("PUT", Some("W/\"weak\""), None, None).is_err());
        assert!(validate_webdav_conditions("PUT", Some("\"bad\r\nheader\""), None, None).is_err());
        assert!(validate_webdav_conditions("GET", Some("\"etag\""), None, None).is_err());
        assert!(validate_webdav_conditions("PROPFIND", None, None, None).is_ok());
        assert!(
            validate_webdav_conditions("PUT", Some("\"etag\""), None, Some("W/\"weak\"")).is_err()
        );
        assert!(
            validate_webdav_conditions("PUT", None, None, Some("W/\"bad\r\nheader\"")).is_err()
        );
        assert!(validate_webdav_conditions("PUT", None, None, Some("unquoted")).is_err());
        assert!(validate_webdav_conditions("PUT", None, None, Some("\"bad\r\nheader\"")).is_err());
    }
}
