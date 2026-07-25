use crate::db::{self, DbState};
use crate::models::WatchRecord;
use crate::{auth, net};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn get_all_records(state: State<DbState>) -> Result<Vec<WatchRecord>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_all_records(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn insert_record(state: State<DbState>, r: WatchRecord) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::insert_record(&conn, r).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_record(state: State<DbState>, id: String, updates: Value) -> Result<(), String> {
    log::info!("[Commands] update_record called for id: {}", id);
    let conn = state.conn.lock().unwrap();

    let obj = updates.as_object().ok_or("Updates must be an object")?;
    if obj.is_empty() {
        return Ok(());
    }

    let allowed_columns = [
        "originalName", "chineseName", "progress", "totalEpisodes", "status", "platform",
        "rating", "startDate", "endDate", "notes", "createdAt", "movieProgress",
        "movieDuration", "releaseYear", "posterPath", "updatedAt", "imdbId", "isLocked",
        "genres", "originCountry", "imdbRating", "tmdbStatus", "interestLevel",
        "episodeRuntime", "mediaType", "contentTags"
    ];

    let mut set_clauses = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    for (k, v) in obj {
        if !allowed_columns.contains(&k.as_str()) {
            continue;
        }
        set_clauses.push(format!("{} = ?", k));
        
        let param = match v {
            Value::Null => rusqlite::types::Value::Null,
            Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    rusqlite::types::Value::Real(f)
                } else {
                    rusqlite::types::Value::Null
                }
            },
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            _ => rusqlite::types::Value::Text(v.to_string()),
        };
        params.push(param);
    }

    if set_clauses.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "UPDATE records SET {} WHERE id = ?",
        set_clauses.join(", ")
    );

    params.push(rusqlite::types::Value::Text(id));

    conn.execute(&sql, rusqlite::params_from_iter(params))
        .map_err(|e| {
            log::error!("[Commands] Failed to execute update query: {}", e);
            e.to_string()
        })?;

    Ok(())
}

#[tauri::command]
pub fn delete_record(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::delete_record(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn replace_all_records(state: State<DbState>, records: Vec<WatchRecord>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::replace_all_records(&conn, records).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vacuum_db(state: State<DbState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::vacuum_db(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_setting(state: State<DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_setting(&conn, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::set_setting(&conn, key, value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn encrypt(text: String, tag: Option<String>) -> Result<String, String> {
    auth::encrypt(&text, tag.as_deref().unwrap_or("webdav_creds"))
}

#[tauri::command]
pub fn decrypt(id: String) -> Result<String, String> {
    auth::decrypt(&id)
}

#[tauri::command]
pub async fn search_tmdb(
    api_key: String,
    query: String,
    language: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    net::search_tmdb(
        api_key,
        query,
        language.unwrap_or("zh-CN".to_string()),
        proxy,
    )
    .await
}

#[tauri::command]
pub async fn get_tmdb_detail(
    api_key: String,
    id: i32,
    media_type: String,
    language: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    net::get_tmdb_detail(
        api_key,
        id,
        media_type,
        language.unwrap_or("zh-CN".to_string()),
        proxy,
    )
    .await
}

#[tauri::command]
pub async fn download_poster(
    app: tauri::AppHandle,
    path: String,
    proxy: Option<String>,
) -> Result<bool, String> {
    net::download_poster(&app, path, proxy).await
}

#[tauri::command]
pub async fn webdav_request(
    method: String,
    url: String,
    username: String,
    password: String,
    body: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    if !matches!(method.as_str(), "GET" | "PUT" | "MKCOL") {
        return Err("Unsupported WebDAV method".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid WebDAV URL".to_string());
    }
    net::webdav_request(&method, &url, &username, &password, body, proxy).await
}


