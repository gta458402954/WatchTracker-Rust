use crate::app_paths::AppPaths;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

pub async fn search_tmdb(
    api_key: String,
    query: String,
    language: String,
    proxy: Option<String>,
) -> Result<Value, String> {
    let is_imdb_id = query.starts_with("tt")
        && query.len() > 2
        && query[2..].chars().all(|c| c.is_ascii_digit());
    if is_imdb_id {
        log::info!("[TMDB] IMDb ID Searching for: {}", query);
    } else {
        log::info!("[TMDB] Multi Searching for: {}", query);
    }

    let mut builder = Client::builder();
    if let Some(p) = proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let is_jwt = api_key.contains('.') || api_key.len() > 40;

    let url = if is_imdb_id {
        if is_jwt {
            format!(
                "https://api.themoviedb.org/3/find/{}?external_source=imdb_id&language={}",
                query, language
            )
        } else {
            format!("https://api.themoviedb.org/3/find/{}?api_key={}&external_source=imdb_id&language={}", query, api_key, language)
        }
    } else {
        if is_jwt {
            format!(
                "https://api.themoviedb.org/3/search/multi?query={}&language={}&include_adult=false",
                urlencoding::encode(&query), language
            )
        } else {
            format!(
                "https://api.themoviedb.org/3/search/multi?api_key={}&query={}&language={}&include_adult=false",
                api_key, urlencoding::encode(&query), language
            )
        }
    };

    let mut req = client.get(&url).header("accept", "application/json");
    if is_jwt {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let res = req.send().await.map_err(|e| {
        let err = format!("Network error: {}", e);
        log::error!("[TMDB] {}", err);
        err
    })?;

    let status = res.status();
    let json: Value = res.json().await.map_err(|e| {
        let err = format!("JSON parse error: {}", e);
        log::error!("[TMDB] {}", err);
        err
    })?;

    // 检查 TMDB API 级别的错误
    if !status.is_success() {
        let err_msg = json
            .get("status_message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown API error");
        let err = format!("TMDB API Error ({}): {}", status, err_msg);
        log::error!("[TMDB] {}", err);
        return Err(err);
    }

    let mut final_json = json;

    // 如果是 IMDb ID，转换结果格式使其与 search/multi 一致
    if is_imdb_id {
        let mut combined_results = Vec::new();
        if let Some(movies) = final_json.get("movie_results").and_then(|r| r.as_array()) {
            for m in movies {
                let mut item = m.clone();
                if item.get("media_type").is_none() {
                    item["media_type"] = serde_json::json!("movie");
                }
                combined_results.push(item);
            }
        }
        if let Some(tvs) = final_json.get("tv_results").and_then(|r| r.as_array()) {
            for t in tvs {
                let mut item = t.clone();
                if item.get("media_type").is_none() {
                    item["media_type"] = serde_json::json!("tv");
                }
                combined_results.push(item);
            }
        }
        if let Some(seasons) = final_json
            .get("tv_season_results")
            .and_then(|r| r.as_array())
        {
            for s in seasons {
                let mut item = s.clone();
                if item.get("media_type").is_none() {
                    item["media_type"] = serde_json::json!("tv_season");
                }
                combined_results.push(item);
            }
        }
        if let Some(episodes) = final_json
            .get("tv_episode_results")
            .and_then(|r| r.as_array())
        {
            for e in episodes {
                let mut item = e.clone();
                if item.get("media_type").is_none() {
                    item["media_type"] = serde_json::json!("tv_episode");
                }
                combined_results.push(item);
            }
        }
        final_json = serde_json::json!({
            "results": combined_results
        });
    }

    // 如果中文没搜到，尝试英文
    if let Some(results) = final_json.get("results").and_then(|r| r.as_array()) {
        if results.is_empty() && language != "en-US" {
            log::info!("[TMDB] No zh-CN results, trying en-US...");
            let en_url = if is_imdb_id {
                if is_jwt {
                    format!("https://api.themoviedb.org/3/find/{}?external_source=imdb_id&language=en-US", query)
                } else {
                    format!("https://api.themoviedb.org/3/find/{}?api_key={}&external_source=imdb_id&language=en-US", query, api_key)
                }
            } else {
                if is_jwt {
                    format!(
                         "https://api.themoviedb.org/3/search/multi?query={}&language=en-US&include_adult=false",
                         urlencoding::encode(&query)
                     )
                } else {
                    format!(
                         "https://api.themoviedb.org/3/search/multi?api_key={}&query={}&language=en-US&include_adult=false",
                         api_key, urlencoding::encode(&query)
                     )
                }
            };
            let mut en_req = client.get(&en_url).header("accept", "application/json");
            if is_jwt {
                en_req = en_req.header("Authorization", format!("Bearer {}", api_key));
            }
            let en_res = en_req.send().await.map_err(|e| e.to_string())?;
            let en_status = en_res.status();
            let mut en_json: Value = en_res.json().await.map_err(|e| e.to_string())?;
            if !en_status.is_success() {
                let message = en_json
                    .get("status_message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown API error");
                return Err(format!("TMDB API Error ({}): {}", en_status, message));
            }

            if is_imdb_id {
                let mut combined_results = Vec::new();
                if let Some(movies) = en_json.get("movie_results").and_then(|r| r.as_array()) {
                    for m in movies {
                        let mut item = m.clone();
                        if item.get("media_type").is_none() {
                            item["media_type"] = serde_json::json!("movie");
                        }
                        combined_results.push(item);
                    }
                }
                if let Some(tvs) = en_json.get("tv_results").and_then(|r| r.as_array()) {
                    for t in tvs {
                        let mut item = t.clone();
                        if item.get("media_type").is_none() {
                            item["media_type"] = serde_json::json!("tv");
                        }
                        combined_results.push(item);
                    }
                }
                if let Some(seasons) = en_json.get("tv_season_results").and_then(|r| r.as_array()) {
                    for s in seasons {
                        let mut item = s.clone();
                        if item.get("media_type").is_none() {
                            item["media_type"] = serde_json::json!("tv_season");
                        }
                        combined_results.push(item);
                    }
                }
                if let Some(episodes) = en_json.get("tv_episode_results").and_then(|r| r.as_array())
                {
                    for e in episodes {
                        let mut item = e.clone();
                        if item.get("media_type").is_none() {
                            item["media_type"] = serde_json::json!("tv_episode");
                        }
                        combined_results.push(item);
                    }
                }
                en_json = serde_json::json!({
                    "results": combined_results
                });
            }

            return Ok(en_json);
        }
        log::info!("[TMDB] Found {} results", results.len());
    }

    Ok(final_json)
}

pub async fn get_tmdb_detail(
    api_key: String,
    id: i32,
    media_type: String,
    language: String,
    proxy: Option<String>,
) -> Result<Value, String> {
    if !matches!(media_type.as_str(), "movie" | "tv") {
        return Err("Unsupported TMDB media type".to_string());
    }
    if id <= 0 {
        return Err("Invalid TMDB ID".to_string());
    }
    log::info!("[TMDB] Fetching detail for {} ID: {}", media_type, id);

    let mut builder = Client::builder();
    if let Some(p) = proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let is_jwt = api_key.contains('.') || api_key.len() > 40;

    let url = if is_jwt {
        format!(
            "https://api.themoviedb.org/3/{}/{}?append_to_response=external_ids&language={}",
            media_type, id, language
        )
    } else {
        format!(
            "https://api.themoviedb.org/3/{}/{}?api_key={}&append_to_response=external_ids&language={}",
            media_type, id, api_key, language
        )
    };

    let mut req = client.get(&url).header("accept", "application/json");
    if is_jwt {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let res = req.send().await.map_err(|e| {
        log::error!("[TMDB] Detail network error: {}", e);
        e.to_string()
    })?;
    let status = res.status();
    let json: Value = res.json().await.map_err(|e| {
        log::error!("[TMDB] Detail JSON error: {}", e);
        e.to_string()
    })?;
    if !status.is_success() {
        let message = json
            .get("status_message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown API error");
        return Err(format!("TMDB API Error ({}): {}", status, message));
    }
    Ok(json)
}

pub async fn download_poster(
    paths: &AppPaths,
    poster_path: String,
    proxy: Option<String>,
) -> Result<bool, String> {
    if poster_path.is_empty() {
        return Ok(false);
    }

    let file_name = PathBuf::from(&poster_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid path")?
        .to_string();

    let local_path = paths.poster_file(&file_name)?;
    if local_path.exists() {
        return Ok(true);
    }

    let url = format!("https://image.tmdb.org/t/p/w342{}", poster_path);

    let mut builder = Client::builder();
    if let Some(p) = proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let res = client.get(url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Download failed: {}", res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let mut file = fs::File::create(local_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;

    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavResponse {
    pub status: u16,
    pub body: Option<Value>,
    pub etag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavRequest {
    pub method: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub body: Option<String>,
    pub proxy: Option<String>,
    pub if_match: Option<String>,
    pub if_none_match: Option<String>,
}

pub async fn webdav_request(request: WebDavRequest) -> Result<WebDavResponse, String> {
    log::info!("[WebDAV] {} Request to: {}", request.method, request.url);

    let mut builder = Client::builder();
    if let Some(p) = request.proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut req_builder = match request.method.as_str() {
        "MKCOL" => client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &request.url),
        "PUT" => client.put(&request.url),
        "GET" => client.get(&request.url),
        _ => return Err(format!("Unsupported method: {}", request.method)),
    };

    req_builder = req_builder.basic_auth(request.username, Some(request.password));

    if let Some(value) = request.if_match {
        req_builder = req_builder.header(reqwest::header::IF_MATCH, value);
    }
    if let Some(value) = request.if_none_match {
        req_builder = req_builder.header(reqwest::header::IF_NONE_MATCH, value);
    }

    if let Some(b) = request.body {
        req_builder = req_builder
            .header("Content-Type", "application/json")
            .body(b);
    }

    let res = req_builder.send().await.map_err(|e| {
        log::error!("[WebDAV] Request error: {}", e);
        e.to_string()
    })?;

    let status = res.status();
    let etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if request.method == "GET" && status.is_success() {
        let json: Value = res.json().await.map_err(|e| {
            log::error!("[WebDAV] JSON parse error: {}", e);
            e.to_string()
        })?;
        return Ok(WebDavResponse {
            status: status.as_u16(),
            body: Some(json),
            etag,
        });
    }

    Ok(WebDavResponse {
        status: status.as_u16(),
        body: None,
        etag,
    })
}
