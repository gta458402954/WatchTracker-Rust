use serde::{Deserialize, Serialize};
use rusqlite::types::{FromSql, FromSqlResult, ValueRef, ToSqlOutput};
use rusqlite::ToSql;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum RecordStatus {
    #[serde(rename = "已看")]
    Watched,
    #[serde(rename = "在看")]
    Watching,
    #[serde(rename = "未看")]
    Unwatched,
}

impl ToSql for RecordStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s = match self {
            RecordStatus::Watched => "已看",
            RecordStatus::Watching => "在看",
            RecordStatus::Unwatched => "未看",
        };
        Ok(ToSqlOutput::from(s))
    }
}

impl FromSql for RecordStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value.as_str().and_then(|s| match s {
            "已看" => Ok(RecordStatus::Watched),
            "在看" => Ok(RecordStatus::Watching),
            "未看" => Ok(RecordStatus::Unwatched),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchRecord {
    pub id: String,
    pub original_name: String,
    pub chinese_name: String,
    pub progress: String,
    pub total_episodes: Option<i32>,
    pub movie_progress: Option<i32>,
    pub movie_duration: Option<i32>,
    pub release_year: Option<String>,
    pub poster_path: Option<String>,
    pub status: RecordStatus,
    pub platform: String,
    pub rating: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub imdb_id: Option<String>,
    pub is_locked: Option<bool>,
    pub genres: Option<String>,
    pub origin_country: Option<String>,
    pub imdb_rating: Option<f64>,
    pub tmdb_status: Option<String>,
    pub interest_level: Option<i32>,
    pub episode_runtime: Option<i32>,
    pub media_type: String,
    pub content_tags: Option<String>,
}
