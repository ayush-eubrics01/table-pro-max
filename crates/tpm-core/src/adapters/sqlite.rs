//! SQLite adapter built on `rusqlite` (bundled SQLite).
//!
//! rusqlite is synchronous, so every call runs on the blocking thread pool. The
//! connection sits behind a `std::sync::Mutex`; cancellation uses `sqlite3_interrupt`
//! through an `InterruptHandle`, which is safe to call from another thread.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};

use super::{Canceller, ParamStatement, Session, TextRow};
use crate::config::ConnectionProfile;
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::*;

pub struct SqliteSession {
    conn: Arc<Mutex<Connection>>,
    canceller: Arc<SqliteCanceller>,
}

struct SqliteCanceller(InterruptHandle);

#[async_trait]
impl Canceller for SqliteCanceller {
    async fn cancel(&self) -> Result<()> {
        self.0.interrupt();
        Ok(())
    }
}

impl SqliteSession {
    /// Opens an existing database file. Never creates a file implicitly; use
    /// [`create_database_file`] for that.
    pub async fn open(profile: &ConnectionProfile) -> Result<Self> {
        let path = profile.file_path.clone().unwrap_or_default();
        let read_only = profile.read_only();
        let conn = tokio::task::spawn_blocking(move || -> Result<Connection> {
            if path != ":memory:" && !Path::new(&path).is_file() {
                return Err(AppError::new(ErrorKind::File, format!("Database file not found: {path}")));
            }
            let flags = if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX
            };
            let conn = Connection::open_with_flags(&path, flags).map_err(map_error)?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(map_error)?;
            if read_only {
                conn.pragma_update(None, "query_only", "ON").map_err(map_error)?;
            }
            // Fail fast if the file is not a SQLite database.
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).map_err(map_error)?;
            Ok(conn)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
        let canceller = Arc::new(SqliteCanceller(conn.get_interrupt_handle()));
        Ok(Self { conn: Arc::new(Mutex::new(conn)), canceller })
    }

    async fn with_conn<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().map_err(|_| AppError::internal("SQLite connection lock poisoned"))?;
            f(&mut guard)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }

    async fn rows(&self, sql: &'static str, params: Vec<Param>) -> Result<Vec<Row>> {
        self.with_conn(move |c| Ok(run_query(c, sql, &params, usize::MAX)?.rows)).await
    }
}

/// Creates a new, empty SQLite database file. Fails if the file already exists.
pub fn create_database_file(path: &str) -> Result<()> {
    if Path::new(path).exists() {
        return Err(AppError::file(format!("A file already exists at {path}")));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
        .map_err(map_error)?;
    // Force the header to be written so the file is a valid database immediately.
    conn.execute_batch("PRAGMA user_version = 0; VACUUM;").map_err(map_error)?;
    Ok(())
}

fn cell(v: ValueRef<'_>) -> Cell {
    match v {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Text(i.to_string()),
        ValueRef::Real(f) => Cell::Text(f.to_string()),
        ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Cell::Bytes(b.to_vec()),
    }
}

fn run_query(conn: &Connection, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
    let mut stmt = conn.prepare(sql).map_err(map_error)?;
    let columns: Vec<ColumnMeta> =
        stmt.columns().iter().map(|c| ColumnMeta::new(c.name(), c.decl_type().unwrap_or(""))).collect();
    let n = columns.len();
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter())).map_err(map_error)?;
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

#[async_trait]
impl Session for SqliteSession {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            multiple_databases: false,
            schemas: true,
            cancel: CancelSupport::Interrupt,
            transactions: true,
            transactional_ddl: true,
            explain: true,
            explain_analyze: false,
            materialized_views: false,
            routines: false,
            sequences: false,
        }
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        Ok(ServerInfo {
            product: "SQLite".into(),
            version: rusqlite::version().to_string(),
            current_database: "main".into(),
            current_user: String::new(),
        })
    }

    async fn ping(&mut self) -> Result<()> {
        self.with_conn(|c| c.query_row("SELECT 1", [], |_| Ok(())).map_err(map_error)).await
    }

    async fn list_databases(&mut self) -> Result<Vec<String>> {
        self.list_schemas().await
    }

    async fn list_schemas(&mut self) -> Result<Vec<String>> {
        let rows = self.rows("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq", vec![]).await?;
        Ok(rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>> {
        let master = format!("{}.sqlite_master", Dialect::Sqlite.quote_ident(schema)?);
        let schema_owned = schema.to_string();
        self.with_conn(move |c| {
            let sql = format!(
                "SELECT name, type FROM {master} WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
            );
            let rs = run_query(c, &sql, &[], usize::MAX)?;
            Ok(rs
                .rows
                .iter()
                .map(|r| {
                    let r = TextRow(r);
                    DbObject {
                        schema: schema_owned.clone(),
                        name: r.str(0),
                        kind: if r.str(1) == "view" { ObjectKind::View } else { ObjectKind::Table },
                        comment: None,
                        estimated_rows: None,
                    }
                })
                .collect())
        })
        .await
    }

    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure> {
        let schema = schema.to_string();
        let name = name.to_string();
        let master = format!("{}.sqlite_master", Dialect::Sqlite.quote_ident(&schema)?);
        self.with_conn(move |c| {
            let p = |v: &str| Some(v.to_string());
            let kind_rs = run_query(c, &format!("SELECT type, sql FROM {master} WHERE name = ?1"), &[p(&name)], 1)?;
            let kind_row = kind_rs.rows.first().ok_or_else(|| AppError::not_found(format!("Table {name} was not found")))?;
            let kind = if TextRow(kind_row).str(0) == "view" { ObjectKind::View } else { ObjectKind::Table };
            let create_sql = TextRow(kind_row).str(1);

            let cols = run_query(
                c,
                "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1, ?2) WHERE hidden IN (0, 2, 3)",
                &[p(&name), p(&schema)],
                usize::MAX,
            )?;
            let pk_count = cols.rows.iter().filter(|r| TextRow(r).i64(4).unwrap_or(0) > 0).count();
            let columns: Vec<ColumnInfo> = cols
                .rows
                .iter()
                .map(|r| {
                    let r = TextRow(r);
                    let pk = r.i64(4).filter(|&n| n > 0).map(|n| n as u32);
                    let ty = r.str(1);
                    ColumnInfo {
                        name: r.str(0),
                        // INTEGER PRIMARY KEY aliases the rowid and auto-assigns values.
                        auto_increment: pk.is_some() && pk_count == 1 && ty.eq_ignore_ascii_case("INTEGER"),
                        data_type: ty,
                        nullable: r.str(2) == "0" && pk.is_none(),
                        default: r.opt(3),
                        primary_key: pk,
                        comment: None,
                    }
                })
                .collect();

            let mut indexes = Vec::new();
            let idx = run_query(
                c,
                "SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2) ORDER BY origin = 'pk' DESC, name",
                &[p(&name), p(&schema)],
                usize::MAX,
            )?;
            for r in &idx.rows {
                let r = TextRow(r);
                let idx_name = r.str(0);
                let cols = run_query(
                    c,
                    "SELECT coalesce(name, '(expression)') FROM pragma_index_info(?1, ?2) ORDER BY seqno",
                    &[p(&idx_name), p(&schema)],
                    usize::MAX,
                )?;
                let def = run_query(c, &format!("SELECT sql FROM {master} WHERE type = 'index' AND name = ?1"), &[p(&idx_name)], 1)?;
                indexes.push(IndexInfo {
                    columns: cols.rows.iter().map(|r| TextRow(r).str(0)).collect(),
                    unique: r.str(1) == "1",
                    primary: r.str(2) == "pk",
                    definition: def.rows.first().and_then(|r| TextRow(r).opt(0)),
                    name: idx_name,
                });
            }
            // A rowid-alias primary key has no index entry; synthesise one for display.
            if !indexes.iter().any(|i| i.primary) && pk_count > 0 {
                let mut pk: Vec<&ColumnInfo> = columns.iter().filter(|c| c.primary_key.is_some()).collect();
                pk.sort_by_key(|c| c.primary_key);
                indexes.insert(
                    0,
                    IndexInfo {
                        name: "PRIMARY KEY".into(),
                        columns: pk.iter().map(|c| c.name.clone()).collect(),
                        unique: true,
                        primary: true,
                        definition: None,
                    },
                );
            }

            let fk_rows = run_query(
                c,
                "SELECT id, \"from\", \"table\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
                &[p(&name), p(&schema)],
                usize::MAX,
            )?;
            let mut foreign_keys: Vec<(String, ForeignKeyInfo)> = Vec::new();
            for r in &fk_rows.rows {
                let r = TextRow(r);
                let id = r.str(0);
                match foreign_keys.iter_mut().find(|(i, _)| *i == id) {
                    Some((_, fk)) => {
                        fk.columns.push(r.str(1));
                        fk.ref_columns.push(r.opt(3).unwrap_or_default());
                    }
                    None => foreign_keys.push((
                        id.clone(),
                        ForeignKeyInfo {
                            name: format!("fk_{name}_{id}"),
                            columns: vec![r.str(1)],
                            ref_schema: schema.clone(),
                            ref_table: r.str(2),
                            ref_columns: vec![r.opt(3).unwrap_or_default()],
                            on_update: r.str(4),
                            on_delete: r.str(5),
                        },
                    )),
                }
            }

            let triggers = run_query(
                c,
                &format!("SELECT name, sql FROM {master} WHERE type = 'trigger' AND tbl_name = ?1 ORDER BY name"),
                &[p(&name)],
                usize::MAX,
            )?
            .rows
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let def = r.str(1);
                let upper = def.to_ascii_uppercase();
                let timing = ["INSTEAD OF", "BEFORE", "AFTER"].iter().find(|t| upper.contains(*t)).map_or("", |t| t);
                let event = ["INSERT", "UPDATE", "DELETE"].iter().find(|e| upper.contains(&format!(" {e}"))).map_or("", |e| e);
                TriggerInfo { name: r.str(0), timing: timing.into(), event: event.into(), definition: def }
            })
            .collect();

            let constraints = if create_sql.to_ascii_uppercase().contains("CHECK") {
                vec![ConstraintInfo { name: "(table definition)".into(), kind: "check".into(), definition: create_sql }]
            } else {
                Vec::new()
            };

            Ok(TableStructure {
                schema,
                name,
                kind,
                columns,
                indexes,
                foreign_keys: foreign_keys.into_iter().map(|(_, f)| f).collect(),
                constraints,
                triggers,
            })
        })
        .await
    }

    async fn object_definition(&mut self, schema: &str, name: &str, _kind: ObjectKind) -> Result<String> {
        let master = format!("{}.sqlite_master", Dialect::Sqlite.quote_ident(schema)?);
        let name = name.to_string();
        self.with_conn(move |c| {
            let rs = run_query(
                c,
                &format!("SELECT sql FROM {master} WHERE (name = ?1 OR tbl_name = ?1) AND sql IS NOT NULL ORDER BY type = 'table' DESC, type = 'view' DESC, name"),
                &[Some(name.clone())],
                usize::MAX,
            )?;
            if rs.rows.is_empty() {
                return Err(AppError::not_found(format!("{name} was not found")));
            }
            Ok(rs.rows.iter().map(|r| format!("{};", TextRow(r).str(0))).collect::<Vec<_>>().join("\n\n"))
        })
        .await
    }

    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let mut stmt = c.prepare(&sql).map_err(map_error)?;
            if stmt.column_count() == 0 {
                let n = stmt.raw_execute().map_err(map_error)?;
                return Ok(vec![StatementOutcome::Affected { rows_affected: n as u64 }]);
            }
            drop(stmt);
            let rows = run_query(c, &sql, &[], max_rows)?;
            Ok(vec![StatementOutcome::Rows { rows }])
        })
        .await
    }

    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
        let sql = sql.to_string();
        let params = params.to_vec();
        self.with_conn(move |c| run_query(c, &sql, &params, max_rows)).await
    }

    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>> {
        let statements = statements.to_vec();
        self.with_conn(move |c| {
            if atomic {
                c.execute_batch("BEGIN").map_err(map_error)?;
            }
            let mut counts = Vec::with_capacity(statements.len());
            for st in &statements {
                let result = c.execute(&st.sql, rusqlite::params_from_iter(st.params.iter())).map_err(map_error);
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
}

pub(crate) fn map_error(e: rusqlite::Error) -> AppError {
    use rusqlite::ffi::ErrorCode;
    match &e {
        rusqlite::Error::SqliteFailure(f, msg) => {
            let text = msg.clone().unwrap_or_else(|| e.to_string());
            let kind = match f.code {
                ErrorCode::ConstraintViolation => ErrorKind::Constraint,
                ErrorCode::OperationInterrupted => ErrorKind::Cancelled,
                ErrorCode::ReadOnly => ErrorKind::PolicyViolation,
                ErrorCode::CannotOpen | ErrorCode::NotADatabase | ErrorCode::PermissionDenied => ErrorKind::File,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => ErrorKind::Timeout,
                _ => ErrorKind::Database,
            };
            AppError::new(kind, text).with_code(format!("{}", f.extended_code))
        }
        rusqlite::Error::SqlInputError { msg, offset, .. } => {
            AppError::new(ErrorKind::Database, msg).with_position(u32::try_from(*offset + 1).ok())
        }
        _ => AppError::new(ErrorKind::Database, e.to_string()),
    }
}
