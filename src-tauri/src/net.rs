use reqwest::Client;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;
use serde_json::Value;

pub async fn search_tmdb(api_key: String, query: String, media_type: String, language: String, proxy: Option<String>) -> Result<Value, String> {
    log::info!("[TMDB] Searching {} for: {}", media_type, query);
    
    let mut builder = Client::builder();
    if let Some(p) = proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let url = format!(
        "https://api.themoviedb.org/3/search/{}?api_key={}&query={}&language={}&include_adult=false",
        media_type, api_key, urlencoding::encode(&query), language
    );

    let res = client.get(url).send().await.map_err(|e| {
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
        let err_msg = json.get("status_message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown API error");
        let err = format!("TMDB API Error ({}): {}", status, err_msg);
        log::error!("[TMDB] {}", err);
        return Err(err);
    }

    // 如果中文没搜到，尝试英文
    if let Some(results) = json.get("results").and_then(|r| r.as_array()) {
        if results.is_empty() && language != "en-US" {
             log::info!("[TMDB] No zh-CN results, trying en-US...");
             let en_url = format!(
                "https://api.themoviedb.org/3/search/{}?api_key={}&query={}&include_adult=false",
                media_type, api_key, urlencoding::encode(&query)
            );
            let en_res = client.get(en_url).send().await.map_err(|e| e.to_string())?;
            let en_json: Value = en_res.json().await.map_err(|e| e.to_string())?;
            return Ok(en_json);
        }
        log::info!("[TMDB] Found {} results", results.len());
    }

    Ok(json)
}

pub async fn get_tmdb_detail(api_key: String, id: i32, media_type: String, language: String, proxy: Option<String>) -> Result<Value, String> {
    log::info!("[TMDB] Fetching detail for {} ID: {}", media_type, id);
    
    let mut builder = Client::builder();
    if let Some(p) = proxy {
        if !p.trim().is_empty() {
            builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let url = format!(
        "https://api.themoviedb.org/3/{}/{}?api_key={}&language={}",
        media_type, id, api_key, language
    );

    let res = client.get(url).send().await.map_err(|e| {
        log::error!("[TMDB] Detail network error: {}", e);
        e.to_string()
    })?;
    res.json().await.map_err(|e| {
        log::error!("[TMDB] Detail JSON error: {}", e);
        e.to_string()
    })
}

pub async fn download_poster(app_handle: &AppHandle, poster_path: String, proxy: Option<String>) -> Result<bool, String> {
    if poster_path.is_empty() { return Ok(false); }

    // 优先检查可执行文件同级目录下的 data 文件夹
    let app_dir = if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(&PathBuf::new()).to_path_buf();
        let portable_dir = exe_dir.join("data");
        if portable_dir.exists() {
            portable_dir
        } else {
            app_handle.path().app_data_dir().map_err(|e| e.to_string())?
        }
    } else {
        app_handle.path().app_data_dir().map_err(|e| e.to_string())?
    };

    let poster_dir = app_dir.join("posters");
    if !poster_dir.exists() {
        fs::create_dir_all(&poster_dir).map_err(|e| e.to_string())?;
    }

    let file_name = PathBuf::from(&poster_path).file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid path")?.to_string();
    
    let local_path = poster_dir.join(&file_name);
    if local_path.exists() { return Ok(true); }

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
