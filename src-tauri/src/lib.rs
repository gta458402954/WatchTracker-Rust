mod auth;
mod commands;
mod db;
mod error;
mod models;
mod net;

use std::path::{Component, Path, PathBuf};
use tauri::Manager;

fn setup_logging(app_handle: &tauri::AppHandle) -> Result<(), String> {
    // 优先使用便携式 data 目录
    let app_dir = if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(&PathBuf::new()).to_path_buf();
        let portable_dir = exe_dir.join("data");
        if portable_dir.exists() {
            portable_dir
        } else {
            app_handle.path().app_data_dir().unwrap_or_default()
        }
    } else {
        app_handle.path().app_data_dir().unwrap_or_default()
    };

    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }

    let log_path = app_dir.join("app.log");

    fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "{}[{}][{}] {}",
                chrono::Local::now().format("[%Y-%m-%d][%H:%M:%S]"),
                record.target(),
                record.level(),
                message
            ))
        })
        .level(log::LevelFilter::Info)
        .chain(std::io::stdout())
        .chain(fern::log_file(log_path).map_err(|e| e.to_string())?)
        .apply()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .register_uri_scheme_protocol("poster", |context, request| {
            let path = request.uri().path();
            let file_name = path.trim_start_matches('/');

            // `poster://` 只应访问海报目录中的单个文件。拒绝目录、绝对路径和
            // `..`，避免来自导入数据的 posterPath 跳出 posters 目录。
            let mut components = Path::new(file_name).components();
            let is_safe_file_name = matches!(components.next(), Some(Component::Normal(_)))
                && components.next().is_none();
            if !is_safe_file_name {
                return tauri::http::Response::builder()
                    .status(400)
                    .body(Vec::new())
                    .unwrap();
            }

            // 优先检查可执行文件同级目录下的 data 文件夹
            let app_dir = if let Ok(exe_path) = std::env::current_exe() {
                let exe_dir = exe_path
                    .parent()
                    .unwrap_or(&std::path::PathBuf::new())
                    .to_path_buf();
                let portable_dir = exe_dir.join("data");
                if portable_dir.exists() {
                    portable_dir
                } else {
                    context
                        .app_handle()
                        .path()
                        .app_data_dir()
                        .unwrap_or_default()
                }
            } else {
                context
                    .app_handle()
                    .path()
                    .app_data_dir()
                    .unwrap_or_default()
            };

            let full_path = app_dir.join("posters").join(file_name);

            if full_path.exists() {
                let content = std::fs::read(full_path).unwrap_or_default();
                tauri::http::Response::builder()
                    .header("Content-Type", "image/jpeg")
                    .body(content)
                    .unwrap()
            } else {
                tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap()
            }
        })
        .setup(|app| {
            // 初始化日志
            let _ = setup_logging(app.handle());
            log::info!("Application starting up (Portable Mode)...");

            // 初始化数据库
            let db_state = db::init(app.handle())?;

            app.manage(db_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_all_records,
            commands::insert_record,
            commands::update_record,
            commands::delete_record,
            commands::replace_all_records,
            commands::get_setting,
            commands::set_setting,
            commands::vacuum_db,
            commands::encrypt,
            commands::decrypt,
            commands::search_tmdb,
            commands::get_tmdb_detail,
            commands::download_poster,
            commands::webdav_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
