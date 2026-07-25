use rusqlite::{params, Connection, Result};
use std::fs;
use tauri::AppHandle;
use tauri::Manager;
use crate::models::{WatchRecord, Category};

pub struct DbState {
    pub conn: std::sync::Mutex<Connection>,
}

pub fn diagnose_db(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("SELECT count(*) FROM records")?;
    let count: i32 = stmt.query_row([], |row| row.get(0))?;
    println!("[DIAGNOSE] Total records in DB: {}", count);

    let mut stmt = conn.prepare("SELECT DISTINCT status FROM records")?;
    let rows = stmt.query_map([], |row| {
        let s: String = row.get(0)?;
        Ok(s)
    })?;

    println!("[DIAGNOSE] Distinct status values found:");
    for row in rows {
        let s = row?;
        // 打印原始字符串及其 HEX 编码，检测隐藏字符
        let hex = s.as_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();
        println!("  - Value: '{}', Hex: {}", s, hex);
    }
    Ok(())
}

pub fn init(app_handle: &AppHandle) -> Result<DbState, String> {
    // 优先检查可执行文件同级目录下的 data 文件夹（实现便携化）
    let app_dir = if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(&std::path::PathBuf::new()).to_path_buf();
        let portable_dir = exe_dir.join("data");
        if portable_dir.exists() {
            portable_dir
        } else {
            app_handle.path().app_data_dir().map_err(|e| e.to_string())?
        }
    } else {
        app_handle.path().app_data_dir().map_err(|e| e.to_string())?
    };

    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }
    
    let db_path = app_dir.join("watchtracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    // 初始化表逻辑
    setup_db(&conn).map_err(|e| e.to_string())?;

    Ok(DbState {
        conn: std::sync::Mutex::new(conn),
    })
}

fn setup_db(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);",
        [],
    )?;

    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = 'db_version'")?;
    let current_version: i32 = stmt.query_row([], |row| {
        let val: String = row.get(0)?;
        Ok(val.parse().unwrap_or(0))
    }).unwrap_or(0);

    if current_version < 1 {
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS records (
              id TEXT PRIMARY KEY, originalName TEXT, chineseName TEXT, progress TEXT, totalEpisodes INTEGER, status TEXT, platform TEXT, rating INTEGER, startDate TEXT, endDate TEXT, category TEXT, notes TEXT, createdAt TEXT
            );
            CREATE TABLE IF NOT EXISTS categories (
              name TEXT PRIMARY KEY, emoji TEXT, sortOrder INTEGER
            );
        ")?;

        // 默认分类
        let defaults = vec![
            ("美剧", "🇺🇸"), ("英剧", "🇬🇧"), ("日剧", "🇯🇵"),
            ("韩剧", "🇰🇷"), ("国产剧", "🇨🇳"), ("港剧", "🇭🇰"), ("台剧", "🇹🇼"),
            ("动画", "🦄"), ("纪录片", "🌍"), 
            ("综艺", "🎭"), ("电影", "🎬")
        ];
        for (i, (name, emoji)) in defaults.iter().enumerate() {
            conn.execute(
                "INSERT OR IGNORE INTO categories (name, emoji, sortOrder) VALUES (?, ?, ?)",
                params![name, emoji, i as i32],
            )?;
        }
    }

    if current_version < 2 {
        let cols = vec![
            ("movieProgress", "INTEGER"),
            ("movieDuration", "INTEGER"),
            ("releaseYear", "TEXT"),
            ("posterPath", "TEXT"),
            ("updatedAt", "TEXT"),
        ];
        
        for (name, col_type) in cols {
            let exists: bool = conn.query_row(
                &format!("SELECT count(*) FROM pragma_table_info('records') WHERE name='{}'", name),
                [],
                |row| row.get(0),
            ).unwrap_or(false);
            
            if !exists {
                conn.execute(&format!("ALTER TABLE records ADD COLUMN {} {}", name, col_type), [])?;
            }
        }
    }

    if current_version < 3 {
        // 创建搜索索引以提升性能
        conn.execute("CREATE INDEX IF NOT EXISTS idx_records_chineseName ON records(chineseName);", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_records_originalName ON records(originalName);", [])?;
    }

    if current_version < 4 {
        let exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('records') WHERE name='imdbId'",
            [],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !exists {
            conn.execute("ALTER TABLE records ADD COLUMN imdbId TEXT", [])?;
        }
    }

    if current_version < 5 {
        let exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('records') WHERE name='isLocked'",
            [],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !exists {
            conn.execute("ALTER TABLE records ADD COLUMN isLocked INTEGER DEFAULT 0", [])?;
        }
    }

    if current_version < 6 {
        let exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('records') WHERE name='sortOrder'",
            [],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !exists {
            conn.execute("ALTER TABLE records ADD COLUMN sortOrder INTEGER", [])?;
        }
    }

    if current_version < 7 {
        let cols = vec![
            ("genres", "TEXT"),
            ("originCountry", "TEXT"),
            ("imdbRating", "REAL"),
            ("tmdbStatus", "TEXT"),
            ("interestLevel", "INTEGER"),
        ];
        
        for (name, col_type) in cols {
            let exists: bool = conn.query_row(
                &format!("SELECT count(*) FROM pragma_table_info('records') WHERE name='{}'", name),
                [],
                |row| row.get(0),
            ).unwrap_or(false);
            
            if !exists {
                conn.execute(&format!("ALTER TABLE records ADD COLUMN {} {}", name, col_type), [])?;
            }
        }
    }

    if current_version < 8 {
        let exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('records') WHERE name='episodeRuntime'",
            [],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !exists {
            conn.execute("ALTER TABLE records ADD COLUMN episodeRuntime INTEGER", [])?;
        }

        conn.execute("
            CREATE TABLE IF NOT EXISTS watch_logs (
                id TEXT PRIMARY KEY,
                record_id TEXT NOT NULL,
                date TEXT NOT NULL,
                watched_seconds INTEGER NOT NULL,
                FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
            );
        ", [])?;
    }

    if current_version < 9 {
        conn.execute("UPDATE records SET rating = rating * 2 WHERE rating IS NOT NULL AND rating >= 1 AND rating <= 5;", [])?;
    }

    if current_version < 10 {
        conn.execute("ALTER TABLE records ADD COLUMN mediaType TEXT", []).ok();
        conn.execute("ALTER TABLE records ADD COLUMN contentTags TEXT", []).ok();
        conn.execute("UPDATE records SET mediaType = CASE WHEN category IN ('电影', '纪录片') THEN '电影' WHEN category = '综艺' THEN '综艺' WHEN category = '动画' THEN '动画' ELSE '剧集' END WHERE mediaType IS NULL OR mediaType = ''", [])?;
        conn.execute("UPDATE records SET contentTags = CASE WHEN contentTags IS NULL OR contentTags = '' THEN CASE WHEN category = '纪录片' THEN '纪录片' ELSE '' END ELSE contentTags END", [])?;
    }

    if current_version < 11 {
        conn.execute("UPDATE records SET contentTags = CASE category WHEN '美剧' THEN '美国' WHEN '英剧' THEN '英国' WHEN '日剧' THEN '日本' WHEN '韩剧' THEN '韩国' WHEN '国产剧' THEN '中国大陆' WHEN '港剧' THEN '中国香港' WHEN '台剧' THEN '中国台湾' WHEN '纪录片' THEN '纪录片' ELSE contentTags END WHERE contentTags IS NULL OR contentTags = ''", [])?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)",
        params!["11"],
    )?;

    Ok(())
}

// 命令实现
pub fn get_all_records(conn: &Connection) -> Result<Vec<WatchRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM records ORDER BY createdAt DESC")?;
    
    // 使用列名映射，避免索引错误
    let rows = stmt.query_map([], |row| {
        Ok(WatchRecord {
            id: row.get("id")?,
            original_name: row.get("originalName")?,
            chinese_name: row.get("chineseName")?,
            progress: row.get("progress")?,
            total_episodes: row.get("totalEpisodes")?,
            status: {
                let s: String = row.get("status")?;
                let lower_s = s.to_lowercase();
                match lower_s.trim() {
                    "watched" | "completed" | "finish" | "finished" | "done" | "已看" => "已看".to_string(),
                    "watching" | "doing" | "start" | "started" | "在看" => "在看".to_string(),
                    "todo" | "wish" | "plan" | "planned" | "waiting" | "未看" => "未看".to_string(),
                    _ => {
                        // 如果还是没匹配上，保持原始字符，但在终端输出一条警告
                        if !s.is_empty() {
                            eprintln!("[DB] Unknown status found: '{}'", s);
                        }
                        s
                    }
                }
            },
            platform: row.get("platform")?,
            rating: row.get("rating").unwrap_or(None),
            start_date: row.get("startDate")?,
            end_date: row.get("endDate")?,
            category: row.get("category")?,
            notes: row.get("notes")?,
            created_at: row.get("createdAt")?,
            movie_progress: row.get("movieProgress").unwrap_or(None),
            movie_duration: row.get("movieDuration").unwrap_or(None),
            release_year: {
                if let Ok(val) = row.get::<_, String>("releaseYear") {
                    Some(val)
                } else if let Ok(val) = row.get::<_, i32>("releaseYear") {
                    Some(val.to_string())
                } else {
                    None
                }
            },
            poster_path: row.get("posterPath").unwrap_or(None),
            updated_at: row.get("updatedAt").unwrap_or(None),
            imdb_id: row.get("imdbId").unwrap_or(None),
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
    })?;

    let mut results = Vec::new();
    for row in rows {
        match row {
            Ok(r) => results.push(r),
            Err(e) => eprintln!("[DB] Failed to read record row: {}", e),
        }
    }
    Ok(results)
}

pub fn insert_record(conn: &Connection, r: WatchRecord) -> Result<()> {
    log::info!("[DB] Inserting/Updating record: {} ({})", r.chinese_name, r.id);
    let is_locked_int = r.is_locked.map(|b| if b { 1 } else { 0 });
    conn.execute(
        "INSERT OR REPLACE INTO records (id, originalName, chineseName, progress, totalEpisodes, status, platform, rating, startDate, endDate, category, notes, createdAt, movieProgress, movieDuration, releaseYear, posterPath, updatedAt, imdbId, isLocked, sortOrder, genres, originCountry, imdbRating, tmdbStatus, interestLevel, episodeRuntime, mediaType, contentTags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            r.id, r.original_name, r.chinese_name, r.progress, r.total_episodes,
            r.status, r.platform, r.rating, r.start_date, r.end_date,
            r.category, r.notes, r.created_at, r.movie_progress, r.movie_duration,
            r.release_year, r.poster_path, r.updated_at, r.imdb_id, is_locked_int, r.sort_order,
            r.genres, r.origin_country, r.imdb_rating, r.tmdb_status, r.interest_level, r.episode_runtime, r.media_type, r.content_tags
        ],
    )?;
    Ok(())
}

pub fn delete_record(conn: &Connection, id: String) -> Result<()> {
    log::info!("[DB] Deleting record: {}", id);
    conn.execute("DELETE FROM records WHERE id = ?", params![id])?;
    Ok(())
}

pub fn replace_all_records(conn: &Connection, records: Vec<WatchRecord>) -> Result<()> {
    conn.execute("BEGIN TRANSACTION", [])?;
    let res = (|| {
        // 先获取所有被锁定的记录 ID
        let mut stmt = conn.prepare("SELECT id FROM records WHERE isLocked = 1")?;
        let locked_ids: Vec<String> = stmt.query_map([], |row| row.get(0))?.filter_map(Result::ok).collect();
        
        // 删除所有未锁定的记录
        conn.execute("DELETE FROM records WHERE isLocked IS NULL OR isLocked = 0", [])?;
        
        for r in records {
            // 如果云端下发的数据对应的本地记录已锁定，直接跳过不覆盖
            if locked_ids.contains(&r.id) {
                log::info!("[DB] Sync skipping locked record: {}", r.id);
                continue;
            }
            insert_record(conn, r)?;
        }
        conn.execute("COMMIT", [])?;
        Ok(())
    })();
    if res.is_err() {
        let _ = conn.execute("ROLLBACK", []);
    }
    res
}

pub fn get_all_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT * FROM categories ORDER BY sortOrder ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(Category {
            name: row.get("name")?,
            emoji: row.get("emoji")?,
            sort_order: row.get("sortOrder")?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn upsert_category(conn: &Connection, c: Category) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO categories (name, emoji, sortOrder) VALUES (?, ?, ?)",
        params![c.name, c.emoji, c.sort_order],
    )?;
    Ok(())
}

pub fn delete_category(conn: &Connection, name: String) -> Result<()> {
    conn.execute("DELETE FROM categories WHERE name = ?", params![name])?;
    Ok(())
}

pub fn rename_category(conn: &Connection, old_name: String, new_name: String, emoji: String) -> Result<()> {
    // 先查出原分类的 sortOrder，避免重命名后顺序丢失
    let original_sort_order: i32 = conn.query_row(
        "SELECT sortOrder FROM categories WHERE name = ?",
        params![old_name],
        |row| row.get(0),
    ).unwrap_or(0);

    conn.execute("UPDATE records SET category = ? WHERE category = ?", params![new_name, old_name])?;
    conn.execute("DELETE FROM categories WHERE name = ?", params![old_name])?;
    conn.execute(
        "INSERT OR REPLACE INTO categories (name, emoji, sortOrder) VALUES (?, ?, ?)",
        params![new_name, emoji, original_sort_order],
    )?;
    Ok(())
}

pub fn reorder_categories(conn: &Connection, names: Vec<String>) -> Result<()> {
    for (i, name) in names.iter().enumerate() {
        conn.execute("UPDATE categories SET sortOrder = ? WHERE name = ?", params![i as i32, name])?;
    }
    Ok(())
}

pub fn reorder_records(conn: &Connection, ids: Vec<String>) -> Result<()> {
    // Start transaction for atomic bulk update
    conn.execute("BEGIN TRANSACTION", [])?;
    for (i, id) in ids.iter().enumerate() {
        if let Err(e) = conn.execute("UPDATE records SET sortOrder = ? WHERE id = ?", params![i as i32, id]) {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    }
    conn.execute("COMMIT", [])?;
    Ok(())
}

pub fn set_setting(conn: &Connection, key: String, value: String) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", params![key, value])?;
    Ok(())
}

pub fn vacuum_db(conn: &Connection) -> Result<()> {
    conn.execute("VACUUM", [])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: String) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
    let res = stmt.query_row(params![key], |row| row.get(0)).ok();
    Ok(res)
}
