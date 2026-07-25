use tauri::State;
use crate::db::{self, DbState};
use crate::models::{WatchRecord, Category};
use crate::{auth, net};
use serde_json::Value;

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
    
    // 先获取当前记录
    let mut stmt = conn.prepare("SELECT * FROM records WHERE id = ?").map_err(|e| {
        log::error!("[Commands] Failed to prepare SELECT for update: {}", e);
        e.to_string()
    })?;

    let mut r = stmt.query_row(params![id], |row| {
        // 使用更安全的读取方式，处理可能的类型不匹配或 NULL 值
        Ok(WatchRecord {
            id: row.get("id")?,
            original_name: row.get("originalName").unwrap_or_default(),
            chinese_name: row.get("chineseName").unwrap_or_default(),
            progress: row.get("progress").unwrap_or_default(),
            total_episodes: row.get("totalEpisodes").ok(),
            status: row.get("status").unwrap_or_default(),
            platform: row.get("platform").unwrap_or_default(),
            rating: row.get::<_, Option<i32>>("rating").unwrap_or(None),
            start_date: row.get("startDate").ok(),
            end_date: row.get("endDate").ok(),
            category: row.get("category").unwrap_or_default(),
            notes: row.get("notes").unwrap_or_default(),
            created_at: row.get("createdAt").unwrap_or_default(),
            movie_progress: row.get("movieProgress").ok(),
            movie_duration: row.get("movieDuration").ok(),
            release_year: {
                // 兼容 INTEGER 和 TEXT 类型的 releaseYear
                if let Ok(val) = row.get::<_, String>("releaseYear") {
                    Some(val)
                } else if let Ok(val) = row.get::<_, i32>("releaseYear") {
                    Some(val.to_string())
                } else {
                    None
                }
            },
            poster_path: row.get("posterPath").ok(),
            updated_at: row.get("updatedAt").ok(),
            imdb_id: row.get("imdbId").ok(),
            is_locked: row.get::<_, Option<i32>>("isLocked").unwrap_or(None).map(|v| v != 0),
            sort_order: row.get("sortOrder").unwrap_or(None),
            genres: row.get("genres").unwrap_or(None),
            origin_country: row.get("originCountry").unwrap_or(None),
            imdb_rating: row.get("imdbRating").unwrap_or(None),
            tmdb_status: row.get("tmdbStatus").unwrap_or(None),
            interest_level: row.get("interestLevel").unwrap_or(None),
            episode_runtime: row.get("episodeRuntime").unwrap_or(None),
            media_type: row.get("mediaType").unwrap_or(None),
            content_tags: row.get("contentTags").unwrap_or(None),
        })
    }).map_err(|e| {
        log::error!("[Commands] Failed to fetch record for update: {}", e);
        e.to_string()
    })?;

    log::info!("[Commands] Fetched existing record: {}", r.chinese_name);

    // 应用更新
    if let Some(o) = updates.as_object() {
        log::info!("[Commands] Applying updates: {:?}", updates);
        if let Some(v) = o.get("chineseName") { r.chinese_name = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("originalName") { r.original_name = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("status") { r.status = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("progress") { r.progress = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("totalEpisodes") { r.total_episodes = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("movieProgress") { r.movie_progress = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("movieDuration") { r.movie_duration = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("releaseYear") { r.release_year = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("posterPath") { r.poster_path = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("platform") { r.platform = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("rating") { r.rating = if v.is_null() { None } else { v.as_i64().map(|n| n as i32) }; }
        if let Some(v) = o.get("startDate") { r.start_date = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("endDate") { r.end_date = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("category") { r.category = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("notes") { r.notes = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("updatedAt") { r.updated_at = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("imdbId") { r.imdb_id = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("isLocked") { r.is_locked = v.as_bool(); }
        if let Some(v) = o.get("sortOrder") { r.sort_order = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("genres") { r.genres = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("originCountry") { r.origin_country = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("imdbRating") { r.imdb_rating = v.as_f64(); }
        if let Some(v) = o.get("tmdbStatus") { r.tmdb_status = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("interestLevel") { r.interest_level = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("episodeRuntime") { r.episode_runtime = v.as_i64().map(|n| n as i32); }
        if let Some(v) = o.get("mediaType") { r.media_type = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("contentTags") { r.content_tags = v.as_str().map(|s| s.to_string()); }
    }
    
    db::insert_record(&conn, r).map_err(|e| e.to_string())
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
pub fn get_all_categories(state: State<DbState>) -> Result<Vec<Category>, String> {
    let conn = state.conn.lock().unwrap();
    db::get_all_categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_category(state: State<DbState>, name: String, emoji: String, sort_order: i32) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::upsert_category(&conn, Category { name, emoji, sort_order }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_category(state: State<DbState>, name: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::delete_category(&conn, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_category(state: State<DbState>, old_name: String, new_name: String, emoji: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::rename_category(&conn, old_name, new_name, emoji).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_categories(state: State<DbState>, names: Vec<String>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::reorder_categories(&conn, names).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_records(state: State<DbState>, ids: Vec<String>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::reorder_records(&conn, ids).map_err(|e| e.to_string())
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
pub async fn search_tmdb(api_key: String, query: String, media_type: String, language: Option<String>, proxy: Option<String>) -> Result<Value, String> {
    net::search_tmdb(api_key, query, media_type, language.unwrap_or("zh-CN".to_string()), proxy).await
}

#[tauri::command]
pub async fn get_tmdb_detail(api_key: String, id: i32, media_type: String, language: Option<String>, proxy: Option<String>) -> Result<Value, String> {
    net::get_tmdb_detail(api_key, id, media_type, language.unwrap_or("zh-CN".to_string()), proxy).await
}

#[tauri::command]
pub async fn download_poster(app: tauri::AppHandle, path: String, proxy: Option<String>) -> Result<bool, String> {
    net::download_poster(&app, path, proxy).await
}

#[tauri::command]
pub async fn webdav_request(
    method: String,
    url: String,
    username: String,
    password: String,
    body: Option<String>,
    proxy: Option<String>
) -> Result<Value, String> {
    net::webdav_request(&method, &url, &username, &password, body, proxy).await
}

// 辅助宏引用
use rusqlite::params;
