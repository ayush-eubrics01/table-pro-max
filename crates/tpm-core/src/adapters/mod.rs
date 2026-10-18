//! Database adapters.
//!
//! Each driver implements [`Session`], a single logical connection. The engine wraps
//! every session in a mutex so one connection never runs two operations at once
//! (which would corrupt transaction state on most drivers). Cancellation goes through a
//! separate [`Canceller`] obtained when the session opens, because the session itself is
//! locked while a query runs.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

use crate::config::{ConnectionProfile, Driver};
use crate::dialect::Dialect;
use crate::error::Result;
use crate::model::{
    Capabilities, ColumnOrigin, DbObject, ObjectKind, Param, RowSet, ServerInfo, StatementOutcome, TableStructure,
};

#[cfg(feature = "duckdb")]
pub mod duckdb;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub(crate) mod tls;

/// A generated statement with bind parameters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamStatement {
    pub sql: String,
    pub params: Vec<Param>,
    /// When set, the statement must affect exactly this many rows; anything else is
    /// reported as a conflict and (inside a transaction) rolled back.
    pub expect_rows: Option<u64>,
}

impl ParamStatement {
    pub fn new(sql: impl Into<String>, params: Vec<Param>) -> Self {
        Self { sql: sql.into(), params, expect_rows: None }
    }
}

/// What a describe reports for one result column.
#[derive(Debug, Clone, Default)]
pub struct DescribedColumn {
    pub origin: Option<ColumnOrigin>,
    pub type_name: String,
}

#[async_trait]
pub trait Canceller: Send + Sync {
    /// Requests cancellation of the statement currently running on the session. Racy by
    /// nature: the statement may complete before the request arrives.
    async fn cancel(&self) -> Result<()>;
}

#[async_trait]
pub trait Session: Send {
    fn dialect(&self) -> Dialect;
    fn capabilities(&self) -> Capabilities;
    fn canceller(&self) -> Arc<dyn Canceller>;

    async fn server_info(&mut self) -> Result<ServerInfo>;
    async fn ping(&mut self) -> Result<()>;
    async fn list_databases(&mut self) -> Result<Vec<String>>;
    async fn list_schemas(&mut self) -> Result<Vec<String>>;
    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>>;
    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure>;
    async fn object_definition(&mut self, schema: &str, name: &str, kind: ObjectKind) -> Result<String>;

    /// Executes one user-authored statement (no bind parameters). Result rows beyond
    /// `max_rows` are not fetched and the row set is marked truncated.
    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>>;

    /// Base-table origin and type name of each column the statement returns, by position,
    /// without running it. Drivers that report these while executing (MySQL, SQLite) or cannot
    /// at all (DuckDB) keep the default.
    async fn describe(&mut self, _sql: &str) -> Result<Vec<DescribedColumn>> {
        Ok(vec![])
    }

    /// Whether the connection is inside a transaction a statement opened earlier. Commits of
    /// grid edits refuse to run then, because their BEGIN/COMMIT would end it.
    async fn in_transaction(&mut self) -> Result<bool> {
        Ok(false)
    }

    /// Runs an application-generated, parameterised query returning rows as text.
    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet>;

    /// Runs generated write statements, inside one transaction when `atomic` is true.
    /// Returns the affected-row count of each statement.
    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>>;

    async fn close(self: Box<Self>);

    /// Starts an explicit transaction spanning several `apply(.., false)` calls.
    async fn begin(&mut self) -> Result<()> {
        let sql = if self.dialect() == Dialect::Mysql { "START TRANSACTION" } else { "BEGIN" };
        self.execute(sql, 1).await.map(|_| ())
    }

    async fn commit(&mut self) -> Result<()> {
        self.execute("COMMIT", 1).await.map(|_| ())
    }

    async fn rollback(&mut self) -> Result<()> {
        self.execute("ROLLBACK", 1).await.map(|_| ())
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConnectOptions {
    /// Connect to this database instead of the profile's default (PostgreSQL/MySQL).
    pub database: Option<String>,
    /// Local port of an SSH tunnel. The driver connects to 127.0.0.1 on this port while
    /// TLS still verifies the profile's real host name.
    pub tunnel_port: Option<u16>,
    /// Open a production connection read-only (the "Open production connections read-only"
    /// setting) unless the user chose to allow writes for this session.
    pub lock_production: bool,
}

pub async fn connect(
    profile: &ConnectionProfile,
    password: Option<&str>,
    options: &ConnectOptions,
) -> Result<Box<dyn Session>> {
    profile.validate()?;
    match profile.driver {
        Driver::Postgres => Ok(Box::new(postgres::PgSession::connect(profile, password, options).await?)),
        Driver::Mysql | Driver::Mariadb => Ok(Box::new(mysql::MySession::connect(profile, password, options).await?)),
        Driver::Sqlite => Ok(Box::new(sqlite::SqliteSession::open(profile).await?)),
        #[cfg(feature = "duckdb")]
        Driver::Duckdb => Ok(Box::new(duckdb::DuckSession::open(profile).await?)),
        #[cfg(not(feature = "duckdb"))]
        Driver::Duckdb => Err(crate::AppError::unsupported("This build does not include DuckDB support")),
        Driver::Redis => Err(crate::AppError::unsupported("Redis connections use the key browser, not SQL sessions")),
    }
}

/// Splits `\x1f`-joined lists produced by the catalog queries.
pub(crate) fn split_list(s: &str) -> Vec<String> {
    if s.is_empty() { Vec::new() } else { s.split('\u{1f}').map(str::to_string).collect() }
}

/// Helper for reading text cells out of catalog queries.
pub(crate) struct TextRow<'a>(pub &'a [crate::model::Cell]);

impl TextRow<'_> {
    pub fn str(&self, i: usize) -> String {
        self.0.get(i).and_then(|c| c.as_text()).unwrap_or_default().to_string()
    }
    pub fn opt(&self, i: usize) -> Option<String> {
        self.0.get(i).and_then(|c| c.as_text()).map(str::to_string)
    }
    pub fn bool(&self, i: usize) -> bool {
        matches!(self.0.get(i).and_then(|c| c.as_text()), Some("t" | "true" | "1" | "YES" | "yes"))
    }
    pub fn i64(&self, i: usize) -> Option<i64> {
        self.0.get(i).and_then(|c| c.as_text()).and_then(|s| s.parse().ok())
    }
}
