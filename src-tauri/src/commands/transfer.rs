//! Import/export commands. Long operations run as jobs that emit `job-progress` events
//! and can be cancelled with `cancel_job`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tpm_core::browse::BrowseRequest;
use tpm_core::engine::{ImportRequest, JobProgress, RunOptions, StatementResult};
use tpm_core::error::{AppError, Result};
use tpm_core::transfer::{ExportOptions, ImportOptions, ImportPreview, open_sink, preview, validate_export_path};

use crate::state::AppState;

/// SQL files opened into an editor tab are limited to this size.
const MAX_SQL_EDITOR_FILE: u64 = 20 * 1024 * 1024;
/// SQL files executed directly (dumps) are limited to this size; they are read into memory.
const MAX_SQL_RUN_FILE: u64 = 512 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent<'a> {
    job_id: &'a str,
    done: u64,
}

fn job_progress(app: &AppHandle, job_id: &str) -> JobProgress {
    let app = app.clone();
    let id = job_id.to_string();
    Arc::new(move |done| {
        let _ = app.emit("job-progress", JobEvent { job_id: &id, done });
    })
}

fn register(state: &AppState, job_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state.jobs.lock().unwrap_or_else(|p| p.into_inner()).insert(job_id.to_string(), flag.clone());
    flag
}

fn unregister(state: &AppState, job_id: &str) {
    state.jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(job_id);
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> bool {
    match state.jobs.lock().unwrap_or_else(|p| p.into_inner()).get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn export_result(
    state: State<'_, AppState>,
    result_id: String,
    path: String,
    options: ExportOptions,
) -> Result<u64> {
    let path = validate_export_path(&path, options.format)?;
    let sink = open_sink(&path, &options)?;
    let n = state.engine.export_result(&result_id, sink).await?;
    tracing::info!(rows = n, format = ?options.format, "exported query result");
    Ok(n)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsTextRequest {
    pub columns: Vec<tpm_core::model::ColumnMeta>,
    /// Grid cells as the UI holds them (text, null, or complete binary values).
    pub rows: Vec<Vec<serde_json::Value>>,
    pub options: ExportOptions,
}

/// Selected grid rows as JSON or INSERT statements, for the clipboard (nothing is written to disk).
#[tauri::command]
pub async fn rows_as_text(request: RowsTextRequest) -> Result<String> {
    if request.rows.len() > 100_000 {
        return Err(AppError::invalid_config("Too many rows to copy; export them instead"));
    }
    tokio::task::spawn_blocking(move || {
        let rows = request
            .rows
            .iter()
            .map(|r| r.iter().map(tpm_core::transfer::cell_from_ui).collect::<Result<tpm_core::model::Row>>())
            .collect::<Result<Vec<_>>>()?;
        tpm_core::transfer::rows_as_text(&request.columns, &rows, &request.options)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRowsRequest {
    pub columns: Vec<tpm_core::model::ColumnMeta>,
    /// Rows as displayed (text or NULL); bounded by the grid's page size.
    pub rows: Vec<Vec<Option<String>>>,
    pub path: String,
    pub options: ExportOptions,
}

/// Exports rows the user selected in a grid.
#[tauri::command]
pub async fn export_rows(request: ExportRowsRequest) -> Result<u64> {
    if request.rows.len() > 1_000_000 {
        return Err(AppError::invalid_config("Too many rows for a selection export; export the table instead"));
    }
    let path = validate_export_path(&request.path, request.options.format)?;
    tokio::task::spawn_blocking(move || {
        let mut sink = open_sink(&path, &request.options)?;
        sink.begin(&request.columns)?;
        let rows: Vec<tpm_core::model::Row> = request
            .rows
            .into_iter()
            .map(|r| {
                r.into_iter().map(|c| c.map_or(tpm_core::model::Cell::Null, tpm_core::model::Cell::Text)).collect()
            })
            .collect();
        sink.write_rows(&rows)?;
        sink.finish()?;
        Ok(rows.len() as u64)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTableRequest {
    pub session_id: String,
    pub source: BrowseRequest,
    pub path: String,
    pub options: ExportOptions,
    pub job_id: String,
}

#[tauri::command]
pub async fn export_table(app: AppHandle, state: State<'_, AppState>, request: ExportTableRequest) -> Result<u64> {
    let path = validate_export_path(&request.path, request.options.format)?;
    let cancel = register(&state, &request.job_id);
    let sink = open_sink(&path, &request.options)?;
    let result = state
        .engine
        .export_table(&request.session_id, &request.source, sink, Some(job_progress(&app, &request.job_id)), cancel)
        .await;
    unregister(&state, &request.job_id);
    if result.is_err() {
        // Do not leave a truncated file that looks like a complete export.
        let _ = std::fs::remove_file(&path);
    }
    result
}

#[tauri::command]
pub async fn preview_import(path: String, options: ImportOptions) -> Result<ImportPreview> {
    tokio::task::spawn_blocking(move || preview(std::path::Path::new(&path), &options, 1000))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileRequest {
    pub session_id: String,
    pub import: ImportRequest,
    /// Optional CREATE TABLE statements to run first (previewed by the user).
    #[serde(default)]
    pub create_statements: Vec<String>,
    pub job_id: String,
    pub confirmed: bool,
}

#[tauri::command]
pub async fn import_file(app: AppHandle, state: State<'_, AppState>, request: ImportFileRequest) -> Result<u64> {
    if !request.create_statements.is_empty() {
        state.engine.apply_ddl(&request.session_id, &request.create_statements, request.confirmed, None).await?;
    }
    let cancel = register(&state, &request.job_id);
    let result = state
        .engine
        .import_file(
            &request.session_id,
            &request.import,
            request.confirmed,
            Some(job_progress(&app, &request.job_id)),
            cancel,
        )
        .await;
    unregister(&state, &request.job_id);
    tracing::info!(ok = result.is_ok(), table = %request.import.table, "import finished");
    result
}

fn read_sql(path: &str, limit: u64) -> Result<String> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::file(format!("Cannot read {path}: {e}")))?;
    if meta.len() > limit {
        return Err(AppError::file(format!("The file is larger than {} MB", limit / 1024 / 1024)));
    }
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| AppError::file("The SQL file is not valid UTF-8"))
}

/// Reads a SQL file so it can be reviewed in an editor tab before anything runs.
#[tauri::command]
pub async fn read_sql_file(path: String) -> Result<String> {
    tokio::task::spawn_blocking(move || read_sql(&path, MAX_SQL_EDITOR_FILE))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// Writes editor text to a .sql file chosen through the save dialog.
#[tauri::command]
pub async fn write_sql_file(path: String, contents: String) -> Result<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() || p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("sql")) != Some(true) {
        return Err(AppError::file("Choose an absolute path ending in .sql"));
    }
    tokio::task::spawn_blocking(move || std::fs::write(p, contents).map_err(AppError::from))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSqlFileRequest {
    pub session_id: String,
    pub path: String,
    pub task_id: String,
    pub confirmed: bool,
    /// The connection name, typed to confirm a file that destroys data on production.
    #[serde(default)]
    pub typed_confirmation: Option<String>,
}

/// Executes a SQL script file (e.g. a dump) statement by statement, with the same safety
/// policy, cancellation and progress events as the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFileResult {
    pub statements_run: usize,
    pub failures: Vec<StatementResult>,
    pub cancelled: bool,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn run_sql_file(
    app: AppHandle,
    state: State<'_, AppState>,
    request: RunSqlFileRequest,
) -> Result<RunFileResult> {
    let path = request.path.clone();
    let sql = tokio::task::spawn_blocking(move || read_sql(&path, MAX_SQL_RUN_FILE))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    let emitter = app.clone();
    let task = request.task_id.clone();
    let progress: tpm_core::engine::ProgressFn = Arc::new(move |_task, st| {
        let _ = emitter.emit("job-progress", JobEvent { job_id: &task, done: st.index as u64 + 1 });
    });
    let result = state
        .engine
        .run_script(
            &request.session_id,
            &sql,
            RunOptions {
                task_id: Some(request.task_id.clone()),
                confirmed: request.confirmed,
                typed_confirmation: request.typed_confirmation.clone(),
                max_rows: Some(1000),
                // A whole SQL file (often a dump) would copy every table it touches and push
                // older restore points out of the size limit.
                keep_restore_points: Some(false),
                ..Default::default()
            },
            Some(progress),
        )
        .await?;
    // Dumps can contain thousands of statements; return only failures and a summary.
    let ids: Vec<String> = result.statements.iter().filter_map(|s| s.result_id.clone()).collect();
    state.engine.release_results(&ids);
    let failures: Vec<StatementResult> = result.statements.iter().filter(|s| s.error.is_some()).cloned().collect();
    tracing::info!(statements = result.statements.len(), failed = failures.len(), "ran SQL file");
    Ok(RunFileResult {
        statements_run: result.statements.len(),
        failures,
        cancelled: result.cancelled,
        duration_ms: result.duration_ms,
    })
}
