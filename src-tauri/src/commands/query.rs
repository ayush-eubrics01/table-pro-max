//! SQL execution, browsing, editing and schema commands.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tpm_core::browse::BrowseRequest;
use tpm_core::changes::{ChangeSet, ColumnValue};
use tpm_core::ddl::{AlterOp, CreateTableRequest, build_alter, build_create_table};
use tpm_core::dialect::Dialect;
use tpm_core::engine::{
    BrowseResult, ChangePreview, ExplainResult, FetchedCell, RunOptions, ScriptResult, StatementResult,
};
use tpm_core::error::Result;
use tpm_core::filter::FilterNode;
use tpm_core::model::{Cell, DbObject, ObjectKind, Row, TableStructure};
use tpm_core::safety::ScriptAnalysis;
use tpm_core::split::{StatementSpan, split_statements, statement_at};
use tpm_core::storage::NewHistoryEntry;

use crate::state::AppState;

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, session_id: String) -> Result<Vec<String>> {
    state.engine.list_databases(&session_id).await
}

/// Unqualified names in this session resolve in `schema` (query tabs follow the sidebar).
#[tauri::command]
pub async fn set_default_schema(state: State<'_, AppState>, session_id: String, schema: String) -> Result<()> {
    state.engine.set_default_schema(&session_id, &schema).await
}

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, session_id: String) -> Result<Vec<String>> {
    state.engine.list_schemas(&session_id).await
}

#[tauri::command]
pub async fn list_objects(state: State<'_, AppState>, session_id: String, schema: String) -> Result<Vec<DbObject>> {
    state.engine.list_objects(&session_id, &schema).await
}

#[tauri::command]
pub async fn table_structure(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    refresh: Option<bool>,
) -> Result<TableStructure> {
    state.engine.table_structure(&session_id, &schema, &table, refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn object_definition(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    name: String,
    kind: ObjectKind,
) -> Result<String> {
    state.engine.object_definition(&session_id, &schema, &name, kind).await
}

#[tauri::command]
pub fn split_sql(sql: String, dialect: Dialect) -> Vec<StatementSpan> {
    split_statements(&sql, dialect)
}

#[tauri::command]
pub fn statement_at_cursor(sql: String, dialect: Dialect, cursor: usize) -> Option<StatementSpan> {
    statement_at(&sql, dialect, cursor)
}

#[tauri::command]
pub fn analyze_sql(state: State<'_, AppState>, session_id: String, sql: String) -> Result<ScriptAnalysis> {
    state.engine.analyze(&session_id, &sql)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    task_id: &'a str,
    statement: &'a StatementResult,
}

#[tauri::command]
pub async fn run_query(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    options: RunOptions,
) -> Result<ScriptResult> {
    let info = state.engine.session_info(&session_id)?;
    let emitter = app.clone();
    let progress: tpm_core::engine::ProgressFn = Arc::new(move |task_id: &str, st: &StatementResult| {
        // Progress events carry status only; rows travel in the command response.
        let mut light = st.clone();
        light.rows = None;
        let _ = emitter.emit("query-progress", ProgressEvent { task_id, statement: &light });
    });
    let result = state.engine.run_script(&session_id, &sql, options, Some(progress)).await;
    let (status, error, rows, duration) = match &result {
        Ok(r) => {
            let err = r.statements.iter().find_map(|s| s.error.as_ref());
            let status = if r.cancelled {
                "cancelled"
            } else if err.is_some() {
                "error"
            } else {
                "success"
            };
            let rows = r
                .statements
                .iter()
                .filter_map(|s| s.total_rows.map(|n| n as i64).or(s.rows_affected.map(|n| n as i64)))
                .sum();
            (status, err.map(|e| e.message.clone()), Some(rows), Some(r.duration_ms as i64))
        }
        Err(e) => ("error", Some(e.message.clone()), None, None),
    };
    // Statements refused by policy or awaiting confirmation were never sent.
    let refused = matches!(&result, Err(e) if matches!(e.kind, tpm_core::ErrorKind::ConfirmationRequired));
    if !refused && history_enabled(&state) {
        let _ = state.storage.add_history(&NewHistoryEntry {
            connection_id: Some(info.connection_id.clone()),
            database_name: Some(info.database.clone()),
            sql: sql.clone(),
            duration_ms: duration,
            status: status.into(),
            row_count: rows,
            error,
        });
    }
    result
}

fn history_enabled(state: &AppState) -> bool {
    !matches!(state.storage.get_setting("history.enabled"), Ok(Some(serde_json::Value::Bool(false))))
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, task_id: String) -> Result<bool> {
    state.engine.cancel_task(&task_id).await
}

#[tauri::command]
pub fn fetch_rows(state: State<'_, AppState>, result_id: String, offset: usize, limit: usize) -> Result<Vec<Row>> {
    state.engine.fetch_rows(&result_id, offset, limit)
}

#[tauri::command]
pub fn release_results(state: State<'_, AppState>, result_ids: Vec<String>) {
    state.engine.release_results(&result_ids);
}

#[tauri::command]
pub async fn browse_table(
    state: State<'_, AppState>,
    session_id: String,
    request: BrowseRequest,
) -> Result<BrowseResult> {
    state.engine.browse(&session_id, &request).await
}

#[tauri::command]
pub async fn count_rows(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    filter: Option<FilterNode>,
) -> Result<i64> {
    state.engine.count_rows(&session_id, &schema, &table, filter.as_ref()).await
}

#[tauri::command]
pub async fn preview_changes(
    state: State<'_, AppState>,
    session_id: String,
    changes: ChangeSet,
) -> Result<ChangePreview> {
    state.engine.preview_changes(&session_id, &changes).await
}

#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    session_id: String,
    changes: ChangeSet,
    confirmed: bool,
) -> Result<Vec<u64>> {
    let r = state.engine.apply_changes(&session_id, &changes, confirmed).await;
    tracing::info!(session = %session_id, ok = r.is_ok(), count = changes.changes.len(), "applied grid changes");
    r
}

#[tauri::command]
pub async fn preview_change_sets(
    state: State<'_, AppState>,
    session_id: String,
    sets: Vec<ChangeSet>,
) -> Result<ChangePreview> {
    state.engine.preview_change_sets(&session_id, &sets).await
}

#[tauri::command]
pub async fn apply_change_sets(
    state: State<'_, AppState>,
    session_id: String,
    sets: Vec<ChangeSet>,
    confirmed: bool,
) -> Result<Vec<u64>> {
    let r = state.engine.apply_change_sets(&session_id, &sets, confirmed).await;
    tracing::info!(session = %session_id, ok = r.is_ok(), tables = sets.len(), "applied result changes");
    r
}

#[tauri::command]
pub fn preview_create_table(
    state: State<'_, AppState>,
    session_id: String,
    request: CreateTableRequest,
) -> Result<Vec<String>> {
    let info = state.engine.session_info(&session_id)?;
    build_create_table(info.dialect, &request)
}

#[tauri::command]
pub fn preview_alter_table(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    ops: Vec<AlterOp>,
) -> Result<Vec<String>> {
    let info = state.engine.session_info(&session_id)?;
    build_alter(info.dialect, &schema, &table, &ops)
}

#[tauri::command]
pub async fn apply_ddl(
    state: State<'_, AppState>,
    session_id: String,
    statements: Vec<String>,
    confirmed: bool,
) -> Result<()> {
    state.engine.apply_ddl(&session_id, &statements, confirmed).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRequest {
    pub sql: String,
    #[serde(default)]
    pub analyze: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    session_id: String,
    request: ExplainRequest,
) -> Result<ExplainResult> {
    state.engine.explain(&session_id, &request.sql, request.analyze, request.confirmed).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetRequest {
    pub session_id: String,
    pub sql: String,
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
    #[serde(default = "widget_timeout")]
    pub timeout_secs: u64,
}

fn widget_timeout() -> u64 {
    30
}

/// Runs a dashboard widget on a read-only session (no history entry: widgets refresh often).
#[tauri::command]
pub async fn run_widget_query(state: State<'_, AppState>, request: WidgetRequest) -> Result<tpm_core::model::RowSet> {
    let info = state.engine.session_info(&request.session_id)?;
    if !info.read_only {
        return Err(tpm_core::AppError::new(
            tpm_core::ErrorKind::PolicyViolation,
            "Dashboard widgets run on read-only sessions only",
        ));
    }
    state
        .engine
        .run_widget(&request.session_id, &request.sql, &request.params, request.timeout_secs.clamp(1, 600), 5_000)
        .await
}

#[tauri::command]
pub async fn fetch_value(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    key: Vec<ColumnValue>,
    column: String,
) -> Result<Cell> {
    state.engine.fetch_value(&session_id, &schema, &table, key, &column).await
}

#[tauri::command]
pub async fn fetch_column(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    column: String,
    keys: Vec<Vec<ColumnValue>>,
) -> Result<Vec<FetchedCell>> {
    state.engine.fetch_column(&session_id, &schema, &table, &column, &keys).await
}

#[tauri::command]
pub fn result_value(state: State<'_, AppState>, result_id: String, row: usize, col: usize) -> Result<Cell> {
    state.engine.result_value(&result_id, row, col)
}
