use rusqlite::types::{FromSql, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::ToSql;
use serde::{Deserialize, Deserializer, Serialize};

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
    #[serde(default)]
    pub episode_tracking_enabled: bool,
    #[serde(default)]
    pub next_episode: Option<i32>,
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
    pub tmdb_media_kind: Option<String>,
    pub tmdb_id: Option<i64>,
    pub tmdb_parent_id: Option<i64>,
    pub tmdb_season_number: Option<i32>,
    pub series_record_kind: Option<String>,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub rev_actor: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T> Deserialize<'de> for Patch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(Debug, Default, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateWatchRecord {
    pub original_name: Option<String>,
    pub chinese_name: Option<String>,
    pub progress: Option<String>,
    #[serde(default)]
    pub total_episodes: Patch<i32>,
    #[serde(default)]
    pub movie_progress: Patch<i32>,
    #[serde(default)]
    pub movie_duration: Patch<i32>,
    #[serde(default)]
    pub release_year: Patch<String>,
    #[serde(default)]
    pub poster_path: Patch<String>,
    pub status: Option<RecordStatus>,
    pub platform: Option<String>,
    #[serde(default)]
    pub rating: Patch<i32>,
    #[serde(default)]
    pub start_date: Patch<String>,
    #[serde(default)]
    pub end_date: Patch<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub imdb_id: Patch<String>,
    #[serde(default)]
    pub is_locked: Patch<bool>,
    #[serde(default)]
    pub genres: Patch<String>,
    #[serde(default)]
    pub origin_country: Patch<String>,
    #[serde(default)]
    pub imdb_rating: Patch<f64>,
    #[serde(default)]
    pub tmdb_status: Patch<String>,
    #[serde(default)]
    pub interest_level: Patch<i32>,
    #[serde(default)]
    pub episode_runtime: Patch<i32>,
    pub media_type: Option<String>,
    #[serde(default)]
    pub content_tags: Patch<String>,
    #[serde(default)]
    pub tmdb_media_kind: Patch<String>,
    #[serde(default)]
    pub tmdb_id: Patch<i64>,
    #[serde(default)]
    pub tmdb_parent_id: Patch<i64>,
    #[serde(default)]
    pub tmdb_season_number: Patch<i32>,
    #[serde(default)]
    pub series_record_kind: Patch<String>,
}
