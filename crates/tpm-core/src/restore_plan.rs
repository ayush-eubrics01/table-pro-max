//! Restore points, part 1: which statements can keep a restore point, and the SQL that captures
//! their rows. See docs/superpowers/specs/2026-10-14-restore-history-design.md.

use sqlparser::ast::{
    AlterTableOperation, AssignmentTarget, FromTable, ObjectName, ObjectType, SetExpr, Statement, TableFactor,
};
use sqlparser::dialect::{Dialect as ParserDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::config::Driver;
use crate::dialect::Dialect;
use crate::error::Result;
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
    CapturePlan { kind, table, alias: None, where_sql: None, set_columns: vec![], column: None }
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
    let parser_dialect: Box<dyn ParserDialect> = match dialect {
        Dialect::Postgres => Box::new(PostgreSqlDialect {}),
        Dialect::Mysql => Box::new(MySqlDialect {}),
        Dialect::Sqlite => Box::new(SQLiteDialect {}),
    };
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
        _ => PlanOutcome::None,
    }
}

fn is_binary_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("");
    matches!(base, "bytea" | "blob" | "binary" | "varbinary" | "tinyblob" | "mediumblob" | "longblob")
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
            _ => format!("{qual}.{q}"),
        });
    }
    let mut sql = format!("SELECT {} FROM {}", select.join(", "), from_sql(plan));
    if let Some(w) = &plan.where_sql {
        sql.push_str(&format!(" WHERE {w}"));
    }
    if lock {
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
            _ => format!("COALESCE(strlen(CAST({col} AS VARCHAR)), 0)"),
        });
    }
    let size = if sizes.is_empty() { "0".to_string() } else { sizes.join(" + ") };
    let mut inner = format!("SELECT {size} AS rp_size FROM {}", from_sql(plan));
    if let (Some(w), CaptureKind::Update | CaptureKind::Delete) = (&plan.where_sql, plan.kind) {
        inner.push_str(&format!(" WHERE {w}"));
    }
    inner.push_str(&format!(" LIMIT {}", limit.saturating_add(1)));
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
