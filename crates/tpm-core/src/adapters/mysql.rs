//! MySQL and MariaDB adapter built on `mysql_async`.
//!
//! * User SQL runs over the text protocol (`query_iter`), so values arrive as the
//!   server formats them and multiple result sets (e.g. from `CALL`) are supported.
//! * Generated queries use server-side prepared statements with bind parameters.
//! * Cancellation issues `KILL QUERY <id>` from a short-lived second connection.
//!
//! In MySQL a "schema" and a "database" are the same thing; schemas are listed as the
//! namespace level and `multiple_databases` is reported as false.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::Queryable;
use mysql_async::{Column, Conn, DriverError, Opts, OptsBuilder, SslOpts, Value};

use super::{Canceller, ConnectOptions, ParamStatement, Session, TextRow};
use crate::config::{ConnectionProfile, Driver, TlsMode};
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::*;

/// MySQL's binary collation/charset id: marks string columns that hold raw bytes.
const BINARY_CHARSET: u16 = 63;

pub struct MySession {
    conn: Conn,
    canceller: Arc<MyCanceller>,
    mariadb: bool,
}

struct MyCanceller {
    opts: Opts,
    connection_id: u32,
}

#[async_trait]
impl Canceller for MyCanceller {
    async fn cancel(&self) -> Result<()> {
        let mut conn = Conn::new(self.opts.clone()).await.map_err(map_error)?;
        let result = conn.query_drop(format!("KILL QUERY {}", self.connection_id)).await.map_err(map_error);
        let _ = conn.disconnect().await;
        result
    }
}

impl MySession {
    pub async fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        options: &ConnectOptions,
    ) -> Result<Self> {
        let database = options.database.as_deref().unwrap_or(&profile.database);
        let mut init = Vec::new();
        if profile.read_only() {
            // Enforced by the server; the safety policy blocks attempts to switch it back.
            init.push("SET SESSION TRANSACTION READ ONLY".to_string());
        }
        let (host, port) = match options.tunnel_port {
            Some(p) => ("127.0.0.1".to_string(), p),
            None => (profile.host.clone(), profile.port_or_default()),
        };
        let base = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .user(Some(profile.user.clone()).filter(|u| !u.is_empty()))
            .pass(password.map(str::to_string))
            .db_name(Some(database.to_string()).filter(|d| !d.is_empty()))
            .prefer_socket(false)
            .tcp_keepalive((profile.keepalive_secs > 0).then(|| Duration::from_secs(profile.keepalive_secs)))
            .init(init);

        let timeout = Duration::from_secs(profile.connect_timeout_secs);
        let conn = match profile.tls.mode {
            TlsMode::Disable => connect_with(base.clone().ssl_opts(None), timeout).await?,
            TlsMode::Prefer => match connect_with(base.clone().ssl_opts(ssl_opts(profile, options)), timeout).await {
                Err(e) if e.code.as_deref() == Some("no_tls") => {
                    connect_with(base.clone().ssl_opts(None), timeout).await?
                }
                other => other?,
            },
            TlsMode::Require | TlsMode::RequireInsecure => {
                connect_with(base.clone().ssl_opts(ssl_opts(profile, options)), timeout).await?
            }
        };
        let opts: Opts = conn.opts().clone();
        let canceller = Arc::new(MyCanceller { opts, connection_id: conn.id() });
        let mut session = Self { conn, canceller, mariadb: profile.driver == Driver::Mariadb };
        let info = session.server_info().await?;
        session.mariadb = info.product == "MariaDB";
        Ok(session)
    }

    async fn rows(&mut self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        let params: Vec<Value> = params.iter().map(to_value).collect();
        let mut result = self.conn.exec_iter(sql, params).await.map_err(map_error)?;
        let columns = result.columns().unwrap_or_else(|| Arc::from(Vec::<Column>::new()));
        let mut out = Vec::new();
        while let Some(row) = result.next().await.map_err(map_error)? {
            out.push(binary_row(row, &columns));
        }
        drop(result);
        Ok(out)
    }
}

fn ssl_opts(profile: &ConnectionProfile, options: &ConnectOptions) -> SslOpts {
    let mut ssl = SslOpts::default();
    if options.tunnel_port.is_some() {
        // Through a tunnel we connect to 127.0.0.1; verify the certificate for the real host.
        ssl = ssl.with_danger_tls_hostname_override(Some(profile.host.clone()));
    }
    if let Some(ca) = profile.tls.ca_cert_path.as_deref().filter(|p| !p.trim().is_empty()) {
        ssl = ssl.with_root_certs(vec![std::path::PathBuf::from(ca).into()]);
    }
    if profile.tls.mode == TlsMode::RequireInsecure {
        ssl = ssl.with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true);
    }
    ssl
}

async fn connect_with(opts: OptsBuilder, timeout: Duration) -> Result<Conn> {
    match tokio::time::timeout(timeout, Conn::new(opts)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer))) => {
            Err(AppError::new(ErrorKind::Tls, "The server does not support TLS").with_code("no_tls"))
        }
        Ok(Err(e)) => Err(map_error(e)),
        Err(_) => Err(AppError::new(ErrorKind::Network, format!("Connection timed out after {}s", timeout.as_secs()))),
    }
}

fn to_value(p: &Param) -> Value {
    match p {
        Some(s) => Value::Bytes(s.as_bytes().to_vec()),
        None => Value::NULL,
    }
}

fn is_binary_column(c: &Column) -> bool {
    c.character_set() == BINARY_CHARSET
        && matches!(
            c.column_type(),
            ColumnType::MYSQL_TYPE_STRING
                | ColumnType::MYSQL_TYPE_VAR_STRING
                | ColumnType::MYSQL_TYPE_VARCHAR
                | ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_TINY_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_BIT
                | ColumnType::MYSQL_TYPE_GEOMETRY
        )
}

fn type_name(c: &Column) -> String {
    let t = format!("{:?}", c.column_type());
    let t = t.trim_start_matches("MYSQL_TYPE_");
    if is_binary_column(c) && !t.contains("BLOB") && t != "BIT" && t != "GEOMETRY" {
        "BINARY".into()
    } else {
        t.replace("VAR_STRING", "VARCHAR").replace("NEWDECIMAL", "DECIMAL").replace("LONGLONG", "BIGINT")
    }
}

fn columns_meta(cols: &[Column]) -> Vec<ColumnMeta> {
    cols.iter().map(|c| ColumnMeta::new(c.name_str(), type_name(c))).collect()
}

/// Converts a text-protocol row (all values arrive as bytes).
fn text_row(row: mysql_async::Row, cols: &[Column]) -> Row {
    row.unwrap_raw()
        .into_iter()
        .enumerate()
        .map(|(i, v)| match v {
            None | Some(Value::NULL) => Cell::Null,
            Some(Value::Bytes(b)) => {
                if cols.get(i).is_some_and(is_binary_column) {
                    Cell::Bytes(b)
                } else {
                    Cell::Text(String::from_utf8_lossy(&b).into_owned())
                }
            }
            Some(other) => value_to_cell(other, cols.get(i)),
        })
        .collect()
}

/// Converts a binary-protocol row (values are typed).
fn binary_row(row: mysql_async::Row, cols: &[Column]) -> Row {
    row.unwrap_raw()
        .into_iter()
        .enumerate()
        .map(|(i, v)| value_to_cell(v.unwrap_or(Value::NULL), cols.get(i)))
        .collect()
}

fn value_to_cell(v: Value, col: Option<&Column>) -> Cell {
    match v {
        Value::NULL => Cell::Null,
        Value::Bytes(b) => {
            if col.is_some_and(is_binary_column) {
                Cell::Bytes(b)
            } else {
                Cell::Text(String::from_utf8_lossy(&b).into_owned())
            }
        }
        Value::Int(n) => Cell::Text(n.to_string()),
        Value::UInt(n) => Cell::Text(n.to_string()),
        Value::Float(f) => Cell::Text(f.to_string()),
        Value::Double(f) => Cell::Text(f.to_string()),
        Value::Date(y, m, d, h, mi, s, us) => {
            let date_only = col.is_some_and(|c| {
                matches!(c.column_type(), ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE)
            });
            if date_only {
                Cell::Text(format!("{y:04}-{m:02}-{d:02}"))
            } else if us > 0 {
                Cell::Text(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"))
            } else {
                Cell::Text(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            }
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let hours = days * 24 + h as u32;
            let sign = if neg { "-" } else { "" };
            if us > 0 {
                Cell::Text(format!("{sign}{hours:02}:{mi:02}:{s:02}.{us:06}"))
            } else {
                Cell::Text(format!("{sign}{hours:02}:{mi:02}:{s:02}"))
            }
        }
    }
}

#[async_trait]
impl Session for MySession {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            multiple_databases: false,
            schemas: true,
            cancel: CancelSupport::KillQuery,
            transactions: true,
            transactional_ddl: false,
            explain: true,
            explain_analyze: !self.mariadb,
            materialized_views: false,
            routines: true,
            sequences: self.mariadb,
        }
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let rows = self.rows("SELECT VERSION(), DATABASE(), CURRENT_USER()", &[]).await?;
        let r = TextRow(&rows[0]);
        let version = r.str(0);
        Ok(ServerInfo {
            product: if version.to_ascii_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" }.into(),
            version,
            current_database: r.str(1),
            current_user: r.str(2),
        })
    }

    async fn ping(&mut self) -> Result<()> {
        self.conn.ping().await.map_err(map_error)
    }

    async fn list_databases(&mut self) -> Result<Vec<String>> {
        self.list_schemas().await
    }

    async fn list_schemas(&mut self) -> Result<Vec<String>> {
        let rows = self
            .rows(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY \
                 SCHEMA_NAME IN ('mysql','information_schema','performance_schema','sys'), SCHEMA_NAME",
                &[],
            )
            .await?;
        Ok(rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>> {
        let mut out: Vec<DbObject> = self
            .rows(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                &[Some(schema.into())],
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let kind = match r.str(1).as_str() {
                    "VIEW" | "SYSTEM VIEW" => ObjectKind::View,
                    "SEQUENCE" => ObjectKind::Sequence,
                    _ => ObjectKind::Table,
                };
                DbObject {
                    schema: schema.into(),
                    name: r.str(0),
                    kind,
                    comment: r.opt(2).filter(|c| !c.is_empty() && c != "VIEW"),
                    estimated_rows: if kind == ObjectKind::Table { r.i64(3) } else { None },
                }
            })
            .collect();
        let routines = self
            .rows(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
                 ORDER BY ROUTINE_NAME",
                &[Some(schema.into())],
            )
            .await?;
        out.extend(routines.iter().map(|r| {
            let r = TextRow(r);
            DbObject {
                schema: schema.into(),
                name: r.str(0),
                kind: if r.str(1) == "PROCEDURE" { ObjectKind::Procedure } else { ObjectKind::Function },
                comment: None,
                estimated_rows: None,
            }
        }));
        Ok(out)
    }

    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure> {
        let sp = || vec![Some(schema.to_string()), Some(name.to_string())];
        let kind_rows = self
            .rows("SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", &sp())
            .await?;
        let kind = match kind_rows.first().map(|r| TextRow(r).str(0)) {
            None => return Err(AppError::not_found(format!("Table {schema}.{name} was not found"))),
            Some(k) if k.contains("VIEW") => ObjectKind::View,
            Some(_) => ObjectKind::Table,
        };

        let pk_rows = self
            .rows(
                "SELECT COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'",
                &sp(),
            )
            .await?;
        let pk_pos = |col: &str| {
            pk_rows.iter().map(|r| TextRow(r)).find(|r| r.str(0) == col).and_then(|r| r.i64(1)).map(|p| p as u32)
        };

        let columns = self
            .rows(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                &sp(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let name = r.str(0);
                ColumnInfo {
                    primary_key: pk_pos(&name),
                    name,
                    data_type: r.str(1),
                    nullable: r.str(2) == "YES",
                    default: r.opt(3),
                    auto_increment: r.str(4).to_ascii_lowercase().contains("auto_increment"),
                    comment: r.opt(5).filter(|c| !c.is_empty()),
                }
            })
            .collect();

        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in self
            .rows(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
                &sp(),
            )
            .await?
        {
            let r = TextRow(&r);
            let idx_name = r.str(0);
            let col = r.opt(1).unwrap_or_else(|| "(expression)".into());
            match indexes.iter_mut().find(|i| i.name == idx_name) {
                Some(i) => i.columns.push(col),
                None => indexes.push(IndexInfo {
                    primary: idx_name == "PRIMARY",
                    unique: r.str(2) == "0",
                    name: idx_name,
                    columns: vec![col],
                    definition: None,
                }),
            }
        }

        let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
        for r in self
            .rows(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, \
                        k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE \
                 FROM information_schema.KEY_COLUMN_USAGE k \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                  AND r.TABLE_NAME = k.TABLE_NAME \
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                &sp(),
            )
            .await?
        {
            let r = TextRow(&r);
            let fk_name = r.str(0);
            match foreign_keys.iter_mut().find(|f| f.name == fk_name) {
                Some(f) => {
                    f.columns.push(r.str(1));
                    f.ref_columns.push(r.str(4));
                }
                None => foreign_keys.push(ForeignKeyInfo {
                    name: fk_name,
                    columns: vec![r.str(1)],
                    ref_schema: r.str(2),
                    ref_table: r.str(3),
                    ref_columns: vec![r.str(4)],
                    on_update: r.str(5),
                    on_delete: r.str(6),
                }),
            }
        }

        let mut constraints: Vec<ConstraintInfo> = indexes
            .iter()
            .filter(|i| i.unique)
            .map(|i| ConstraintInfo {
                name: i.name.clone(),
                kind: if i.primary { "primary_key" } else { "unique" }.into(),
                definition: format!("{} ({})", if i.primary { "PRIMARY KEY" } else { "UNIQUE" }, i.columns.join(", ")),
            })
            .collect();
        // CHECK_CONSTRAINTS exists in MySQL 8.0.16+ and MariaDB 10.2+; ignore its absence.
        if let Ok(rows) = self
            .rows(
                "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS \
                 WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
                &sp(),
            )
            .await
        {
            constraints.extend(rows.iter().map(|r| {
                let r = TextRow(r);
                ConstraintInfo { name: r.str(0), kind: "check".into(), definition: format!("CHECK ({})", r.str(1)) }
            }));
        }

        let triggers = self
            .rows(
                "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS \
                 WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME",
                &sp(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                TriggerInfo { name: r.str(0), timing: r.str(1), event: r.str(2), definition: r.str(3) }
            })
            .collect();

        Ok(TableStructure {
            schema: schema.into(),
            name: name.into(),
            kind,
            columns,
            indexes,
            foreign_keys,
            constraints,
            triggers,
        })
    }

    async fn object_definition(&mut self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        let q = Dialect::Mysql.qualified(Some(schema), name)?;
        let (sql, col) = match kind {
            ObjectKind::View => (format!("SHOW CREATE VIEW {q}"), 1),
            ObjectKind::Procedure => (format!("SHOW CREATE PROCEDURE {q}"), 2),
            ObjectKind::Function => (format!("SHOW CREATE FUNCTION {q}"), 2),
            ObjectKind::Sequence => (format!("SHOW CREATE SEQUENCE {q}"), 1),
            _ => (format!("SHOW CREATE TABLE {q}"), 1),
        };
        let mut result = self.conn.query_iter(sql).await.map_err(map_error)?;
        let columns = result.columns().unwrap_or_else(|| Arc::from(Vec::<Column>::new()));
        let mut def = None;
        while let Some(row) = result.next().await.map_err(map_error)? {
            if def.is_none() {
                def = TextRow(&text_row(row, &columns)).opt(col);
            }
        }
        drop(result);
        def.map(|d| format!("{d};")).ok_or_else(|| AppError::not_found("Definition not available (check privileges)"))
    }

    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        let canceller = self.canceller.clone();
        let mut result = self.conn.query_iter(sql).await.map_err(map_error)?;
        let mut outcomes = Vec::new();
        let mut cancelled_for_cap = false;
        // Bounded loop guards against a driver bug producing endless empty result sets.
        for _ in 0..10_000 {
            let cols = result.columns().unwrap_or_else(|| Arc::from(Vec::<Column>::new()));
            if cols.is_empty() {
                outcomes.push(StatementOutcome::Affected { rows_affected: result.affected_rows() });
                if let Err(e) = result.next().await {
                    return Err(map_error(e));
                }
            } else {
                let mut rs = RowSet { columns: columns_meta(&cols), ..Default::default() };
                loop {
                    match result.next().await {
                        Ok(Some(row)) => {
                            if rs.rows.len() < max_rows {
                                rs.rows.push(text_row(row, &cols));
                            } else if !rs.truncated {
                                rs.truncated = true;
                                cancelled_for_cap = true;
                                let _ = canceller.cancel().await;
                            }
                        }
                        Ok(None) => break,
                        Err(e) if cancelled_for_cap && is_interrupted(&e) => {
                            outcomes.push(StatementOutcome::Rows { rows: rs });
                            return Ok(outcomes);
                        }
                        Err(e) => return Err(map_error(e)),
                    }
                }
                outcomes.push(StatementOutcome::Rows { rows: rs });
            }
            if result.is_empty() {
                break;
            }
        }
        drop(result);
        Ok(outcomes)
    }

    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
        let params: Vec<Value> = params.iter().map(to_value).collect();
        let mut result = self.conn.exec_iter(sql, params).await.map_err(map_error)?;
        let cols = result.columns().unwrap_or_else(|| Arc::from(Vec::<Column>::new()));
        let mut rs = RowSet { columns: columns_meta(&cols), ..Default::default() };
        while let Some(row) = result.next().await.map_err(map_error)? {
            if rs.rows.len() < max_rows {
                rs.rows.push(binary_row(row, &cols));
            } else {
                rs.truncated = true;
            }
        }
        drop(result);
        Ok(rs)
    }

    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>> {
        if atomic {
            self.conn.query_drop("START TRANSACTION").await.map_err(map_error)?;
        }
        let mut counts = Vec::with_capacity(statements.len());
        for st in statements {
            let params: Vec<Value> = st.params.iter().map(to_value).collect();
            let result = self.conn.exec_drop(st.sql.as_str(), params).await.map_err(map_error);
            let failure = match result {
                Ok(()) => {
                    let n = self.conn.affected_rows();
                    match st.expect_rows {
                        Some(expected) if expected != n => Some(super::postgres::conflict_error(expected, n)),
                        _ => {
                            counts.push(n);
                            None
                        }
                    }
                }
                Err(e) => Some(e),
            };
            if let Some(err) = failure {
                if atomic {
                    let _ = self.conn.query_drop("ROLLBACK").await;
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
            self.conn.query_drop("COMMIT").await.map_err(map_error)?;
        }
        Ok(counts)
    }

    async fn close(self: Box<Self>) {
        let _ = self.conn.disconnect().await;
    }
}

fn is_interrupted(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Server(s) if s.code == 1317)
}

pub(crate) fn map_error(e: mysql_async::Error) -> AppError {
    match e {
        mysql_async::Error::Server(s) => {
            let kind = match s.code {
                1045 | 1044 | 1698 | 1251 => ErrorKind::Authentication,
                1049 => ErrorKind::InvalidConfig,
                1062 | 1451 | 1452 | 1048 | 1216 | 1217 | 3819 | 4025 => ErrorKind::Constraint,
                1317 => ErrorKind::Cancelled,
                1792 => ErrorKind::PolicyViolation,
                3024 | 1969 => ErrorKind::Timeout,
                _ => ErrorKind::Database,
            };
            let err = AppError::new(kind, &s.message).with_code(format!("{} ({})", s.code, s.state));
            match syntax_error_near(&s.message) {
                Some(near) => err.with_detail(near),
                None => err,
            }
        }
        mysql_async::Error::Io(io) => {
            let msg = io.to_string();
            if msg.to_ascii_lowercase().contains("tls") || msg.contains("certificate") {
                AppError::new(ErrorKind::Tls, format!("TLS error: {msg}"))
            } else {
                AppError::new(ErrorKind::Network, format!("Network error: {msg}"))
            }
        }
        mysql_async::Error::Driver(DriverError::ConnectionClosed) => {
            AppError::new(ErrorKind::Network, "The connection to the server was closed")
        }
        mysql_async::Error::Driver(d) => AppError::new(ErrorKind::Database, format!("Driver error: {d}")),
        other => AppError::new(ErrorKind::Database, other.to_string()),
    }
}

fn syntax_error_near(message: &str) -> Option<String> {
    message.find("near '").map(|i| format!("Error location: {}", &message[i..]))
}
