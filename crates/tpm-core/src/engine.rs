//! Session registry and query execution engine.
//!
//! * A *session* is one live connection, owned by one UI tab (or the schema browser).
//!   Each session has its own mutex, so a tab's statements run strictly in order and
//!   tabs never share transaction state.
//! * Every execution gets a task id. Cancelling a task sends the driver-specific cancel
//!   request; the engine then waits for the driver to report the interruption rather
//!   than abandoning the future, so the connection stays in a known state.
//! * Result rows are kept server-side in a bounded store and fetched by the UI in
//!   pages, so large results never cross IPC in one message.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::adapters::{self, Canceller, ConnectOptions, ParamStatement, Session};
use crate::browse::{BrowseRequest, build_count, build_select};
use crate::changes::{ChangeSet, build_statements, preview};
use crate::config::{ConnectionProfile, SafetyMode};
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::filter::FilterNode;
use crate::model::*;
use crate::safety::{PolicyDecision, ScriptAnalysis, analyze_script};
use crate::transfer::{ColumnMapping, ImportOptions, RecordReader, RowSink};

/// Rows returned inline with an execution result; the rest are fetched by page.
pub const FIRST_PAGE_ROWS: usize = 500;
/// Default cap on rows retained per result set.
pub const DEFAULT_MAX_ROWS: usize = 100_000;
/// Upper bound on concurrently executing statements across all sessions.
const MAX_CONCURRENT_EXECUTIONS: usize = 32;
/// Approximate memory budget for retained result rows.
const RESULT_STORE_BUDGET_BYTES: usize = 512 * 1024 * 1024;
/// After a cancel request, how long to wait for the driver before giving up on the session.
const CANCEL_GRACE: Duration = Duration::from_secs(15);
/// How long the PostgreSQL describe for result origins may take before it is interrupted.
const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub dialect: Dialect,
    pub database: String,
    pub capabilities: Capabilities,
    pub server: ServerInfo,
    pub read_only: bool,
    pub safety_mode: SafetyMode,
    pub environment: crate::config::Environment,
    pub target: String,
}

struct SessionHandle {
    info: SessionInfo,
    profile: ConnectionProfile,
    options: ConnectOptions,
    /// Keeps the SSH tunnel (if any) alive for as long as the session exists.
    tunnel: Mutex<Option<crate::ssh::Tunnel>>,
    session: tokio::sync::Mutex<Option<Box<dyn Session>>>,
    canceller: Mutex<Arc<dyn Canceller>>,
    /// Set when a statement could not be interrupted; the session must be reconnected.
    broken: AtomicBool,
    /// The user ran BEGIN/START TRANSACTION in this session and has not yet ended it.
    open_txn: AtomicBool,
}

struct RunningTask {
    session_id: String,
    cancelled: Arc<AtomicBool>,
}

struct StoredResult {
    session_id: String,
    columns: Vec<ColumnMeta>,
    rows: Vec<Row>,
    approx_bytes: usize,
}

#[derive(Default)]
struct ResultStore {
    results: HashMap<String, StoredResult>,
    order: VecDeque<String>,
    bytes: usize,
}

impl ResultStore {
    fn insert(&mut self, id: String, r: StoredResult) {
        self.bytes += r.approx_bytes;
        self.order.push_back(id.clone());
        self.results.insert(id, r);
        while self.bytes > RESULT_STORE_BUDGET_BYTES && self.order.len() > 1 {
            if let Some(old) = self.order.pop_front() {
                self.remove(&old);
            }
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some(r) = self.results.remove(id) {
            self.bytes -= r.approx_bytes;
        }
        self.order.retain(|x| x != id);
    }
}

fn approx_row_bytes(row: &Row) -> usize {
    row.iter()
        .map(|c| match c {
            Cell::Null => 8,
            Cell::Text(t) => t.len() + 24,
            Cell::Bytes(b) => b.len() + 24,
            Cell::NotLoaded => 8,
            Cell::Partial { preview, .. } => preview.len() + 24,
        })
        .sum()
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    /// Caller-chosen task id so the UI can cancel before the call returns.
    pub task_id: Option<String>,
    /// The user has confirmed the warnings returned by a previous attempt.
    #[serde(default)]
    pub confirmed: bool,
    /// Overrides the connection's query timeout (seconds, 0 = none).
    pub timeout_secs: Option<u64>,
    pub max_rows: Option<usize>,
    /// Byte offset of `sql` within the editor buffer, for error positions.
    #[serde(default)]
    pub base_offset: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub index: usize,
    pub sql: String,
    /// Byte range of the statement in the submitted text (plus `base_offset`).
    pub start: usize,
    pub end: usize,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnMeta>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Row>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<usize>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    /// Which cells of this result can be edited (row-returning SELECTs only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editing: Option<crate::result_edit::ResultEditing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResult {
    pub task_id: String,
    pub statements: Vec<StatementResult>,
    pub duration_ms: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Row>,
    pub sql: String,
    pub duration_ms: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePreview {
    pub sql: String,
    pub statement_count: usize,
    pub atomic: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    /// `postgres_json`, `mysql_json`, `mysql_tree` or `sqlite_plan`.
    pub format: String,
    pub raw: String,
    pub rows: Option<RowSet>,
    pub duration_ms: u64,
}

pub type ProgressFn = Arc<dyn Fn(&str, &StatementResult) + Send + Sync>;

pub struct Engine {
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
    tasks: Mutex<HashMap<String, RunningTask>>,
    results: Mutex<ResultStore>,
    structures: Mutex<HashMap<(String, String, String), TableStructure>>,
    limiter: Semaphore,
    known_hosts: Option<crate::ssh::KnownHosts>,
    redis: Mutex<HashMap<String, Arc<tokio::sync::Mutex<crate::redis_kv::RedisSession>>>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic while holding one of these short critical sections leaves the data
    // structurally valid, so recover instead of propagating the poison.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Engine {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            results: Mutex::new(ResultStore::default()),
            structures: Mutex::new(HashMap::new()),
            limiter: Semaphore::new(MAX_CONCURRENT_EXECUTIONS),
            known_hosts: None,
            redis: Mutex::new(HashMap::new()),
        }
    }

    /// Engine whose SSH tunnels trust keys recorded in `app_known_hosts` (plus the user's
    /// `~/.ssh/known_hosts`).
    pub fn with_known_hosts(app_known_hosts: std::path::PathBuf) -> Self {
        Self { known_hosts: Some(crate::ssh::KnownHosts::new(app_known_hosts)), ..Self::new() }
    }

    /// Records an SSH host key the user chose to trust.
    pub fn trust_ssh_host(&self, host: &str, port: u16, openssh_key: &str) -> Result<()> {
        let known =
            self.known_hosts.as_ref().ok_or_else(|| AppError::internal("SSH known hosts are not configured"))?;
        let key = russh::keys::PublicKey::from_openssh(openssh_key.trim())
            .map_err(|e| AppError::invalid_config(format!("Invalid host key: {e}")))?;
        known.trust(host, port, &key)
    }

    /// Opens the SSH tunnel (when configured) and then the database connection through it.
    async fn connect_through(
        &self,
        profile: &ConnectionProfile,
        password: Option<&str>,
        ssh_secret: Option<&str>,
        options: &ConnectOptions,
    ) -> Result<(Box<dyn Session>, Option<crate::ssh::Tunnel>)> {
        profile.validate()?;
        let Some(ssh) = &profile.ssh else {
            return Ok((adapters::connect(profile, password, options).await?, None));
        };
        let known = self.known_hosts.clone().ok_or_else(|| AppError::internal("SSH known hosts are not configured"))?;
        let tunnel = crate::ssh::open_tunnel(
            ssh,
            ssh_secret,
            &profile.host,
            profile.port_or_default(),
            known,
            Duration::from_secs(profile.connect_timeout_secs),
        )
        .await?;
        let opts = ConnectOptions { tunnel_port: Some(tunnel.local_port), ..options.clone() };
        let session = adapters::connect(profile, password, &opts).await?;
        Ok((session, Some(tunnel)))
    }

    // ---- sessions ----------------------------------------------------------------

    pub async fn open_session(
        &self,
        profile: &ConnectionProfile,
        password: Option<&str>,
        ssh_secret: Option<&str>,
        options: ConnectOptions,
    ) -> Result<SessionInfo> {
        let (mut session, tunnel) = self.connect_through(profile, password, ssh_secret, &options).await?;
        let server = session.server_info().await?;
        let info = SessionInfo {
            session_id: uuid::Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            connection_name: profile.name.clone(),
            dialect: session.dialect(),
            database: if server.current_database.is_empty() {
                options.database.clone().unwrap_or_else(|| profile.database.clone())
            } else {
                server.current_database.clone()
            },
            capabilities: session.capabilities(),
            server,
            read_only: profile.read_only(),
            safety_mode: profile.safety_mode,
            environment: profile.environment,
            target: profile.target_label(),
        };
        let handle = Arc::new(SessionHandle {
            info: info.clone(),
            profile: profile.clone(),
            options,
            tunnel: Mutex::new(tunnel),
            canceller: Mutex::new(session.canceller()),
            session: tokio::sync::Mutex::new(Some(session)),
            broken: AtomicBool::new(false),
            open_txn: AtomicBool::new(false),
        });
        lock(&self.sessions).insert(info.session_id.clone(), handle);
        Ok(info)
    }

    /// Replaces the connection behind an existing session id (after a network failure
    /// or an uninterruptible query). Results and tab state keep their ids.
    pub async fn reconnect(
        &self,
        session_id: &str,
        password: Option<&str>,
        ssh_secret: Option<&str>,
    ) -> Result<SessionInfo> {
        let handle = self.handle(session_id)?;
        let (new_session, tunnel) =
            self.connect_through(&handle.profile, password, ssh_secret, &handle.options).await?;
        *lock(&handle.canceller) = new_session.canceller();
        *lock(&handle.tunnel) = tunnel;
        let old = {
            let mut guard = handle.session.lock().await;
            guard.replace(new_session)
        };
        if let Some(old) = old {
            old.close().await;
        }
        handle.broken.store(false, Ordering::SeqCst);
        handle.open_txn.store(false, Ordering::SeqCst);
        Ok(handle.info.clone())
    }

    pub async fn close_session(&self, session_id: &str) {
        let handle = lock(&self.sessions).remove(session_id);
        {
            let mut results = lock(&self.results);
            let ids: Vec<String> =
                results.results.iter().filter(|(_, r)| r.session_id == session_id).map(|(k, _)| k.clone()).collect();
            for id in ids {
                results.remove(&id);
            }
        }
        lock(&self.structures).retain(|k, _| k.0 != session_id);
        if let Some(h) = handle {
            // Stop anything still running so close does not wait on a long query.
            let canceller = lock(&h.canceller).clone();
            let _ = canceller.cancel().await;
            if let Some(s) = h.session.lock().await.take() {
                s.close().await;
            }
        }
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        for id in ids {
            self.close_session(&id).await;
        }
    }

    pub fn session_info(&self, session_id: &str) -> Result<SessionInfo> {
        Ok(self.handle(session_id)?.info.clone())
    }

    pub fn sessions_for_connection(&self, connection_id: &str) -> Vec<String> {
        lock(&self.sessions)
            .values()
            .filter(|h| h.info.connection_id == connection_id)
            .map(|h| h.info.session_id.clone())
            .collect()
    }

    fn handle(&self, session_id: &str) -> Result<Arc<SessionHandle>> {
        lock(&self.sessions)
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("This connection session is closed. Reconnect to continue."))
    }

    /// Runs `f` with exclusive access to the session's connection.
    async fn with_session<T, F>(&self, session_id: &str, f: F) -> Result<T>
    where
        F: for<'a> FnOnce(&'a mut Box<dyn Session>) -> futures_util::future::BoxFuture<'a, Result<T>>,
    {
        let handle = self.handle(session_id)?;
        if handle.broken.load(Ordering::SeqCst) {
            return Err(
                AppError::new(ErrorKind::Network, "The connection needs to be re-established").with_code("broken")
            );
        }
        let _permit = self.limiter.acquire().await.map_err(|_| AppError::internal("Engine is shutting down"))?;
        let mut guard = handle.session.lock().await;
        let session = guard.as_mut().ok_or_else(|| AppError::not_found("This connection session is closed"))?;
        let result = f(session).await;
        if let Err(e) = &result
            && e.kind == ErrorKind::Network
        {
            handle.broken.store(true, Ordering::SeqCst);
        }
        result
    }

    pub async fn ping(&self, session_id: &str) -> Result<()> {
        self.with_session(session_id, |s| Box::pin(s.ping())).await
    }

    // ---- metadata ----------------------------------------------------------------

    pub async fn list_databases(&self, session_id: &str) -> Result<Vec<String>> {
        self.with_session(session_id, |s| Box::pin(s.list_databases())).await
    }

    pub async fn list_schemas(&self, session_id: &str) -> Result<Vec<String>> {
        self.with_session(session_id, |s| Box::pin(s.list_schemas())).await
    }

    pub async fn list_objects(&self, session_id: &str, schema: &str) -> Result<Vec<DbObject>> {
        let schema = schema.to_string();
        self.with_session(session_id, move |s| Box::pin(async move { s.list_objects(&schema).await })).await
    }

    pub async fn table_structure(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        refresh: bool,
    ) -> Result<TableStructure> {
        let key = (session_id.to_string(), schema.to_string(), table.to_string());
        if !refresh && let Some(s) = lock(&self.structures).get(&key) {
            return Ok(s.clone());
        }
        let (schema_s, table_s) = (schema.to_string(), table.to_string());
        let s = self
            .with_session(session_id, move |s| Box::pin(async move { s.table_structure(&schema_s, &table_s).await }))
            .await?;
        lock(&self.structures).insert(key, s.clone());
        Ok(s)
    }

    pub fn invalidate_structures(&self, session_id: &str) {
        lock(&self.structures).retain(|k, _| k.0 != session_id);
    }

    pub async fn object_definition(
        &self,
        session_id: &str,
        schema: &str,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        let (schema, name) = (schema.to_string(), name.to_string());
        self.with_session(session_id, move |s| Box::pin(async move { s.object_definition(&schema, &name, kind).await }))
            .await
    }

    // ---- user SQL ----------------------------------------------------------------

    pub fn analyze(&self, session_id: &str, sql: &str) -> Result<ScriptAnalysis> {
        let h = self.handle(session_id)?;
        Ok(analyze_script(sql, h.info.dialect, h.profile.safety_mode))
    }

    fn enforce_policy(analysis: &ScriptAnalysis, confirmed: bool, info: &SessionInfo) -> Result<()> {
        match &analysis.decision {
            PolicyDecision::Allow => Ok(()),
            PolicyDecision::Block { reason } => Err(AppError::new(ErrorKind::PolicyViolation, reason)),
            PolicyDecision::Confirm { reasons } if !confirmed => Err(AppError::new(
                ErrorKind::ConfirmationRequired,
                format!("Confirm execution on {} ({})", info.connection_name, info.target),
            )
            .with_detail(reasons.join("\n"))),
            PolicyDecision::Confirm { .. } => Ok(()),
        }
    }

    /// Executes a script statement by statement. Stops at the first error.
    pub async fn run_script(
        &self,
        session_id: &str,
        sql: &str,
        opts: RunOptions,
        progress: Option<ProgressFn>,
    ) -> Result<ScriptResult> {
        let handle = self.handle(session_id)?;
        let analysis = analyze_script(sql, handle.info.dialect, handle.profile.safety_mode);
        Self::enforce_policy(&analysis, opts.confirmed, &handle.info)?;

        let task_id = opts.task_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.tasks)
            .insert(task_id.clone(), RunningTask { session_id: session_id.to_string(), cancelled: cancelled.clone() });
        let timeout_secs = opts.timeout_secs.unwrap_or(handle.profile.query_timeout_secs);
        let max_rows = opts.max_rows.unwrap_or(DEFAULT_MAX_ROWS).clamp(1, 10_000_000);
        let started = Instant::now();
        let mut statements = Vec::new();

        async {
            for (index, stmt) in analysis.statements.iter().enumerate() {
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }
                let t0 = Instant::now();
                // Origins let result cells be edited: only for reads, never on read-only sessions, and
                // not inside the user's open transaction (commits are refused there, and a failed
                // describe would abort that transaction).
                let want_origins = stmt.class == crate::safety::StatementClass::Read
                    && !handle.profile.read_only()
                    && !handle.open_txn.load(Ordering::SeqCst);
                let mut res = self.execute_one(&handle, &stmt.sql, max_rows, timeout_secs, &cancelled).await;
                if want_origins && let Ok(outcomes) = &mut res {
                    self.add_origins(&handle, &stmt.sql, outcomes).await;
                }
                if res.is_ok()
                    && stmt.class == crate::safety::StatementClass::Transaction
                    && let Some(open) = txn_effect(&stmt.sql)
                {
                    handle.open_txn.store(open, Ordering::SeqCst);
                }
                let duration_ms = t0.elapsed().as_millis() as u64;
                let base = opts.base_offset + stmt.start;
                let mut produced = match res {
                    Ok(outcomes) => self.store_outcomes(
                        session_id,
                        index,
                        &stmt.sql,
                        base,
                        base + stmt.sql.len(),
                        duration_ms,
                        outcomes,
                    ),
                    Err(mut e) => {
                        // Map the server's character position to a byte offset in the editor.
                        if let Some(p) = e.position {
                            let byte =
                                stmt.sql.char_indices().nth((p as usize).saturating_sub(1)).map_or(0, |(b, _)| b);
                            e.position = Some((base + byte) as u32);
                        }
                        vec![StatementResult {
                            index,
                            sql: stmt.sql.clone(),
                            start: base,
                            end: base + stmt.sql.len(),
                            duration_ms,
                            result_id: None,
                            columns: None,
                            rows: None,
                            total_rows: None,
                            truncated: false,
                            rows_affected: None,
                            error: Some(e),
                            editing: None,
                        }]
                    }
                };
                if stmt.class == crate::safety::StatementClass::Read {
                    for r in produced.iter_mut() {
                        if let Some(cols) = r.columns.clone() {
                            r.editing = Some(self.editing_for(&handle, session_id, &stmt.sql, &cols).await);
                        }
                    }
                }
                let failed = produced.iter().any(|r| r.error.is_some());
                if let Some(p) = &progress {
                    for r in &produced {
                        p(&task_id, r);
                    }
                }
                statements.append(&mut produced);
                if failed {
                    break;
                }
            }
        }
        .await;

        lock(&self.tasks).remove(&task_id);
        if analysis.statements.iter().any(|s| s.class >= crate::safety::StatementClass::Ddl) {
            self.invalidate_structures(session_id);
        }
        Ok(ScriptResult {
            task_id,
            statements,
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled: cancelled.load(Ordering::SeqCst),
        })
    }

    async fn execute_one(
        &self,
        handle: &Arc<SessionHandle>,
        sql: &str,
        max_rows: usize,
        timeout_secs: u64,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<Vec<StatementOutcome>> {
        let canceller = lock(&handle.canceller).clone();
        let sql_owned = sql.to_string();
        let fut = self.with_session(&handle.info.session_id, move |s| {
            Box::pin(async move { s.execute(&sql_owned, max_rows).await })
        });
        tokio::pin!(fut);
        let map_cancel = |e: AppError| {
            if cancelled.load(Ordering::SeqCst) && e.kind == ErrorKind::Cancelled { AppError::cancelled() } else { e }
        };
        if timeout_secs == 0 {
            return fut.await.map_err(map_cancel);
        }
        tokio::select! {
            r = &mut fut => r.map_err(map_cancel),
            _ = tokio::time::sleep(Duration::from_secs(timeout_secs)) => {
                let _ = canceller.cancel().await;
                match tokio::time::timeout(CANCEL_GRACE, &mut fut).await {
                    Ok(_) => Err(AppError::timeout(timeout_secs)),
                    Err(_) => {
                        handle.broken.store(true, Ordering::SeqCst);
                        Err(AppError::timeout(timeout_secs).with_detail("The server did not acknowledge cancellation; reconnect this tab."))
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn store_outcomes(
        &self,
        session_id: &str,
        index: usize,
        sql: &str,
        start: usize,
        end: usize,
        duration_ms: u64,
        outcomes: Vec<StatementOutcome>,
    ) -> Vec<StatementResult> {
        let mut out = Vec::new();
        for o in outcomes {
            let mut r = StatementResult {
                index,
                sql: sql.to_string(),
                start,
                end,
                duration_ms,
                result_id: None,
                columns: None,
                rows: None,
                total_rows: None,
                truncated: false,
                rows_affected: None,
                error: None,
                editing: None,
            };
            match o {
                StatementOutcome::Affected { rows_affected } => r.rows_affected = Some(rows_affected),
                StatementOutcome::Rows { rows } => {
                    let id = uuid::Uuid::new_v4().to_string();
                    r.total_rows = Some(rows.rows.len());
                    r.truncated = rows.truncated;
                    r.columns = Some(rows.columns.clone());
                    r.rows = Some(rows.rows.iter().take(FIRST_PAGE_ROWS).cloned().collect());
                    {
                        let approx_bytes = rows.rows.iter().map(approx_row_bytes).sum();
                        lock(&self.results).insert(
                            id.clone(),
                            StoredResult {
                                session_id: session_id.to_string(),
                                columns: rows.columns,
                                rows: rows.rows,
                                approx_bytes,
                            },
                        );
                    }
                    r.result_id = Some(id);
                }
            }
            out.push(r);
        }
        out
    }

    /// Fetches a page of a stored result.
    pub fn fetch_rows(&self, result_id: &str, offset: usize, limit: usize) -> Result<Vec<Row>> {
        let store = lock(&self.results);
        let r = store
            .results
            .get(result_id)
            .ok_or_else(|| AppError::not_found("This result is no longer available; run the query again"))?;
        Ok(r.rows.iter().skip(offset).take(limit.min(10_000)).cloned().collect())
    }

    /// All rows and columns of a stored result (for export).
    pub fn result_snapshot(&self, result_id: &str) -> Result<(Vec<ColumnMeta>, Vec<Row>)> {
        let store = lock(&self.results);
        let r = store.results.get(result_id).ok_or_else(|| AppError::not_found("Result not available"))?;
        Ok((r.columns.clone(), r.rows.clone()))
    }

    pub fn release_results(&self, ids: &[String]) {
        let mut store = lock(&self.results);
        for id in ids {
            store.remove(id);
        }
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<bool> {
        let session_id = {
            let tasks = lock(&self.tasks);
            match tasks.get(task_id) {
                Some(t) => {
                    t.cancelled.store(true, Ordering::SeqCst);
                    t.session_id.clone()
                }
                None => return Ok(false),
            }
        };
        let canceller = lock(&self.handle(&session_id)?.canceller).clone();
        canceller.cancel().await?;
        Ok(true)
    }

    // ---- browsing & editing ------------------------------------------------------

    pub async fn browse(&self, session_id: &str, req: &BrowseRequest) -> Result<BrowseResult> {
        let handle = self.handle(session_id)?;
        let structure = self.table_structure(session_id, &req.schema, &req.table, false).await?;
        // Fetch one extra row to learn whether another page exists without COUNT(*).
        let mut probe = req.clone();
        probe.limit = req.limit.saturating_add(1).min(crate::browse::MAX_PAGE_SIZE + 1);
        let q = build_select(handle.info.dialect, &structure, &BrowseRequest { limit: req.limit, ..req.clone() })?;
        let probe_q = build_select_unchecked(handle.info.dialect, &structure, &probe)?;
        if handle.profile.read_only() && probe.filter.as_ref().is_some_and(has_raw) {
            let analysis = analyze_script(&probe_q.sql, handle.info.dialect, SafetyMode::ReadOnly);
            Self::enforce_policy(&analysis, false, &handle.info)?;
        }
        let t0 = Instant::now();
        let limit = req.limit as usize;
        let (sql, params) = (probe_q.sql, probe_q.params);
        let mut rs = self
            .with_session(session_id, move |s| Box::pin(async move { s.query(&sql, &params, limit + 1).await }))
            .await?;
        let has_more = rs.rows.len() > limit;
        rs.rows.truncate(limit);
        Ok(BrowseResult {
            columns: rs.columns,
            rows: rs.rows,
            sql: q.sql,
            duration_ms: t0.elapsed().as_millis() as u64,
            has_more,
        })
    }

    pub async fn count_rows(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        filter: Option<&FilterNode>,
    ) -> Result<i64> {
        let handle = self.handle(session_id)?;
        let structure = self.table_structure(session_id, schema, table, false).await?;
        let q = build_count(handle.info.dialect, &structure, filter)?;
        let rs = self
            .with_session(session_id, move |s| Box::pin(async move { s.query(&q.sql, &q.params, 1).await }))
            .await?;
        rs.rows
            .first()
            .and_then(|r| r.first())
            .and_then(|c| c.as_text())
            .and_then(|t| t.parse().ok())
            .ok_or_else(|| AppError::internal("COUNT returned no value"))
    }

    /// Fills in column origins the driver could not report while executing (PostgreSQL describes
    /// the statement without running it). Runs after the statement, outside its timeout, so a
    /// slow describe can never turn a finished statement into a "timeout". Origins are a bonus:
    /// any failure leaves the result read-only.
    async fn add_origins(&self, handle: &Arc<SessionHandle>, sql: &str, outcomes: &mut [StatementOutcome]) {
        let unknown = |o: &StatementOutcome| matches!(o, StatementOutcome::Rows { rows } if rows.columns.iter().all(|c| c.origin.is_none()));
        if !outcomes.iter().any(unknown) {
            return;
        }
        let sql = sql.to_string();
        let fut = self
            .with_session(&handle.info.session_id, move |s| Box::pin(async move { s.describe_origins(&sql).await }));
        tokio::pin!(fut);
        let found = match tokio::time::timeout(DESCRIBE_TIMEOUT, &mut fut).await {
            Ok(Ok(found)) => found,
            Ok(Err(_)) => return,
            Err(_) => {
                // Waiting on a lock, say: interrupt it rather than hold the session.
                let canceller = lock(&handle.canceller).clone();
                let _ = canceller.cancel().await;
                let _ = tokio::time::timeout(CANCEL_GRACE, &mut fut).await;
                return;
            }
        };
        for o in outcomes.iter_mut() {
            if let StatementOutcome::Rows { rows } = o
                && rows.columns.iter().all(|c| c.origin.is_none())
                && found.len() == rows.columns.len()
            {
                for (c, f) in rows.columns.iter_mut().zip(found.iter()) {
                    c.origin = f.clone();
                }
            }
        }
    }

    /// Which cells of a result can be edited (see result_edit.rs). Never fails: problems make cells read-only.
    async fn editing_for(
        &self,
        handle: &Arc<SessionHandle>,
        session_id: &str,
        sql: &str,
        cols: &[ColumnMeta],
    ) -> crate::result_edit::ResultEditing {
        use crate::config::Driver;
        use crate::result_edit::{not_editable, origin_tables, result_editing_with};
        use crate::result_sql::{Shape, occurrences, shape};
        let driver = handle.profile.driver;
        if handle.profile.read_only() {
            return not_editable(cols, "Read-only connection");
        }
        if handle.open_txn.load(Ordering::SeqCst) {
            return not_editable(cols, "Commit or roll back the open transaction to edit results");
        }
        if driver == Driver::Duckdb {
            return not_editable(cols, "Query results can't be edited on DuckDB");
        }
        let origins = origin_tables(cols);
        if origins.is_empty() {
            return result_editing_with(cols, &[], &[]);
        }
        // Origins name the table, not the alias or the UNION branch; the statement's shape
        // rules out results where that is ambiguous (see result_sql.rs).
        let relations = match shape(sql, handle.info.dialect) {
            Shape::Blocked(reason) => return not_editable(cols, &reason),
            Shape::Tables(t) => t,
        };
        let mut pre_blocked = Vec::new();
        for (schema, table) in &origins {
            let reason = match occurrences(&relations, schema, table) {
                1 => continue,
                0 => format!("{table} is not named in the query, so its rows cannot be traced"),
                _ => format!("{table} appears more than once, so rows cannot be told apart"),
            };
            pre_blocked.push(((schema.clone(), table.clone()), reason));
        }
        // SQLite (and possibly MySQL) report a view's columns as its base table's, so a view
        // anywhere in the query could hide another instance of an origin table.
        if matches!(driver, Driver::Sqlite | Driver::Mysql | Driver::Mariadb) {
            for r in relations
                .iter()
                .filter(|r| !origins.iter().any(|(s, t)| occurrences(std::slice::from_ref(r), s, t) > 0))
            {
                let schemas: Vec<String> = match (&r.schema, driver) {
                    (Some(s), _) => vec![s.clone()],
                    (None, Driver::Sqlite) => vec!["main".into()],
                    (None, _) => {
                        let mut v: Vec<String> = origins.iter().map(|(s, _)| s.clone()).collect();
                        v.push(handle.info.database.clone());
                        v.dedup();
                        v
                    }
                };
                let mut found = false;
                for s in &schemas {
                    if let Ok(st) = self.table_structure(session_id, s, &r.name, false).await {
                        if st.kind != ObjectKind::Table {
                            return not_editable(cols, "Results that read from a view can't be edited");
                        }
                        found = true;
                    }
                }
                if !found {
                    return not_editable(
                        cols,
                        &format!("Could not check {}, so these results can't be edited", r.name),
                    );
                }
            }
        }
        let mut structures = Vec::new();
        for (schema, table) in &origins {
            if let Ok(s) = self.table_structure(session_id, schema, table, false).await {
                structures.push(s);
            }
        }
        result_editing_with(cols, &structures, &pre_blocked)
    }

    pub async fn preview_changes(&self, session_id: &str, set: &ChangeSet) -> Result<ChangePreview> {
        self.preview_change_sets(session_id, std::slice::from_ref(set)).await
    }

    pub async fn preview_change_sets(&self, session_id: &str, sets: &[ChangeSet]) -> Result<ChangePreview> {
        let handle = self.handle(session_id)?;
        let mut statements = Vec::new();
        for set in sets {
            let structure = self.table_structure(session_id, &set.schema, &set.table, false).await?;
            statements.extend(build_statements(handle.info.dialect, &structure, set)?);
        }
        Ok(ChangePreview {
            sql: preview(handle.info.dialect, &statements),
            statement_count: statements.len(),
            atomic: handle.info.capabilities.transactions,
        })
    }

    /// Commits pending grid edits in one transaction. The review dialog in the UI is
    /// the confirmation step, so `confirmed` must be true.
    pub async fn apply_changes(&self, session_id: &str, set: &ChangeSet, confirmed: bool) -> Result<Vec<u64>> {
        self.apply_change_sets(session_id, std::slice::from_ref(set), confirmed).await
    }

    /// Commits edits to one or more tables (e.g. from a joined query result) in one transaction.
    pub async fn apply_change_sets(&self, session_id: &str, sets: &[ChangeSet], confirmed: bool) -> Result<Vec<u64>> {
        let handle = self.handle(session_id)?;
        if handle.profile.read_only() {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the pending changes before committing"));
        }
        // Our BEGIN/COMMIT would commit (or, on a conflict, roll back) the user's own open transaction.
        let open_txn = || {
            AppError::new(
                ErrorKind::PolicyViolation,
                "This tab has an open transaction. Commit or roll it back first, then commit your edits.",
            )
        };
        if handle.open_txn.load(Ordering::SeqCst) {
            return Err(open_txn());
        }
        let mut statements = Vec::new();
        for set in sets {
            let structure = self.table_structure(session_id, &set.schema, &set.table, true).await?;
            statements.extend(build_statements(handle.info.dialect, &structure, set)?);
        }
        let atomic = handle.info.capabilities.transactions;
        self.with_session(session_id, move |s| {
            Box::pin(async move {
                if s.in_transaction().await? {
                    return Err(open_txn());
                }
                s.apply(&statements, atomic).await
            })
        })
        .await
    }

    /// Runs reviewed, application-generated DDL (from the structure editor).
    pub async fn apply_ddl(&self, session_id: &str, statements: &[String], confirmed: bool) -> Result<()> {
        let handle = self.handle(session_id)?;
        let script = statements.iter().map(|s| format!("{s};")).collect::<Vec<_>>().join("\n");
        let analysis = analyze_script(&script, handle.info.dialect, handle.profile.safety_mode);
        if let PolicyDecision::Block { reason } = &analysis.decision {
            return Err(AppError::new(ErrorKind::PolicyViolation, reason));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the schema change before applying it"));
        }
        let stmts: Vec<ParamStatement> = statements.iter().map(|s| ParamStatement::new(s.clone(), vec![])).collect();
        let atomic = handle.info.capabilities.transactional_ddl;
        self.with_session(session_id, move |s| Box::pin(async move { s.apply(&stmts, atomic).await })).await?;
        self.invalidate_structures(session_id);
        Ok(())
    }

    /// Makes `schema` the default for unqualified names in this session, so a query tab follows
    /// the schema picked in the sidebar. App-generated and identifier-quoted; not user SQL.
    pub async fn set_default_schema(&self, session_id: &str, schema: &str) -> Result<()> {
        let driver = self.handle(session_id)?.profile.driver;
        let Some(sql) = default_schema_sql(driver, schema)? else { return Ok(()) };
        self.with_session(session_id, move |s| {
            Box::pin(async move {
                s.execute(&sql, 0).await?;
                Ok(())
            })
        })
        .await
    }

    pub async fn explain(&self, session_id: &str, sql: &str, analyze: bool, confirmed: bool) -> Result<ExplainResult> {
        let handle = self.handle(session_id)?;
        if !handle.info.capabilities.explain {
            return Err(AppError::unsupported(format!(
                "{} query plans are not supported yet",
                handle.info.server.product
            )));
        }
        let dialect = handle.info.dialect;
        let stmt = crate::split::split_statements(sql, dialect)
            .into_iter()
            .next()
            .ok_or_else(|| AppError::invalid_config("Nothing to explain"))?;
        if analyze {
            // ANALYZE executes the statement: apply the same policy as running it.
            let analysis = analyze_script(&stmt.sql, dialect, handle.profile.safety_mode);
            Self::enforce_policy(&analysis, confirmed, &handle.info)?;
        }
        let (explain_sql, format) = match (dialect, analyze) {
            (Dialect::Postgres, false) => (format!("EXPLAIN (FORMAT JSON, VERBOSE) {}", stmt.sql), "postgres_json"),
            (Dialect::Postgres, true) => {
                (format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, VERBOSE) {}", stmt.sql), "postgres_json")
            }
            (Dialect::Mysql, false) => (format!("EXPLAIN FORMAT=JSON {}", stmt.sql), "mysql_json"),
            (Dialect::Mysql, true) if handle.info.capabilities.explain_analyze => {
                (format!("EXPLAIN ANALYZE {}", stmt.sql), "mysql_tree")
            }
            (Dialect::Mysql, true) => {
                return Err(AppError::unsupported("EXPLAIN ANALYZE is not supported by this server"));
            }
            (Dialect::Sqlite, false) => (format!("EXPLAIN QUERY PLAN {}", stmt.sql), "sqlite_plan"),
            (Dialect::Sqlite, true) => return Err(AppError::unsupported("SQLite does not support EXPLAIN ANALYZE")),
        };
        let t0 = Instant::now();
        let outcomes = self
            .with_session(session_id, move |s| Box::pin(async move { s.execute(&explain_sql, 100_000).await }))
            .await?;
        let rows = outcomes.into_iter().find_map(|o| match o {
            StatementOutcome::Rows { rows } => Some(rows),
            _ => None,
        });
        let raw = rows
            .as_ref()
            .map(|r| {
                r.rows
                    .iter()
                    .map(|row| row.iter().filter_map(|c| c.as_text()).collect::<Vec<_>>().join("\t"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok(ExplainResult { format: format.into(), raw, rows, duration_ms: t0.elapsed().as_millis() as u64 })
    }
}

/// Progress callback for long-running jobs: units done so far (rows).
pub type JobProgress = Arc<dyn Fn(u64) + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: String,
    pub options: ImportOptions,
    pub schema: String,
    pub table: String,
    pub mapping: Vec<ColumnMapping>,
    /// Skip this many data records at the start of the file.
    #[serde(default)]
    pub skip: u64,
}

impl Engine {
    /// Writes a stored query result to `sink` (runs on the blocking pool).
    pub async fn export_result(&self, result_id: &str, mut sink: Box<dyn RowSink>) -> Result<u64> {
        let (columns, rows) = self.result_snapshot(result_id)?;
        tokio::task::spawn_blocking(move || {
            sink.begin(&columns)?;
            for chunk in rows.chunks(5_000) {
                sink.write_rows(chunk)?;
            }
            sink.finish()?;
            Ok(rows.len() as u64)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }

    /// Streams a table (optionally filtered and sorted) into `sink` page by page.
    pub async fn export_table(
        &self,
        session_id: &str,
        req: &BrowseRequest,
        sink: Box<dyn RowSink>,
        progress: Option<JobProgress>,
        cancel: Arc<AtomicBool>,
    ) -> Result<u64> {
        const PAGE: u32 = 5_000;
        let structure = self.table_structure(session_id, &req.schema, &req.table, true).await?;
        let dialect = self.handle(session_id)?.info.dialect;
        let columns: Vec<ColumnMeta> =
            structure.columns.iter().map(|c| ColumnMeta::new(&c.name, &c.data_type)).collect();
        let mut sink = Some(sink);
        let mut written = 0u64;
        let mut offset = 0u64;
        let first = sink.take().unwrap();
        sink = Some(
            tokio::task::spawn_blocking(move || {
                let mut s = first;
                s.begin(&columns).map(|_| s)
            })
            .await
            .map_err(|e| AppError::internal(e.to_string()))??,
        );
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::cancelled());
            }
            let page_req = BrowseRequest { limit: PAGE, offset, ..req.clone() };
            let q = build_select(dialect, &structure, &page_req)?;
            let rs = self
                .with_session(session_id, move |s| {
                    Box::pin(async move { s.query(&q.sql, &q.params, PAGE as usize).await })
                })
                .await?;
            let n = rs.rows.len() as u64;
            let mut s = sink.take().unwrap();
            s = tokio::task::spawn_blocking(move || s.write_rows(&rs.rows).map(|_| s))
                .await
                .map_err(|e| AppError::internal(e.to_string()))??;
            sink = Some(s);
            written += n;
            offset += n;
            if let Some(p) = &progress {
                p(written);
            }
            if n < PAGE as u64 {
                break;
            }
        }
        let s = sink.take().unwrap();
        tokio::task::spawn_blocking(move || s.finish()).await.map_err(|e| AppError::internal(e.to_string()))??;
        Ok(written)
    }

    /// Imports a CSV/JSON file into an existing table inside one transaction. The file is
    /// read on the blocking pool and handed over in batches through a bounded channel.
    pub async fn import_file(
        &self,
        session_id: &str,
        req: &ImportRequest,
        confirmed: bool,
        progress: Option<JobProgress>,
        cancel: Arc<AtomicBool>,
    ) -> Result<u64> {
        let handle = self.handle(session_id)?;
        if handle.profile.read_only() {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the import before running it"));
        }
        if req.mapping.is_empty() {
            return Err(AppError::invalid_config("Map at least one column"));
        }
        let dialect = handle.info.dialect;
        let structure = self.table_structure(session_id, &req.schema, &req.table, true).await?;
        let mut targets = Vec::with_capacity(req.mapping.len());
        for m in &req.mapping {
            if structure.column(&m.target).is_none() {
                return Err(AppError::invalid_config(format!("Column '{}' does not exist in {}", m.target, req.table)));
            }
            targets.push(dialect.quote_ident(&m.target)?);
        }
        let schema = if dialect == Dialect::Sqlite && req.schema == "main" { None } else { Some(req.schema.as_str()) };
        let table = dialect.qualified(schema, &req.table)?;
        let batch = crate::transfer::batch_rows(req.mapping.len());

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<ParamStatement>>(4);
        let path = std::path::PathBuf::from(&req.path);
        let options = req.options.clone();
        let mapping = req.mapping.clone();
        let skip = req.skip;
        let reader_cancel = cancel.clone();
        let producer = tokio::task::spawn_blocking(move || {
            let mut reader = match RecordReader::open(&path, &options) {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    return;
                }
            };
            let mut skipped = 0;
            let mut records = Vec::with_capacity(batch);
            loop {
                if reader_cancel.load(Ordering::SeqCst) {
                    return;
                }
                match reader.next_record() {
                    Ok(Some(r)) => {
                        if skipped < skip {
                            skipped += 1;
                            continue;
                        }
                        records.push(r);
                        if records.len() == batch {
                            let st = crate::transfer::insert_batch(dialect, &table, &targets, &mapping, &records);
                            records.clear();
                            if tx.blocking_send(Ok(st)).is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = tx.blocking_send(Err(e));
                        return;
                    }
                }
            }
            if !records.is_empty() {
                let _ =
                    tx.blocking_send(Ok(crate::transfer::insert_batch(dialect, &table, &targets, &mapping, &records)));
            }
        });

        let transactional = handle.info.capabilities.transactions;
        let result = self
            .with_session(session_id, move |s| {
                Box::pin(async move {
                    if transactional {
                        s.begin().await?;
                    }
                    let mut total = 0u64;
                    let outcome: Result<()> = async {
                        while let Some(item) = rx.recv().await {
                            if cancel.load(Ordering::SeqCst) {
                                return Err(AppError::cancelled());
                            }
                            let st = item?;
                            let rows = st.expect_rows.unwrap_or(0);
                            s.apply(std::slice::from_ref(&st), false).await.map_err(|e| {
                                e.add_context(format!("While importing records {}–{}", total + 1, total + rows))
                            })?;
                            total += rows;
                            if let Some(p) = &progress {
                                p(total);
                            }
                        }
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Ok(()) => {
                            if transactional {
                                s.commit().await?;
                            }
                            Ok(total)
                        }
                        Err(e) => {
                            if transactional {
                                let _ = s.rollback().await;
                            }
                            Err(e)
                        }
                    }
                })
            })
            .await;
        let _ = producer.await;
        result
    }
}

/// Dashboard placeholders: `{{from}}` and `{{to}}` become quoted date or timestamp literals.
/// Values must match `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`, so substitution cannot
/// introduce SQL; anything else is refused.
pub fn substitute_dashboard_params(sql: &str, params: &HashMap<String, String>) -> Result<String> {
    let mut out = sql.to_string();
    for (name, value) in params {
        if !matches!(name.as_str(), "from" | "to") {
            return Err(AppError::invalid_config(format!("Unknown dashboard parameter '{name}'")));
        }
        if !is_date_literal(value) {
            return Err(AppError::invalid_config(format!("'{value}' is not a date (use YYYY-MM-DD)")));
        }
        out = out.replace(&format!("{{{{{name}}}}}"), &format!("'{value}'"));
    }
    if out.contains("{{") && (out.contains("{{from}}") || out.contains("{{to}}")) {
        return Err(AppError::invalid_config("Set the date range used by this widget"));
    }
    Ok(out)
}

fn is_date_literal(v: &str) -> bool {
    let b = v.as_bytes();
    let date = b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    match b.len() {
        10 => date,
        16 | 19 => {
            date && b[10] == b' '
                && b[11..]
                    .iter()
                    .enumerate()
                    .all(|(i, c)| if i == 2 || i == 5 { *c == b':' } else { c.is_ascii_digit() })
        }
        _ => false,
    }
}

impl Engine {
    /// Runs one dashboard widget query. The session should be opened read-only; the
    /// statement must also pass the read-only policy, and only one statement is allowed.
    pub async fn run_widget(
        &self,
        session_id: &str,
        sql: &str,
        params: &HashMap<String, String>,
        timeout_secs: u64,
        max_rows: usize,
    ) -> Result<RowSet> {
        let handle = self.handle(session_id)?;
        let sql = substitute_dashboard_params(sql, params)?;
        let analysis = analyze_script(&sql, handle.info.dialect, SafetyMode::ReadOnly);
        if analysis.statements.len() != 1 {
            return Err(AppError::invalid_config("A widget runs exactly one SELECT statement"));
        }
        Self::enforce_policy(&analysis, false, &handle.info)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let outcomes = self
            .execute_one(&handle, &analysis.statements[0].sql, max_rows.clamp(1, 50_000), timeout_secs, &cancelled)
            .await?;
        outcomes
            .into_iter()
            .find_map(|o| match o {
                StatementOutcome::Rows { rows } => Some(rows),
                _ => None,
            })
            .ok_or_else(|| AppError::invalid_config("The widget query returned no rows; use a SELECT"))
    }
}

impl Engine {
    /// Opens a Redis connection (through an SSH tunnel when configured).
    pub async fn redis_open(
        &self,
        profile: &ConnectionProfile,
        password: Option<&str>,
        ssh_secret: Option<&str>,
    ) -> Result<(String, crate::redis_kv::RedisInfo)> {
        profile.validate()?;
        let tunnel = match &profile.ssh {
            Some(ssh) => {
                let known =
                    self.known_hosts.clone().ok_or_else(|| AppError::internal("SSH known hosts are not configured"))?;
                Some(
                    crate::ssh::open_tunnel(
                        ssh,
                        ssh_secret,
                        &profile.host,
                        profile.port.unwrap_or(6379),
                        known,
                        Duration::from_secs(profile.connect_timeout_secs),
                    )
                    .await?,
                )
            }
            None => None,
        };
        let mut session = crate::redis_kv::RedisSession::connect(profile, password, tunnel).await?;
        let info = session.info().await?;
        let id = uuid::Uuid::new_v4().to_string();
        lock(&self.redis).insert(id.clone(), Arc::new(tokio::sync::Mutex::new(session)));
        Ok((id, info))
    }

    pub fn redis(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<crate::redis_kv::RedisSession>>> {
        lock(&self.redis).get(id).cloned().ok_or_else(|| AppError::not_found("This Redis connection is closed"))
    }

    pub fn redis_close(&self, id: &str) {
        lock(&self.redis).remove(id);
    }
}

fn has_raw(node: &FilterNode) -> bool {
    match node {
        FilterNode::Raw { enabled, .. } => *enabled,
        FilterNode::Group { children, .. } => children.iter().any(has_raw),
        FilterNode::Condition { .. } => false,
    }
}

/// Same as [`build_select`] but allows `limit` to exceed the page cap by one (probe row).
fn build_select_unchecked(
    dialect: Dialect,
    s: &TableStructure,
    req: &BrowseRequest,
) -> Result<crate::browse::BuiltQuery> {
    let mut capped = req.clone();
    let limit = req.limit;
    capped.limit = limit.min(crate::browse::MAX_PAGE_SIZE);
    let mut q = build_select(dialect, s, &capped)?;
    if limit != capped.limit {
        q.sql = q.sql.replacen(&format!(" LIMIT {} ", capped.limit), &format!(" LIMIT {limit} "), 1);
    }
    Ok(q)
}

/// Whether a successful transaction-control statement leaves a transaction open (`Some(true)`),
/// ends it (`Some(false)`), or neither (savepoints, `SET TRANSACTION`).
fn txn_effect(sql: &str) -> Option<bool> {
    let words: Vec<String> =
        sql.split_whitespace().take(2).map(|w| w.trim_end_matches(';').to_ascii_uppercase()).collect();
    match words.first().map(String::as_str)? {
        "BEGIN" | "START" => Some(true),
        "COMMIT" | "END" | "ABORT" => Some(false),
        "ROLLBACK" if words.get(1).is_none_or(|w| w != "TO") => Some(false),
        _ => None,
    }
}

/// Statement that switches the default schema, or `None` where names are not resolved
/// through a default schema (SQLite searches main, temp and attached databases itself).
pub fn default_schema_sql(driver: crate::config::Driver, schema: &str) -> Result<Option<String>> {
    use crate::config::Driver;
    Ok(match driver {
        // `public` stays on the path so extension functions and types still resolve.
        Driver::Postgres => {
            let q = Dialect::Postgres.quote_ident(schema)?;
            Some(if schema == "public" {
                "SET search_path TO public".into()
            } else {
                format!("SET search_path TO {q}, public")
            })
        }
        Driver::Mysql | Driver::Mariadb => Some(format!("USE {}", Dialect::Mysql.quote_ident(schema)?)),
        Driver::Duckdb => {
            Dialect::Postgres.quote_ident(schema)?;
            Some(format!("SET schema = {}", Dialect::Postgres.quote_literal(schema)))
        }
        Driver::Sqlite | Driver::Redis => None,
    })
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    use crate::config::Driver;

    #[test]
    fn transaction_control_is_tracked() {
        assert_eq!(super::txn_effect("BEGIN"), Some(true));
        assert_eq!(super::txn_effect("start transaction read only"), Some(true));
        assert_eq!(super::txn_effect("COMMIT;"), Some(false));
        assert_eq!(super::txn_effect("end"), Some(false));
        assert_eq!(super::txn_effect("ROLLBACK"), Some(false));
        assert_eq!(super::txn_effect("rollback to savepoint a"), None);
        assert_eq!(super::txn_effect("SAVEPOINT a"), None);
    }

    #[test]
    fn default_schema_statements() {
        assert_eq!(
            default_schema_sql(Driver::Postgres, "shop").unwrap().unwrap(),
            "SET search_path TO \"shop\", public"
        );
        assert_eq!(default_schema_sql(Driver::Postgres, "public").unwrap().unwrap(), "SET search_path TO public");
        assert_eq!(
            default_schema_sql(Driver::Postgres, "a\"b").unwrap().unwrap(),
            "SET search_path TO \"a\"\"b\", public"
        );
        assert_eq!(default_schema_sql(Driver::Mysql, "shop").unwrap().unwrap(), "USE `shop`");
        assert_eq!(default_schema_sql(Driver::Duckdb, "it's").unwrap().unwrap(), "SET schema = 'it''s'");
        assert_eq!(default_schema_sql(Driver::Sqlite, "main").unwrap(), None);
        assert!(default_schema_sql(Driver::Postgres, "").is_err());
    }
}

#[cfg(test)]
mod dashboard_tests {
    use super::*;

    #[test]
    fn substitutes_only_validated_dates() {
        let mut p = HashMap::new();
        p.insert("from".to_string(), "2026-01-01".to_string());
        p.insert("to".to_string(), "2026-01-31 23:59:59".to_string());
        let sql = substitute_dashboard_params("select * from t where at between {{from}} and {{to}}", &p).unwrap();
        assert_eq!(sql, "select * from t where at between '2026-01-01' and '2026-01-31 23:59:59'");
        p.insert("from".to_string(), "2026-01-01'; drop table t; --".to_string());
        assert!(substitute_dashboard_params("select {{from}}", &p).is_err());
        let mut q = HashMap::new();
        q.insert("x".to_string(), "2026-01-01".to_string());
        assert!(substitute_dashboard_params("select 1", &q).is_err());
        assert!(substitute_dashboard_params("select {{from}}", &HashMap::new()).is_err());
        assert_eq!(substitute_dashboard_params("select 1", &HashMap::new()).unwrap(), "select 1");
    }
}
