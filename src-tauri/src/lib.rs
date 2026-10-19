//! Tauri shell: wires the core engine and local storage to typed IPC commands.

mod commands;
mod logging;
mod state;

use std::sync::Arc;

use tauri::Manager;
use tpm_core::credentials::{CredentialStore, MemoryStore};
use tpm_core::engine::Engine;
use tpm_core::storage::Storage;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opener: Rust-side only (release page); no webview permission is granted.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let paths = app.path();
            let data_dir = paths.app_data_dir()?;
            let log_dir = paths.app_log_dir().unwrap_or_else(|_| data_dir.join("logs"));
            std::fs::create_dir_all(&data_dir)?;

            let storage = Storage::open(&data_dir.join("app.db"))?;
            let level = storage
                .get_setting("log.level")
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "info".into());
            logging::init(&log_dir, &level);
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting");

            let retention_days = setting_u32(&storage, "history.retentionDays", 90);
            let max_entries = setting_u32(&storage, "history.maxEntries", 10_000);
            if let Ok(n) = storage.prune_history(retention_days, max_entries)
                && n > 0
            {
                tracing::info!(removed = n, "pruned query history");
            }

            // Restore points past their keep period or the size limit (settings) go at startup.
            let _ = storage.discard_pending_restore_points();
            if let Ok(n) = storage.purge_restore_points()
                && n > 0
            {
                tracing::info!(removed = n, "purged restore points");
            }

            let keyring = detect_keyring();
            let storage = Arc::new(storage);
            let engine = Arc::new(Engine::with_known_hosts(data_dir.join("known_hosts")));
            engine.set_restore_store(storage.clone());
            app.manage(AppState {
                engine,
                storage,
                keyring,
                session_secrets: Arc::new(MemoryStore::default()),
                data_dir,
                log_dir,
                jobs: Default::default(),
                ai_jobs: Default::default(),
                pending_update: Default::default(),
                update_jobs: Default::default(),
                update_lock: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections::app_info,
            commands::connections::open_window,
            commands::connections::list_connections,
            commands::connections::parse_url,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::reorder_connections,
            commands::connections::test_connection,
            commands::connections::connect,
            commands::connections::cancel_connect,
            commands::connections::disconnect,
            commands::connections::reconnect,
            commands::connections::ping,
            commands::query::set_default_schema,
            commands::connections::create_database_file,
            commands::connections::trust_ssh_host,
            commands::connections::export_connections,
            commands::connections::import_connections,
            commands::mongo::mongo_connect,
            commands::mongo::mongo_disconnect,
            commands::mongo::mongo_databases,
            commands::mongo::mongo_collections,
            commands::mongo::mongo_find,
            commands::mongo::mongo_count,
            commands::mongo::mongo_aggregate,
            commands::mongo::mongo_vector_search,
            commands::mongo::mongo_delete_count,
            commands::mongo::mongo_delete,
            commands::redis::redis_connect,
            commands::redis::redis_disconnect,
            commands::redis::redis_info,
            commands::redis::redis_scan,
            commands::redis::redis_read,
            commands::redis::redis_set_string,
            commands::redis::redis_hash_set,
            commands::redis::redis_hash_delete,
            commands::redis::redis_delete,
            commands::redis::redis_expire,
            commands::redis::redis_command,
            commands::ai::ai_status,
            commands::ai::ai_set_key,
            commands::ai::ai_preview,
            commands::ai::ai_send,
            commands::ai::ai_cancel,
            commands::update::update_status,
            commands::update::update_check,
            commands::update::update_install,
            commands::update::update_cancel,
            commands::update::update_open_release_page,
            commands::query::list_databases,
            commands::query::list_schemas,
            commands::query::list_objects,
            commands::query::table_structure,
            commands::query::referencing_keys,
            commands::query::object_definition,
            commands::query::split_sql,
            commands::query::statement_at_cursor,
            commands::query::script_parameters,
            commands::query::analyze_sql,
            commands::query::run_query,
            commands::query::cancel_query,
            commands::query::fetch_rows,
            commands::query::release_results,
            commands::query::browse_table,
            commands::query::fetch_value,
            commands::query::fetch_column,
            commands::query::result_value,
            commands::query::result_values,
            commands::query::count_rows,
            commands::query::preview_changes,
            commands::query::apply_changes,
            commands::query::preview_change_sets,
            commands::query::apply_change_sets,
            commands::query::preview_restore,
            commands::query::apply_restore,
            commands::query::preview_create_table,
            commands::query::preview_alter_table,
            commands::query::apply_ddl,
            commands::query::explain_query,
            commands::query::run_widget_query,
            commands::transfer::cancel_job,
            commands::transfer::export_result,
            commands::transfer::export_table,
            commands::transfer::export_rows,
            commands::transfer::rows_as_text,
            commands::transfer::preview_import,
            commands::transfer::import_file,
            commands::transfer::read_sql_file,
            commands::transfer::write_sql_file,
            commands::transfer::run_sql_file,
            commands::library::search_history,
            commands::library::list_restore_points,
            commands::library::get_restore_point,
            commands::library::delete_restore_point,
            commands::library::delete_restore_points,
            commands::library::restore_points_usage,
            commands::library::delete_history,
            commands::library::clear_history,
            commands::library::prune_history,
            commands::library::list_saved_queries,
            commands::library::save_query,
            commands::library::delete_saved_query,
            commands::library::list_filter_presets,
            commands::library::list_column_fetch,
            commands::library::list_pins,
            commands::library::list_snippets,
            commands::library::save_snippet,
            commands::library::delete_snippet,
            commands::library::pin_object,
            commands::library::unpin_object,
            commands::library::set_column_fetch,
            commands::library::save_filter_preset,
            commands::library::delete_filter_preset,
            commands::library::list_dashboards,
            commands::library::save_dashboard,
            commands::library::delete_dashboard,
            commands::library::get_settings,
            commands::library::set_setting,
            commands::library::reset_settings,
            commands::library::get_workspace,
            commands::library::set_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let engine = app.state::<AppState>().engine.clone();
                tauri::async_runtime::block_on(engine.close_all());
            }
        });
}

fn setting_u32(storage: &Storage, key: &str, default: u32) -> u32 {
    storage.get_setting(key).ok().flatten().and_then(|v| v.as_u64()).map_or(default, |n| n.min(u32::MAX as u64) as u32)
}

fn detect_keyring() -> Option<Arc<dyn CredentialStore>> {
    match tpm_core::credentials::OsKeyring::detect() {
        Ok(k) => Some(Arc::new(k)),
        Err(e) => {
            tracing::warn!(error = %e.message, "system credential store unavailable; passwords will be requested at connect time");
            None
        }
    }
}
