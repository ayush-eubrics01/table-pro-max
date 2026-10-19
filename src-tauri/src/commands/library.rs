//! Locally stored user data: history, saved queries, filter presets, dashboards,
//! settings and workspace state.

use tauri::State;
use tpm_core::error::Result;
use tpm_core::restore::{RestorePoint, RestorePointSummary, RestoreStore, RestoreUsage};
use tpm_core::storage::{ColumnFetch, Dashboard, FetchMode, FilterPreset, HistoryEntry, Pin, SavedQuery, Snippet};

use crate::state::AppState;

#[tauri::command]
pub fn search_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    search: String,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>> {
    state.storage.search_history(connection_id.as_deref(), &search, limit.unwrap_or(200))
}

#[tauri::command]
pub fn delete_history(state: State<'_, AppState>, ids: Vec<i64>) -> Result<()> {
    state.storage.delete_history(&ids)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>, connection_id: Option<String>) -> Result<()> {
    state.storage.clear_history(connection_id.as_deref())
}

#[tauri::command]
pub fn list_saved_queries(state: State<'_, AppState>) -> Result<Vec<SavedQuery>> {
    state.storage.list_saved_queries()
}

#[tauri::command]
pub fn save_query(state: State<'_, AppState>, query: SavedQuery) -> Result<()> {
    state.storage.save_query(&query)
}

#[tauri::command]
pub fn delete_saved_query(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_saved_query(&id)
}

#[tauri::command]
pub fn list_filter_presets(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<Vec<FilterPreset>> {
    state.storage.list_filter_presets(&connection_id, &schema, &table)
}

#[tauri::command]
pub fn save_filter_preset(state: State<'_, AppState>, preset: FilterPreset) -> Result<()> {
    state.storage.save_filter_preset(&preset)
}

#[tauri::command]
pub fn delete_filter_preset(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_filter_preset(&id)
}

#[tauri::command]
pub fn list_dashboards(state: State<'_, AppState>) -> Result<Vec<Dashboard>> {
    state.storage.list_dashboards()
}

#[tauri::command]
pub fn save_dashboard(state: State<'_, AppState>, dashboard: Dashboard) -> Result<()> {
    state.storage.save_dashboard(&dashboard)
}

#[tauri::command]
pub fn delete_dashboard(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_dashboard(&id)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<serde_json::Map<String, serde_json::Value>> {
    state.storage.all_settings()
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<()> {
    if key.len() > 128 {
        return Err(tpm_core::AppError::invalid_config("Setting key is too long"));
    }
    state.storage.set_setting(&key, &value)
}

#[tauri::command]
pub fn reset_settings(state: State<'_, AppState>) -> Result<()> {
    state.storage.reset_settings()
}

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>, key: String) -> Result<Option<serde_json::Value>> {
    state.storage.get_workspace(&key)
}

#[tauri::command]
pub fn set_workspace(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<()> {
    state.storage.set_workspace(&key, &value)
}

#[tauri::command]
pub fn prune_history(state: State<'_, AppState>, days: u32, max_entries: u32) -> Result<usize> {
    state.storage.prune_history(days, max_entries)
}

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    state.storage.list_snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> Result<()> {
    state.storage.save_snippet(&snippet)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_snippet(&id)
}

/// Objects pinned to the top of the sidebar for a connection and database, in pin order.
/// `database` is empty where a connection has one database.
#[tauri::command]
pub fn list_pins(state: State<'_, AppState>, connection_id: String, database: String) -> Result<Vec<Pin>> {
    state.storage.list_pins(&connection_id, &database)
}

#[tauri::command]
pub fn pin_object(state: State<'_, AppState>, connection_id: String, database: String, pin: Pin) -> Result<()> {
    state.storage.pin(&connection_id, &database, &pin)
}

#[tauri::command]
pub fn unpin_object(state: State<'_, AppState>, connection_id: String, database: String, pin: Pin) -> Result<()> {
    state.storage.unpin(&connection_id, &database, &pin)
}

#[tauri::command]
pub fn list_column_fetch(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnFetch>> {
    state.storage.list_column_fetch(&connection_id, &schema, &table)
}

#[tauri::command]
pub fn set_column_fetch(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    mode: Option<FetchMode>,
) -> Result<()> {
    state.storage.set_column_fetch(&connection_id, &schema, &table, &column, mode)
}

// ---- restore points (copies of changed rows, kept on this computer) ---------------------

#[tauri::command]
pub fn list_restore_points(state: State<'_, AppState>, connection_id: String) -> Result<Vec<RestorePointSummary>> {
    state.storage.list_restore_points(&connection_id)
}

#[tauri::command]
pub fn get_restore_point(state: State<'_, AppState>, id: String) -> Result<RestorePoint> {
    state.storage.get(&id)
}

#[tauri::command]
pub fn delete_restore_point(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete(&[id])
}

/// Deletes all of a connection's restore points (pending ones stay until their transaction ends).
#[tauri::command]
pub fn delete_restore_points(state: State<'_, AppState>, connection_id: String) -> Result<usize> {
    state.storage.delete_restore_points(&connection_id)
}

#[tauri::command]
pub fn restore_points_usage(state: State<'_, AppState>) -> Result<RestoreUsage> {
    state.storage.restore_points_usage()
}
