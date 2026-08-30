use crate::collections::{Collection, CollectionMember};
use crate::episode_history::EpisodeCompletion;
use crate::error::AppError;
use crate::models::WatchRecord;
use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackup {
    format_version: u8,
    exported_at: String,
    records: Vec<WatchRecord>,
    episode_completions: Vec<EpisodeCompletion>,
    collections: Vec<Collection>,
    collection_members: Vec<CollectionMember>,
}

fn backup_file_name(now: DateTime<Local>) -> String {
    format!("影视追踪_{}.json", now.format("%Y-%m-%d_%H%M%S"))
}

fn backup_json(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<u8>, AppError> {
    let backup = LocalBackup {
        format_version: 4,
        exported_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        records: crate::db::get_all_records(conn)?,
        episode_completions: crate::episode_history::all_completions(conn)?,
        collections: crate::collections::all(conn)?,
        collection_members: crate::collections::all_members(conn)?,
    };
    serde_json::to_vec_pretty(&backup)
        .map_err(|error| AppError::General(format!("backup_serialization_failed:{error}")))
}

fn ensure_json_extension(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none() {
        path.set_extension("json");
    }
    path
}

pub async fn export(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<Option<String>, AppError> {
    let data = {
        let conn = crate::commands::lock_database(state.inner())?;
        backup_json(&conn, Utc::now())?
    };

    let selected = app
        .dialog()
        .file()
        .set_title("导出 WatchTracker JSON 备份")
        .set_file_name(backup_file_name(Local::now()))
        .add_filter("JSON 备份", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = ensure_json_extension(
        selected
            .into_path()
            .map_err(|error| AppError::General(format!("backup_path_invalid:{error}")))?,
    );

    let mut file = std::fs::File::create(&path)?;
    std::io::Write::write_all(&mut file, &data)?;
    std::io::Write::flush(&mut file)?;
    file.sync_all()?;
    log::info!("[Backup] Local JSON backup saved: {}", path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{RecordStatus, WatchRecord};
    use chrono::TimeZone;
    use rusqlite::Connection;

    fn record() -> WatchRecord {
        WatchRecord {
            id: "export-record".to_string(),
            original_name: "Export Original".to_string(),
            chinese_name: "导出记录".to_string(),
            progress: "0".to_string(),
            total_episodes: None,
            episode_tracking_enabled: false,
            next_episode: None,
            movie_progress: None,
            movie_duration: Some(120),
            release_year: Some("2026".to_string()),
            poster_path: None,
            status: RecordStatus::Unwatched,
            platform: String::new(),
            rating: None,
            start_date: None,
            end_date: None,
            notes: String::new(),
            created_at: "2026-08-30T00:00:00.000Z".to_string(),
            updated_at: Some("2026-08-30T00:00:00.000Z".to_string()),
            imdb_id: None,
            is_locked: Some(false),
            genres: None,
            origin_country: Some("CN".to_string()),
            imdb_rating: None,
            tmdb_status: None,
            interest_level: None,
            episode_runtime: None,
            media_type: "电影".to_string(),
            content_tags: Some("测试".to_string()),
            tmdb_media_kind: None,
            tmdb_id: None,
            tmdb_parent_id: None,
            tmdb_season_number: None,
            series_record_kind: None,
            rev: 1,
            rev_actor: "test".to_string(),
        }
    }

    #[test]
    fn filename_uses_local_date_and_time() {
        let now = Local.with_ymd_and_hms(2026, 8, 30, 0, 35, 23).unwrap();
        assert_eq!(backup_file_name(now), "影视追踪_2026-08-30_003523.json");
    }

    #[test]
    fn version_four_backup_contains_every_domain_array() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        crate::db::insert_record(&conn, record()).unwrap();

        let exported_at = Utc.with_ymd_and_hms(2026, 8, 29, 16, 35, 23).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&backup_json(&conn, exported_at).unwrap()).unwrap();

        assert_eq!(json["formatVersion"], 4);
        assert_eq!(json["exportedAt"], "2026-08-29T16:35:23.000Z");
        assert_eq!(json["records"].as_array().unwrap().len(), 1);
        assert_eq!(json["records"][0]["chineseName"], "导出记录");
        assert!(json["episodeCompletions"].as_array().unwrap().is_empty());
        assert!(json["collections"].as_array().unwrap().is_empty());
        assert!(json["collectionMembers"].as_array().unwrap().is_empty());
    }
}
