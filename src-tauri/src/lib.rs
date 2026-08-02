mod app_paths;
mod auth;
mod commands;
mod db;
mod db_atomic_crud;
mod db_atomic_helpers;
mod db_atomic_update;
mod error;
mod models;
mod net;
mod record_validation;
mod recovery_points;

#[cfg(test)]
mod db_atomic_tests;

use app_paths::AppPaths;
use tauri::Manager;

fn setup_logging(paths: &AppPaths) -> Result<(), String> {
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
        .chain(fern::log_file(paths.log()).map_err(|error| {
            format!(
                "Could not open the application log at {}: {error}",
                paths.log().display()
            )
        })?)
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
            let paths = context.app_handle().state::<AppPaths>();
            let full_path = match paths.poster_file(file_name) {
                Ok(path) => path,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(400)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            if !full_path.is_file() {
                return tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap();
            }

            let content = match std::fs::read(&full_path) {
                Ok(content) => content,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            let mime_type = infer::get(&content)
                .map(|file_type| file_type.mime_type())
                .unwrap_or_else(|| match full_path.extension().and_then(|extension| extension.to_str()) {
                    Some("png") | Some("PNG") => "image/png",
                    Some("webp") | Some("WEBP") => "image/webp",
                    Some("gif") | Some("GIF") => "image/gif",
                    _ => "image/jpeg",
                });

            tauri::http::Response::builder()
                .header("Content-Type", mime_type)
                .body(content)
                .unwrap()
        })
        .setup(|app| {
            let paths = AppPaths::resolve(app.handle())?;
            setup_logging(&paths)?;
            if let Err(error) = recovery_points::cleanup_temporary_files(&paths) {
                log::warn!("Could not clean stale recovery-point temporary files: {error}");
            }
            log::info!(
                "Application starting with {} data root: {} (database: {}, posters: {}, backups: {})",
                paths.mode().as_str(),
                paths.root().display(),
                paths.database().display(),
                paths.posters().display(),
                paths.backups().display()
            );

            let db_state = db::init(&paths)?;

            app.manage(paths);
            app.manage(db_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_all_records,
            commands::get_database_compatibility,
            commands::insert_record,
            commands::update_record,
            commands::delete_record,
            commands::replace_all_records,
            commands::create_recovery_point,
            commands::list_recovery_points,
            commands::set_recovery_point_retained,
            commands::delete_recovery_point,
            commands::restore_recovery_point,
            commands::open_backup_directory,
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
