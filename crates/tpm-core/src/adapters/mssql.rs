//! SQL Server adapter built on `tiberius` (TDS over TCP; TLS through rustls with ring).
//!
//! * User SQL runs as batches (see split.rs), so variables, blocks and procedure bodies work as
//!   in SSMS. A batch's result sets come back in order; one without any reports `@@ROWCOUNT`.
//! * Values are bound through `sp_executesql` (`@P1`…), always as text, which SQL Server
//!   converts to the column's type.
//! * Read-only sessions run every batch inside a transaction that is always rolled back, on
//!   top of the safety analyzer refusing anything but reads.
//! * A plain `SELECT` is capped on the server (`SET ROWCOUNT`); in other batches rows past the
//!   cap are read and dropped, so every statement still runs. Cancels (and timeouts) use the TDS
//!   attention signal; when the driver cannot settle the connection after one, it is opened
//!   again on the same database, and session state such as #temp tables is lost.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, QueryItem, ToSql};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::{Canceller, ConnectOptions, DescribedColumn, ParamStatement, Session, TextRow, group_referencing_keys};
use crate::config::{ConnectionProfile, TlsMode};
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::*;

type MsClient = Client<Compat<TcpStream>>;

pub struct MsSession {
    client: Option<MsClient>,
    config: Config,
    connect_timeout: Duration,
    read_only: bool,
    canceller: Arc<MsCanceller>,
    /// The database the session last reported (`USE` changes it): a reconnect goes back to it.
    database: Option<String>,
    /// Opened again since the engine last asked (`take_connection_reset`).
    reset: bool,
}

#[derive(Default)]
struct MsCanceller {
    requested: AtomicBool,
    wake: Notify,
}

#[async_trait]
impl Canceller for MsCanceller {
    async fn cancel(&self) -> Result<()> {
        // The running operation is waiting on this; it sends the attention signal itself, because
        // the connection is borrowed by it.
        self.requested.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
        Ok(())
    }

    fn reset(&self) {
        self.requested.store(false, Ordering::SeqCst);
    }
}

/// How long the app's own reads wait for another session's lock before giving up.
const APP_LOCK_TIMEOUT_MS: u32 = 5000;

/// A text parameter; `None` binds NULL.
struct Text<'a>(Option<&'a str>);

impl ToSql for Text<'_> {
    fn to_sql(&self) -> ColumnData<'_> {
        ColumnData::String(self.0.map(Cow::Borrowed))
    }
}

/// Words that would end the transaction a read-only session runs each batch in, or reach past it.
/// (ANSI_DEFAULTS turns IMPLICIT_TRANSACTIONS on.)
const READ_ONLY_REFUSED: [&str; 7] =
    ["COMMIT", "ROLLBACK", "IMPLICIT_TRANSACTIONS", "ANSI_DEFAULTS", "OPENQUERY", "OPENROWSET", "OPENDATASOURCE"];

/// The UDP port SQL Browser listens on.
const SQL_BROWSER_PORT: u16 = 1434;

/// The TCP port of a named instance, asked of SQL Browser on `host` (the `CLNT_UCAST_INST`
/// request of [MC-SQLR]): one UDP datagram there and one back, within `wait`.
pub(crate) async fn instance_port(host: &str, browser_port: u16, instance: &str, wait: Duration) -> Result<u16> {
    let ask = async {
        let socket = tokio::net::UdpSocket::bind(if host.contains(':') { "[::]:0" } else { "0.0.0.0:0" })
            .await
            .map_err(|e| AppError::new(ErrorKind::Network, e.to_string()))?;
        socket.connect((host, browser_port)).await.map_err(|e| AppError::new(ErrorKind::Network, e.to_string()))?;
        let mut request = vec![0x04];
        request.extend_from_slice(instance.as_bytes());
        request.push(0);
        socket.send(&request).await.map_err(|e| AppError::new(ErrorKind::Network, e.to_string()))?;
        let mut buf = vec![0u8; 4096];
        let n = socket.recv(&mut buf).await.map_err(|e| AppError::new(ErrorKind::Network, e.to_string()))?;
        browser_reply_port(&buf[..n])
    };
    let unreachable = || {
        AppError::new(
            ErrorKind::Network,
            format!(
                "SQL Browser on {host} didn't answer for instance {instance}. Start the SQL Server Browser service, or enter the instance's port."
            ),
        )
    };
    match tokio::time::timeout(wait, ask).await {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(e)) if e.kind == ErrorKind::Network => Err(unreachable()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(unreachable()),
    }
}

/// The TCP port in a SQL Browser reply: `0x05`, a two-byte length, then `key;value;…` pairs.
fn browser_reply_port(reply: &[u8]) -> Result<u16> {
    let bad = || AppError::new(ErrorKind::Database, "SQL Browser sent a reply that couldn't be read");
    if reply.len() < 3 || reply[0] != 0x05 {
        return Err(bad());
    }
    let len = u16::from_le_bytes([reply[1], reply[2]]) as usize;
    let text = String::from_utf8_lossy(reply.get(3..3 + len).unwrap_or(&reply[3..]));
    let parts: Vec<&str> = text.split(';').collect();
    let tcp = parts.iter().position(|p| p.eq_ignore_ascii_case("tcp")).and_then(|i| parts.get(i + 1));
    match tcp {
        Some(port) => port.trim().parse::<u16>().map_err(|_| bad()),
        None => Err(AppError::new(
            ErrorKind::InvalidConfig,
            "The instance doesn't accept TCP connections. Enable TCP/IP for it in SQL Server Configuration Manager.",
        )),
    }
}

impl MsSession {
    pub async fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        options: &ConnectOptions,
    ) -> Result<Self> {
        // tiberius uses the process's rustls provider.
        super::tls::install_process_provider();
        let mut config = Config::new();
        let addr = match options.tunnel_port {
            Some(p) => {
                // Through a tunnel we connect to 127.0.0.1; verify the certificate for the real host.
                config.hostname_in_certificate(&profile.host);
                ("127.0.0.1".to_string(), p)
            }
            // A named instance without a port: SQL Browser knows it.
            None => match (&profile.instance, profile.port) {
                (Some(instance), None) => {
                    let wait = Duration::from_secs(profile.connect_timeout_secs.min(10));
                    (profile.host.clone(), instance_port(&profile.host, SQL_BROWSER_PORT, instance, wait).await?)
                }
                _ => (profile.host.clone(), profile.port_or_default()),
            },
        };
        config.host(&addr.0);
        config.port(addr.1);
        let database = options.database.as_deref().unwrap_or(&profile.database);
        if !database.is_empty() {
            config.database(database);
        }
        config.application_name("Table Pro Max");
        config.authentication(AuthMethod::sql_server(&profile.user, password.unwrap_or_default()));
        config.readonly(profile.read_only());
        // The engine times statements out itself, through the canceller.
        config.command_timeout(None);
        match profile.tls.mode {
            // SQL Server encrypts the sign-in either way; without verification it only guards
            // against someone listening, as plaintext would not.
            TlsMode::Disable => {
                config.encryption(EncryptionLevel::Off);
                config.trust_cert();
            }
            TlsMode::Prefer => config.encryption(EncryptionLevel::On),
            TlsMode::Require => config.encryption(EncryptionLevel::Required),
            TlsMode::RequireInsecure => {
                config.encryption(EncryptionLevel::Required);
                config.trust_cert();
            }
        }
        if let Some(ca) = profile.tls.ca_cert_path.as_deref().filter(|p| !p.trim().is_empty()) {
            config.trust_cert_ca(ca);
        }
        let connect_timeout = Duration::from_secs(profile.connect_timeout_secs);
        let mut session = Self {
            client: None,
            config,
            connect_timeout,
            read_only: profile.read_only(),
            canceller: Arc::new(MsCanceller::default()),
            database: None,
            reset: false,
        };
        session.open().await?;
        session.in_transaction().await?;
        Ok(session)
    }

    async fn open(&mut self) -> Result<()> {
        let timeout = self.connect_timeout;
        let mut config = self.config.clone();
        if let Some(db) = &self.database {
            config.database(db);
        }
        // Azure SQL's gateway may send the client on to the database's own node.
        for _ in 0..3 {
            let tcp = tokio::time::timeout(timeout, TcpStream::connect(config.get_addr()))
                .await
                .map_err(|_| {
                    AppError::new(ErrorKind::Network, format!("Connection timed out after {}s", timeout.as_secs()))
                })?
                .map_err(|e| AppError::new(ErrorKind::Network, format!("Network error: {e}")))?;
            let _ = tcp.set_nodelay(true);
            // Boxed: the sign-in and TLS handshake state is large, too large for a worker thread's
            // stack beneath the engine's own connect in debug builds.
            let handshake = Box::pin(Client::connect(config.clone(), tcp.compat_write()));
            match tokio::time::timeout(timeout, handshake).await {
                Err(_) => {
                    return Err(AppError::new(
                        ErrorKind::Network,
                        format!("The server did not answer within {}s", timeout.as_secs()),
                    ));
                }
                Ok(Ok(client)) => {
                    self.client = Some(client);
                    return Ok(());
                }
                Ok(Err(tiberius::error::Error::Routing { host, port })) => {
                    config.host(host);
                    config.port(port);
                }
                Ok(Err(e)) => return Err(map_error(e)),
            }
        }
        Err(AppError::new(ErrorKind::Network, "The server kept redirecting the connection"))
    }

    fn client(&mut self) -> Result<&mut MsClient> {
        self.client.as_mut().ok_or_else(|| AppError::new(ErrorKind::Network, "The connection to the server was closed"))
    }

    /// Starts listening for a cancel: one requested from here on is seen, even before the wait is
    /// polled. A cancel that came in before this belonged to an operation that has ended.
    fn listen(canceller: &MsCanceller) -> std::pin::Pin<Box<tokio::sync::futures::Notified<'_>>> {
        let mut wake = Box::pin(canceller.wake.notified());
        wake.as_mut().enable();
        wake
    }

    /// After a cancel interrupted an operation: stops the server's work with the attention signal,
    /// or, when the driver can't settle the connection that way (tiberius#459), opens it again on
    /// the same database. The error says what that cost.
    async fn cancelled(&mut self) -> AppError {
        if let Some(client) = self.client.as_mut()
            && client.cancel_query().await.is_ok()
        {
            // The batch stopped part-way, before its own clean-up.
            let reset = if self.read_only {
                "SET ROWCOUNT 0; IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"
            } else {
                "SET ROWCOUNT 0"
            };
            if let Some(client) = self.client.as_mut()
                && let Ok(stream) = client.simple_query(reset).await
            {
                let _ = stream.into_results().await;
            }
            return AppError::cancelled();
        }
        self.client = None;
        self.reset = true;
        if let Err(e) = self.open().await {
            return e.add_context("The connection was lost while stopping the query.");
        }
        let on = self.database.as_deref().map(|d| format!(" It is on database {d}.")).unwrap_or_default();
        AppError::cancelled().add_context(format!(
            "The connection was opened again to stop the query, so temporary tables, variables, SET options \
             and any open transaction were reset.{on}"
        ))
    }

    /// Rows of the app's own queries (catalog, pages, restore points), read in full (they are
    /// bounded already). They run through sp_executesql with a lock timeout scoped to that call,
    /// so none waits long behind another session's transaction, and a cancel (meant for the
    /// user's statement) doesn't interrupt them.
    async fn rows(&mut self, sql: &str, params: &[Param]) -> Result<RowSet> {
        self.fetch(&format!("SET LOCK_TIMEOUT {APP_LOCK_TIMEOUT_MS};\n{sql}"), params, true).await
    }

    /// A statement of the app's own that has to run as a plain batch: transaction control (a
    /// BEGIN TRANSACTION inside sp_executesql is refused for changing the transaction count) and
    /// the session's `@@` counters.
    async fn control(&mut self, sql: &str) -> Result<RowSet> {
        self.fetch(sql, &[], false).await
    }

    async fn fetch(&mut self, sql: &str, params: &[Param], rpc: bool) -> Result<RowSet> {
        let refs: Vec<Text> = params.iter().map(|p| Text(p.as_deref())).collect();
        let args: Vec<&dyn ToSql> = refs.iter().map(|p| p as &dyn ToSql).collect();
        let client = self.client()?;
        let stream = if rpc { client.query(sql, &args).await } else { client.simple_query(sql).await };
        let mut stream = stream.map_err(app_error)?;
        let mut rs = RowSet::default();
        while let Some(item) = stream.try_next().await.map_err(app_error)? {
            match item {
                QueryItem::Metadata(m) if rs.columns.is_empty() => rs.columns = columns_meta(m.columns()),
                QueryItem::Metadata(_) => {}
                QueryItem::Row(row) if row.result_index() == 0 => rs.rows.push(to_row(row)),
                QueryItem::Row(_) => {}
            }
        }
        Ok(rs)
    }

    /// Runs one batch of user SQL (with values bound when `params` is set) and gathers its result
    /// sets. Rows past `max_rows` are read and dropped, so the rest of the batch still runs; a
    /// plain SELECT is capped by the server instead.
    async fn run(&mut self, sql: &str, params: Option<&[Param]>, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        let words = crate::split::mssql_words(sql);
        let module = crate::split::starts_batch_object(sql);
        // In a procedure body it limits that procedure's statements only.
        if !module && words.windows(2).any(|w| w[0] == "SET" && w[1] == "ROWCOUNT") {
            return Err(AppError::unsupported(
                "SET ROWCOUNT isn't supported here: it would also limit the app's own queries. Use TOP (n) instead.",
            ));
        }
        if self.read_only
            && let Some(w) = words.iter().find(|w| READ_ONLY_REFUSED.contains(&w.as_str()))
        {
            return Err(AppError::new(
                ErrorKind::PolicyViolation,
                format!(
                    "This connection is read-only: {w} isn't allowed, because every batch runs in a transaction \
                     that is rolled back afterwards"
                ),
            ));
        }
        // A plain SELECT is capped by the server: it stops after the rows we keep (+1 to know).
        let cap = !module && is_plain_select(sql);
        let mut prefix = String::new();
        let mut suffix = String::new();
        if self.read_only && !module {
            prefix.push_str("BEGIN TRANSACTION;\n");
            suffix.push_str("\n;IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
        }
        if cap {
            prefix.push_str(&format!("SET ROWCOUNT {};\n", max_rows.saturating_add(1)));
            suffix.push_str("\n;SET ROWCOUNT 0;");
        }
        let batch = format!("{prefix}{sql}{suffix}");
        let shift = prefix.matches('\n').count() as u32;

        let canceller = self.canceller.clone();
        let mut wake = Self::listen(&canceller);
        if canceller.requested.load(Ordering::SeqCst) {
            return Err(AppError::cancelled());
        }
        let refs: Vec<Text> = params.unwrap_or_default().iter().map(|p| Text(p.as_deref())).collect();
        let args: Vec<&dyn ToSql> = refs.iter().map(|p| p as &dyn ToSql).collect();
        let mut outcomes: Vec<StatementOutcome> = Vec::new();
        let result: Option<Result<()>> = {
            let client = self.client()?;
            let read = async {
                let mut stream = match params {
                    Some(_) => client.query(batch.as_str(), &args).await,
                    None => client.simple_query(batch.as_str()).await,
                }
                .map_err(map_error)?;
                let mut current: Option<RowSet> = None;
                while let Some(item) = stream.try_next().await.map_err(map_error)? {
                    match item {
                        QueryItem::Metadata(m) => {
                            if let Some(rs) = current.take() {
                                outcomes.push(StatementOutcome::Rows { rows: rs });
                            }
                            current = Some(RowSet { columns: columns_meta(m.columns()), ..Default::default() });
                        }
                        QueryItem::Row(row) => {
                            let Some(rs) = current.as_mut() else { continue };
                            if rs.rows.len() < max_rows {
                                rs.rows.push(to_row(row));
                            } else {
                                // Read and dropped: stopping the server here would also stop the
                                // statements after this one.
                                rs.truncated = true;
                            }
                        }
                    }
                }
                if let Some(rs) = current.take() {
                    outcomes.push(StatementOutcome::Rows { rows: rs });
                }
                Ok::<(), AppError>(())
            };
            tokio::select! {
                biased;
                r = read => Some(r),
                _ = &mut wake => None,
            }
        };
        let Some(result) = result else { return Err(self.cancelled().await) };
        if let Err(e) = result {
            // The batch may have stopped before its own clean-up ran. Only the app's own state is
            // reset: a transaction outside read-only is the user's.
            let reset = if self.read_only {
                "SET ROWCOUNT 0; IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"
            } else {
                "SET ROWCOUNT 0"
            };
            if self.read_only || cap {
                let _ = self.control(reset).await;
            }
            return Err(with_line(e, sql, shift));
        }
        if outcomes.is_empty() {
            let n = if self.read_only || cap { 0 } else { self.row_count().await? };
            outcomes.push(StatementOutcome::Affected { rows_affected: n });
        }
        Ok(outcomes)
    }

    async fn row_count(&mut self) -> Result<u64> {
        let rs = self.control("SELECT CAST(@@ROWCOUNT AS bigint)").await?;
        Ok(rs.rows.first().and_then(|r| TextRow(r).i64(0)).unwrap_or(0).max(0) as u64)
    }

    async fn object_id(&mut self, schema: &str, name: &str) -> Result<Option<(String, String)>> {
        let rs = self
            .rows(
                "SELECT CAST(o.object_id AS nvarchar(20)), RTRIM(o.type) FROM sys.all_objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.name = @P2",
                &[Some(schema.into()), Some(name.into())],
            )
            .await?;
        Ok(rs.rows.first().map(|r| (TextRow(r).str(0), TextRow(r).str(1))))
    }
}

/// `SELECT …` (or `WITH … SELECT`) on its own, without INTO: safe to cap with SET ROWCOUNT, which
/// would also limit the rows a write or SELECT INTO changes.
fn is_plain_select(sql: &str) -> bool {
    use sqlparser::ast::{SetExpr, Statement};
    let Ok(stmts) = sqlparser::parser::Parser::parse_sql(Dialect::Mssql.parser().as_ref(), sql) else {
        return false;
    };
    let [Statement::Query(q)] = stmts.as_slice() else { return false };
    match q.body.as_ref() {
        SetExpr::Select(s) => s.into.is_none() && q.with.is_none(),
        SetExpr::SetOperation { .. } => q.with.is_none(),
        _ => false,
    }
}

/// The server's line number as a position in the user's SQL (it counts lines of the batch we
/// sent, which may start with lines of our own).
fn with_line(e: AppError, sql: &str, shift: u32) -> AppError {
    let Some(line) = e.position else { return e };
    let line = line.saturating_sub(shift);
    if line == 0 {
        return AppError { position: None, ..e };
    }
    let start: usize = sql.split_inclusive('\n').take(line as usize - 1).map(str::len).sum();
    if start >= sql.len() {
        return AppError { position: None, ..e };
    }
    let rest = &sql[start..];
    let lead = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let chars = sql[..start + lead].chars().count() as u32;
    AppError { position: Some(chars + 1), ..e }
}

fn type_name(t: ColumnType) -> &'static str {
    match t {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 | ColumnType::Intn => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money => "money",
        ColumnType::Money4 => "smallmoney",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln | ColumnType::Numericn => "decimal",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::Image => "image",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Text => "text",
        ColumnType::NText => "ntext",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::SSVariant => "sql_variant",
    }
}

fn columns_meta(cols: &[tiberius::Column]) -> Vec<ColumnMeta> {
    cols.iter().map(|c| ColumnMeta::new(c.name(), type_name(c.column_type()))).collect()
}

fn to_row(row: tiberius::Row) -> Row {
    let types: Vec<ColumnType> = row.columns().iter().map(|c| c.column_type()).collect();
    row.into_iter().enumerate().map(|(i, v)| to_cell(v, types.get(i).copied())).collect()
}

/// `n` fractional digits of `increments / 10^scale` seconds, as SQL Server prints them.
fn fraction(increments: u64, scale: u8, digits: u8) -> String {
    if digits == 0 {
        return String::new();
    }
    let frac = increments % 10u64.pow(scale.into());
    format!(".{:0width$}", frac, width = digits as usize)
}

/// Very large and very small floats in exponent form (`1e300`), as SQL Server shows them,
/// rather than hundreds of digits. Both forms convert back to the same value.
fn float_text(f: f64, plain: String) -> String {
    let a = f.abs();
    if f.is_finite() && a != 0.0 && !(1e-5..1e16).contains(&a) { format!("{f:e}") } else { plain }
}

fn clock(seconds: u64) -> String {
    format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

fn date_text(days_from_year_one: i64) -> String {
    chrono::NaiveDate::from_num_days_from_ce_opt((days_from_year_one + 1) as i32)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn time_text(t: tiberius::time::Time) -> String {
    let per_second = 10u64.pow(t.scale().into());
    format!("{}{}", clock(t.increments() / per_second), fraction(t.increments(), t.scale(), t.scale()))
}

/// Days from 0001-01-01 to 1900-01-01, where `datetime` and `smalldatetime` count from.
const DAYS_TO_1900: i64 = 693_595;

fn to_cell(v: ColumnData<'static>, ty: Option<ColumnType>) -> Cell {
    let text = |s: String| Cell::Text(s);
    match v {
        ColumnData::U8(Some(n)) => text(n.to_string()),
        ColumnData::I16(Some(n)) => text(n.to_string()),
        ColumnData::I32(Some(n)) => text(n.to_string()),
        ColumnData::I64(Some(n)) => text(n.to_string()),
        // money arrives as a float; printed with its four decimals it is exact below ~9e11.
        ColumnData::F64(Some(f)) if matches!(ty, Some(ColumnType::Money | ColumnType::Money4)) => {
            text(format!("{f:.4}"))
        }
        ColumnData::F32(Some(f)) => text(float_text(f64::from(f), f.to_string())),
        ColumnData::F64(Some(f)) => text(float_text(f, f.to_string())),
        ColumnData::Bit(Some(b)) => text(if b { "1" } else { "0" }.into()),
        ColumnData::String(Some(s)) => text(s.into_owned()),
        ColumnData::Guid(Some(g)) => text(g.to_string().to_uppercase()),
        ColumnData::Binary(Some(b)) => Cell::Bytes(b.into_owned()),
        ColumnData::Numeric(Some(n)) => text(n.to_string()),
        ColumnData::Xml(Some(x)) => text(x.as_ref().as_ref().to_string()),
        ColumnData::DateTime(Some(dt)) => {
            // 1/300-second ticks, shown to the millisecond like SSMS.
            let frags = u64::from(dt.seconds_fragments());
            let ms = (frags % 300 * 1000 + 150) / 300;
            let date = date_text(DAYS_TO_1900 + i64::from(dt.days()));
            text(format!("{date} {}.{ms:03}", clock(frags / 300)))
        }
        ColumnData::SmallDateTime(Some(dt)) => {
            let date = date_text(DAYS_TO_1900 + i64::from(dt.days()));
            text(format!("{date} {}", clock(u64::from(dt.seconds_fragments()) * 60)))
        }
        ColumnData::Date(Some(d)) => text(date_text(i64::from(d.days()))),
        ColumnData::Time(Some(t)) => text(time_text(t)),
        ColumnData::DateTime2(Some(dt)) => {
            text(format!("{} {}", date_text(i64::from(dt.date().days())), time_text(dt.time())))
        }
        ColumnData::DateTimeOffset(Some(dto)) => {
            // Stored in UTC with the offset alongside; shown in the offset's local time.
            let dt = dto.datetime2();
            let per_second = 10u64.pow(dt.time().scale().into());
            let utc_secs = i64::from(dt.date().days()) * 86_400 + (dt.time().increments() / per_second) as i64;
            let local = utc_secs + i64::from(dto.offset()) * 60;
            let (days, secs) = (local.div_euclid(86_400), local.rem_euclid(86_400) as u64);
            let off = dto.offset();
            let sign = if off < 0 { '-' } else { '+' };
            let scale = dt.time().scale();
            text(format!(
                "{} {}{} {sign}{:02}:{:02}",
                date_text(days),
                clock(secs),
                fraction(dt.time().increments(), scale, scale),
                off.unsigned_abs() / 60,
                off.unsigned_abs() % 60
            ))
        }
        _ => Cell::Null,
    }
}

/// A column's declared type as SQL Server writes it: `nvarchar(50)`, `decimal(10,2)`, `varbinary(max)`.
fn declared_type(name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    let len = |n: i64| if n < 0 { "max".to_string() } else { n.to_string() };
    match name {
        "varchar" | "char" | "varbinary" | "binary" => format!("{name}({})", len(max_length)),
        "nvarchar" | "nchar" => {
            format!("{name}({})", if max_length < 0 { "max".into() } else { (max_length / 2).to_string() })
        }
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{name}({scale})"),
        "timestamp" => "rowversion".into(),
        _ => name.to_string(),
    }
}

#[async_trait]
impl Session for MsSession {
    fn dialect(&self) -> Dialect {
        Dialect::Mssql
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            multiple_databases: true,
            schemas: true,
            cancel: CancelSupport::Attention,
            transactions: true,
            transactional_ddl: true,
            explain: true,
            explain_analyze: true,
            materialized_views: false,
            routines: true,
            sequences: true,
        }
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let rs = self
            .rows(
                "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), \
                        CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), \
                        CAST(SERVERPROPERTY('EngineEdition') AS int), DB_NAME(), SUSER_SNAME()",
                &[],
            )
            .await?;
        let r = rs.rows.first().map(|r| TextRow(r)).ok_or_else(|| AppError::internal("No server information"))?;
        // EngineEdition 5 is Azure SQL Database, 8 Azure SQL Managed Instance.
        let product = match r.i64(2) {
            Some(5) | Some(8) => "Azure SQL",
            _ => "SQL Server",
        };
        Ok(ServerInfo {
            product: product.into(),
            // "16.0.4305.5 Developer Edition (64-bit)"
            version: format!("{} {}", r.str(0), r.str(1)),
            current_database: r.str(3),
            current_user: r.str(4),
        })
    }

    async fn ping(&mut self) -> Result<()> {
        self.control("SELECT 1").await.map(|_| ())
    }

    async fn list_databases(&mut self) -> Result<Vec<String>> {
        let rs = self
            .rows(
                "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state = 0 \
                 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name",
                &[],
            )
            .await?;
        Ok(rs.rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_schemas(&mut self) -> Result<Vec<String>> {
        // Leaves out the schemas of the fixed database roles (db_owner …) and guest.
        let rs = self
            .rows(
                "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name <> 'guest' \
                 ORDER BY CASE WHEN name = 'dbo' THEN 0 WHEN name IN ('sys', 'INFORMATION_SCHEMA') THEN 2 ELSE 1 END, name",
                &[],
            )
            .await?;
        Ok(rs.rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>> {
        let rs = self
            .rows(
                "SELECT o.name, RTRIM(o.type), CAST(ep.value AS nvarchar(4000)), \
                        CAST((SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id \
                              AND p.index_id IN (0, 1)) AS nvarchar(20)) \
                 FROM sys.all_objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id \
                   AND ep.minor_id = 0 AND ep.name = 'MS_Description' \
                 WHERE s.name = @P1 AND o.type IN ('U', 'V', 'P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT', 'SO') \
                 ORDER BY o.name",
                &[Some(schema.into())],
            )
            .await?;
        Ok(rs
            .rows
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let kind = match r.str(1).as_str() {
                    "U" => ObjectKind::Table,
                    "V" => ObjectKind::View,
                    "P" | "PC" => ObjectKind::Procedure,
                    "SO" => ObjectKind::Sequence,
                    _ => ObjectKind::Function,
                };
                DbObject {
                    schema: schema.into(),
                    name: r.str(0),
                    kind,
                    comment: r.opt(2).filter(|c| !c.is_empty()),
                    estimated_rows: if kind == ObjectKind::Table { r.i64(3) } else { None },
                }
            })
            .collect())
    }

    async fn referencing_keys(&mut self, schema: &str, name: &str) -> Result<Vec<ReferencingKey>> {
        let Some((id, _)) = self.object_id(schema, name).await? else {
            return Err(AppError::not_found(format!("Table {schema}.{name} was not found")));
        };
        let rows = self
            .rows(
                "SELECT ps.name, pt.name, fk.name, pc.name, rc.name \
                 FROM sys.foreign_keys fk \
                 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
                 JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id \
                 JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
                 WHERE fk.referenced_object_id = @P1 \
                 ORDER BY ps.name, pt.name, fk.name, fkc.constraint_column_id",
                &[Some(id)],
            )
            .await?
            .rows;
        Ok(group_referencing_keys(rows.iter().map(|r| {
            let r = TextRow(r);
            [r.str(0), r.str(1), r.str(2), r.str(3), r.str(4)]
        })))
    }

    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure> {
        let (id, kind) = match self.object_id(schema, name).await? {
            Some((id, t)) if t == "U" => (id, ObjectKind::Table),
            Some((id, t)) if t == "V" => (id, ObjectKind::View),
            _ => return Err(AppError::not_found(format!("Table {schema}.{name} was not found"))),
        };
        let p = || vec![Some(id.clone())];

        let pk = self
            .rows(
                "SELECT c.name, CAST(ic.key_ordinal AS nvarchar(10)) FROM sys.indexes i \
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE i.object_id = @P1 AND i.is_primary_key = 1",
                &p(),
            )
            .await?;
        let pk_pos = |col: &str| {
            pk.rows.iter().map(|r| TextRow(r)).find(|r| r.str(0) == col).and_then(|r| r.i64(1)).map(|p| p as u32)
        };

        let cols = self
            .rows(
                "SELECT c.name, TYPE_NAME(c.user_type_id), CAST(c.max_length AS nvarchar(10)), \
                        CAST(c.precision AS nvarchar(10)), CAST(c.scale AS nvarchar(10)), \
                        CAST(c.is_nullable AS nvarchar(1)), dc.definition, CAST(c.is_identity AS nvarchar(1)), \
                        CAST(ep.value AS nvarchar(4000)), CAST(c.is_computed AS nvarchar(1)), cc.definition, \
                        CAST(t.is_user_defined AS nvarchar(1)) \
                 FROM sys.all_columns c JOIN sys.types t ON t.user_type_id = c.user_type_id \
                 LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
                 LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
                 LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
                   AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' \
                 WHERE c.object_id = @P1 ORDER BY c.column_id",
                &p(),
            )
            .await?;
        let columns = cols
            .rows
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let name = r.str(0);
                let base = r.str(1);
                let data_type = if r.bool(11) {
                    base
                } else {
                    declared_type(&base, r.i64(2).unwrap_or(0), r.i64(3).unwrap_or(0), r.i64(4).unwrap_or(0))
                };
                let generated = r.bool(9);
                ColumnInfo {
                    enum_values: Vec::new(),
                    primary_key: pk_pos(&name),
                    name,
                    data_type,
                    nullable: r.bool(5),
                    // A computed column's expression stands where a default would.
                    default: if generated { r.opt(10) } else { r.opt(6) },
                    auto_increment: r.bool(7),
                    comment: r.opt(8).filter(|c| !c.is_empty()),
                    generated,
                }
            })
            .collect();

        let qualified = Dialect::Mssql.qualified(Some(schema), name)?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        let mut unique_constraints: Vec<String> = Vec::new();
        for r in self
            .rows(
                "SELECT i.name, c.name, CAST(i.is_unique AS nvarchar(1)), CAST(i.is_primary_key AS nvarchar(1)), \
                        CAST(ic.is_included_column AS nvarchar(1)), i.type_desc, i.filter_definition, \
                        CAST(i.is_unique_constraint AS nvarchar(1)) \
                 FROM sys.indexes i \
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE i.object_id = @P1 AND i.type > 0 \
                 ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id",
                &p(),
            )
            .await?
            .rows
        {
            let r = TextRow(&r);
            let idx = r.str(0);
            let included = r.bool(4);
            let pos = match indexes.iter().position(|i| i.name == idx) {
                Some(pos) => pos,
                None => {
                    if r.bool(7) {
                        unique_constraints.push(idx.clone());
                    }
                    indexes.push(IndexInfo {
                        name: idx,
                        columns: vec![],
                        unique: r.bool(2),
                        primary: r.bool(3),
                        definition: Some(format!("{}|{}|", r.str(5), r.opt(6).unwrap_or_default())),
                    });
                    indexes.len() - 1
                }
            };
            let col = Dialect::Mssql.quote_ident(&r.str(1))?;
            let i = &mut indexes[pos];
            if included {
                // Kept in the definition only: INCLUDE columns are not part of the key.
                if let Some(d) = i.definition.as_mut() {
                    d.push_str(&format!("{col},"));
                }
            } else {
                i.columns.push(r.str(1));
            }
        }
        for i in &mut indexes {
            let raw = i.definition.take().unwrap_or_default();
            let mut parts = raw.splitn(3, '|');
            let kind = parts.next().unwrap_or_default();
            let filter = parts.next().unwrap_or_default();
            let include = parts.next().unwrap_or_default().trim_end_matches(',');
            if i.primary || unique_constraints.contains(&i.name) {
                continue;
            }
            let cols: Result<Vec<String>> = i.columns.iter().map(|c| Dialect::Mssql.quote_ident(c)).collect();
            let mut def = format!(
                "CREATE {}{} INDEX {} ON {qualified} ({})",
                if i.unique { "UNIQUE " } else { "" },
                kind,
                Dialect::Mssql.quote_ident(&i.name)?,
                cols?.join(", ")
            );
            if !include.is_empty() {
                def.push_str(&format!(" INCLUDE ({})", include.replace(',', ", ")));
            }
            if !filter.is_empty() {
                def.push_str(&format!(" WHERE {filter}"));
            }
            i.definition = Some(def);
        }

        let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
        for r in self
            .rows(
                "SELECT fk.name, pc.name, rs.name, rt.name, rc.name, \
                        REPLACE(fk.update_referential_action_desc, '_', ' '), \
                        REPLACE(fk.delete_referential_action_desc, '_', ' ') \
                 FROM sys.foreign_keys fk \
                 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
                 JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id \
                 JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
                 WHERE fk.parent_object_id = @P1 ORDER BY fk.name, fkc.constraint_column_id",
                &p(),
            )
            .await?
            .rows
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
            .filter(|i| i.primary || unique_constraints.contains(&i.name))
            .map(|i| {
                let cols: Vec<String> =
                    i.columns.iter().map(|c| Dialect::Mssql.quote_ident(c).unwrap_or_default()).collect();
                ConstraintInfo {
                    name: i.name.clone(),
                    kind: if i.primary { "primary_key" } else { "unique" }.into(),
                    definition: format!("{} ({})", if i.primary { "PRIMARY KEY" } else { "UNIQUE" }, cols.join(", ")),
                }
            })
            .collect();
        let checks = self
            .rows("SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = @P1 ORDER BY name", &p())
            .await?;
        constraints.extend(checks.rows.iter().map(|r| {
            let r = TextRow(r);
            ConstraintInfo { name: r.str(0), kind: "check".into(), definition: format!("CHECK {}", r.str(1)) }
        }));

        let trig = self
            .rows(
                "SELECT tr.name, CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END, \
                        te.type_desc, OBJECT_DEFINITION(tr.object_id) \
                 FROM sys.triggers tr JOIN sys.trigger_events te ON te.object_id = tr.object_id \
                 WHERE tr.parent_id = @P1 ORDER BY tr.name, te.type",
                &p(),
            )
            .await?;
        let mut triggers: Vec<TriggerInfo> = Vec::new();
        for r in &trig.rows {
            let r = TextRow(r);
            match triggers.iter_mut().find(|t| t.name == r.str(0)) {
                Some(t) => t.event.push_str(&format!(" OR {}", r.str(2))),
                None => triggers.push(TriggerInfo {
                    name: r.str(0),
                    timing: r.str(1),
                    event: r.str(2),
                    definition: r.str(3),
                }),
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
            triggers,
        })
    }

    async fn object_definition(&mut self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        if kind == ObjectKind::Table {
            let s = self.table_structure(schema, name).await?;
            let mut def = crate::ddl::create_table_sql(Dialect::Mssql, &s)?;
            if s.columns.iter().any(|c| c.auto_increment) {
                let q = Dialect::Mssql.qualified(Some(schema), name)?;
                let rs = self
                    .rows(
                        "SELECT CAST(IDENT_SEED(@P1) AS nvarchar(40)), CAST(IDENT_INCR(@P1) AS nvarchar(40))",
                        &[Some(q)],
                    )
                    .await?;
                if let Some(r) = rs.rows.first().map(|r| TextRow(r)) {
                    def = def.replacen(" IDENTITY", &format!(" IDENTITY({}, {})", r.str(0), r.str(1)), 1);
                }
            }
            return Ok(def);
        }
        if kind == ObjectKind::Sequence {
            let rs = self
                .rows(
                    "SELECT TYPE_NAME(sq.user_type_id), CAST(sq.start_value AS nvarchar(40)), \
                            CAST(sq.increment AS nvarchar(40)) FROM sys.sequences sq \
                     JOIN sys.schemas s ON s.schema_id = sq.schema_id WHERE s.name = @P1 AND sq.name = @P2",
                    &[Some(schema.into()), Some(name.into())],
                )
                .await?;
            let r = rs.rows.first().map(|r| TextRow(r)).ok_or_else(|| AppError::not_found("Sequence not found"))?;
            return Ok(format!(
                "CREATE SEQUENCE {} AS {} START WITH {} INCREMENT BY {};",
                Dialect::Mssql.qualified(Some(schema), name)?,
                r.str(0),
                r.str(1),
                r.str(2)
            ));
        }
        let qualified = Dialect::Mssql.qualified(Some(schema), name)?;
        let rs = self.rows("SELECT OBJECT_DEFINITION(OBJECT_ID(@P1))", &[Some(qualified)]).await?;
        rs.rows
            .first()
            .and_then(|r| TextRow(r).opt(0))
            .ok_or_else(|| AppError::not_found("Definition not available (it may be encrypted, or check privileges)"))
    }

    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        self.run(sql, None, max_rows).await
    }

    async fn execute_params(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<Vec<StatementOutcome>> {
        self.run(sql, Some(params), max_rows).await
    }

    /// SHOWPLAN_XML has to be the only statement in its batch, so it can't go through `run`
    /// (whose read-only wrapper adds statements); nothing runs while it is on, so this is safe on
    /// a read-only connection too.
    async fn estimated_plan(&mut self, sql: &str) -> Result<String> {
        self.control("SET SHOWPLAN_XML ON").await?;
        let plan = self.fetch(sql, &[], false).await;
        // Always switched off: a session left in SHOWPLAN mode would stop running statements.
        let off = self.control("SET SHOWPLAN_XML OFF").await;
        if off.is_err() {
            self.control("SET SHOWPLAN_XML OFF").await?;
        }
        let rs = plan?;
        let xml: Vec<&str> = rs.rows.iter().filter_map(|r| r.first().and_then(|c| c.as_text())).collect();
        if xml.is_empty() {
            return Err(AppError::new(ErrorKind::Database, "SQL Server returned no plan for this statement"));
        }
        Ok(xml.join("\n"))
    }

    async fn describe(&mut self, sql: &str) -> Result<Vec<DescribedColumn>> {
        // Browse mode reports the base table and column behind each result column.
        let rs = self
            .rows(
                "SELECT source_schema, source_table, source_column, system_type_name \
                 FROM sys.dm_exec_describe_first_result_set(@P1, NULL, 1) WHERE is_hidden = 0 ORDER BY column_ordinal",
                &[Some(sql.into())],
            )
            .await?;
        Ok(rs
            .rows
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let origin = match (r.opt(0), r.opt(1), r.opt(2)) {
                    (Some(schema), Some(table), Some(column)) => Some(ColumnOrigin { schema, table, column }),
                    _ => None,
                };
                DescribedColumn { origin, type_name: r.str(3) }
            })
            .collect())
    }

    /// Asked after every batch (engine.rs `sync_transaction`): notes the database too, which
    /// `USE` may have changed, for a reconnect to come back to.
    fn take_connection_reset(&mut self) -> bool {
        std::mem::take(&mut self.reset)
    }

    async fn in_transaction(&mut self) -> Result<bool> {
        let rs = self.control("SELECT @@TRANCOUNT, DB_NAME()").await?;
        let row = rs.rows.first().map(|r| TextRow(r));
        if let Some(db) = row.as_ref().and_then(|r| r.opt(1)) {
            self.database = Some(db);
        }
        Ok(row.and_then(|r| r.i64(0)).unwrap_or(0) > 0)
    }

    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
        let mut rs = self.rows(sql, params).await?;
        if rs.rows.len() > max_rows {
            rs.rows.truncate(max_rows);
            rs.truncated = true;
        }
        Ok(rs)
    }

    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>> {
        if atomic {
            self.begin().await?;
        }
        let mut counts = Vec::with_capacity(statements.len());
        for st in statements {
            let refs: Vec<Text> = st.params.iter().map(|p| Text(p.as_deref())).collect();
            let args: Vec<&dyn ToSql> = refs.iter().map(|p| p as &dyn ToSql).collect();
            let result = self.client()?.execute(st.sql.as_str(), &args).await.map_err(app_error);
            let failure = match result {
                Ok(r) => {
                    let n = r.total();
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
                    let _ = self.rollback().await;
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
            self.commit().await?;
        }
        Ok(counts)
    }

    async fn close(self: Box<Self>) {
        if let Some(client) = self.client {
            let _ = client.close().await;
        }
    }

    async fn begin(&mut self) -> Result<()> {
        // A bare BEGIN opens a block in T-SQL, not a transaction.
        self.control("BEGIN TRANSACTION").await.map(|_| ())
    }

    async fn commit(&mut self) -> Result<()> {
        self.control("COMMIT TRANSACTION").await.map(|_| ())
    }

    async fn rollback(&mut self) -> Result<()> {
        self.control("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await.map(|_| ())
    }
}

/// An error of the app's own SQL: its line number means nothing to the user.
fn app_error(e: tiberius::error::Error) -> AppError {
    AppError { position: None, ..map_error(e) }
}

pub(crate) fn map_error(e: tiberius::error::Error) -> AppError {
    use tiberius::error::Error;
    match e {
        Error::Server(t) => {
            let kind = match t.code() {
                18456 | 18452 | 18486 | 18487 | 18488 => ErrorKind::Authentication,
                4060 => ErrorKind::InvalidConfig,
                2627 | 2601 | 547 | 515 => ErrorKind::Constraint,
                3621 if t.message().contains("cancel") => ErrorKind::Cancelled,
                229 | 230 | 262 | 297 | 300 | 3906 => ErrorKind::PolicyViolation,
                1222 => ErrorKind::Timeout,
                _ => ErrorKind::Database,
            };
            let mut err = AppError::new(kind, t.message()).with_code(format!("{} (state {})", t.code(), t.state()));
            if !t.procedure().is_empty() {
                err = err.with_detail(format!("In {} at line {}", t.procedure(), t.line()));
            } else if t.line() > 0 {
                // The batch's line; `run` turns it into a position in the editor.
                err = err.with_position(Some(t.line()));
            }
            err
        }
        Error::Io { message, .. } => AppError::new(ErrorKind::Network, format!("Network error: {message}")),
        Error::Tls(m) => AppError::new(
            ErrorKind::Tls,
            format!(
                "TLS error: {m}. If the server uses a self-signed certificate, add its CA certificate or \
                 choose \"Require (don't verify)\"."
            ),
        ),
        Error::Routing { host, port } => {
            AppError::new(ErrorKind::Network, format!("The server redirected the connection to {host}:{port}"))
        }
        other => AppError::new(ErrorKind::Database, other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_from_a_sql_browser_reply() {
        let reply = |text: &str| {
            let mut r = vec![0x05];
            r.extend_from_slice(&(text.len() as u16).to_le_bytes());
            r.extend_from_slice(text.as_bytes());
            r
        };
        let ok = reply("ServerName;H;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0.1000.6;tcp;49172;;");
        assert_eq!(browser_reply_port(&ok).unwrap(), 49172);
        let no_tcp = reply("ServerName;H;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0;np;\\\\H\\pipe;;");
        assert!(browser_reply_port(&no_tcp).unwrap_err().message.contains("TCP"));
        assert!(browser_reply_port(&[0x01, 0x00]).is_err());
    }

    #[tokio::test]
    async fn looks_up_a_named_instance_through_sql_browser() {
        let browser = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = browser.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = [0u8; 64];
            let (n, from) = browser.recv_from(&mut buf).await.unwrap();
            assert_eq!(&buf[..n], b"\x04SQLEXPRESS\x00");
            let text = "ServerName;H;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0;tcp;50123;;";
            let mut r = vec![0x05];
            r.extend_from_slice(&(text.len() as u16).to_le_bytes());
            r.extend_from_slice(text.as_bytes());
            browser.send_to(&r, from).await.unwrap();
        });
        let found = instance_port("127.0.0.1", port, "SQLEXPRESS", Duration::from_secs(2)).await.unwrap();
        assert_eq!(found, 50123);
        // Nobody answering: a clear message, within the time limit.
        let silent = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let quiet_port = silent.local_addr().unwrap().port();
        let e = instance_port("127.0.0.1", quiet_port, "SQLEXPRESS", Duration::from_millis(300)).await.unwrap_err();
        assert!(e.message.contains("SQL Browser"), "{}", e.message);
        drop(silent);
    }

    #[test]
    fn declared_types_read_like_sql_server() {
        assert_eq!(declared_type("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(declared_type("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(declared_type("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(declared_type("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(declared_type("datetime2", 8, 27, 7), "datetime2(7)");
        assert_eq!(declared_type("timestamp", 8, 0, 0), "rowversion");
        assert_eq!(declared_type("int", 4, 10, 0), "int");
    }

    #[test]
    fn plain_selects_are_told_apart() {
        assert!(is_plain_select("SELECT * FROM t"));
        assert!(is_plain_select("SELECT 1 UNION ALL SELECT 2"));
        assert!(!is_plain_select("SELECT * INTO #t FROM t"), "SELECT INTO writes rows");
        assert!(!is_plain_select("WITH c AS (SELECT 1 a) SELECT * FROM c"), "a CTE may hide a write");
        assert!(!is_plain_select("DELETE FROM t"));
        assert!(!is_plain_select("SELECT 1; SELECT 2"));
    }

    #[test]
    fn error_lines_become_positions_in_the_users_sql() {
        let sql = "SELECT 1\n  SELEC 2\nSELECT 3";
        let e = AppError::new(ErrorKind::Database, "x").with_position(Some(2));
        assert_eq!(with_line(e.clone(), sql, 0).position, Some(12));
        // Two lines of ours came first.
        let e = AppError::new(ErrorKind::Database, "x").with_position(Some(4));
        assert_eq!(with_line(e, sql, 2).position, Some(12));
        let e = AppError::new(ErrorKind::Database, "x").with_position(Some(1));
        assert_eq!(with_line(e, sql, 1).position, None, "the error is in our own line");
    }
}
