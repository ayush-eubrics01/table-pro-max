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
    /// Restore points made inside that transaction: kept on COMMIT, deleted on ROLLBACK.
    pending_restore: Mutex<Vec<String>>,
    /// A statement failed inside that transaction on PostgreSQL or DuckDB, so a COMMIT will roll
    /// it back (until a successful ROLLBACK TO SAVEPOINT).
    txn_failed: AtomicBool,
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
    /// Text longer than this is sent to the UI as a preview (see large_values.rs).
    preview_over: Option<usize>,
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
    /// Send text longer than this many characters to the UI as a preview (query results).
    /// `None` sends full values.
    #[serde(default)]
    pub large_value_chars: Option<u32>,
    /// Row limit for one restore point (default 100,000); over it, the user is asked first.
    #[serde(default)]
    pub restore_max_rows: Option<u64>,
    /// Size limit for one restore point in MB (default 50); over it, none is kept.
    #[serde(default)]
    pub restore_max_mb: Option<u64>,
}

/// A statement's restore point, resolved against its table before the script runs.
#[derive(Clone)]
struct ResolvedCapture {
    plan: crate::restore_plan::CapturePlan,
    structure: TableStructure,
}

#[derive(Clone)]
enum CaptureState {
    /// Not a statement restore points cover, or restore points are off.
    Off,
    Planned(Box<ResolvedCapture>),
    /// No restore point; `ask` when the user must confirm before it runs.
    Skipped {
        reason: String,
        ask: bool,
    },
}

const DUCKDB_TXN: &str = "inside a transaction on DuckDB";

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
    /// Whether a restore point was kept for this statement, or why not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore: Option<RestoreNote>,
}

/// What a statement's run says about its restore point (shown in Messages).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNote {
    /// Set when a restore point was kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_id: Option<String>,
    /// Why there is no restore point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
pub struct FetchedCell {
    /// False when no row has that key any more.
    pub found: bool,
    pub value: Cell,
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
    /// Where restore points are kept (the app's local storage); without one, none are made.
    restore_store: Mutex<Option<Arc<dyn crate::restore::RestoreStore>>>,
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
            restore_store: Mutex::new(None),
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

    /// Where restore points are kept (the app's local storage); without one, none are made.
    pub fn set_restore_store(&self, store: Arc<dyn crate::restore::RestoreStore>) {
        *lock(&self.restore_store) = Some(store);
    }

    fn restore_store(&self) -> Option<Arc<dyn crate::restore::RestoreStore>> {
        lock(&self.restore_store).clone()
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
            pending_restore: Mutex::new(Vec::new()),
            txn_failed: AtomicBool::new(false),
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
        // The old connection's transaction is gone, and with it what its restore points kept.
        self.settle_pending(&handle, false);
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
            self.settle_pending(&h, false);
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
        if let PolicyDecision::Block { reason } = &analysis.decision {
            return Err(AppError::new(ErrorKind::PolicyViolation, reason));
        }
        // Plan restore points before anything runs, so one confirmation covers every reason.
        let captures = self.plan_restore_points(&handle, &analysis, opts.restore_max_rows.unwrap_or(100_000)).await;
        let mut reasons = match &analysis.decision {
            PolicyDecision::Confirm { reasons } => reasons.clone(),
            _ => vec![],
        };
        for (i, c) in captures.iter().enumerate() {
            if let CaptureState::Skipped { reason, ask: true } = c {
                reasons.push(format!("Statement {}: can't keep a restore point ({reason})", i + 1));
            }
        }
        if !reasons.is_empty() && !opts.confirmed {
            return Err(AppError::new(
                ErrorKind::ConfirmationRequired,
                format!("Confirm execution on {} ({})", handle.info.connection_name, handle.info.target),
            )
            .with_detail(reasons.join("\n")));
        }

        let task_id = opts.task_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.tasks)
            .insert(task_id.clone(), RunningTask { session_id: session_id.to_string(), cancelled: cancelled.clone() });
        let timeout_secs = opts.timeout_secs.unwrap_or(handle.profile.query_timeout_secs);
        let max_rows = opts.max_rows.unwrap_or(DEFAULT_MAX_ROWS).clamp(1, 10_000_000);
        let restore_max_rows = opts.restore_max_rows.unwrap_or(100_000);
        let restore_max_bytes = opts.restore_max_mb.unwrap_or(50).saturating_mul(1024 * 1024);
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
                let (job, mut note) = match &captures[index] {
                    CaptureState::Planned(rc) => (
                        Some(CaptureJob {
                            rc: (**rc).clone(),
                            dialect: handle.info.dialect,
                            driver: handle.profile.driver,
                            in_txn: handle.open_txn.load(Ordering::SeqCst),
                            max_rows: restore_max_rows,
                            max_bytes: restore_max_bytes,
                        }),
                        None,
                    ),
                    CaptureState::Skipped { reason, .. } => {
                        (None, Some(RestoreNote { point_id: None, reason: Some(reason.clone()) }))
                    }
                    CaptureState::Off => (None, None),
                };
                let mut res = match self.execute_one(&handle, &stmt.sql, max_rows, timeout_secs, &cancelled, job).await
                {
                    Ok((outcomes, captured)) => {
                        if let Some(c) = captured {
                            note = self.keep_restore_point(&handle, &stmt.sql, c);
                        }
                        Ok(outcomes)
                    }
                    Err(e) => Err(e),
                };
                if want_origins && let Ok(outcomes) = &mut res {
                    self.add_origins(&handle, &stmt.sql, outcomes).await;
                }
                self.track_transaction(&handle, stmt, res.is_ok());
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
                        opts.large_value_chars.map(|n| n as usize),
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
                            restore: None,
                        }]
                    }
                };
                if let (Some(n), Some(last)) = (note, produced.last_mut()) {
                    last.restore = Some(n);
                }
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

    // ---- restore points: planning -------------------------------------------------

    fn restore_enabled(&self, handle: &SessionHandle) -> bool {
        handle.profile.restore_points
            && !handle.profile.read_only()
            && handle.profile.driver != crate::config::Driver::Redis
            && self.restore_store().is_some()
    }

    /// A read made for restore points that must not disturb the user's open transaction: on
    /// PostgreSQL inside one it runs under a savepoint (a failed statement would abort the
    /// transaction); DuckDB has no savepoints, so nothing is read there.
    async fn restore_read(
        &self,
        handle: &Arc<SessionHandle>,
        sql: String,
        params: Vec<Param>,
        max_rows: usize,
    ) -> Result<RowSet> {
        let in_txn = handle.open_txn.load(Ordering::SeqCst);
        let driver = handle.profile.driver;
        if in_txn && driver == crate::config::Driver::Duckdb {
            return Err(AppError::unsupported(DUCKDB_TXN));
        }
        let guard = in_txn && driver == crate::config::Driver::Postgres;
        self.with_session(&handle.info.session_id, move |s| {
            Box::pin(async move {
                if guard {
                    s.execute("SAVEPOINT tpm_restore", 0).await?;
                }
                let r = s.query(&sql, &params, max_rows).await;
                if guard {
                    if r.is_err() {
                        s.execute("ROLLBACK TO SAVEPOINT tpm_restore", 0).await?;
                    }
                    s.execute("RELEASE SAVEPOINT tpm_restore", 0).await?;
                }
                r
            })
        })
        .await
    }

    /// The schema and name of the table a statement names, as the server resolves it.
    /// `Ok(None)` when no such table exists (the statement will fail, or is `IF EXISTS`).
    async fn resolve_table(
        &self,
        handle: &Arc<SessionHandle>,
        t: &crate::restore_plan::TableRef,
    ) -> Result<Option<(String, String)>> {
        use crate::config::Driver;
        let first = |rs: &RowSet, i: usize| {
            rs.rows.first().and_then(|r| r.get(i)).and_then(|c| c.as_text()).map(str::to_string)
        };
        match handle.profile.driver {
            Driver::Postgres => {
                let rs = self
                    .restore_read(
                        handle,
                        "SELECT n.nspname::text, c.relname::text FROM pg_class c \
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($1)"
                            .into(),
                        vec![Some(t.sql.clone())],
                        1,
                    )
                    .await?;
                Ok(first(&rs, 0).zip(first(&rs, 1)))
            }
            driver => {
                let schema = match (&t.schema, driver) {
                    (Some(s), _) => s.clone(),
                    (None, Driver::Mysql | Driver::Mariadb) => {
                        let rs = self.restore_read(handle, "SELECT DATABASE()".into(), vec![], 1).await?;
                        first(&rs, 0).unwrap_or_else(|| handle.info.database.clone())
                    }
                    (None, Driver::Duckdb) => {
                        let rs = self.restore_read(handle, "SELECT current_schema()".into(), vec![], 1).await?;
                        first(&rs, 0).unwrap_or_else(|| "main".into())
                    }
                    (None, _) => "main".into(),
                };
                Ok(Some((schema, t.name.clone())))
            }
        }
    }

    /// Resolves a capture plan against its table and the row limit. `Ok(None)`: the table does
    /// not exist, so there is nothing to keep. `Err`: the reason there can't be a restore point.
    async fn resolve_capture(
        &self,
        handle: &Arc<SessionHandle>,
        mut plan: crate::restore_plan::CapturePlan,
        max_rows: u64,
    ) -> std::result::Result<Option<ResolvedCapture>, String> {
        use crate::restore_plan::{TABLE_UNREADABLE, UNREADABLE, count_select, structure_reason};
        let session_id = handle.info.session_id.clone();
        let (schema, table) = match self.resolve_table(handle, &plan.table).await {
            Ok(Some(found)) => found,
            Ok(None) => return Ok(None),
            Err(e) if e.message.contains(DUCKDB_TXN) => return Err(DUCKDB_TXN.into()),
            Err(_) => return Err(TABLE_UNREADABLE.into()),
        };
        let structure = match self.table_structure(&session_id, &schema, &table, true).await {
            Ok(s) => s,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(TABLE_UNREADABLE.into()),
        };
        if let Some(r) = structure_reason(&plan, &structure, handle.profile.driver) {
            return Err(r);
        }
        plan.table.schema = Some(schema);
        plan.table.name = table;
        let rs = self.restore_read(handle, count_select(&plan), vec![], 1).await.map_err(|_| UNREADABLE.to_string())?;
        let n: u64 =
            rs.rows.first().and_then(|r| r.first()).and_then(|c| c.as_text()).and_then(|t| t.parse().ok()).unwrap_or(0);
        if n > max_rows {
            return Err(format!("affects {n} rows, more than {max_rows}"));
        }
        Ok(Some(ResolvedCapture { plan, structure }))
    }

    /// Plans a restore point for each statement of a script (see restore_plan.rs).
    async fn plan_restore_points(
        &self,
        handle: &Arc<SessionHandle>,
        analysis: &ScriptAnalysis,
        max_rows: u64,
    ) -> Vec<CaptureState> {
        use crate::restore_plan::{PlanOutcome, plan_statement};
        let mut out = vec![CaptureState::Off; analysis.statements.len()];
        if !self.restore_enabled(handle) {
            return out;
        }
        for (i, stmt) in analysis.statements.iter().enumerate() {
            if stmt.class < crate::safety::StatementClass::Write {
                continue;
            }
            out[i] = match plan_statement(&stmt.sql, handle.info.dialect) {
                PlanOutcome::None => CaptureState::Off,
                PlanOutcome::Unsupported(reason) => CaptureState::Skipped { reason, ask: true },
                PlanOutcome::Capture(plan) => match self.resolve_capture(handle, plan, max_rows).await {
                    Ok(Some(rc)) => CaptureState::Planned(Box::new(rc)),
                    Ok(None) => CaptureState::Off,
                    // DuckDB in a transaction: said in the statement's message, not asked about.
                    Err(reason) if reason == DUCKDB_TXN => CaptureState::Skipped { reason, ask: false },
                    Err(reason) => CaptureState::Skipped { reason, ask: true },
                },
            };
        }
        out
    }

    // ---- restore points: after a statement ------------------------------------------

    /// Follows the user's transaction control: whether one is open, whether it failed, and what
    /// happens to the restore points made inside it.
    fn track_transaction(&self, handle: &SessionHandle, stmt: &crate::safety::StatementAnalysis, ok: bool) {
        use crate::config::Driver;
        let driver = handle.profile.driver;
        if !ok {
            // PostgreSQL and DuckDB abort the whole transaction on an error: its COMMIT rolls back.
            if handle.open_txn.load(Ordering::SeqCst) && matches!(driver, Driver::Postgres | Driver::Duckdb) {
                handle.txn_failed.store(true, Ordering::SeqCst);
            }
            return;
        }
        if stmt.class == crate::safety::StatementClass::Transaction {
            if let Some(commit) = txn_end(&stmt.sql) {
                let failed = handle.txn_failed.swap(false, Ordering::SeqCst);
                self.settle_pending(handle, commit && !failed);
            } else if is_rollback_to(&stmt.sql) || txn_effect(&stmt.sql) == Some(true) {
                // ROLLBACK TO recovers the transaction; BEGIN starts a fresh one.
                handle.txn_failed.store(false, Ordering::SeqCst);
            }
            if let Some(open) = txn_effect(&stmt.sql) {
                handle.open_txn.store(open, Ordering::SeqCst);
            }
        } else if matches!(driver, Driver::Mysql | Driver::Mariadb) && mysql_implicit_commit(&stmt.sql) {
            // MySQL commits the open transaction before and after DDL.
            self.settle_pending(handle, true);
        }
    }

    /// Ends the restore points made inside the user's transaction: kept (COMMIT) or deleted.
    fn settle_pending(&self, handle: &SessionHandle, keep: bool) {
        let ids = std::mem::take(&mut *lock(&handle.pending_restore));
        if ids.is_empty() {
            return;
        }
        let Some(store) = self.restore_store() else { return };
        let r = if keep { store.set_status(&ids, crate::restore::RestoreStatus::Kept) } else { store.delete(&ids) };
        if let Err(e) = r {
            tracing::warn!(error = %e.message, "could not update pending restore points");
        }
    }

    /// Saves what a capture read as a restore point; the note for the statement's message.
    fn keep_restore_point(&self, handle: &SessionHandle, statement: &str, c: Captured) -> Option<RestoreNote> {
        use crate::restore::{RestoreKind, RestorePoint, RestoreStatus};
        if let Some(reason) = c.dropped {
            return Some(RestoreNote { point_id: None, reason: Some(reason) });
        }
        // Nothing matched: nothing to put back (a dropped table or column still comes back).
        if c.data.before.is_empty() && !matches!(c.kind, RestoreKind::DropTable | RestoreKind::DropColumn) {
            return None;
        }
        let store = self.restore_store()?;
        let point = RestorePoint {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: handle.profile.id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            status: if c.pending { RestoreStatus::Pending } else { RestoreStatus::Kept },
            restored_at: None,
            kind: c.kind,
            schema: c.schema,
            table: c.table,
            statement: statement.to_string(),
            row_count: c.data.before.len() as u64,
            data: c.data,
            bytes: c.bytes,
        };
        match store.save(&point) {
            Ok(()) => {
                if c.pending {
                    lock(&handle.pending_restore).push(point.id.clone());
                }
                Some(RestoreNote { point_id: Some(point.id), reason: None })
            }
            Err(e) => Some(RestoreNote { point_id: None, reason: Some(format!("could not be saved: {}", e.message)) }),
        }
    }

    async fn execute_one(
        &self,
        handle: &Arc<SessionHandle>,
        sql: &str,
        max_rows: usize,
        timeout_secs: u64,
        cancelled: &Arc<AtomicBool>,
        capture: Option<CaptureJob>,
    ) -> Result<(Vec<StatementOutcome>, Option<Captured>)> {
        let canceller = lock(&handle.canceller).clone();
        let sql_owned = sql.to_string();
        let fut = self.with_session(&handle.info.session_id, move |s| {
            Box::pin(async move {
                match capture {
                    Some(job) => run_captured(s, &sql_owned, max_rows, job).await.map(|(o, c)| (o, Some(c))),
                    None => s.execute(&sql_owned, max_rows).await.map(|o| (o, None)),
                }
            })
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
        preview_over: Option<usize>,
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
                restore: None,
            };
            match o {
                StatementOutcome::Affected { rows_affected } => r.rows_affected = Some(rows_affected),
                StatementOutcome::Rows { rows } => {
                    let id = uuid::Uuid::new_v4().to_string();
                    r.total_rows = Some(rows.rows.len());
                    r.truncated = rows.truncated;
                    r.columns = Some(rows.columns.clone());
                    let first: Vec<Row> = rows.rows.iter().take(FIRST_PAGE_ROWS).cloned().collect();
                    r.rows = Some(match preview_over {
                        Some(n) => crate::large_values::preview_rows(&first, n),
                        None => first,
                    });
                    {
                        let approx_bytes = rows.rows.iter().map(approx_row_bytes).sum();
                        lock(&self.results).insert(
                            id.clone(),
                            StoredResult {
                                session_id: session_id.to_string(),
                                columns: rows.columns,
                                rows: rows.rows,
                                approx_bytes,
                                preview_over,
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
        let page: Vec<Row> = r.rows.iter().skip(offset).take(limit.min(10_000)).cloned().collect();
        Ok(match r.preview_over {
            Some(n) => crate::large_values::preview_rows(&page, n),
            None => page,
        })
    }

    /// The full value of one result cell, from memory (opening a previewed value).
    pub fn result_value(&self, result_id: &str, row: usize, col: usize) -> Result<Cell> {
        let store = lock(&self.results);
        let r = store
            .results
            .get(result_id)
            .ok_or_else(|| AppError::not_found("This result is no longer in memory; run the query again"))?;
        r.rows
            .get(row)
            .and_then(|cells| cells.get(col))
            .cloned()
            .ok_or_else(|| AppError::not_found("That cell is outside this result"))
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
        let deferred = if req.lazy {
            crate::large_values::deferred_columns(
                handle.profile.driver,
                &structure,
                &req.load_columns,
                &req.defer_columns,
            )
        } else {
            vec![false; structure.columns.len()]
        };
        let q = crate::browse::build_select_projected(
            handle.info.dialect,
            &structure,
            &BrowseRequest { limit: req.limit, ..req.clone() },
            &deferred,
        )?;
        let probe_q = build_select_unchecked(handle.info.dialect, &structure, &probe, &deferred)?;
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
        let (columns, rows) = crate::large_values::expand_deferred(&structure, &deferred, rs.columns, rs.rows);
        Ok(BrowseResult { columns, rows, sql: q.sql, duration_ms: t0.elapsed().as_millis() as u64, has_more })
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
        let fut = self.with_session(&handle.info.session_id, move |s| Box::pin(async move { s.describe(&sql).await }));
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
                    c.origin = f.origin.clone();
                    if c.type_name.is_empty() {
                        c.type_name = f.type_name.clone();
                    }
                }
            }
        }
    }

    /// One column of an opened table for the given rows, by primary key (large values on demand).
    pub async fn fetch_column(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        column: &str,
        keys: &[Vec<crate::changes::ColumnValue>],
    ) -> Result<Vec<FetchedCell>> {
        let handle = self.handle(session_id)?;
        let structure = self.table_structure(session_id, schema, table, false).await?;
        let q = crate::browse::build_fetch(handle.info.dialect, &structure, column, keys)?;
        let n = keys.len();
        let rs = self
            .with_session(session_id, move |s| Box::pin(async move { s.query(&q.sql, &q.params, n).await }))
            .await?;
        let pk: Vec<String> = structure.primary_key().iter().map(|c| c.name.clone()).collect();
        let mut by_key: HashMap<Vec<String>, Cell> = HashMap::new();
        for row in rs.rows {
            let key = row[..pk.len()].iter().map(|c| c.as_text().unwrap_or_default().to_string()).collect();
            by_key.insert(key, row[pk.len()].clone());
        }
        Ok(keys
            .iter()
            .map(|k| {
                let want: Vec<String> = pk
                    .iter()
                    .map(|p| k.iter().find(|v| &v.column == p).and_then(|v| v.value.clone()).unwrap_or_default())
                    .collect();
                match by_key.get(&want) {
                    Some(c) => FetchedCell { found: true, value: c.clone() },
                    None => FetchedCell { found: false, value: Cell::Null },
                }
            })
            .collect())
    }

    pub async fn fetch_value(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        key: Vec<crate::changes::ColumnValue>,
        column: &str,
    ) -> Result<Cell> {
        let mut got = self.fetch_column(session_id, schema, table, column, std::slice::from_ref(&key)).await?;
        let f = got.remove(0);
        if !f.found {
            return Err(AppError::not_found("This row no longer exists"));
        }
        Ok(f.value)
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
        self.apply_change_sets_as(session_id, sets, confirmed, crate::restore::RestoreKind::GridEdit, None).await
    }

    /// `apply_change_sets`, keeping a restore point of `kind` per table for the updated and
    /// deleted rows (inserted rows are not kept). `statement` is the point's description; by
    /// default the generated SQL.
    async fn apply_change_sets_as(
        &self,
        session_id: &str,
        sets: &[ChangeSet],
        confirmed: bool,
        kind: crate::restore::RestoreKind,
        statement: Option<String>,
    ) -> Result<Vec<u64>> {
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
        let dialect = handle.info.dialect;
        let mut statements = Vec::new();
        let mut grid_captures = Vec::new();
        let capture = self.restore_enabled(&handle) && handle.info.capabilities.transactions;
        for set in sets {
            let structure = self.table_structure(session_id, &set.schema, &set.table, true).await?;
            let set_statements = build_statements(dialect, &structure, set)?;
            if capture && let Some(gc) = grid_capture(dialect, handle.profile.driver, &structure, set, &set_statements)?
            {
                grid_captures.push(GridCapture { statement: statement.clone().unwrap_or(gc.statement.clone()), ..gc });
            }
            statements.extend(set_statements);
        }
        let atomic = handle.info.capabilities.transactions;
        let (counts, captured) = self
            .with_session(session_id, move |s| {
                Box::pin(async move {
                    if s.in_transaction().await? {
                        return Err(open_txn());
                    }
                    if grid_captures.is_empty() {
                        return Ok((s.apply(&statements, atomic).await?, vec![]));
                    }
                    apply_captured(s, &statements, grid_captures).await
                })
            })
            .await?;
        for c in captured {
            let statement = c.statement.clone();
            let _ = self.keep_restore_point(&handle, &statement, Captured { kind, ..c.captured });
        }
        Ok(counts)
    }

    /// The point, and the DDL and change sets that restore it (`rows`: indexes into its rows).
    async fn restore_actions(
        &self,
        session_id: &str,
        point_id: &str,
        rows: Option<Vec<usize>>,
    ) -> Result<(crate::restore::RestorePoint, crate::restore::RestoreActions)> {
        use crate::restore::RestoreKind;
        let handle = self.handle(session_id)?;
        let store = self.restore_store().ok_or_else(|| AppError::internal("Restore points are not available"))?;
        let point = store.get(point_id)?;
        if point.connection_id != handle.profile.id {
            return Err(AppError::invalid_config("This restore point belongs to another connection"));
        }
        let current = self.table_structure(session_id, &point.schema, &point.table, true).await;
        let exists = match (&current, point.kind) {
            (Ok(s), RestoreKind::DropColumn) => {
                point.data.columns.iter().filter(|c| !point.data.key_columns.contains(c)).all(|c| s.column(c).is_some())
            }
            (Ok(_), _) => true,
            (Err(e), _) if e.kind == ErrorKind::NotFound => false,
            (Err(e), _) => return Err(e.clone()),
        };
        let actions = crate::restore::build_restore(&point, handle.info.dialect, rows.as_deref(), exists)?;
        Ok((point, actions))
    }

    /// The SQL a restore will run, for the review dialog.
    pub async fn preview_restore(
        &self,
        session_id: &str,
        point_id: &str,
        rows: Option<Vec<usize>>,
    ) -> Result<ChangePreview> {
        let handle = self.handle(session_id)?;
        let dialect = handle.info.dialect;
        let (point, actions) = self.restore_actions(session_id, point_id, rows).await?;
        let mut sql: Vec<String> = actions.ddl.iter().map(|d| format!("{d};")).collect();
        let mut count = actions.ddl.len();
        for set in &actions.sets {
            // Before the DDL has run, the table (or column) exists only in the restore point.
            let structure = if actions.ddl.is_empty() {
                self.table_structure(session_id, &set.schema, &set.table, false).await?
            } else {
                restored_structure(&point, self.table_structure(session_id, &set.schema, &set.table, false).await.ok())
            };
            let statements = build_statements(dialect, &structure, set)?;
            count += statements.len();
            sql.push(preview(dialect, &statements));
        }
        // DDL runs first, on its own: MySQL commits DDL implicitly.
        Ok(ChangePreview {
            sql: sql.join("\n"),
            statement_count: count,
            atomic: handle.info.capabilities.transactions && actions.ddl.is_empty(),
        })
    }

    /// Puts a restore point's rows back (all, or the chosen ones) after the review dialog.
    /// Rows changed since the point was made stop the restore; nothing is written then.
    pub async fn apply_restore(
        &self,
        session_id: &str,
        point_id: &str,
        rows: Option<Vec<usize>>,
        confirmed: bool,
    ) -> Result<Vec<u64>> {
        let handle = self.handle(session_id)?;
        if handle.profile.read_only() {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the restore before committing"));
        }
        if handle.open_txn.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorKind::PolicyViolation,
                "This tab has an open transaction. Commit or roll it back first, then restore.",
            ));
        }
        let (point, actions) = self.restore_actions(session_id, point_id, rows).await?;
        if !actions.ddl.is_empty() {
            self.apply_ddl(session_id, &actions.ddl, true).await?;
        }
        let counts = if actions.sets.is_empty() {
            vec![]
        } else {
            self.apply_change_sets_as(
                session_id,
                &actions.sets,
                true,
                crate::restore::RestoreKind::Restore,
                Some(format!("Restore of: {}", point.statement)),
            )
            .await?
        };
        if let Some(store) = self.restore_store() {
            store.set_status(std::slice::from_ref(&point.id), crate::restore::RestoreStatus::Restored)?;
        }
        Ok(counts)
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
            .execute_one(
                &handle,
                &analysis.statements[0].sql,
                max_rows.clamp(1, 50_000),
                timeout_secs,
                &cancelled,
                None,
            )
            .await?
            .0;
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
    deferred: &[bool],
) -> Result<crate::browse::BuiltQuery> {
    let mut capped = req.clone();
    let limit = req.limit;
    capped.limit = limit.min(crate::browse::MAX_PAGE_SIZE);
    let mut q = crate::browse::build_select_projected(dialect, s, &capped, deferred)?;
    if limit != capped.limit {
        q.sql = q.sql.replacen(&format!(" LIMIT {} ", capped.limit), &format!(" LIMIT {limit} "), 1);
    }
    Ok(q)
}

/// Whether a successful transaction-control statement leaves a transaction open (`Some(true)`),
/// ends it (`Some(false)`), or neither (savepoints, `SET TRANSACTION`).
/// What a planned restore point needs while its statement runs (see `run_captured`).
struct CaptureJob {
    rc: ResolvedCapture,
    dialect: Dialect,
    driver: crate::config::Driver,
    /// The statement runs inside the user's open transaction.
    in_txn: bool,
    max_rows: u64,
    max_bytes: u64,
}

/// The rows a capture read, or why none were kept.
struct Captured {
    kind: crate::restore::RestoreKind,
    schema: String,
    table: String,
    data: crate::restore::RestoreData,
    bytes: u64,
    /// Made inside the user's transaction: kept on COMMIT, deleted on ROLLBACK.
    pending: bool,
    dropped: Option<String>,
}

fn cell_param(c: &Cell) -> Param {
    match c {
        Cell::Text(t) => Some(t.clone()),
        other => other.to_export_string(),
    }
}

/// Runs `f` under a savepoint when `guard` is set, so a failed read leaves the user's
/// PostgreSQL transaction usable.
async fn guarded<T>(
    s: &mut Box<dyn Session>,
    guard: bool,
    f: impl for<'a> FnOnce(&'a mut Box<dyn Session>) -> futures_util::future::BoxFuture<'a, Result<T>>,
) -> Result<T> {
    if guard {
        s.execute("SAVEPOINT tpm_restore", 0).await?;
    }
    let r = f(s).await;
    if guard {
        if r.is_err() {
            s.execute("ROLLBACK TO SAVEPOINT tpm_restore", 0).await?;
        }
        s.execute("RELEASE SAVEPOINT tpm_restore", 0).await?;
    }
    r
}

/// The connection is gone or the user cancelled: stop rather than carry on without a capture.
fn is_fatal(e: &AppError) -> bool {
    matches!(e.kind, ErrorKind::Cancelled | ErrorKind::Network | ErrorKind::Timeout)
}

/// Runs one statement with its restore point (spec: "Capture at run time"): outside the user's
/// transaction inside our own, so the rows read are exactly the rows changed; before rows, the
/// statement, after rows (UPDATE), commit. A read that fails leaves the statement to run without
/// a restore point; the statement's own failure rolls everything back.
async fn run_captured(
    s: &mut Box<dyn Session>,
    sql: &str,
    max_rows: usize,
    job: CaptureJob,
) -> Result<(Vec<StatementOutcome>, Captured)> {
    use crate::config::Driver;
    use crate::restore::RestoreKind;
    use crate::restore_plan::{CaptureKind, capture_columns, capture_select};
    let plan = &job.rc.plan;
    let st = &job.rc.structure;
    let mysql = matches!(job.driver, Driver::Mysql | Driver::Mariadb);
    let row_change = matches!(plan.kind, CaptureKind::Update | CaptureKind::Delete);
    // MySQL commits implicitly around DDL (TRUNCATE too): no transaction of ours, and the point
    // is kept even inside the user's transaction, which that commit ended.
    let implicit_commit = mysql && !row_change;
    let own_txn = !job.in_txn && !implicit_commit;
    let guard = job.in_txn && job.driver == Driver::Postgres;
    let lock = (job.driver == Driver::Postgres || mysql) && row_change;
    let cols = capture_columns(plan, st);
    let mut cap = Captured {
        kind: match plan.kind {
            CaptureKind::Update => RestoreKind::Update,
            CaptureKind::Delete => RestoreKind::Delete,
            CaptureKind::Truncate => RestoreKind::Truncate,
            CaptureKind::DropTable => RestoreKind::DropTable,
            CaptureKind::DropColumn => RestoreKind::DropColumn,
        },
        schema: st.schema.clone(),
        table: st.name.clone(),
        data: crate::restore::RestoreData {
            columns: cols.iter().map(|c| c.name.clone()).collect(),
            types: cols.iter().map(|c| c.data_type.clone()).collect(),
            key_columns: st.primary_key().iter().map(|c| c.name.clone()).collect(),
            column_type: plan
                .column
                .as_ref()
                .and_then(|c| st.columns.iter().find(|x| x.name.eq_ignore_ascii_case(c)))
                .map(|c| c.data_type.clone()),
            ..Default::default()
        },
        bytes: 0,
        pending: job.in_txn && !implicit_commit,
        dropped: None,
    };

    if own_txn {
        s.begin().await?;
    }
    let select = capture_select(plan, st, job.dialect, lock)?;
    let limit = job.max_rows as usize;
    let want_ddl = plan.kind == CaptureKind::DropTable;
    let (schema, table) = (st.schema.clone(), st.name.clone());
    let read = guarded(s, guard, move |s| {
        Box::pin(async move {
            let rows = s.query(&select, &[], limit.saturating_add(1)).await?;
            let ddl =
                if want_ddl { Some(s.object_definition(&schema, &table, ObjectKind::Table).await?) } else { None };
            Ok((rows, ddl))
        })
    })
    .await;
    match read {
        Err(e) if is_fatal(&e) => {
            if own_txn {
                let _ = s.rollback().await;
            }
            return Err(e);
        }
        Err(e) => {
            if own_txn {
                s.rollback().await?;
            }
            let outcomes = s.execute(sql, max_rows).await?;
            cap.dropped = Some(format!("could not read the rows: {}", e.message));
            return Ok((outcomes, cap));
        }
        Ok((rows, ddl)) => {
            cap.data.ddl = ddl;
            cap.data.before = rows.rows.iter().map(|r| r.iter().map(cell_param).collect()).collect();
            cap.bytes = cap.data.before.iter().flatten().map(|v| v.as_ref().map_or(0, |t| t.len() as u64)).sum();
            if cap.data.before.len() > limit || rows.truncated {
                cap.dropped = Some(format!("more than {} rows", job.max_rows));
            } else if cap.bytes > job.max_bytes {
                cap.dropped = Some(format!("more than {} MB", job.max_bytes / (1024 * 1024)));
            }
        }
    }

    let outcomes = match s.execute(sql, max_rows).await {
        Ok(o) => o,
        Err(e) => {
            if own_txn {
                let _ = s.rollback().await;
            }
            return Err(e);
        }
    };

    if plan.kind == CaptureKind::Update && cap.dropped.is_none() {
        let d = &cap.data;
        let key_idx: Vec<usize> = d.key_columns.iter().filter_map(|k| d.columns.iter().position(|c| c == k)).collect();
        let keys: Vec<Vec<crate::changes::ColumnValue>> = d
            .before
            .iter()
            .map(|row| {
                key_idx
                    .iter()
                    .map(|i| crate::changes::ColumnValue { column: d.columns[*i].clone(), value: row[*i].clone() })
                    .collect()
            })
            .collect();
        let mut queries = Vec::new();
        for chunk in keys.chunks(200) {
            queries.push(crate::browse::build_rows_by_key(job.dialect, st, chunk)?);
        }
        let read = guarded(s, guard, move |s| {
            Box::pin(async move {
                let mut rows = Vec::new();
                for q in queries {
                    rows.extend(s.query(&q.sql, &q.params, 200).await?.rows);
                }
                Ok(rows)
            })
        })
        .await;
        match read {
            Ok(rows) => {
                let mut by_key: HashMap<Vec<Param>, Vec<Param>> = HashMap::new();
                for r in rows {
                    let vals: Vec<Param> = r.iter().map(cell_param).collect();
                    by_key.insert(key_idx.iter().map(|i| vals[*i].clone()).collect(), vals);
                }
                cap.data.after = cap
                    .data
                    .before
                    .iter()
                    .map(|b| by_key.get(&key_idx.iter().map(|i| b[*i].clone()).collect::<Vec<_>>()).cloned())
                    .collect();
            }
            Err(e) if is_fatal(&e) => {
                if own_txn {
                    let _ = s.rollback().await;
                }
                return Err(e);
            }
            Err(e) => cap.dropped = Some(format!("could not read the changed rows: {}", e.message)),
        }
    }

    if own_txn && let Err(e) = s.commit().await {
        let _ = s.rollback().await;
        return Err(e);
    }
    Ok((outcomes, cap))
}

/// The table as a restore point recorded it: the current structure plus the columns it lacks
/// (DROP COLUMN), or rebuilt from the point (DROP TABLE). For previews before the DDL has run.
fn restored_structure(point: &crate::restore::RestorePoint, current: Option<TableStructure>) -> TableStructure {
    let d = &point.data;
    let mut s = current.unwrap_or_else(|| TableStructure {
        schema: point.schema.clone(),
        name: point.table.clone(),
        kind: ObjectKind::Table,
        ..Default::default()
    });
    for (i, name) in d.columns.iter().enumerate() {
        if s.column(name).is_none() {
            s.columns.push(ColumnInfo {
                name: name.clone(),
                data_type: d.types.get(i).cloned().unwrap_or_default(),
                nullable: true,
                default: None,
                primary_key: d.key_columns.iter().position(|k| k == name).map(|p| p as u32 + 1),
                auto_increment: false,
                comment: None,
            });
        }
    }
    s
}

/// A grid commit's restore point for one table, before it runs.
struct GridCapture {
    statement: String,
    structure: TableStructure,
    dialect: Dialect,
    /// Keys of the updated rows (after rows are read for these) and of the deleted rows.
    updated: Vec<Vec<crate::changes::ColumnValue>>,
    deleted: Vec<Vec<crate::changes::ColumnValue>>,
    captured: Captured,
}

/// Plans the restore point of a grid commit to one table: `None` when there is nothing to keep
/// (inserts only) or it can't be kept (a key edited, or binary columns off PostgreSQL).
fn grid_capture(
    dialect: Dialect,
    driver: crate::config::Driver,
    s: &TableStructure,
    set: &ChangeSet,
    statements: &[ParamStatement],
) -> Result<Option<GridCapture>> {
    use crate::changes::RowChange;
    let pk: Vec<String> = s.primary_key().iter().map(|c| c.name.clone()).collect();
    if pk.is_empty() || crate::restore_plan::has_binary_columns(s, driver) {
        return Ok(None);
    }
    let (mut updated, mut deleted) = (Vec::new(), Vec::new());
    for c in &set.changes {
        match c {
            RowChange::Update { key, edits } => {
                if edits.iter().any(|e| pk.contains(&e.column)) {
                    return Ok(None);
                }
                updated.push(key.clone());
            }
            RowChange::Delete { key } => deleted.push(key.clone()),
            RowChange::Insert { .. } => {}
        }
    }
    if updated.is_empty() && deleted.is_empty() {
        return Ok(None);
    }
    Ok(Some(GridCapture {
        statement: preview(dialect, statements),
        structure: s.clone(),
        dialect,
        updated,
        deleted,
        captured: Captured {
            kind: crate::restore::RestoreKind::GridEdit,
            schema: s.schema.clone(),
            table: s.name.clone(),
            data: crate::restore::RestoreData {
                columns: s.columns.iter().map(|c| c.name.clone()).collect(),
                types: s.columns.iter().map(|c| c.data_type.clone()).collect(),
                key_columns: pk,
                ..Default::default()
            },
            bytes: 0,
            pending: false,
            dropped: None,
        },
    }))
}

/// Reads every column of the rows with these keys, keyed by their key values.
async fn rows_by_key(
    s: &mut Box<dyn Session>,
    dialect: Dialect,
    st: &TableStructure,
    keys: &[Vec<crate::changes::ColumnValue>],
) -> Result<HashMap<Vec<Param>, Vec<Param>>> {
    let pk: Vec<usize> =
        st.primary_key().iter().filter_map(|k| st.columns.iter().position(|c| c.name == k.name)).collect();
    let mut out = HashMap::new();
    for chunk in keys.chunks(200) {
        let q = crate::browse::build_rows_by_key(dialect, st, chunk)?;
        for r in s.query(&q.sql, &q.params, chunk.len()).await?.rows {
            let vals: Vec<Param> = r.iter().map(cell_param).collect();
            out.insert(pk.iter().map(|i| vals[*i].clone()).collect(), vals);
        }
    }
    Ok(out)
}

fn key_values(st: &TableStructure, key: &[crate::changes::ColumnValue]) -> Vec<Param> {
    st.primary_key().iter().map(|k| key.iter().find(|v| v.column == k.name).and_then(|v| v.value.clone())).collect()
}

/// A grid commit with its restore points: in one transaction, read the rows about to change,
/// apply, read the updated rows again, commit. If the rows can't be read, the commit goes ahead
/// without restore points.
async fn apply_captured(
    s: &mut Box<dyn Session>,
    statements: &[ParamStatement],
    mut caps: Vec<GridCapture>,
) -> Result<(Vec<u64>, Vec<GridCapture>)> {
    s.begin().await?;
    let mut before = Vec::with_capacity(caps.len());
    for c in &caps {
        let keys: Vec<_> = c.updated.iter().chain(&c.deleted).cloned().collect();
        match rows_by_key(s, c.dialect, &c.structure, &keys).await {
            Ok(rows) => before.push(rows),
            Err(e) if is_fatal(&e) => {
                let _ = s.rollback().await;
                return Err(e);
            }
            Err(_) => {
                s.rollback().await?;
                return Ok((s.apply(statements, true).await?, vec![]));
            }
        }
    }
    let counts = match s.apply(statements, false).await {
        Ok(c) => c,
        Err(e) => {
            let _ = s.rollback().await;
            return Err(e);
        }
    };
    for (c, rows) in caps.iter_mut().zip(before) {
        let after = match rows_by_key(s, c.dialect, &c.structure, &c.updated).await {
            Ok(a) => a,
            Err(e) if is_fatal(&e) => {
                let _ = s.rollback().await;
                return Err(e);
            }
            Err(e) => {
                c.captured.dropped = Some(format!("could not read the changed rows: {}", e.message));
                continue;
            }
        };
        let st = &c.structure;
        for key in c.updated.iter().chain(&c.deleted) {
            let k = key_values(st, key);
            // A row that was already gone changed nothing.
            let Some(b) = rows.get(&k) else { continue };
            c.captured.data.before.push(b.clone());
            c.captured.data.after.push(after.get(&k).cloned());
        }
        c.captured.bytes =
            c.captured.data.before.iter().flatten().map(|v| v.as_ref().map_or(0, |t| t.len() as u64)).sum();
    }
    if let Err(e) = s.commit().await {
        let _ = s.rollback().await;
        return Err(e);
    }
    caps.retain(|c| c.captured.dropped.is_none() && !c.captured.data.before.is_empty());
    Ok((counts, caps))
}

/// COMMIT (true) or ROLLBACK (false) of the whole transaction; `None` for anything else.
fn txn_end(sql: &str) -> Option<bool> {
    match txn_effect(sql) {
        Some(false) => {
            let first = sql.split_whitespace().next().unwrap_or("").trim_end_matches(';').to_ascii_uppercase();
            Some(matches!(first.as_str(), "COMMIT" | "END"))
        }
        _ => None,
    }
}

fn is_rollback_to(sql: &str) -> bool {
    let words: Vec<String> = sql.split_whitespace().take(2).map(|w| w.to_ascii_uppercase()).collect();
    words.first().map(String::as_str) == Some("ROLLBACK") && words.get(1).map(String::as_str) == Some("TO")
}

/// MySQL statements that commit the open transaction implicitly (DDL).
fn mysql_implicit_commit(sql: &str) -> bool {
    let first = sql.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    matches!(first.as_str(), "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME")
}

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
    fn transaction_ends_are_told_apart() {
        assert_eq!(super::txn_end("COMMIT"), Some(true));
        assert_eq!(super::txn_end("end;"), Some(true));
        assert_eq!(super::txn_end("ROLLBACK"), Some(false));
        assert_eq!(super::txn_end("abort"), Some(false));
        assert_eq!(super::txn_end("ROLLBACK TO SAVEPOINT a"), None);
        assert_eq!(super::txn_end("BEGIN"), None);
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
