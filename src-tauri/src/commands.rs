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
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT * FROM records WHERE id = ?").map_err(|e| e.to_string())?;
    let mut r = stmt.query_row(params![id], |row| {
        Ok(WatchRecord {
            id: row.get(0)?,
            original_name: row.get(1)?,
            chinese_name: row.get(2)?,
            progress: row.get(3)?,
            total_episodes: row.get(4)?,
            status: row.get(5)?,
            platform: row.get(6)?,
            rating: row.get(7)?,
            start_date: row.get(8)?,
            end_date: row.get(9)?,
            category: row.get(10)?,
            notes: row.get(11)?,
            created_at: row.get(12)?,
            movie_progress: row.get(13)?,
            movie_duration: row.get(14)?,
            release_year: row.get(15)?,
            poster_path: row.get(16)?,
            updated_at: row.get(17)?,
        })
    }).map_err(|e| e.to_string())?;

    // 应用更新
    if let Some(o) = updates.as_object() {
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
        if let Some(v) = o.get("rating") { r.rating = v.as_i64().unwrap_or(0) as i32; }
        if let Some(v) = o.get("startDate") { r.start_date = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("endDate") { r.end_date = v.as_str().map(|s| s.to_string()); }
        if let Some(v) = o.get("category") { r.category = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("notes") { r.notes = v.as_str().unwrap_or("").to_string(); }
        if let Some(v) = o.get("updatedAt") { r.updated_at = v.as_str().map(|s| s.to_string()); }
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

// 辅助宏引用
use rusqlite::params;
