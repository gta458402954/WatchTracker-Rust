use serde::{Deserialize, Serialize};

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
    pub status: String,
    pub platform: String,
    pub rating: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub category: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub imdb_id: Option<String>,
    pub is_locked: Option<bool>,
    pub sort_order: Option<i32>,
    pub genres: Option<String>,
    pub origin_country: Option<String>,
    pub imdb_rating: Option<f64>,
    pub tmdb_status: Option<String>,
    pub interest_level: Option<i32>,
    pub episode_runtime: Option<i32>,
    pub media_type: Option<String>,
    pub content_tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub name: String,
    pub emoji: String,
    pub sort_order: i32,
}
