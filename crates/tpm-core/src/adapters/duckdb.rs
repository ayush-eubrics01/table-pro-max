//! DuckDB adapter (embedded, file based) built on the `duckdb` crate.
//!
//! DuckDB's SQL follows PostgreSQL conventions closely enough (double-quoted
//! identifiers, `$n` parameters, `::` casts, `IS NOT DISTINCT FROM`, `ILIKE`) that the
//! PostgreSQL dialect is used for generated SQL. Result values are rendered by DuckDB
//! itself: row-returning statements are wrapped as `SELECT COLUMNS(*)::VARCHAR FROM (…)`
//! so every type (decimals, timestamps, lists, structs) is shown in its own text form.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use duckdb::types::ValueRef;
use duckdb::{AccessMode, Config, Connection, InterruptHandle};

use super::{Canceller, ParamStatement, Session, TextRow, split_list};
use crate::config::ConnectionProfile;
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::*;

pub struct DuckSession {
    conn: Arc<Mutex<Connection>>,
    canceller: Arc<DuckCanceller>,
    /// Keeps the shared database instance alive while this session exists.
    _root: Arc<Mutex<Connection>>,
    /// Every statement runs in `BEGIN TRANSACTION READ ONLY`, so DuckDB itself refuses
    /// writes even when the shared instance was opened read-write by another session.
    read_only: bool,
}

/// Runs `f` inside a read-only transaction when `read_only` is set.
fn guarded<T>(c: &Connection, read_only: bool, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    if !read_only {
        return f(c);
    }
    c.execute_batch("BEGIN TRANSACTION READ ONLY").map_err(map_error)?;
    let r = f(c);
    let _ = c.execute_batch("ROLLBACK");
    r
}

struct DuckCanceller(Arc<InterruptHandle>);

#[async_trait]
impl Canceller for DuckCanceller {
    async fn cancel(&self) -> Result<()> {
        self.0.interrupt();
        Ok(())
    }
}

/// Creates a new, empty DuckDB database file. Fails if the file already exists.
pub fn create_database_file(path: &str) -> Result<()> {
    if Path::new(path).exists() {
        return Err(AppError::file(format!("A file already exists at {path}")));
    }
    let conn = Connection::open(path).map_err(map_error)?;
    conn.execute_batch("CHECKPOINT").map_err(map_error)?;
    Ok(())
}

/// DuckDB allows one database instance per file per process. Sessions on the same file
/// share it through `try_clone`; the registry remembers the instance and its mode.
struct OpenDatabase {
    root: std::sync::Weak<Mutex<Connection>>,
    read_only: bool,
}

static REGISTRY: std::sync::LazyLock<Mutex<std::collections::HashMap<std::path::PathBuf, OpenDatabase>>> =
    std::sync::LazyLock::new(Default::default);

fn connect_shared(path: &str, read_only: bool) -> Result<(Connection, Arc<Mutex<Connection>>)> {
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    let mut reg = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(entry) = reg.get(&key)
        && let Some(root) = entry.root.upgrade()
    {
        if entry.read_only && !read_only {
            return Err(AppError::new(
                ErrorKind::File,
                "This DuckDB file is open read-only elsewhere in the app. Close those tabs to open it for writing.",
            ));
        }
        // A read-only request on a read-write instance cannot be enforced by DuckDB
        // (access mode is per database); the backend's read-only policy still applies.
        let conn =
            root.lock().map_err(|_| AppError::internal("DuckDB lock poisoned"))?.try_clone().map_err(map_error)?;
        return Ok((conn, root));
    }
    let mut config = Config::default();
    if read_only {
        config = config.access_mode(AccessMode::ReadOnly).map_err(map_error)?;
    }
    let root_conn = Connection::open_with_flags(path, config).map_err(map_error)?;
    let conn = root_conn.try_clone().map_err(map_error)?;
    let root = Arc::new(Mutex::new(root_conn));
    reg.insert(key, OpenDatabase { root: Arc::downgrade(&root), read_only });
    Ok((conn, root))
}

impl DuckSession {
    pub async fn open(profile: &ConnectionProfile) -> Result<Self> {
        let path = profile.file_path.clone().unwrap_or_default();
        let read_only = profile.read_only();
        let (conn, root) = tokio::task::spawn_blocking(move || -> Result<(Connection, Arc<Mutex<Connection>>)> {
            if path != ":memory:" && !Path::new(&path).is_file() {
                return Err(AppError::new(ErrorKind::File, format!("Database file not found: {path}")));
            }
            connect_shared(&path, read_only)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
        let canceller = Arc::new(DuckCanceller(conn.interrupt_handle()));
        Ok(Self { conn: Arc::new(Mutex::new(conn)), canceller, _root: root, read_only: profile.read_only() })
    }

    async fn with_conn<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().map_err(|_| AppError::internal("DuckDB connection lock poisoned"))?;
            f(&mut guard)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }

    async fn rows(&self, sql: String, params: Vec<Param>) -> Result<Vec<Row>> {
        self.with_conn(move |c| Ok(run(c, &sql, &params, usize::MAX)?.rows)).await
    }
}

/// Formats a value DuckDB did not render itself (fallback path only).
fn cell(v: ValueRef<'_>) -> Cell {
    match v {
        ValueRef::Null => Cell::Null,
        ValueRef::Boolean(b) => Cell::Text(b.to_string()),
        ValueRef::TinyInt(n) => Cell::Text(n.to_string()),
        ValueRef::SmallInt(n) => Cell::Text(n.to_string()),
        ValueRef::Int(n) => Cell::Text(n.to_string()),
        ValueRef::BigInt(n) => Cell::Text(n.to_string()),
        ValueRef::HugeInt(n) => Cell::Text(n.to_string()),
        ValueRef::UTinyInt(n) => Cell::Text(n.to_string()),
        ValueRef::USmallInt(n) => Cell::Text(n.to_string()),
        ValueRef::UInt(n) => Cell::Text(n.to_string()),
        ValueRef::UBigInt(n) => Cell::Text(n.to_string()),
        ValueRef::Float(f) => Cell::Text(f.to_string()),
        ValueRef::Double(f) => Cell::Text(f.to_string()),
        ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Cell::Bytes(b.to_vec()),
        other => Cell::Text(format!("{:?}", other.to_owned())),
    }
}

fn run(conn: &Connection, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
    let mut stmt = conn.prepare(sql).map_err(map_error)?;
    run_prepared(&mut stmt, params, max_rows)
}

fn run_prepared(stmt: &mut duckdb::Statement<'_>, params: &[Param], max_rows: usize) -> Result<RowSet> {
    let mut rows = stmt.query(duckdb::params_from_iter(params.iter())).map_err(map_error)?;
    let (columns, n) = {
        let st = rows.as_ref().ok_or_else(|| AppError::internal("DuckDB statement unavailable"))?;
        let n = st.column_count();
        let cols = (0..n)
            .map(|i| {
                ColumnMeta::new(st.column_name(i).map(|s| s.as_str()).unwrap_or(""), format!("{:?}", st.column_type(i)))
            })
            .collect();
        (cols, n)
    };
    let mut rs = RowSet { columns, ..Default::default() };
    while let Some(row) = rows.next().map_err(map_error)? {
        if rs.rows.len() >= max_rows {
            rs.truncated = true;
            break;
        }
        rs.rows.push((0..n).map(|i| row.get_ref(i).map(cell).unwrap_or(Cell::Null)).collect());
    }
    Ok(rs)
}

/// Column types of a query, from binding only (`DESCRIBE` does not execute it).
fn describe_types(conn: &Connection, sql: &str) -> Option<Vec<String>> {
    let rs = run(conn, &format!("DESCRIBE {sql}"), &[], 10_000).ok()?;
    Some(rs.rows.iter().map(|r| TextRow(r).str(1)).collect())
}

/// Statements that produce rows and can be wrapped in a subquery for text rendering.
fn wrappable(sql: &str) -> bool {
    let head = sql.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase();
    matches!(
        head.as_str(),
        "SELECT" | "WITH" | "VALUES" | "FROM" | "TABLE" | "SUMMARIZE" | "DESCRIBE" | "SHOW" | "PIVOT" | "UNPIVOT"
    )
}

#[async_trait]
impl Session for DuckSession {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            multiple_databases: false,
            schemas: true,
            cancel: CancelSupport::Interrupt,
            transactions: true,
            transactional_ddl: true,
            explain: false,
            explain_analyze: false,
            materialized_views: false,
            routines: false,
            sequences: true,
        }
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let rows = self.rows("SELECT version()::VARCHAR, current_database()::VARCHAR".into(), vec![]).await?;
        let r = TextRow(&rows[0]);
        Ok(ServerInfo {
            product: "DuckDB".into(),
            version: r.str(0),
            current_database: r.str(1),
            current_user: String::new(),
        })
    }

    async fn ping(&mut self) -> Result<()> {
        self.rows("SELECT 1".into(), vec![]).await.map(|_| ())
    }

    async fn list_databases(&mut self) -> Result<Vec<String>> {
        let rows = self.rows("SELECT current_database()::VARCHAR".into(), vec![]).await?;
        Ok(rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_schemas(&mut self) -> Result<Vec<String>> {
        let rows = self
            .rows(
                "SELECT schema_name::VARCHAR FROM duckdb_schemas() WHERE database_name = current_database() \
                 AND NOT internal ORDER BY schema_name <> 'main', schema_name"
                    .into(),
                vec![],
            )
            .await?;
        let mut out: Vec<String> = rows.iter().map(|r| TextRow(r).str(0)).collect();
        if !out.iter().any(|s| s == "main") {
            out.insert(0, "main".into());
        }
        Ok(out)
    }

    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>> {
        let rows = self
            .rows(
                "SELECT table_name::VARCHAR, 'table', comment::VARCHAR, estimated_size::VARCHAR FROM duckdb_tables() \
                   WHERE database_name = current_database() AND schema_name = $1 \
                 UNION ALL SELECT view_name::VARCHAR, 'view', comment::VARCHAR, NULL FROM duckdb_views() \
                   WHERE database_name = current_database() AND schema_name = $1 AND NOT internal \
                 UNION ALL SELECT sequence_name::VARCHAR, 'sequence', NULL, NULL FROM duckdb_sequences() \
                   WHERE database_name = current_database() AND schema_name = $1 \
                 ORDER BY 1"
                    .into(),
                vec![Some(schema.into())],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let kind = match r.str(1).as_str() {
                    "view" => ObjectKind::View,
                    "sequence" => ObjectKind::Sequence,
                    _ => ObjectKind::Table,
                };
                DbObject { schema: schema.into(), name: r.str(0), kind, comment: r.opt(2), estimated_rows: r.i64(3) }
            })
            .collect())
    }

    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure> {
        let sp = || vec![Some(schema.to_string()), Some(name.to_string())];
        let kind_rows = self
            .rows(
                "SELECT 'table' FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2 \
                 UNION ALL SELECT 'view' FROM duckdb_views() WHERE database_name = current_database() AND schema_name = $1 AND view_name = $2"
                    .into(),
                sp(),
            )
            .await?;
        let kind = match kind_rows.first().map(|r| TextRow(r).str(0)) {
            None => return Err(AppError::not_found(format!("Table {schema}.{name} was not found"))),
            Some(k) if k == "view" => ObjectKind::View,
            Some(_) => ObjectKind::Table,
        };
        let constraints_rows = self
            .rows(
                "SELECT constraint_type::VARCHAR, array_to_string(constraint_column_names, chr(31)), \
                        coalesce(constraint_text, '')::VARCHAR, \
                        coalesce(referenced_table, '')::VARCHAR, \
                        coalesce(array_to_string(referenced_column_names, chr(31)), '') \
                 FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2"
                    .into(),
                sp(),
            )
            .await
            .unwrap_or_default();
        let pk: Vec<String> = constraints_rows
            .iter()
            .map(|r| TextRow(r))
            .find(|r| r.str(0) == "PRIMARY KEY")
            .map(|r| split_list(&r.str(1)))
            .unwrap_or_default();
        let columns = self
            .rows(
                "SELECT column_name::VARCHAR, data_type::VARCHAR, is_nullable::VARCHAR, column_default::VARCHAR, comment::VARCHAR \
                 FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2 \
                 ORDER BY column_index"
                    .into(),
                sp(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let name = r.str(0);
                let default = r.opt(3);
                ColumnInfo {
                    primary_key: pk.iter().position(|p| *p == name).map(|i| i as u32 + 1),
                    auto_increment: default.as_deref().is_some_and(|d| d.starts_with("nextval(")),
                    nullable: r.bool(2),
                    data_type: r.str(1),
                    default,
                    comment: r.opt(4),
                    name,
                }
            })
            .collect();
        let indexes = self
            .rows(
                "SELECT index_name::VARCHAR, expressions::VARCHAR, is_unique::VARCHAR, is_primary::VARCHAR, sql::VARCHAR \
                 FROM duckdb_indexes() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2"
                    .into(),
                sp(),
            )
            .await
            .unwrap_or_default()
            .iter()
            .map(|r| {
                let r = TextRow(r);
                IndexInfo {
                    name: r.str(0),
                    columns: vec![r.str(1).trim_matches(|c| c == '[' || c == ']').to_string()],
                    unique: r.bool(2),
                    primary: r.bool(3),
                    definition: r.opt(4),
                }
            })
            .collect();
        let mut foreign_keys = Vec::new();
        let mut constraints = Vec::new();
        for r in &constraints_rows {
            let r = TextRow(r);
            let ty = r.str(0);
            if ty == "FOREIGN KEY" {
                foreign_keys.push(ForeignKeyInfo {
                    name: format!("fk_{name}_{}", r.str(1).replace('\u{1f}', "_")),
                    columns: split_list(&r.str(1)),
                    ref_schema: schema.into(),
                    ref_table: r.str(3),
                    ref_columns: split_list(&r.str(4)),
                    on_update: "NO ACTION".into(),
                    on_delete: "NO ACTION".into(),
                });
            } else if ty != "NOT NULL" {
                constraints.push(ConstraintInfo {
                    name: format!("{} ({})", ty.to_ascii_lowercase(), r.str(1).replace('\u{1f}', ", ")),
                    kind: ty.to_ascii_lowercase().replace(' ', "_"),
                    definition: r.str(2),
                });
            }
        }
        Ok(TableStructure {
            schema: schema.into(),
            name: name.into(),
            kind,
            columns,
            indexes,
            foreign_keys,
            constraints,
            triggers: Vec::new(),
        })
    }

    async fn object_definition(&mut self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        let sql = match kind {
            ObjectKind::View => {
                "SELECT sql::VARCHAR FROM duckdb_views() WHERE database_name = current_database() AND schema_name = $1 AND view_name = $2"
            }
            ObjectKind::Sequence => {
                "SELECT sql::VARCHAR FROM duckdb_sequences() WHERE database_name = current_database() AND schema_name = $1 AND sequence_name = $2"
            }
            _ => {
                "SELECT sql::VARCHAR FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2"
            }
        };
        let rows = self.rows(sql.into(), vec![Some(schema.into()), Some(name.into())]).await?;
        rows.first().and_then(|r| TextRow(r).opt(0)).ok_or_else(|| AppError::not_found(format!("{name} was not found")))
    }

    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        let sql = sql.trim().trim_end_matches(';').to_string();
        let read_only = self.read_only;
        self.with_conn(move |c| {
            guarded(c, read_only, |c| {
                if wrappable(&sql) {
                    // Let DuckDB render every value as text. Fall back to the plain statement only
                    // when the wrapper does not prepare; once it runs, its result (or error, e.g.
                    // an interrupt) is final so a statement never executes twice.
                    let wrapped = format!("SELECT COLUMNS(*)::VARCHAR FROM ({sql})");
                    if let Ok(mut stmt) = c.prepare(&wrapped) {
                        let mut rows = run_prepared(&mut stmt, &[], max_rows)?;
                        drop(stmt);
                        if let Some(types) = describe_types(c, &sql) {
                            for (col, ty) in rows.columns.iter_mut().zip(types) {
                                col.type_name = ty;
                            }
                        }
                        return Ok(vec![StatementOutcome::Rows { rows }]);
                    }
                }
                let rows = run(c, &sql, &[], max_rows)?;
                // DDL returns no columns; DML returns a single "Count" column.
                if rows.columns.is_empty() {
                    return Ok(vec![StatementOutcome::Affected { rows_affected: 0 }]);
                }
                if rows.columns.len() == 1 && rows.columns[0].name == "Count" && rows.rows.len() == 1 {
                    let n = rows.rows[0][0].as_text().and_then(|t| t.parse().ok()).unwrap_or(0);
                    return Ok(vec![StatementOutcome::Affected { rows_affected: n }]);
                }
                Ok(vec![StatementOutcome::Rows { rows }])
            })
        })
        .await
    }

    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
        let sql = sql.to_string();
        let params = params.to_vec();
        let read_only = self.read_only;
        self.with_conn(move |c| guarded(c, read_only, |c| run(c, &sql, &params, max_rows))).await
    }

    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>> {
        if self.read_only {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        let statements = statements.to_vec();
        self.with_conn(move |c| {
            if atomic {
                c.execute_batch("BEGIN TRANSACTION").map_err(map_error)?;
            }
            let mut counts = Vec::with_capacity(statements.len());
            for st in &statements {
                let result = c.execute(&st.sql, duckdb::params_from_iter(st.params.iter())).map_err(map_error);
                let failure = match result {
                    Ok(n) => match st.expect_rows {
                        Some(expected) if expected != n as u64 => {
                            Some(super::postgres::conflict_error(expected, n as u64))
                        }
                        _ => {
                            counts.push(n as u64);
                            None
                        }
                    },
                    Err(e) => Some(e),
                };
                if let Some(err) = failure {
                    if atomic {
                        let _ = c.execute_batch("ROLLBACK");
                    }
                    return Err(err.add_context(format!(
                        "Statement {} of {}: {}",
                        counts.len() + 1,
                        statements.len(),
                        st.sql
                    )));
                }
            }
            if atomic {
                c.execute_batch("COMMIT").map_err(map_error)?;
            }
            Ok(counts)
        })
        .await
    }

    async fn close(self: Box<Self>) {}

    async fn begin(&mut self) -> Result<()> {
        self.with_conn(|c| c.execute_batch("BEGIN TRANSACTION").map_err(map_error)).await
    }

    async fn commit(&mut self) -> Result<()> {
        self.with_conn(|c| c.execute_batch("COMMIT").map_err(map_error)).await
    }

    async fn rollback(&mut self) -> Result<()> {
        self.with_conn(|c| c.execute_batch("ROLLBACK").map_err(map_error)).await
    }
}

pub(crate) fn map_error(e: duckdb::Error) -> AppError {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    let kind = if lower.contains("interrupt") {
        ErrorKind::Cancelled
    } else if lower.contains("constraint") || lower.contains("duplicate key") {
        ErrorKind::Constraint
    } else if lower.contains("read-only") || lower.contains("read only") {
        ErrorKind::PolicyViolation
    } else if lower.contains("could not open") || lower.contains("cannot open") || lower.contains("io error") {
        ErrorKind::File
    } else {
        ErrorKind::Database
    };
    AppError::new(kind, msg)
}
