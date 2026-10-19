//! Restore points, part 1: which statements can keep a restore point, and the SQL that captures
//! their rows. See docs/superpowers/specs/2026-10-14-restore-history-design.md.

use sqlparser::ast::{
    AlterTableOperation, Assignment, AssignmentTarget, ConflictTarget, Expr, FromTable, Ident, Insert, ObjectName,
    ObjectType, OnConflictAction, OnInsert, SetExpr, SqliteOnConflict, Statement, TableFactor, TableObject,
    UnaryOperator, Value,
};
use sqlparser::parser::Parser;

use crate::config::Driver;
use crate::dialect::Dialect;
use crate::error::Result;
use crate::large_values::is_binary_type;
use crate::model::{ColumnInfo, TableStructure};

pub const JOINS: &str = "joins other tables";
pub const ORDER_LIMIT: &str = "uses ORDER BY or LIMIT";
pub const WITH: &str = "uses a WITH clause";
pub const CHANGES_KEY: &str = "changes the primary key";
pub const NO_KEY: &str = "the table has no primary key";
pub const UNREADABLE: &str = "the statement could not be analysed";
pub const TABLE_UNREADABLE: &str = "the table could not be read";
pub const MULTI: &str = "names more than one table";
pub const COMBINED: &str = "combines several changes";
pub const BINARY: &str = "the table has binary columns";
pub const MERGE: &str = "uses MERGE";
pub const DROPS_KEY: &str = "drops a primary-key column";
pub const DROPPED_UNCLEAR: &str = "the dropped column could not be identified";
pub const UPSERT_QUERY: &str = "the upsert's rows come from a query";
pub const UPSERT_CONSTRAINT: &str = "the upsert names a constraint, not columns";
pub const UPSERT_KEY: &str = "the upsert's key values are not plain values";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    Update,
    Delete,
    Truncate,
    DropTable,
    DropColumn,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableRef {
    pub schema: Option<String>,
    pub name: String,
    /// The table as the user wrote it (quoting kept), reused verbatim in the capture SQL.
    pub sql: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CapturePlan {
    pub kind: CaptureKind,
    pub table: TableRef,
    pub alias: Option<String>,
    pub where_sql: Option<String>,
    pub set_columns: Vec<String>,
    pub column: Option<String>,
    /// An upsert: its rows are found by the keys they hold, not by a WHERE.
    pub upsert: Option<Box<Upsert>>,
}

/// The rows an upsert (`INSERT … ON CONFLICT`, `ON DUPLICATE KEY UPDATE`, `REPLACE`) inserts,
/// from which the existing rows it may overwrite are found before it runs.
#[derive(Debug, Clone, PartialEq)]
pub struct Upsert {
    /// The inserted columns as named; empty means the table's columns in order.
    pub columns: Vec<String>,
    /// Each row's values: the literal as written, or `None` for any other expression.
    pub rows: Vec<Vec<Option<String>>>,
    /// `ON CONFLICT (columns)`; `None` when any unique key may conflict.
    pub target: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanOutcome {
    /// Not a statement restore points cover (reads, inserts, other DDL).
    None,
    Capture(CapturePlan),
    Unsupported(String),
}

fn table_ref(name: &ObjectName) -> TableRef {
    let parts: Vec<String> = name.0.iter().map(|p| p.as_ident().map(|i| i.value.clone()).unwrap_or_default()).collect();
    let (table, schema) = match parts.split_last() {
        Some((t, rest)) => (t.clone(), rest.last().cloned()),
        None => (String::new(), None),
    };
    TableRef { schema, name: table, sql: name.to_string() }
}

fn new_plan(kind: CaptureKind, table: TableRef) -> CapturePlan {
    CapturePlan { kind, table, alias: None, where_sql: None, set_columns: vec![], column: None, upsert: None }
}

/// Statements whose leading keyword means they change rows or drop things.
fn looks_capturable(sql: &str) -> bool {
    let first = sql.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase();
    matches!(first.as_str(), "UPDATE" | "DELETE" | "TRUNCATE" | "DROP" | "ALTER" | "WITH")
}

fn unsupported(reason: &str) -> PlanOutcome {
    PlanOutcome::Unsupported(reason.into())
}

/// Decides whether one statement can keep a restore point, and how its rows are found.
pub fn plan_statement(sql: &str, dialect: Dialect) -> PlanOutcome {
    let parser_dialect = dialect.parser();
    let stmts = match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(s) if s.len() == 1 => s,
        _ => return if looks_capturable(sql) { unsupported(UNREADABLE) } else { PlanOutcome::None },
    };
    match &stmts[0] {
        Statement::Update(u) => {
            if !u.table.joins.is_empty() || u.from.is_some() {
                return unsupported(JOINS);
            }
            if !u.order_by.is_empty() || u.limit.is_some() {
                return unsupported(ORDER_LIMIT);
            }
            let TableFactor::Table { name, alias, .. } = &u.table.relation else {
                return unsupported(UNREADABLE);
            };
            let mut p = new_plan(CaptureKind::Update, table_ref(name));
            p.alias = alias.as_ref().map(|a| a.name.to_string());
            p.where_sql = u.selection.as_ref().map(|e| e.to_string());
            p.set_columns = u
                .assignments
                .iter()
                .flat_map(|a| match &a.target {
                    AssignmentTarget::ColumnName(n) => vec![table_ref(n).name],
                    AssignmentTarget::Tuple(ns) => ns.iter().map(|n| table_ref(n).name).collect(),
                })
                .collect();
            PlanOutcome::Capture(p)
        }
        Statement::Delete(d) => {
            let (FromTable::WithFromKeyword(from) | FromTable::WithoutKeyword(from)) = &d.from;
            if d.using.is_some() || !d.tables.is_empty() || from.len() != 1 || !from[0].joins.is_empty() {
                return unsupported(JOINS);
            }
            if !d.order_by.is_empty() || d.limit.is_some() {
                return unsupported(ORDER_LIMIT);
            }
            let TableFactor::Table { name, alias, .. } = &from[0].relation else {
                return unsupported(UNREADABLE);
            };
            let mut p = new_plan(CaptureKind::Delete, table_ref(name));
            p.alias = alias.as_ref().map(|a| a.name.to_string());
            p.where_sql = d.selection.as_ref().map(|e| e.to_string());
            PlanOutcome::Capture(p)
        }
        Statement::Truncate(t) => match t.table_names.as_slice() {
            [one] => PlanOutcome::Capture(new_plan(CaptureKind::Truncate, table_ref(&one.name))),
            _ => unsupported(MULTI),
        },
        Statement::Drop { object_type: ObjectType::Table, names, .. } => match names.as_slice() {
            [one] => PlanOutcome::Capture(new_plan(CaptureKind::DropTable, table_ref(one))),
            _ => unsupported(MULTI),
        },
        Statement::AlterTable(a) => {
            if !a.operations.iter().any(|o| matches!(o, AlterTableOperation::DropColumn { .. })) {
                return PlanOutcome::None;
            }
            match a.operations.as_slice() {
                [AlterTableOperation::DropColumn { column_names, .. }] if column_names.len() == 1 => {
                    let mut p = new_plan(CaptureKind::DropColumn, table_ref(&a.name));
                    let name = &column_names[0];
                    // PostgreSQL folds unquoted names to lower case; quoted names are exact.
                    p.column = Some(if name.quote_style.is_none() && dialect == Dialect::Postgres {
                        name.value.to_lowercase()
                    } else {
                        name.value.clone()
                    });
                    PlanOutcome::Capture(p)
                }
                _ => unsupported(COMBINED),
            }
        }
        Statement::Query(q) if matches!(*q.body, SetExpr::Update(_) | SetExpr::Delete(_)) => unsupported(WITH),
        Statement::Merge(_) => unsupported(MERGE),
        Statement::Insert(i) => plan_upsert(i, dialect),
        _ => PlanOutcome::None,
    }
}

/// An identifier as the database stores it: PostgreSQL folds unquoted names to lower case.
fn ident_name(i: &Ident, dialect: Dialect) -> String {
    if i.quote_style.is_none() && dialect == Dialect::Postgres { i.value.to_lowercase() } else { i.value.clone() }
}

fn assigned_columns(assignments: &[Assignment]) -> Vec<String> {
    assignments
        .iter()
        .flat_map(|a| match &a.target {
            AssignmentTarget::ColumnName(n) => vec![table_ref(n).name],
            AssignmentTarget::Tuple(ns) => ns.iter().map(|n| table_ref(n).name).collect(),
        })
        .collect()
}

/// A value an upsert's key can be looked up by: a literal (a negative number too), not a
/// placeholder or any other expression.
fn literal(e: &Expr) -> Option<String> {
    match e {
        Expr::Value(v) if !matches!(v.value, Value::Placeholder(_)) => Some(v.to_string()),
        Expr::UnaryOp { op: UnaryOperator::Minus, expr } => match expr.as_ref() {
            Expr::Value(v) if matches!(v.value, Value::Number(..)) => Some(format!("-{v}")),
            _ => None,
        },
        _ => None,
    }
}

/// Upserts overwrite existing rows; a plain INSERT (or one that does nothing on a conflict) doesn't.
fn plan_upsert(i: &Insert, dialect: Dialect) -> PlanOutcome {
    let replaces = i.replace_into || matches!(i.or, Some(SqliteOnConflict::Replace));
    let (target, set_columns) = match &i.on {
        Some(OnInsert::OnConflict(c)) => match &c.action {
            OnConflictAction::DoNothing => return PlanOutcome::None,
            OnConflictAction::DoUpdate(u) => match &c.conflict_target {
                Some(ConflictTarget::Columns(cols)) => {
                    (Some(cols.iter().map(|c| ident_name(c, dialect)).collect()), assigned_columns(&u.assignments))
                }
                Some(ConflictTarget::OnConstraint(_)) => return unsupported(UPSERT_CONSTRAINT),
                None => (None, assigned_columns(&u.assignments)),
            },
        },
        Some(OnInsert::DuplicateKeyUpdate(a)) => (None, assigned_columns(a)),
        None if replaces => (None, vec![]),
        _ => return PlanOutcome::None,
    };
    let TableObject::TableName(name) = &i.table else { return unsupported(UNREADABLE) };
    let Some(source) = &i.source else { return unsupported(UNREADABLE) };
    if source.with.is_some() {
        return unsupported(WITH);
    }
    let SetExpr::Values(values) = source.body.as_ref() else { return unsupported(UPSERT_QUERY) };
    let columns = i
        .columns
        .iter()
        .map(|c| c.0.last().and_then(|p| p.as_ident()).map(|i| ident_name(i, dialect)).unwrap_or_default())
        .collect();
    let rows = values.rows.iter().map(|r| r.content.iter().map(literal).collect()).collect();
    let mut p = new_plan(CaptureKind::Update, table_ref(name));
    p.set_columns = set_columns;
    p.upsert = Some(Box::new(Upsert { columns, rows, target }));
    PlanOutcome::Capture(p)
}

/// The keys an upsert's rows can conflict on, as the table's own column names: its target, or
/// else the primary key and each unique index, among those whose columns it inserts.
fn upsert_keys<'a>(u: &Upsert, s: &'a TableStructure) -> Vec<Vec<&'a ColumnInfo>> {
    let column = |name: &str| {
        s.columns
            .iter()
            .find(|c| c.name == name)
            .or_else(|| s.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name)))
    };
    let resolve = |names: &[String]| -> Option<Vec<&'a ColumnInfo>> { names.iter().map(|n| column(n)).collect() };
    let mut keys: Vec<Vec<&'a ColumnInfo>> = Vec::new();
    let pk: Vec<&ColumnInfo> = s.primary_key();
    let unique: Vec<Vec<&ColumnInfo>> =
        s.indexes.iter().filter(|i| i.unique && !i.primary).filter_map(|i| resolve(&i.columns)).collect();
    let same = |a: &[&ColumnInfo], b: &[&ColumnInfo]| {
        a.len() == b.len() && a.iter().all(|x| b.iter().any(|y| y.name == x.name))
    };
    match &u.target {
        Some(t) => {
            // The target must be a key of the table; otherwise its rows can't be told apart.
            if let Some(t) = resolve(t)
                && (same(&t, &pk) || unique.iter().any(|k| same(&t, k)))
            {
                keys.push(t);
            }
        }
        None => {
            if !pk.is_empty() {
                keys.push(pk);
            }
            keys.extend(unique);
        }
    }
    let inserted: Vec<&str> = if u.columns.is_empty() {
        s.columns.iter().map(|c| c.name.as_str()).collect()
    } else {
        u.columns.iter().map(String::as_str).collect()
    };
    keys.retain(|k| k.iter().all(|c| inserted.iter().any(|i| i.eq_ignore_ascii_case(&c.name))));
    keys
}

/// The WHERE that finds the existing rows an upsert may overwrite; `None` when a key value is
/// not a plain value, or no key can be matched.
fn upsert_where(u: &Upsert, s: &TableStructure, dialect: Dialect) -> Option<String> {
    let keys = upsert_keys(u, s);
    if keys.is_empty() {
        return None;
    }
    let position = |name: &str| -> Option<usize> {
        if u.columns.is_empty() {
            s.columns.iter().position(|c| c.name == name)
        } else {
            u.columns.iter().position(|c| c.eq_ignore_ascii_case(name))
        }
    };
    let mut rows = Vec::with_capacity(u.rows.len());
    for row in &u.rows {
        let mut terms = Vec::with_capacity(keys.len());
        for key in &keys {
            let mut parts = Vec::with_capacity(key.len());
            for c in key {
                let value = row.get(position(&c.name)?)?.as_ref()?;
                parts.push(format!("{} = {value}", dialect.quote_ident(&c.name).ok()?));
            }
            terms.push(parts.join(" AND "));
        }
        rows.push(format!("({})", terms.join(" OR ")));
    }
    Some(rows.join(" OR "))
}

/// The statement's own WHERE, or for an upsert the one built from its keys.
fn plan_where(plan: &CapturePlan, s: &TableStructure, dialect: Dialect) -> Result<Option<String>> {
    match &plan.upsert {
        None => Ok(plan.where_sql.clone()),
        Some(u) => {
            upsert_where(u, s, dialect).map(Some).ok_or_else(|| crate::error::AppError::invalid_config(UPSERT_KEY))
        }
    }
}

/// Reasons the table itself rules out a restore point for this plan.
pub fn structure_reason(plan: &CapturePlan, s: &TableStructure, driver: Driver) -> Option<String> {
    let pk: Vec<&str> = s.primary_key().iter().map(|c| c.name.as_str()).collect();
    if matches!(plan.kind, CaptureKind::Update | CaptureKind::DropColumn) && pk.is_empty() {
        return Some(NO_KEY.into());
    }
    if plan.kind == CaptureKind::DropColumn {
        match dropped_column(plan, s) {
            None => return Some(DROPPED_UNCLEAR.into()),
            Some(c) if c.primary_key.is_some() => return Some(DROPS_KEY.into()),
            Some(_) => {}
        }
    }
    if plan.kind == CaptureKind::Update && plan.set_columns.iter().any(|c| pk.iter().any(|k| k.eq_ignore_ascii_case(c)))
    {
        return Some(CHANGES_KEY.into());
    }
    if let Some(u) = &plan.upsert
        && upsert_where(u, s, driver.dialect()).is_none()
    {
        return Some(UPSERT_KEY.into());
    }
    if has_binary_columns(s, driver) {
        return Some(BINARY.into());
    }
    None
}

/// PostgreSQL reads bytea back as `\x` hex text, which round-trips; other engines would not.
pub fn has_binary_columns(s: &TableStructure, driver: Driver) -> bool {
    driver != Driver::Postgres && s.columns.iter().any(|c| is_binary_type(&c.data_type))
}

fn from_sql(plan: &CapturePlan) -> String {
    match &plan.alias {
        Some(a) => format!("{} AS {a}", plan.table.sql),
        None => plan.table.sql.clone(),
    }
}

/// The columns a capture reads, in order: all of them, or for DROP COLUMN the key and the
/// dropped column.
pub fn capture_columns<'a>(plan: &CapturePlan, s: &'a TableStructure) -> Vec<&'a ColumnInfo> {
    match plan.kind {
        CaptureKind::DropColumn => {
            let dropped = dropped_column(plan, s).map(|c| c.name.as_str());
            s.columns.iter().filter(|x| x.primary_key.is_some() || Some(x.name.as_str()) == dropped).collect()
        }
        _ => s.columns.iter().collect(),
    }
}

/// The column a DROP COLUMN removes: the exact name, or else the one column matching it
/// case-insensitively (MySQL, SQLite and DuckDB compare names that way). `None` when there is no
/// such column, or more than one candidate.
pub fn dropped_column<'a>(plan: &CapturePlan, s: &'a TableStructure) -> Option<&'a ColumnInfo> {
    let name = plan.column.as_deref()?;
    if let Some(c) = s.columns.iter().find(|c| c.name == name) {
        return Some(c);
    }
    let mut similar = s.columns.iter().filter(|c| c.name.eq_ignore_ascii_case(name));
    match (similar.next(), similar.next()) {
        (Some(c), None) => Some(c),
        _ => None,
    }
}

/// The SELECT that reads the rows a statement is about to change (the user's own WHERE).
pub fn capture_select(plan: &CapturePlan, s: &TableStructure, dialect: Dialect, lock: bool) -> Result<String> {
    let qual = plan.alias.clone().unwrap_or_else(|| plan.table.sql.clone());
    let cols = capture_columns(plan, s);
    let mut select = Vec::with_capacity(cols.len());
    for c in cols {
        let q = dialect.quote_ident(&c.name)?;
        select.push(match dialect {
            // Text everywhere (bytea too, as \x hex) so every value round-trips as a parameter.
            Dialect::Postgres => format!("{qual}.{q}::text AS {q}"),
            _ => dialect.read_column(&format!("{qual}.{q}"), &q, &c.data_type),
        });
    }
    let mut sql = format!("SELECT {} FROM {}", select.join(", "), from_sql(plan));
    // SQL Server locks with a table hint instead of FOR UPDATE.
    if lock && dialect == Dialect::Mssql {
        sql.push_str(" WITH (UPDLOCK, HOLDLOCK)");
    }
    if let Some(w) = plan_where(plan, s, dialect)? {
        sql.push_str(&format!(" WHERE {w}"));
    }
    if lock && dialect != Dialect::Mssql {
        sql.push_str(" FOR UPDATE");
    }
    Ok(sql)
}

/// Counts (at most `limit + 1` of) the rows a statement will change, before anything runs, and
/// estimates their size as the capture would store it. Bounded, so a huge table is never scanned.
pub fn count_select(plan: &CapturePlan, s: &TableStructure, driver: Driver, limit: u64) -> Result<String> {
    let dialect = driver.dialect();
    let qual = plan.alias.clone().unwrap_or_else(|| plan.table.sql.clone());
    let mut sizes = Vec::new();
    for c in capture_columns(plan, s) {
        let col = format!("{qual}.{}", dialect.quote_ident(&c.name)?);
        sizes.push(match driver {
            Driver::Postgres => format!("COALESCE(octet_length({col}::text), 0)"),
            Driver::Mysql | Driver::Mariadb => format!("COALESCE(LENGTH({col}), 0)"),
            Driver::Sqlite => format!("COALESCE(length(CAST({col} AS BLOB)), 0)"),
            Driver::Mssql => format!("COALESCE(DATALENGTH({col}), 0)"),
            _ => format!("COALESCE(strlen(CAST({col} AS VARCHAR)), 0)"),
        });
    }
    let size = if sizes.is_empty() { "0".to_string() } else { sizes.join(" + ") };
    let bound = limit.saturating_add(1);
    let top = if driver == Driver::Mssql { format!("TOP ({bound}) ") } else { String::new() };
    let mut inner = format!("SELECT {top}{size} AS rp_size FROM {}", from_sql(plan));
    if driver == Driver::Mssql {
        // An estimate: it must not wait behind another session's open transaction.
        inner.push_str(" WITH (NOLOCK)");
    }
    if let (Some(w), CaptureKind::Update | CaptureKind::Delete) = (plan_where(plan, s, dialect)?, plan.kind) {
        inner.push_str(&format!(" WHERE {w}"));
    }
    if driver == Driver::Mssql {
        // DATALENGTH is an int: sum the rows as bigint.
        return Ok(format!("SELECT count(*), COALESCE(sum(CAST(rp_size AS bigint)), 0) FROM ({inner}) AS rp_count"));
    }
    inner.push_str(&format!(" LIMIT {bound}"));
    Ok(format!("SELECT count(*), COALESCE(sum(rp_size), 0) FROM ({inner}) AS rp_count"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnInfo, ObjectKind};

    fn plan(sql: &str) -> PlanOutcome {
        plan_statement(sql, Dialect::Postgres)
    }
    fn cap(sql: &str) -> CapturePlan {
        match plan(sql) {
            PlanOutcome::Capture(p) => p,
            other => panic!("{sql}: {other:?}"),
        }
    }
    fn col(name: &str, ty: &str, pk: Option<u32>) -> ColumnInfo {
        ColumnInfo {
            enum_values: Vec::new(),
            name: name.into(),
            data_type: ty.into(),
            nullable: pk.is_none(),
            default: None,
            primary_key: pk,
            auto_increment: false,
            comment: None,
            generated: false,
        }
    }
    fn orders() -> TableStructure {
        TableStructure {
            schema: "public".into(),
            name: "orders".into(),
            kind: ObjectKind::Table,
            columns: vec![col("id", "integer", Some(1)), col("status", "text", None), col("doc", "bytea", None)],
            ..Default::default()
        }
    }

    fn users() -> TableStructure {
        use crate::model::IndexInfo;
        TableStructure {
            name: "users".into(),
            columns: vec![col("id", "integer", Some(1)), col("email", "text", None), col("name", "text", None)],
            indexes: vec![IndexInfo {
                name: "users_email".into(),
                columns: vec!["email".into()],
                unique: true,
                primary: false,
                definition: None,
            }],
            ..orders()
        }
    }

    #[test]
    fn upserts_with_values_capture_the_rows_they_may_overwrite() {
        let p = cap("INSERT INTO users (id, email, name) VALUES (1, 'a@x', 'A'), (2, 'b@x', now()) \
                     ON CONFLICT (id) DO UPDATE SET name = excluded.name");
        assert_eq!(p.kind, CaptureKind::Update);
        assert_eq!(p.set_columns, vec!["name"]);
        assert_eq!(structure_reason(&p, &users(), Driver::Postgres), None);
        // The conflict target decides which existing rows can be overwritten.
        let sql = capture_select(&p, &users(), Dialect::Postgres, false).unwrap();
        assert!(sql.ends_with(r#"FROM users WHERE ("id" = 1) OR ("id" = 2)"#), "{sql}");
        // Nothing existing changes with DO NOTHING; a plain INSERT keeps no restore point either.
        assert_eq!(plan("INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO NOTHING"), PlanOutcome::None);
        assert_eq!(plan("INSERT INTO users (id) VALUES (1)"), PlanOutcome::None);
    }

    #[test]
    fn upserts_without_a_target_match_every_key_they_hold() {
        // MySQL's ON DUPLICATE KEY and REPLACE conflict on the primary key or any unique key.
        let p = match plan_statement(
            "INSERT INTO users (id, email, name) VALUES (1, 'a@x', 'A') ON DUPLICATE KEY UPDATE name = VALUES(name)",
            Dialect::Mysql,
        ) {
            PlanOutcome::Capture(p) => p,
            other => panic!("{other:?}"),
        };
        let sql = capture_select(&p, &users(), Dialect::Mysql, false).unwrap();
        assert!(sql.ends_with("FROM users WHERE (`id` = 1 OR `email` = 'a@x')"), "{sql}");
        for (sql, dialect) in [
            ("REPLACE INTO users (id, name) VALUES (-3, 'C')", Dialect::Mysql),
            ("INSERT OR REPLACE INTO users (id, name) VALUES (-3, 'C')", Dialect::Sqlite),
        ] {
            let PlanOutcome::Capture(p) = plan_statement(sql, dialect) else { panic!("{sql}") };
            let select = capture_select(&p, &users(), dialect, false).unwrap();
            assert!(select.ends_with(" = -3)"), "{sql}: {select}");
            let where_part = select.split(" WHERE ").nth(1).unwrap_or_default();
            assert!(!where_part.contains("email"), "{sql}: email isn't given, so it can't conflict");
        }
        // Without a column list the values follow the table's columns.
        let p = cap("INSERT INTO users VALUES (5, 'e@x', 'E') ON CONFLICT (email) DO UPDATE SET name = 'E'");
        let sql = capture_select(&p, &users(), Dialect::Postgres, false).unwrap();
        assert!(sql.ends_with(r#"WHERE ("email" = 'e@x')"#), "{sql}");
    }

    #[test]
    fn upserts_that_cannot_be_matched_say_why() {
        assert_eq!(
            plan(
                "INSERT INTO users (id, name) SELECT id, name FROM staging ON CONFLICT (id) DO UPDATE SET name = excluded.name"
            ),
            PlanOutcome::Unsupported(UPSERT_QUERY.into())
        );
        assert_eq!(
            plan("INSERT INTO users (id) VALUES (1) ON CONFLICT ON CONSTRAINT users_pkey DO UPDATE SET name = 'x'"),
            PlanOutcome::Unsupported(UPSERT_CONSTRAINT.into())
        );
        // A key value that isn't a plain value (a function, a parameter) can't be looked up first.
        let p =
            cap("INSERT INTO users (id, name) VALUES (nextval('s'), 'x') ON CONFLICT (id) DO UPDATE SET name = 'x'");
        assert_eq!(structure_reason(&p, &users(), Driver::Postgres), Some(UPSERT_KEY.into()));
        // Updating the key on conflict moves the row: no restore point.
        let p = cap("INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 9");
        assert_eq!(structure_reason(&p, &users(), Driver::Postgres), Some(CHANGES_KEY.into()));
        // A target that is no key of the table, or a table without one.
        let p = cap("INSERT INTO users (name) VALUES ('x') ON CONFLICT (name) DO UPDATE SET email = 'y'");
        assert_eq!(structure_reason(&p, &users(), Driver::Postgres), Some(UPSERT_KEY.into()));
    }

    #[test]
    fn plans_updates_and_deletes_with_their_where() {
        let p = cap("UPDATE orders o SET status = 'x' WHERE o.customer_id = 42 AND o.status <> 'paid'");
        assert_eq!(p.kind, CaptureKind::Update);
        assert_eq!((p.table.name.as_str(), p.alias.as_deref()), ("orders", Some("o")));
        assert_eq!(p.where_sql.as_deref(), Some("o.customer_id = 42 AND o.status <> 'paid'"));
        assert_eq!(p.set_columns, vec!["status".to_string()]);
        let d = cap("DELETE FROM \"Sales\".\"Orders\" WHERE id IN (1, 2)");
        assert_eq!(d.kind, CaptureKind::Delete);
        assert_eq!(d.table.schema.as_deref(), Some("Sales"));
        assert_eq!(d.table.name, "Orders");
        assert_eq!(d.table.sql, "\"Sales\".\"Orders\"");
        assert_eq!(cap("DELETE FROM orders").where_sql, None);
    }

    #[test]
    fn plans_destructive_ddl() {
        assert_eq!(cap("TRUNCATE TABLE orders").kind, CaptureKind::Truncate);
        assert_eq!(cap("DROP TABLE orders").kind, CaptureKind::DropTable);
        let c = cap("ALTER TABLE orders DROP COLUMN status");
        assert_eq!((c.kind, c.column.as_deref()), (CaptureKind::DropColumn, Some("status")));
    }

    #[test]
    fn says_why_a_statement_cannot_be_captured() {
        let un = |r: &str| PlanOutcome::Unsupported(r.into());
        assert_eq!(plan("UPDATE orders SET status = 'x' FROM customers c WHERE c.id = orders.customer_id"), un(JOINS));
        assert_eq!(plan("DELETE FROM orders USING customers c WHERE c.id = orders.customer_id"), un(JOINS));
        assert_eq!(plan_statement("DELETE FROM orders ORDER BY id LIMIT 5", Dialect::Mysql), un(ORDER_LIMIT));
        assert_eq!(plan_statement("UPDATE orders SET a = 1 ORDER BY id LIMIT 5", Dialect::Mysql), un(ORDER_LIMIT));
        assert_eq!(plan("WITH x AS (SELECT 1) DELETE FROM orders"), un(WITH));
        assert_eq!(plan("DROP TABLE a, b"), un(MULTI));
        assert_eq!(plan("TRUNCATE a, b"), un(MULTI));
        assert_eq!(plan("ALTER TABLE orders DROP COLUMN a, ADD COLUMN b int"), un(COMBINED));
        assert_eq!(plan("UPDATE orders SET status = 'x' WHERE (id = 1"), un(UNREADABLE));
    }

    #[test]
    fn other_statements_are_not_planned() {
        for sql in [
            "SELECT 1",
            "INSERT INTO orders VALUES (1)",
            "CREATE TABLE t (a int)",
            "ALTER TABLE orders ADD COLUMN x int",
            "BEGIN",
            "DROP VIEW v",
            "CREATE INDEX i ON t (a)",
        ] {
            assert_eq!(plan(sql), PlanOutcome::None, "{sql}");
        }
    }

    #[test]
    fn merge_is_unsupported_and_quoted_aliases_stay_quoted() {
        assert_eq!(
            plan("MERGE INTO orders o USING src s ON o.id = s.id WHEN MATCHED THEN DELETE"),
            PlanOutcome::Unsupported(MERGE.into())
        );
        let p = cap("UPDATE orders \"O\" SET status = 'x' WHERE \"O\".id = 1");
        assert_eq!(p.alias.as_deref(), Some("\"O\""));
        assert!(
            capture_select(&p, &orders(), Dialect::Postgres, false)
                .unwrap()
                .contains("FROM orders AS \"O\" WHERE \"O\".id = 1")
        );
    }

    #[test]
    fn drop_column_matches_the_column_as_the_database_does() {
        let mut s = orders();
        s.columns.push(col("Status", "text", None)); // differs from "status" only by case
        // Quoted: exactly that column.
        let p = cap("ALTER TABLE orders DROP COLUMN \"Status\"");
        let cols: Vec<&str> = capture_columns(&p, &s).iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, vec!["id", "Status"]);
        // Unquoted on PostgreSQL: folded to lower case.
        let p = cap("ALTER TABLE orders DROP COLUMN Status");
        let cols: Vec<&str> = capture_columns(&p, &s).iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, vec!["id", "status"]);
        assert_eq!(dropped_column(&p, &s).map(|c| c.name.as_str()), Some("status"));
        // Elsewhere names match case-insensitively: with two candidates, the column is unclear.
        let PlanOutcome::Capture(p) = plan_statement("ALTER TABLE orders DROP COLUMN STATUS", Dialect::Sqlite) else {
            panic!()
        };
        assert_eq!(structure_reason(&p, &s, Driver::Sqlite), Some(DROPPED_UNCLEAR.into()));
        // One candidate: found whatever the case.
        assert_eq!(dropped_column(&p, &orders()).map(|c| c.name.as_str()), Some("status"));
        // Dropping a key column: rows could no longer be found by key.
        assert_eq!(
            structure_reason(&cap("ALTER TABLE orders DROP COLUMN id"), &orders(), Driver::Postgres),
            Some(DROPS_KEY.into())
        );
    }

    #[test]
    fn sql_server_counts_and_captures() {
        let PlanOutcome::Capture(p) =
            plan_statement("UPDATE dbo.orders SET status = N'x' WHERE id = 1", Dialect::Mssql)
        else {
            panic!()
        };
        assert_eq!(
            count_select(&p, &orders(), Driver::Mssql, 10).unwrap(),
            "SELECT count(*), COALESCE(sum(CAST(rp_size AS bigint)), 0) FROM (SELECT TOP (11) \
             COALESCE(DATALENGTH(dbo.orders.[id]), 0) + COALESCE(DATALENGTH(dbo.orders.[status]), 0) + \
             COALESCE(DATALENGTH(dbo.orders.[doc]), 0) AS rp_size FROM dbo.orders WITH (NOLOCK) WHERE id = 1) AS rp_count"
        );
        assert_eq!(
            capture_select(&p, &orders(), Dialect::Mssql, true).unwrap(),
            "SELECT dbo.orders.[id], dbo.orders.[status], dbo.orders.[doc] FROM dbo.orders WITH (UPDLOCK, HOLDLOCK) \
             WHERE id = 1"
        );
        // money is read as decimal: the driver would read it as a float.
        let mut paid = orders();
        paid.columns[1].data_type = "money".into();
        assert!(
            capture_select(&p, &paid, Dialect::Mssql, false)
                .unwrap()
                .contains("CAST(dbo.orders.[status] AS decimal(19,4)) AS [status]")
        );
        let PlanOutcome::Capture(t) = plan_statement("TRUNCATE TABLE dbo.orders", Dialect::Mssql) else { panic!() };
        assert!(count_select(&t, &orders(), Driver::Mssql, 5).unwrap().contains("SELECT TOP (6) "));
    }

    #[test]
    fn counts_are_bounded_and_estimate_the_size() {
        let p = cap("UPDATE orders o SET status = 'x' WHERE o.id = 1");
        assert_eq!(
            count_select(&p, &orders(), Driver::Postgres, 10).unwrap(),
            "SELECT count(*), COALESCE(sum(rp_size), 0) FROM (SELECT COALESCE(octet_length(o.\"id\"::text), 0) + COALESCE(octet_length(o.\"status\"::text), 0) + COALESCE(octet_length(o.\"doc\"::text), 0) AS rp_size FROM orders AS o WHERE o.id = 1 LIMIT 11) AS rp_count"
        );
        let t = plan_statement("TRUNCATE orders", Dialect::Mysql);
        let PlanOutcome::Capture(t) = t else { panic!() };
        assert_eq!(
            count_select(&t, &orders(), Driver::Mysql, 5).unwrap(),
            "SELECT count(*), COALESCE(sum(rp_size), 0) FROM (SELECT COALESCE(LENGTH(orders.`id`), 0) + COALESCE(LENGTH(orders.`status`), 0) + COALESCE(LENGTH(orders.`doc`), 0) AS rp_size FROM orders LIMIT 6) AS rp_count"
        );
        let d = plan_statement("DELETE FROM orders WHERE id = 2", Dialect::Sqlite);
        let PlanOutcome::Capture(d) = d else { panic!() };
        assert!(
            count_select(&d, &orders(), Driver::Sqlite, 5)
                .unwrap()
                .contains("COALESCE(length(CAST(orders.\"id\" AS BLOB)), 0)")
        );
        assert!(
            count_select(&d, &orders(), Driver::Duckdb, 5)
                .unwrap()
                .contains("COALESCE(strlen(CAST(orders.\"id\" AS VARCHAR)), 0)")
        );
    }

    #[test]
    fn structure_reasons() {
        let s = orders();
        assert_eq!(
            structure_reason(&cap("UPDATE orders SET id = 2 WHERE id = 1"), &s, Driver::Postgres),
            Some(CHANGES_KEY.into())
        );
        let nokey = TableStructure { columns: vec![col("a", "integer", None)], ..orders() };
        assert_eq!(structure_reason(&cap("UPDATE orders SET a = 1"), &nokey, Driver::Postgres), Some(NO_KEY.into()));
        assert_eq!(
            structure_reason(&cap("DELETE FROM orders"), &nokey, Driver::Postgres),
            None,
            "a delete can be re-inserted"
        );
        assert_eq!(structure_reason(&cap("DELETE FROM orders"), &s, Driver::Mysql), Some(BINARY.into()));
        assert_eq!(structure_reason(&cap("DELETE FROM orders"), &s, Driver::Postgres), None);
    }

    #[test]
    fn builds_capture_and_count_queries() {
        let p = cap("UPDATE orders o SET status = 'x' WHERE o.id = 1");
        assert_eq!(
            capture_select(&p, &orders(), Dialect::Postgres, true).unwrap(),
            "SELECT o.\"id\"::text AS \"id\", o.\"status\"::text AS \"status\", o.\"doc\"::text AS \"doc\" FROM orders AS o WHERE o.id = 1 FOR UPDATE"
        );
        let t = cap("TRUNCATE orders");
        assert_eq!(
            capture_select(&t, &orders(), Dialect::Sqlite, false).unwrap(),
            "SELECT orders.\"id\", orders.\"status\", orders.\"doc\" FROM orders"
        );
        let dc = cap("ALTER TABLE orders DROP COLUMN status");
        assert_eq!(
            capture_select(&dc, &orders(), Dialect::Postgres, false).unwrap(),
            "SELECT orders.\"id\"::text AS \"id\", orders.\"status\"::text AS \"status\" FROM orders"
        );
    }
}
