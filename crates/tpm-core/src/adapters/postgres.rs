//! PostgreSQL adapter built on `tokio-postgres`.
//!
//! * User SQL runs through the simple-query protocol, so every value arrives in the
//!   server's text representation and any type (including extensions) can be shown.
//! * Generated queries use the extended protocol with [`TextParam`] bind parameters sent
//!   in text format: the server infers each parameter's type from context and parses
//!   the text exactly like a literal, without string interpolation.
//! * Cancellation uses the protocol-level cancel request.

use std::error::Error as StdError;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::BytesMut;
use futures_util::{StreamExt, pin_mut};
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::types::{Format, FromSql, IsNull, Kind, ToSql, Type};
use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::{Canceller, ConnectOptions, ParamStatement, Session, TextRow, split_list};
use crate::config::{ConnectionProfile, TlsMode};
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::*;

pub struct PgSession {
    client: Client,
    canceller: Arc<PgCanceller>,
    /// (table oid, attnum) → (schema, table, column), for result column origins.
    origin_names: std::collections::HashMap<(u32, i16), (String, String, String)>,
}

struct PgCanceller {
    token: CancelToken,
    tls: MakeRustlsConnect,
}

#[async_trait]
impl Canceller for PgCanceller {
    async fn cancel(&self) -> Result<()> {
        self.token.cancel_query(self.tls.clone()).await.map_err(map_error)
    }
}

impl PgSession {
    pub async fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        options: &ConnectOptions,
    ) -> Result<Self> {
        if profile.user.trim().is_empty() {
            return Err(AppError::invalid_config("A username is required for PostgreSQL"));
        }
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&profile.host).port(options.tunnel_port.unwrap_or(profile.port_or_default()));
        if options.tunnel_port.is_some() {
            // TCP goes to the tunnel; TLS (SNI and verification) still uses `host`.
            cfg.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        }
        cfg.user(&profile.user)
            .application_name("Table Pro Max")
            .connect_timeout(Duration::from_secs(profile.connect_timeout_secs))
            .keepalives(profile.keepalive_secs > 0);
        if profile.keepalive_secs > 0 {
            cfg.keepalives_idle(Duration::from_secs(profile.keepalive_secs));
        }
        let database = options.database.as_deref().unwrap_or(&profile.database);
        if !database.is_empty() {
            cfg.dbname(database);
        }
        if let Some(pw) = password {
            cfg.password(pw);
        }
        if profile.read_only() {
            // Enforced by the server for every transaction in this session. The safety
            // policy additionally blocks statements that try to switch it off.
            cfg.options("-c default_transaction_read_only=on");
        }
        cfg.ssl_mode(match profile.tls.mode {
            TlsMode::Disable => tokio_postgres::config::SslMode::Disable,
            TlsMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            TlsMode::Require | TlsMode::RequireInsecure => tokio_postgres::config::SslMode::Require,
        });
        let tls = MakeRustlsConnect::new(if profile.tls.mode == TlsMode::Disable {
            unused_tls_config()?
        } else {
            super::tls::client_config(&profile.tls)?
        });

        let (client, connection) = cfg.connect(tls.clone()).await.map_err(map_error)?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::debug!(error = %crate::redact::redact(&e.to_string()), "postgres connection closed");
            }
        });
        let canceller = Arc::new(PgCanceller { token: client.cancel_token(), tls });
        Ok(Self { client, canceller, origin_names: std::collections::HashMap::new() })
    }

    async fn rows(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        let text_params: Vec<TextParam> = params.iter().map(|p| TextParam(p.as_deref())).collect();
        let refs: Vec<&(dyn ToSql + Sync)> = text_params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
        let rows = self.client.query(sql, &refs).await.map_err(map_error)?;
        rows.iter()
            .map(|r| (0..r.len()).map(|i| r.try_get::<_, PgCell>(i).map(|c| c.0).map_err(map_error)).collect())
            .collect()
    }

    async fn relation_oid(&self, schema: &str, name: &str) -> Result<String> {
        let rows = self
            .rows(
                "SELECT c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[Some(schema.into()), Some(name.into())],
            )
            .await?;
        rows.first()
            .map(|r| TextRow(r).str(0))
            .ok_or_else(|| AppError::not_found(format!("Relation {schema}.{name} was not found")))
    }
}

fn unused_tls_config() -> Result<rustls::ClientConfig> {
    // TLS is disabled; the connector is never used but the type requires a config.
    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::internal(e.to_string()))?
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth())
}

#[async_trait]
impl Session for PgSession {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            multiple_databases: true,
            schemas: true,
            cancel: CancelSupport::Native,
            transactions: true,
            transactional_ddl: true,
            explain: true,
            explain_analyze: true,
            materialized_views: true,
            routines: true,
            sequences: true,
        }
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        self.canceller.clone()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let rows = self
            .rows("SELECT current_setting('server_version'), current_database()::text, current_user::text", &[])
            .await?;
        let r = TextRow(&rows[0]);
        Ok(ServerInfo {
            product: "PostgreSQL".into(),
            version: r.str(0),
            current_database: r.str(1),
            current_user: r.str(2),
        })
    }

    async fn ping(&mut self) -> Result<()> {
        self.client.simple_query("SELECT 1").await.map_err(map_error).map(|_| ())
    }

    async fn list_databases(&mut self) -> Result<Vec<String>> {
        let rows = self
            .rows("SELECT datname::text FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1", &[])
            .await?;
        Ok(rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_schemas(&mut self) -> Result<Vec<String>> {
        let rows = self
            .rows(
                "SELECT nspname::text FROM pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
                 ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname",
                &[],
            )
            .await?;
        Ok(rows.iter().map(|r| TextRow(r).str(0)).collect())
    }

    async fn list_objects(&mut self, schema: &str) -> Result<Vec<DbObject>> {
        let mut out = Vec::new();
        let rows = self
            .rows(
                "SELECT c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class'), \
                        CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname",
                &[Some(schema.into())],
            )
            .await?;
        for r in &rows {
            let r = TextRow(r);
            let kind = match r.str(1).as_str() {
                "r" | "p" => ObjectKind::Table,
                "v" => ObjectKind::View,
                "m" => ObjectKind::MaterializedView,
                "f" => ObjectKind::ForeignTable,
                _ => ObjectKind::Sequence,
            };
            out.push(DbObject {
                schema: schema.into(),
                name: r.str(0),
                kind,
                comment: r.opt(2),
                estimated_rows: if kind == ObjectKind::Table { r.i64(3) } else { None },
            });
        }
        let rows = self
            .rows(
                "SELECT DISTINCT p.proname::text, p.prokind::text FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY 1",
                &[Some(schema.into())],
            )
            .await
            // pg_proc.prokind exists from PostgreSQL 11; older servers fall back to functions only.
            .or_else(|_| Ok::<_, AppError>(Vec::new()))?;
        for r in &rows {
            let r = TextRow(r);
            out.push(DbObject {
                schema: schema.into(),
                name: r.str(0),
                kind: if r.str(1) == "p" { ObjectKind::Procedure } else { ObjectKind::Function },
                comment: None,
                estimated_rows: None,
            });
        }
        Ok(out)
    }

    async fn table_structure(&mut self, schema: &str, name: &str) -> Result<TableStructure> {
        let oid = self.relation_oid(schema, name).await?;
        let oid_param = || vec![Some(oid.clone())];

        let kind_rows = self.rows("SELECT relkind::text FROM pg_class WHERE oid = $1::oid", &oid_param()).await?;
        let kind = match kind_rows.first().map(|r| TextRow(r).str(0)).as_deref() {
            Some("v") => ObjectKind::View,
            Some("m") => ObjectKind::MaterializedView,
            Some("f") => ObjectKind::ForeignTable,
            _ => ObjectKind::Table,
        };

        let columns = self
            .rows(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text, \
                        pg_get_expr(d.adbin, d.adrelid), \
                        (SELECT array_position(i.indkey::int2[], a.attnum) FROM pg_index i \
                           WHERE i.indrelid = a.attrelid AND i.indisprimary)::text, \
                        (a.attidentity <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%')::text, \
                        col_description(a.attrelid, a.attnum) \
                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
                &oid_param(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                ColumnInfo {
                    name: r.str(0),
                    data_type: r.str(1),
                    nullable: r.bool(2),
                    default: r.opt(3),
                    primary_key: r.i64(4).map(|p| p as u32),
                    auto_increment: r.bool(5),
                    comment: r.opt(6),
                }
            })
            .collect();

        let indexes = self
            .rows(
                "SELECT ic.relname::text, \
                        array_to_string(ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) \
                          FROM generate_series(1, i.indnatts) k ORDER BY k), E'\\x1f'), \
                        i.indisunique::text, i.indisprimary::text, pg_get_indexdef(i.indexrelid) \
                 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid \
                 WHERE i.indrelid = $1::oid ORDER BY i.indisprimary DESC, ic.relname",
                &oid_param(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                IndexInfo {
                    name: r.str(0),
                    columns: split_list(&r.str(1)),
                    unique: r.bool(2),
                    primary: r.bool(3),
                    definition: r.opt(4),
                }
            })
            .collect();

        let foreign_keys = self
            .rows(
                "SELECT con.conname::text, \
                   array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o) \
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), E'\\x1f'), \
                   fn.nspname::text, fc.relname::text, \
                   array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o) \
                     JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), E'\\x1f'), \
                   con.confupdtype::text, con.confdeltype::text \
                 FROM pg_constraint con JOIN pg_class fc ON fc.oid = con.confrelid \
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                 WHERE con.conrelid = $1::oid AND con.contype = 'f' ORDER BY con.conname",
                &oid_param(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                ForeignKeyInfo {
                    name: r.str(0),
                    columns: split_list(&r.str(1)),
                    ref_schema: r.str(2),
                    ref_table: r.str(3),
                    ref_columns: split_list(&r.str(4)),
                    on_update: fk_action(&r.str(5)),
                    on_delete: fk_action(&r.str(6)),
                }
            })
            .collect();

        let constraints = self
            .rows(
                "SELECT conname::text, contype::text, pg_get_constraintdef(oid, true) FROM pg_constraint \
                 WHERE conrelid = $1::oid ORDER BY contype, conname",
                &oid_param(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                ConstraintInfo {
                    name: r.str(0),
                    kind: match r.str(1).as_str() {
                        "p" => "primary_key",
                        "f" => "foreign_key",
                        "u" => "unique",
                        "c" => "check",
                        "x" => "exclusion",
                        _ => "other",
                    }
                    .into(),
                    definition: r.str(2),
                }
            })
            .collect();

        let triggers = self
            .rows(
                "SELECT tgname::text, pg_get_triggerdef(oid, true) FROM pg_trigger \
                 WHERE tgrelid = $1::oid AND NOT tgisinternal ORDER BY tgname",
                &oid_param(),
            )
            .await?
            .iter()
            .map(|r| {
                let r = TextRow(r);
                let def = r.str(1);
                let (timing, event) = trigger_timing_event(&def);
                TriggerInfo { name: r.str(0), timing, event, definition: def }
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
        let d = Dialect::Postgres;
        match kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                let oid = self.relation_oid(schema, name).await?;
                let rows = self.rows("SELECT pg_get_viewdef($1::oid, true)", &[Some(oid)]).await?;
                let body = rows.first().map(|r| TextRow(r).str(0)).unwrap_or_default();
                let head = if kind == ObjectKind::View { "CREATE OR REPLACE VIEW" } else { "CREATE MATERIALIZED VIEW" };
                Ok(format!("{head} {} AS\n{}", d.qualified(Some(schema), name)?, body.trim_end()))
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let rows = self
                    .rows(
                        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                         WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid",
                        &[Some(schema.into()), Some(name.into())],
                    )
                    .await?;
                Ok(rows.iter().map(|r| format!("{};", TextRow(r).str(0).trim_end())).collect::<Vec<_>>().join("\n\n"))
            }
            ObjectKind::Sequence => {
                let rows = self
                    .rows(
                        "SELECT data_type::text, start_value::text, min_value::text, max_value::text, \
                                increment_by::text, cycle::text, cache_size::text \
                         FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2",
                        &[Some(schema.into()), Some(name.into())],
                    )
                    .await?;
                let r = rows.first().ok_or_else(|| AppError::not_found("Sequence not found"))?;
                let r = TextRow(r);
                Ok(format!(
                    "CREATE SEQUENCE {} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {}{};",
                    d.qualified(Some(schema), name)?,
                    r.str(0),
                    r.str(4),
                    r.str(2),
                    r.str(3),
                    r.str(1),
                    r.str(6),
                    if r.bool(5) { " CYCLE" } else { "" }
                ))
            }
            ObjectKind::Table | ObjectKind::ForeignTable => {
                let s = self.table_structure(schema, name).await?;
                crate::ddl::create_table_sql(Dialect::Postgres, &s)
            }
        }
    }

    async fn describe_origins(&mut self, sql: &str) -> Result<Vec<Option<ColumnOrigin>>> {
        // Describe only: prepare parses and plans the statement but never executes it.
        let stmt = self.client.prepare(sql).await.map_err(map_error)?;
        let cols: Vec<(Option<u32>, Option<i16>)> = stmt.columns().iter().map(|c| (c.table_oid(), c.column_id())).collect();
        let missing: Vec<u32> = {
            let mut m: Vec<u32> = cols
                .iter()
                .filter_map(|(t, a)| match (t, a) {
                    (Some(t), Some(a)) if !self.origin_names.contains_key(&(*t, *a)) => Some(*t),
                    _ => None,
                })
                .collect();
            m.sort_unstable();
            m.dedup();
            m
        };
        if !missing.is_empty() {
            let rows = self
                .client
                .query(
                    "SELECT a.attrelid, a.attnum, n.nspname, c.relname, a.attname FROM pg_attribute a \
                     JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped",
                    &[&missing],
                )
                .await
                .map_err(map_error)?;
            for r in rows {
                let oid: u32 = r.get(0);
                let attnum: i16 = r.get(1);
                self.origin_names.insert((oid, attnum), (r.get(2), r.get(3), r.get(4)));
            }
        }
        Ok(cols
            .into_iter()
            .map(|(t, a)| match (t, a) {
                (Some(t), Some(a)) => self
                    .origin_names
                    .get(&(t, a))
                    .map(|(s, tb, c)| ColumnOrigin { schema: s.clone(), table: tb.clone(), column: c.clone() }),
                _ => None,
            })
            .collect())
    }

    async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<StatementOutcome>> {
        let stream = self.client.simple_query_raw(sql).await.map_err(map_error)?;
        pin_mut!(stream);
        let mut outcomes = Vec::new();
        let mut current: Option<RowSet> = None;
        let mut cancelled_for_cap = false;
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(SimpleQueryMessage::RowDescription(cols)) => {
                    current = Some(RowSet {
                        columns: cols.iter().map(|c| ColumnMeta::new(c.name(), "")).collect(),
                        ..Default::default()
                    });
                }
                Ok(SimpleQueryMessage::Row(row)) => {
                    let rs = current.get_or_insert_with(|| RowSet {
                        columns: row.columns().iter().map(|c| ColumnMeta::new(c.name(), "")).collect(),
                        ..Default::default()
                    });
                    if rs.rows.len() < max_rows {
                        rs.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map_or(Cell::Null, |v| Cell::Text(v.to_string())))
                                .collect(),
                        );
                    } else if !rs.truncated {
                        // Stop the server from producing rows we will not keep.
                        rs.truncated = true;
                        cancelled_for_cap = true;
                        let _ = self.canceller.cancel().await;
                    }
                }
                Ok(SimpleQueryMessage::CommandComplete(n)) => match current.take() {
                    Some(rows) => outcomes.push(StatementOutcome::Rows { rows }),
                    None => outcomes.push(StatementOutcome::Affected { rows_affected: n }),
                },
                Ok(_) => {}
                Err(e) => {
                    if cancelled_for_cap && e.code() == Some(&SqlState::QUERY_CANCELED) {
                        if let Some(rows) = current.take() {
                            outcomes.push(StatementOutcome::Rows { rows });
                        }
                        break;
                    }
                    return Err(map_error(e));
                }
            }
        }
        if let Some(rows) = current.take() {
            outcomes.push(StatementOutcome::Rows { rows });
        }
        Ok(outcomes)
    }

    async fn query(&mut self, sql: &str, params: &[Param], max_rows: usize) -> Result<RowSet> {
        let text_params: Vec<TextParam> = params.iter().map(|p| TextParam(p.as_deref())).collect();
        let refs: Vec<&(dyn ToSql + Sync)> = text_params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
        let stmt = self.client.prepare(sql).await.map_err(map_error)?;
        let columns = stmt.columns().iter().map(|c| ColumnMeta::new(c.name(), c.type_().name())).collect();
        let stream = self.client.query_raw(&stmt, refs).await.map_err(map_error)?;
        pin_mut!(stream);
        let mut rs = RowSet { columns, ..Default::default() };
        while let Some(row) = stream.next().await {
            let row = row.map_err(map_error)?;
            if rs.rows.len() >= max_rows {
                rs.truncated = true;
                break;
            }
            rs.rows.push(
                (0..row.len())
                    .map(|i| row.try_get::<_, PgCell>(i).map(|c| c.0).map_err(map_error))
                    .collect::<Result<_>>()?,
            );
        }
        Ok(rs)
    }

    async fn apply(&mut self, statements: &[ParamStatement], atomic: bool) -> Result<Vec<u64>> {
        if atomic {
            self.client.batch_execute("BEGIN").await.map_err(map_error)?;
        }
        let mut counts = Vec::with_capacity(statements.len());
        for st in statements {
            let text_params: Vec<TextParam> = st.params.iter().map(|p| TextParam(p.as_deref())).collect();
            let refs: Vec<&(dyn ToSql + Sync)> = text_params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
            let result = self.client.execute(st.sql.as_str(), &refs).await.map_err(map_error);
            let failure = match result {
                Ok(n) => match st.expect_rows {
                    Some(expected) if expected != n => Some(conflict_error(expected, n)),
                    _ => {
                        counts.push(n);
                        None
                    }
                },
                Err(e) => Some(e),
            };
            if let Some(err) = failure {
                if atomic {
                    let _ = self.client.batch_execute("ROLLBACK").await;
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
            self.client.batch_execute("COMMIT").await.map_err(map_error)?;
        }
        Ok(counts)
    }

    async fn close(self: Box<Self>) {
        drop(self.client);
    }
}

pub(crate) fn conflict_error(expected: u64, actual: u64) -> AppError {
    AppError::new(
        ErrorKind::Conflict,
        if actual == 0 {
            "The row was changed or deleted by someone else since it was loaded. Reload and try again.".to_string()
        } else {
            format!("Expected to change {expected} row(s) but {actual} matched; nothing was committed.")
        },
    )
}

fn fk_action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .into()
}

fn trigger_timing_event(def: &str) -> (String, String) {
    let upper = def.to_ascii_uppercase();
    let timing = ["INSTEAD OF", "BEFORE", "AFTER"]
        .iter()
        .find(|t| upper.contains(&format!(" {t} ")))
        .map(|t| t.to_string())
        .unwrap_or_default();
    let events: Vec<&str> =
        ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].into_iter().filter(|e| upper.contains(&format!(" {e}"))).collect();
    (timing, events.join(" OR "))
}

/// A bind parameter sent in text format; the server converts it to whatever type the
/// statement expects, exactly as it would a quoted literal.
#[derive(Debug)]
struct TextParam<'a>(Option<&'a str>);

impl ToSql for TextParam<'_> {
    fn to_sql(&self, _ty: &Type, out: &mut BytesMut) -> std::result::Result<IsNull, Box<dyn StdError + Sync + Send>> {
        match self.0 {
            Some(s) => {
                out.extend_from_slice(s.as_bytes());
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    tokio_postgres::types::to_sql_checked!();
}

/// Decodes binary result values of the types the generated queries produce. Generated
/// queries cast everything except `bytea` to text, so the set of types is small.
struct PgCell(Cell);

impl<'a> FromSql<'a> for PgCell {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> std::result::Result<Self, Box<dyn StdError + Sync + Send>> {
        let text = |s: String| Ok(PgCell(Cell::Text(s)));
        match *ty {
            Type::BOOL => text(if raw.first() == Some(&1) { "true".into() } else { "false".into() }),
            Type::INT2 => text(i16::from_sql(ty, raw)?.to_string()),
            Type::INT4 => text(i32::from_sql(ty, raw)?.to_string()),
            Type::INT8 => text(i64::from_sql(ty, raw)?.to_string()),
            Type::OID => text(u32::from_sql(ty, raw)?.to_string()),
            Type::FLOAT4 => text(f32::from_sql(ty, raw)?.to_string()),
            Type::FLOAT8 => text(f64::from_sql(ty, raw)?.to_string()),
            Type::BYTEA => Ok(PgCell(Cell::Bytes(raw.to_vec()))),
            Type::JSONB => text(String::from_utf8_lossy(raw.get(1..).unwrap_or_default()).into_owned()),
            _ if matches!(ty.kind(), Kind::Enum(_)) || is_textual(ty) => {
                text(String::from_utf8_lossy(raw).into_owned())
            }
            _ => Err(format!("unsupported column type {}; cast it to text", ty.name()).into()),
        }
    }

    fn from_sql_null(_ty: &Type) -> std::result::Result<Self, Box<dyn StdError + Sync + Send>> {
        Ok(PgCell(Cell::Null))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

fn is_textual(ty: &Type) -> bool {
    matches!(*ty, Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN | Type::JSON | Type::CHAR)
        || matches!(ty.name(), "citext" | "ltree" | "lquery" | "ltxtquery")
}

pub(crate) fn map_error(e: tokio_postgres::Error) -> AppError {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code();
        let kind = match &code[..2.min(code.len())] {
            "23" => ErrorKind::Constraint,
            "28" => ErrorKind::Authentication,
            "08" => ErrorKind::Network,
            "3D" => ErrorKind::InvalidConfig,
            "57" if code == "57014" => ErrorKind::Cancelled,
            "25" if code == "25006" => ErrorKind::PolicyViolation,
            _ => ErrorKind::Database,
        };
        let mut detail = Vec::new();
        if let Some(d) = db.detail() {
            detail.push(format!("Detail: {d}"));
        }
        if let Some(h) = db.hint() {
            detail.push(format!("Hint: {h}"));
        }
        if let Some(w) = db.where_() {
            detail.push(format!("Context: {w}"));
        }
        let position = match db.position() {
            Some(ErrorPosition::Original(p)) => Some(*p),
            _ => None,
        };
        let mut err = AppError::new(kind, db.message()).with_code(code).with_position(position);
        if !detail.is_empty() {
            err = err.with_detail(detail.join("\n"));
        }
        return err;
    }
    if e.is_closed() {
        return AppError::new(ErrorKind::Network, "The connection to the server was closed");
    }
    // Walk the source chain to distinguish TLS and network failures.
    let mut source: Option<&(dyn StdError + 'static)> = e.source();
    while let Some(s) = source {
        if s.downcast_ref::<rustls::Error>().is_some() {
            return AppError::new(ErrorKind::Tls, format!("TLS error: {s}"));
        }
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            if let Some(inner) = io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
                return AppError::new(ErrorKind::Tls, format!("TLS error: {inner}"));
            }
            return AppError::new(ErrorKind::Network, format!("Network error: {io}"));
        }
        source = s.source();
    }
    let msg = e.to_string();
    let kind = if msg.contains("timed out") {
        ErrorKind::Network
    } else if msg.contains("TLS") || msg.contains("tls") || msg.contains("ssl") {
        ErrorKind::Tls
    } else if msg.contains("password") {
        ErrorKind::Authentication
    } else {
        ErrorKind::Database
    };
    AppError::new(kind, msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_parsing() {
        let (t, e) = trigger_timing_event(
            "CREATE TRIGGER x BEFORE INSERT OR UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION f()",
        );
        assert_eq!(t, "BEFORE");
        assert_eq!(e, "INSERT OR UPDATE");
    }
}
