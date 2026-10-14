# Restore Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before UPDATE/DELETE/TRUNCATE/DROP TABLE/ALTER … DROP COLUMN (query tabs) and grid commits change rows, the app keeps the affected rows as a local *restore point* (7 days). They can be restored, in whole or by chosen rows, through the existing review and commit flow.

**Architecture:**
- **Capture planning.** A pure module (`restore_plan.rs`) turns each statement into a capture plan, or into a reason it can't be captured.
- **Capture at run time.** The engine counts rows up front (so the user confirms once, before anything runs), then captures in the statement's transaction: read before rows, run the statement, read after rows, commit.
- **Storage and retention.** Restore points go into the local app database through a `RestoreStore` trait that `Storage` implements, with retention.
- **Restoring.** A pure module (`restore.rs`) turns a restore point into DDL plus `ChangeSet`s, which run through the existing preview, review and `apply_change_sets` path.
- **UI.** A right-hand panel lists the restore points and restores them.

**Tech Stack:** Rust (tpm-core, sqlparser 0.63 AST, rusqlite storage), Tauri commands, React/TypeScript, Vitest, cargo integration tests against the disposable databases.

**Spec:** `docs/superpowers/specs/2026-10-14-restore-history-design.md`

## Global Constraints
- **Storage:** restore points are stored **unencrypted** in the local app database and never leave the machine. No new network calls.
- **Defaults:** on for every connection, production included, via `ConnectionProfile.restore_points` (serde default `true`).
- **Limits (settings):**

  | Key | Default |
  |---|---|
  | `restore.keepDays` | 7 |
  | `restore.maxRows` | 100,000 |
  | `restore.maxMb` | 50 |
  | `restore.maxTotalMb` | 1,024 |

- **Values are always bind parameters;** identifiers are quoted with `Dialect::quote_ident` and checked against the structure. The capture `SELECT` re-emits the user's own WHERE (sqlparser `Display`).
- **Restores** run only through review and **Commit**. The backend refuses them on read-only connections and without `confirmed`.
- **One operation per session:** every capture step runs inside the session lock (`with_session`).
- **Exact copy:**
  - the confirmation detail line `Statement <n>: can't keep a restore point (<reason>)`;
  - the message `Restore point saved`, or `No restore point: <reason>`;
  - the status bar `Restore points · <n>`;
  - the buttons **Restore all**, **Restore selected**, **Delete restore point**;
  - the connection form switch "Keep restore points".
- **Reasons (exact strings):**
  - "joins other tables"
  - "uses ORDER BY or LIMIT"
  - "uses a WITH clause"
  - "changes the primary key"
  - "the table has no primary key"
  - "the statement could not be analysed"
  - "the table could not be read"
  - "names more than one table"
  - "combines several changes"
  - "the table has binary columns" (non-PostgreSQL only)
  - "affects <n> rows, more than <max>"
- **Node:** `source ~/.nvm/nvm.sh && nvm use 24`. **Tauri check:** `source target/tpm-scratch/sysroot/env.sh; cargo check -p table-pro-max`.

## Review Focus
1. **A script with a destructive statement that also can't be captured.** One confirmation lists both the destructive warning and the restore reason. Confirming runs everything, and nothing is skipped silently. Tested in Task 4.
2. **A statement inside the user's `BEGIN … ROLLBACK`.** No restore point survives. Inside `BEGIN … COMMIT`, it is kept. Tested in Task 5.
3. **A capture `SELECT` that fails** (the WHERE doesn't round-trip, or a permission problem). The statement still runs, the message says why there's no restore point, and the user's own transaction isn't aborted. Tested in Task 5.
4. **Restore after someone changed one of the rows.** Nothing is written, and the point stays `kept`. Tested in Task 6.
5. **Restoring selected rows only.** Only those rows change. Tested in Task 2 (unit) and Task 6 (integration).

---

### Task 1: Capture plans (`restore_plan.rs`)

**Files:**
- Create: `crates/tpm-core/src/restore_plan.rs`
- Modify: `crates/tpm-core/src/lib.rs`

**Interfaces:**
- **Produces:**

```rust
pub enum CaptureKind { Update, Delete, Truncate, DropTable, DropColumn }
pub struct TableRef { pub schema: Option<String>, pub name: String, /** as written, quoting kept */ pub sql: String }
pub struct CapturePlan {
    pub kind: CaptureKind,
    pub table: TableRef,
    pub alias: Option<String>,
    pub where_sql: Option<String>,
    pub set_columns: Vec<String>,
    pub column: Option<String>,
}
pub enum PlanOutcome { None, Capture(CapturePlan), Unsupported(String) }
pub fn plan_statement(sql: &str, dialect: Dialect) -> PlanOutcome;
pub fn structure_reason(plan: &CapturePlan, s: &TableStructure, driver: Driver) -> Option<String>;
pub fn capture_select(plan: &CapturePlan, s: &TableStructure, dialect: Dialect, lock: bool) -> Result<String>;
pub fn count_select(plan: &CapturePlan) -> String;
```

  - `CaptureKind`, `TableRef`, `CapturePlan` and `PlanOutcome` derive `Debug, Clone, PartialEq`; `CaptureKind` also derives `Copy`.
  - The reason strings are `pub const` values: `JOINS`, `ORDER_LIMIT`, `WITH`, `CHANGES_KEY`, `NO_KEY`, `UNREADABLE`, `TABLE_UNREADABLE`, `MULTI`, `COMBINED`, `BINARY`.

- [ ] **Step 1: Write the failing tests** (in a `#[cfg(test)] mod tests` at the bottom of the new file; the stubs `todo!()` until Step 3)

```rust
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
        ColumnInfo { name: name.into(), data_type: ty.into(), nullable: pk.is_none(), default: None, primary_key: pk, auto_increment: false, comment: None }
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
        assert_eq!(plan("UPDATE orders SET status = 'x' FROM customers c WHERE c.id = orders.customer_id"), PlanOutcome::Unsupported(JOINS.into()));
        assert_eq!(plan("DELETE FROM orders USING customers c WHERE c.id = orders.customer_id"), PlanOutcome::Unsupported(JOINS.into()));
        assert_eq!(plan_statement("DELETE FROM orders ORDER BY id LIMIT 5", Dialect::Mysql), PlanOutcome::Unsupported(ORDER_LIMIT.into()));
        assert_eq!(plan("WITH x AS (SELECT 1) DELETE FROM orders"), PlanOutcome::Unsupported(WITH.into()));
        assert_eq!(plan("DROP TABLE a, b"), PlanOutcome::Unsupported(MULTI.into()));
        assert_eq!(plan("TRUNCATE a, b"), PlanOutcome::Unsupported(MULTI.into()));
        assert_eq!(plan("ALTER TABLE orders DROP COLUMN a, ADD COLUMN b int"), PlanOutcome::Unsupported(COMBINED.into()));
        assert_eq!(plan("UPDATE orders SET status = WHERE"), PlanOutcome::Unsupported(UNREADABLE.into()));
    }

    #[test]
    fn other_statements_are_not_planned() {
        for sql in ["SELECT 1", "INSERT INTO orders VALUES (1)", "CREATE TABLE t (a int)", "ALTER TABLE orders ADD COLUMN x int", "BEGIN", "DROP VIEW v", "CREATE INDEX i ON t (a)"] {
            assert_eq!(plan(sql), PlanOutcome::None, "{sql}");
        }
    }

    #[test]
    fn structure_reasons() {
        let s = orders();
        assert_eq!(structure_reason(&cap("UPDATE orders SET id = 2 WHERE id = 1"), &s, Driver::Postgres), Some(CHANGES_KEY.into()));
        let nokey = TableStructure { columns: vec![col("a", "integer", None)], ..orders() };
        assert_eq!(structure_reason(&cap("UPDATE orders SET a = 1"), &nokey, Driver::Postgres), Some(NO_KEY.into()));
        assert_eq!(structure_reason(&cap("DELETE FROM orders"), &nokey, Driver::Postgres), None, "a delete can be re-inserted");
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
        assert_eq!(count_select(&p), "SELECT count(*) FROM orders AS o WHERE o.id = 1");
        let t = cap("TRUNCATE orders");
        assert_eq!(count_select(&t), "SELECT count(*) FROM orders");
        assert_eq!(
            capture_select(&t, &orders(), Dialect::Sqlite, false).unwrap(),
            "SELECT orders.\"id\", orders.\"status\", orders.\"doc\" FROM orders"
        );
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p tpm-core --lib restore_plan 2>&1 | grep -E "test result|panicked|error\[" | head`
Expected: compile errors until the stubs exist; then the tests panic on `todo!()`.

- [ ] **Step 3: Implement**

```rust
//! Restore points, part 1: which statements can keep a restore point, and the SQL that captures
//! their rows. See docs/superpowers/specs/2026-10-14-restore-history-design.md.

use sqlparser::ast::{AlterTableOperation, FromTable, ObjectName, ObjectType, SetExpr, Statement, TableFactor};
use sqlparser::dialect::{Dialect as ParserDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::config::Driver;
use crate::dialect::Dialect;
use crate::error::Result;
use crate::model::TableStructure;

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
    let (table, rest) = parts.split_last().map(|(t, r)| (t.clone(), r.to_vec())).unwrap_or_default();
    TableRef { schema: rest.last().cloned(), name: table, sql: name.to_string() }
}

fn plan(kind: CaptureKind, table: TableRef) -> CapturePlan {
    CapturePlan { kind, table, alias: None, where_sql: None, set_columns: vec![], column: None }
}

/// Statements whose leading keyword means they change rows or drop things.
fn looks_like_capturable(sql: &str) -> bool {
    let first = sql.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase();
    matches!(first.as_str(), "UPDATE" | "DELETE" | "TRUNCATE" | "DROP" | "ALTER")
}

pub fn plan_statement(sql: &str, dialect: Dialect) -> PlanOutcome {
    let parser_dialect: Box<dyn ParserDialect> = match dialect {
        Dialect::Postgres => Box::new(PostgreSqlDialect {}),
        Dialect::Mysql => Box::new(MySqlDialect {}),
        Dialect::Sqlite => Box::new(SQLiteDialect {}),
    };
    let stmts = match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(s) if s.len() == 1 => s,
        _ => return if looks_like_capturable(sql) { PlanOutcome::Unsupported(UNREADABLE.into()) } else { PlanOutcome::None },
    };
    match &stmts[0] {
        Statement::Update(u) => {
            if !u.table.joins.is_empty() || u.from.is_some() {
                return PlanOutcome::Unsupported(JOINS.into());
            }
            if !u.order_by.is_empty() || u.limit.is_some() {
                return PlanOutcome::Unsupported(ORDER_LIMIT.into());
            }
            let TableFactor::Table { name, alias, .. } = &u.table.relation else {
                return PlanOutcome::Unsupported(UNREADABLE.into());
            };
            let mut p = plan(CaptureKind::Update, table_ref(name));
            p.alias = alias.as_ref().map(|a| a.name.value.clone());
            p.where_sql = u.selection.as_ref().map(|e| e.to_string());
            p.set_columns = u
                .assignments
                .iter()
                .flat_map(|a| match &a.target {
                    sqlparser::ast::AssignmentTarget::ColumnName(n) => vec![table_ref(n).name],
                    sqlparser::ast::AssignmentTarget::Tuple(ns) => ns.iter().map(|n| table_ref(n).name).collect(),
                })
                .collect();
            PlanOutcome::Capture(p)
        }
        Statement::Delete(d) => {
            let from = match &d.from {
                FromTable::WithFromKeyword(t) | FromTable::WithoutKeyword(t) => t,
            };
            if d.using.is_some() || !d.tables.is_empty() || from.len() != 1 || !from[0].joins.is_empty() {
                return PlanOutcome::Unsupported(JOINS.into());
            }
            if !d.order_by.is_empty() || d.limit.is_some() {
                return PlanOutcome::Unsupported(ORDER_LIMIT.into());
            }
            let TableFactor::Table { name, alias, .. } = &from[0].relation else {
                return PlanOutcome::Unsupported(UNREADABLE.into());
            };
            let mut p = plan(CaptureKind::Delete, table_ref(name));
            p.alias = alias.as_ref().map(|a| a.name.value.clone());
            p.where_sql = d.selection.as_ref().map(|e| e.to_string());
            PlanOutcome::Capture(p)
        }
        Statement::Truncate(t) => match t.table_names.as_slice() {
            [one] => PlanOutcome::Capture(plan(CaptureKind::Truncate, table_ref(&one.name))),
            _ => PlanOutcome::Unsupported(MULTI.into()),
        },
        Statement::Drop { object_type: ObjectType::Table, names, .. } => match names.as_slice() {
            [one] => PlanOutcome::Capture(plan(CaptureKind::DropTable, table_ref(one))),
            _ => PlanOutcome::Unsupported(MULTI.into()),
        },
        Statement::AlterTable(a) => {
            let drops = a.operations.iter().filter(|o| matches!(o, AlterTableOperation::DropColumn { .. })).count();
            if drops == 0 {
                return PlanOutcome::None;
            }
            match a.operations.as_slice() {
                [AlterTableOperation::DropColumn { column_names, .. }] if column_names.len() == 1 => {
                    let mut p = plan(CaptureKind::DropColumn, table_ref(&a.name));
                    p.column = Some(column_names[0].value.clone());
                    PlanOutcome::Capture(p)
                }
                _ => PlanOutcome::Unsupported(COMBINED.into()),
            }
        }
        Statement::Query(q) if matches!(*q.body, SetExpr::Update(_) | SetExpr::Delete(_)) => PlanOutcome::Unsupported(WITH.into()),
        _ => PlanOutcome::None,
    }
}

pub fn structure_reason(plan: &CapturePlan, s: &TableStructure, driver: Driver) -> Option<String> {
    let pk: Vec<&str> = s.primary_key().iter().map(|c| c.name.as_str()).collect();
    if matches!(plan.kind, CaptureKind::Update | CaptureKind::DropColumn) && pk.is_empty() {
        return Some(NO_KEY.into());
    }
    if plan.kind == CaptureKind::Update && plan.set_columns.iter().any(|c| pk.iter().any(|k| k.eq_ignore_ascii_case(c))) {
        return Some(CHANGES_KEY.into());
    }
    let binary = |t: &str| {
        let t = t.to_ascii_lowercase();
        let base = t.split(['(', ' ']).next().unwrap_or("").to_string();
        matches!(base.as_str(), "bytea" | "blob" | "binary" | "varbinary" | "tinyblob" | "mediumblob" | "longblob")
    };
    if driver != Driver::Postgres && s.columns.iter().any(|c| binary(&c.data_type)) {
        return Some(BINARY.into());
    }
    None
}

fn from_sql(plan: &CapturePlan) -> String {
    match &plan.alias {
        Some(a) => format!("{} AS {a}", plan.table.sql),
        None => plan.table.sql.clone(),
    }
}

pub fn capture_select(plan: &CapturePlan, s: &TableStructure, dialect: Dialect, lock: bool) -> Result<String> {
    let qual = plan.alias.clone().unwrap_or_else(|| plan.table.sql.clone());
    let cols: Vec<&crate::model::ColumnInfo> = match (plan.kind, &plan.column) {
        // DROP COLUMN keeps the key and the dropped column only.
        (CaptureKind::DropColumn, Some(c)) => s.columns.iter().filter(|x| x.primary_key.is_some() || &x.name == c).collect(),
        _ => s.columns.iter().collect(),
    };
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

pub fn count_select(plan: &CapturePlan) -> String {
    let mut sql = format!("SELECT count(*) FROM {}", from_sql(plan));
    if let (Some(w), CaptureKind::Update | CaptureKind::Delete) = (&plan.where_sql, plan.kind) {
        sql.push_str(&format!(" WHERE {w}"));
    }
    sql
}
```

Add `pub mod restore_plan;` to `lib.rs`. If a field name differs in sqlparser 0.63 (for example `alias.name`), follow the compiler. The shapes were checked against `sqlparser-0.63.0/src/ast/{dml,ddl,mod}.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tpm-core --lib restore_plan 2>&1 | grep -E "test result|panicked" | head`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add crates/tpm-core/src/restore_plan.rs crates/tpm-core/src/lib.rs && git commit -m "feat: plan which statements can keep a restore point"
```

---

### Task 2: Restore points and their undo (`restore.rs`)

**Files:**
- Create: `crates/tpm-core/src/restore.rs`
- Modify: `crates/tpm-core/src/lib.rs`

**Interfaces:**
- **Produces:**

```rust
#[derive(Serialize, Deserialize)] pub enum RestoreKind { Update, Delete, Truncate, DropTable, DropColumn, GridEdit, Restore }  // snake_case
#[derive(Serialize, Deserialize)] pub enum RestoreStatus { Pending, Kept, Restored }                                       // snake_case
pub struct RestoreData {
    pub columns: Vec<String>, pub types: Vec<String>, pub key_columns: Vec<String>,
    pub before: Vec<Vec<Param>>, pub after: Vec<Option<Vec<Param>>>,
    pub ddl: Option<String>, pub column_type: Option<String>,
}
pub struct RestorePoint {
    pub id: String, pub connection_id: String, pub created_at: String, pub status: RestoreStatus,
    pub restored_at: Option<String>, pub kind: RestoreKind, pub schema: String, pub table: String,
    pub statement: String, pub data: RestoreData, pub row_count: u64, pub bytes: u64,
}
pub struct RestorePointSummary { /* every RestorePoint field except `data` */ }
pub trait RestoreStore: Send + Sync {
    fn save(&self, point: &RestorePoint) -> Result<()>;
    fn get(&self, id: &str) -> Result<RestorePoint>;
    fn set_status(&self, ids: &[String], status: RestoreStatus) -> Result<()>;
    fn delete(&self, ids: &[String]) -> Result<()>;
}
pub struct RestoreActions { pub ddl: Vec<String>, pub sets: Vec<ChangeSet> }
pub fn build_restore(point: &RestorePoint, dialect: Dialect, rows: Option<&[usize]>, table_exists: bool) -> Result<RestoreActions>;
```

  - `RestorePoint` and `RestorePointSummary` derive `Debug, Clone, Serialize, Deserialize`, with `serde(rename_all = "camelCase")`.
  - `RestoreData` derives `Debug, Clone, Default, Serialize, Deserialize`, also camelCase.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::{EditValue, RowChange};

    fn s(v: &str) -> Param {
        Some(v.to_string())
    }

    fn point(kind: RestoreKind, before: Vec<Vec<Param>>, after: Vec<Option<Vec<Param>>>) -> RestorePoint {
        RestorePoint {
            id: "p".into(),
            connection_id: "c".into(),
            created_at: "2026-10-14T10:00:00Z".into(),
            status: RestoreStatus::Kept,
            restored_at: None,
            kind,
            schema: "public".into(),
            table: "orders".into(),
            statement: "UPDATE orders SET status = 'x'".into(),
            data: RestoreData {
                columns: vec!["id".into(), "status".into(), "note".into()],
                types: vec!["integer".into(), "text".into(), "text".into()],
                key_columns: vec!["id".into()],
                before,
                after,
                ddl: None,
                column_type: None,
            },
            row_count: 0,
            bytes: 0,
        }
    }

    #[test]
    fn an_update_restores_changed_columns_with_the_after_value_as_the_check() {
        let p = point(
            RestoreKind::Update,
            vec![vec![s("1"), s("paid"), s("n")], vec![s("2"), s("new"), None]],
            vec![Some(vec![s("1"), s("x"), s("n")]), Some(vec![s("2"), s("x"), None])],
        );
        let a = build_restore(&p, Dialect::Postgres, None, true).unwrap();
        assert!(a.ddl.is_empty());
        let RowChange::Update { key, edits } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(key[0].value, s("1"));
        assert_eq!(edits.len(), 1, "unchanged columns are left alone");
        assert_eq!(edits[0].column, "status");
        assert!(matches!(&edits[0].value, EditValue::Value { value } if *value == s("paid")));
        assert_eq!(edits[0].original, Some(s("x")));
        assert!(a.sets[0].check_conflicts);
        let only_second = build_restore(&p, Dialect::Postgres, Some(&[1]), true).unwrap();
        assert_eq!(only_second.sets[0].changes.len(), 1);
        let RowChange::Update { key, .. } = &only_second.sets[0].changes[0] else { panic!() };
        assert_eq!(key[0].value, s("2"));
    }

    #[test]
    fn deletes_and_truncates_reinsert_every_column() {
        let p = point(RestoreKind::Delete, vec![vec![s("1"), s("paid"), None]], vec![]);
        let a = build_restore(&p, Dialect::Postgres, None, true).unwrap();
        let RowChange::Insert { values } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(values.len(), 3);
        assert!(matches!(&values[2].value, EditValue::Value { value: None }));
    }

    #[test]
    fn grid_edits_mix_updates_and_reinserts() {
        let p = point(RestoreKind::GridEdit, vec![vec![s("1"), s("a"), None], vec![s("2"), s("b"), None]], vec![Some(vec![s("1"), s("z"), None]), None]);
        let a = build_restore(&p, Dialect::Postgres, None, true).unwrap();
        assert!(matches!(a.sets[0].changes[0], RowChange::Update { .. }));
        assert!(matches!(a.sets[0].changes[1], RowChange::Insert { .. }));
    }

    #[test]
    fn dropped_tables_and_columns_come_back_with_ddl_first() {
        let mut t = point(RestoreKind::DropTable, vec![vec![s("1"), s("a"), None]], vec![]);
        t.data.ddl = Some("CREATE TABLE orders (id integer PRIMARY KEY, status text, note text)".into());
        let a = build_restore(&t, Dialect::Postgres, None, false).unwrap();
        assert_eq!(a.ddl, vec!["CREATE TABLE orders (id integer PRIMARY KEY, status text, note text)".to_string()]);
        assert!(build_restore(&t, Dialect::Postgres, None, true).unwrap().ddl.is_empty(), "the table exists again");
        let mut c = point(RestoreKind::DropColumn, vec![vec![s("1"), s("gone")]], vec![]);
        c.data.columns = vec!["id".into(), "status".into()];
        c.data.column_type = Some("text".into());
        let a = build_restore(&c, Dialect::Postgres, None, false).unwrap();
        assert_eq!(a.ddl, vec!["ALTER TABLE \"public\".\"orders\" ADD COLUMN \"status\" text".to_string()]);
        let RowChange::Update { key, edits } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!((key[0].value.clone(), edits[0].column.as_str(), edits[0].original.clone()), (s("1"), "status", None));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p tpm-core --lib restore:: 2>&1 | grep -E "test result|error\[" | head -3`
Expected: compile errors or failures.

- [ ] **Step 3: Implement**

```rust
//! Restore points, part 2: what a restore point holds, where it is kept (`RestoreStore`), and the
//! SQL that puts its rows back (as `ChangeSet`s for the existing review and commit path).

use serde::{Deserialize, Serialize};

use crate::changes::{ChangeSet, ColumnEdit, ColumnValue, EditValue, RowChange};
use crate::dialect::Dialect;
use crate::error::{AppError, Result};
use crate::model::Param;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreKind { Update, Delete, Truncate, DropTable, DropColumn, GridEdit, Restore }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStatus { Pending, Kept, Restored }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreData {
    pub columns: Vec<String>,
    pub types: Vec<String>,
    pub key_columns: Vec<String>,
    pub before: Vec<Vec<Param>>,
    /// Per before row: its values after the change, or `None` when it was deleted.
    pub after: Vec<Option<Vec<Param>>>,
    pub ddl: Option<String>,
    pub column_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    pub connection_id: String,
    pub created_at: String,
    pub status: RestoreStatus,
    pub restored_at: Option<String>,
    pub kind: RestoreKind,
    pub schema: String,
    pub table: String,
    pub statement: String,
    pub data: RestoreData,
    pub row_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointSummary {
    pub id: String,
    pub connection_id: String,
    pub created_at: String,
    pub status: RestoreStatus,
    pub restored_at: Option<String>,
    pub kind: RestoreKind,
    pub schema: String,
    pub table: String,
    pub statement: String,
    pub row_count: u64,
    pub bytes: u64,
}

pub trait RestoreStore: Send + Sync {
    fn save(&self, point: &RestorePoint) -> Result<()>;
    fn get(&self, id: &str) -> Result<RestorePoint>;
    fn set_status(&self, ids: &[String], status: RestoreStatus) -> Result<()>;
    fn delete(&self, ids: &[String]) -> Result<()>;
}

pub struct RestoreActions {
    pub ddl: Vec<String>,
    pub sets: Vec<ChangeSet>,
}

fn key_of(d: &RestoreData, row: &[Param]) -> Vec<ColumnValue> {
    d.key_columns
        .iter()
        .map(|k| {
            let i = d.columns.iter().position(|c| c == k).unwrap_or(0);
            ColumnValue { column: k.clone(), value: row.get(i).cloned().flatten() }
        })
        .collect()
}

fn reinsert(d: &RestoreData, row: &[Param]) -> RowChange {
    RowChange::Insert {
        values: d
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| ColumnEdit { column: c.clone(), value: EditValue::Value { value: row.get(i).cloned().flatten() }, original: None })
            .collect(),
    }
}

pub fn build_restore(point: &RestorePoint, dialect: Dialect, rows: Option<&[usize]>, table_exists: bool) -> Result<RestoreActions> {
    let d = &point.data;
    let chosen: Vec<usize> = match rows {
        Some(r) => r.iter().copied().filter(|i| *i < d.before.len()).collect(),
        None => (0..d.before.len()).collect(),
    };
    if chosen.is_empty() {
        return Err(AppError::invalid_config("Choose at least one row to restore"));
    }
    let mut ddl = Vec::new();
    let mut changes = Vec::new();
    match point.kind {
        RestoreKind::Update | RestoreKind::GridEdit | RestoreKind::Restore => {
            for i in chosen {
                let before = &d.before[i];
                match d.after.get(i).cloned().flatten() {
                    Some(after) => {
                        let edits: Vec<ColumnEdit> = d
                            .columns
                            .iter()
                            .enumerate()
                            .filter(|(j, c)| !d.key_columns.contains(c) && before.get(*j) != after.get(*j))
                            .map(|(j, c)| ColumnEdit {
                                column: c.clone(),
                                value: EditValue::Value { value: before.get(j).cloned().flatten() },
                                original: Some(after.get(j).cloned().flatten()),
                            })
                            .collect();
                        if !edits.is_empty() {
                            changes.push(RowChange::Update { key: key_of(d, before), edits });
                        }
                    }
                    None => changes.push(reinsert(d, before)),
                }
            }
        }
        RestoreKind::Delete | RestoreKind::Truncate => changes.extend(chosen.iter().map(|i| reinsert(d, &d.before[*i]))),
        RestoreKind::DropTable => {
            if !table_exists {
                ddl.push(d.ddl.clone().ok_or_else(|| AppError::internal("This restore point has no table definition"))?);
            }
            changes.extend(chosen.iter().map(|i| reinsert(d, &d.before[*i])));
        }
        RestoreKind::DropColumn => {
            let col = d.columns.iter().find(|c| !d.key_columns.contains(c)).cloned().ok_or_else(|| AppError::internal("No dropped column recorded"))?;
            let j = d.columns.iter().position(|c| *c == col).unwrap_or(0);
            if !table_exists {
                let table = dialect.qualified(Some(&point.schema), &point.table)?;
                let ty = d.column_type.clone().unwrap_or_else(|| "text".into());
                ddl.push(format!("ALTER TABLE {table} ADD COLUMN {} {ty}", dialect.quote_ident(&col)?));
            }
            for i in chosen {
                let before = &d.before[i];
                changes.push(RowChange::Update {
                    key: key_of(d, before),
                    edits: vec![ColumnEdit { column: col.clone(), value: EditValue::Value { value: before.get(j).cloned().flatten() }, original: None }],
                });
            }
        }
    }
    let sets = if changes.is_empty() {
        vec![]
    } else {
        vec![ChangeSet { schema: point.schema.clone(), table: point.table.clone(), changes, check_conflicts: true }]
    };
    Ok(RestoreActions { ddl, sets })
}
```

For DROP COLUMN, `table_exists` means "the column exists again". The engine (Task 6) passes whether the column is present in the current structure.

Add `pub mod restore;` to `lib.rs`. `ColumnEdit.original` is `Option<Param>`: `Some(None)` checks for NULL, and `None` skips the check. That matches `changes.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tpm-core --lib restore:: 2>&1 | grep -E "test result|panicked"`
Expected: `test result: ok. 4 passed`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add crates/tpm-core/src/restore.rs crates/tpm-core/src/lib.rs && git commit -m "feat: restore points and the change sets that undo them"
```

---

### Task 3: Storage: migration 3, CRUD, retention, `RestoreStore` for `Storage`

**Files:**
- Modify: `crates/tpm-core/src/storage.rs`

**Interfaces:**
- **Consumes:** Task 2 types.
- **Produces:**
  - `Storage::list_restore_points(&self, connection_id: &str) -> Result<Vec<RestorePointSummary>>`, newest first;
  - `Storage::purge_restore_points(&self) -> Result<usize>`, which reads the settings `restore.keepDays` (default 7) and `restore.maxTotalMb` (default 1024);
  - `impl RestoreStore for Storage`, where `save` also purges;
  - `delete_connection` also deletes the connection's restore points.

- [ ] **Step 1: Write the failing test** (in `storage.rs` `mod tests`)

```rust
    #[test]
    fn restore_points_are_saved_listed_purged_and_removed_with_the_connection() {
        use crate::restore::{RestoreData, RestoreKind, RestorePoint, RestoreStatus, RestoreStore};
        let s = Storage::open_in_memory().unwrap();
        let p = |id: &str, created: &str, bytes: u64| RestorePoint {
            id: id.into(),
            connection_id: "c1".into(),
            created_at: created.into(),
            status: RestoreStatus::Kept,
            restored_at: None,
            kind: RestoreKind::Update,
            schema: "public".into(),
            table: "orders".into(),
            statement: "UPDATE orders SET a = 1".into(),
            data: RestoreData { columns: vec!["id".into()], before: vec![vec![Some("1".into())]], ..Default::default() },
            row_count: 1,
            bytes,
        };
        let now = chrono::Utc::now();
        let recent = (now - chrono::Duration::hours(1)).to_rfc3339();
        let old = (now - chrono::Duration::days(8)).to_rfc3339();
        s.save(&p("a", &recent, 10)).unwrap();
        s.save(&p("old", &old, 10)).unwrap(); // purged by age on save
        let list = s.list_restore_points("c1").unwrap();
        assert_eq!(list.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(s.get("a").unwrap().data.before, vec![vec![Some("1".to_string())]]);
        s.set_status(&["a".into()], RestoreStatus::Restored).unwrap();
        assert!(s.get("a").unwrap().restored_at.is_some());
        // Total size cap: the oldest goes first.
        s.set_setting("restore.maxTotalMb", &serde_json::json!(1)).unwrap();
        s.save(&p("big1", &(now - chrono::Duration::minutes(30)).to_rfc3339(), 700_000)).unwrap();
        s.save(&p("big2", &now.to_rfc3339(), 700_000)).unwrap();
        let ids: Vec<String> = s.list_restore_points("c1").unwrap().into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["big2".to_string()]);
        s.delete_connection("c1").unwrap();
        assert!(s.list_restore_points("c1").unwrap().is_empty());
    }
```

Check that `chrono` is a dependency of tpm-core: `grep -n chrono crates/tpm-core/Cargo.toml`. If it isn't, use the timestamp helper `storage.rs` already uses (`now()`), and build the old timestamps with `time` or by string-formatting UTC. Mirror whatever `now()` returns.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p tpm-core --lib restore_points_are 2>&1 | grep -E "test result|error\[" | head -3`
Expected: compile error (missing methods and trait impl).

- [ ] **Step 3: Implement**
- **Migration** (the third element of `MIGRATIONS`):

```rust
    r#"
    CREATE TABLE restore_points (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'kept', 'restored')),
        restored_at TEXT,
        kind TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        statement TEXT NOT NULL,
        data TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        bytes INTEGER NOT NULL
    );
    CREATE INDEX restore_points_conn ON restore_points (connection_id, created_at);
    "#,
```

- **Methods** (strings for `kind` and `status` through `serde_json::to_value(..)`.as_str()):

```rust
    // ---- restore points (row copies kept locally; see restore.rs) -------------------------

    fn restore_setting(&self, key: &str, default: i64) -> i64 {
        self.get_setting(key).ok().flatten().and_then(|v| v.as_i64()).filter(|n| *n > 0).unwrap_or(default)
    }

    pub fn list_restore_points(&self, connection_id: &str) -> Result<Vec<RestorePointSummary>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, created_at, status, restored_at, kind, schema_name, table_name, statement, row_count, bytes
             FROM restore_points WHERE connection_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([connection_id], |r| {
            Ok(RestorePointSummary {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                created_at: r.get(2)?,
                status: serde_json::from_value(serde_json::Value::String(r.get(3)?)).unwrap_or(RestoreStatus::Kept),
                restored_at: r.get(4)?,
                kind: serde_json::from_value(serde_json::Value::String(r.get(5)?)).unwrap_or(RestoreKind::Update),
                schema: r.get(6)?,
                table: r.get(7)?,
                statement: r.get(8)?,
                row_count: r.get::<_, i64>(9)? as u64,
                bytes: r.get::<_, i64>(10)? as u64,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Removes restore points older than `restore.keepDays`, then the oldest until the total
    /// size is within `restore.maxTotalMb`. Returns how many were removed.
    pub fn purge_restore_points(&self) -> Result<usize> {
        let days = self.restore_setting("restore.keepDays", 7);
        let max_bytes = self.restore_setting("restore.maxTotalMb", 1024) * 1024 * 1024;
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        let conn = self.lock()?;
        let mut removed = conn.execute("DELETE FROM restore_points WHERE created_at < ?1 AND status <> 'pending'", [cutoff])?;
        loop {
            let total: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM restore_points", [], |r| r.get(0))?;
            if total <= max_bytes {
                break;
            }
            let n = conn.execute(
                "DELETE FROM restore_points WHERE id = (SELECT id FROM restore_points WHERE status <> 'pending' ORDER BY created_at LIMIT 1)",
                [],
            )?;
            if n == 0 {
                break;
            }
            removed += n;
        }
        Ok(removed)
    }
```

- **`impl RestoreStore for Storage`:**
  - `save` inserts with `data` as `serde_json::to_string(&p.data)`, then calls `purge_restore_points`.
  - `get` selects the full row and parses `data`. A missing id gives `AppError::not_found("This restore point no longer exists")`.
  - `set_status` runs `UPDATE … SET status = ?, restored_at = CASE WHEN ? = 'restored' THEN ?now ELSE restored_at END WHERE id IN (…)`, one `execute` per id.
  - `delete` runs `DELETE … WHERE id = ?`, one per id.
- **`delete_connection`** also runs `DELETE FROM restore_points WHERE connection_id = ?1` in its transaction.

Timestamps use `chrono::Utc::now().to_rfc3339()` if chrono is available. Otherwise use the module's existing `now()` helper and parse it for the cutoff. RFC 3339 strings compare correctly as text only if every one uses the same format, so use a single helper for both.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tpm-core --lib storage 2>&1 | grep -E "test result|panicked"`
Expected: ok. The existing `migrates_and_reopens` still passes, because it uses `MIGRATIONS.len()`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add crates/tpm-core/src/storage.rs && git commit -m "feat: keep restore points locally with age and size limits"
```

---

### Task 4: Engine: plan before running, one confirmation, connection switch, run limits

**Files:**
- Modify:
  - `crates/tpm-core/src/config.rs` (`ConnectionProfile.restore_points`);
  - `crates/tpm-core/src/engine.rs` (`restore_store`, `SessionHandle.default_schema`, `RunOptions` limits, planning in `run_script`).
- Test: `crates/tpm-core/tests/integration.rs` (a new `restore_points` function, called per driver).

**Interfaces:**
- **Consumes:** Task 1 (`plan_statement`, `structure_reason`, `count_select`) and Task 3 (`RestoreStore`).
- **Produces:**
  - `ConnectionProfile.restore_points: bool`, with a serde default of `true`. `ConnectionProfile::new` sets `true`.
  - `Engine::set_restore_store(&self, store: Arc<dyn RestoreStore>)`;
  - `RunOptions.restore_max_rows: Option<u64>`, default 100,000;
  - `RunOptions.restore_max_mb: Option<u64>`, default 50;
  - the private `struct ResolvedCapture { plan: CapturePlan, structure: TableStructure, schema: String }`;
  - `run_script` returns `ConfirmationRequired`. Its detail lists the destructive-policy reasons and the lines `Statement <n>: can't keep a restore point (<reason>)`.

- [ ] **Step 1: Write the failing integration test**

Add to `crates/tpm-core/tests/integration.rs`, and call `restore_points(&engine, &sid, &t.schema, driver).await;` after `fk_round_trip(…)` in the per-driver test:

```rust
/// Restore points: planned before anything runs, captured around the statement, restored by review.
async fn restore_points(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::restore::RestoreStore;
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store.clone());
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rp").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rp_nokey").await;
    run(engine, sid, "CREATE TABLE tpm_it_rp (id integer PRIMARY KEY, status varchar(20), qty integer)").await;
    run(engine, sid, "INSERT INTO tpm_it_rp VALUES (1, 'paid', 5), (2, 'paid', 7), (3, 'new', 1)").await;
    run(engine, sid, "CREATE TABLE tpm_it_rp_nokey (a integer)").await;

    // Planning: one confirmation names every statement that can't keep a restore point.
    let opts = |confirmed| RunOptions { confirmed, ..Default::default() };
    let err = engine
        .run_script(sid, "UPDATE tpm_it_rp_nokey SET a = 1; DELETE FROM tpm_it_rp ORDER BY id LIMIT 1", opts(false), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{driver:?}");
    let detail = err.detail.clone().unwrap_or_default();
    // Review Focus 1: statement 1 is destructive (no WHERE) *and* can't keep a restore point;
    // the one confirmation names both.
    assert!(detail.contains("UPDATE without a WHERE clause changes every row"), "{driver:?}: {detail}");
    assert!(detail.contains("Statement 1: can't keep a restore point (the table has no primary key)"), "{driver:?}: {detail}");
    if matches!(driver, Driver::Mysql | Driver::Mariadb) {
        assert!(detail.contains("Statement 2: can't keep a restore point (uses ORDER BY or LIMIT)"), "{driver:?}: {detail}");
    }
    // Over the row limit.
    let small = RunOptions { confirmed: false, restore_max_rows: Some(2), ..Default::default() };
    let err = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 0", small, None).await.unwrap_err();
    assert!(err.detail.unwrap_or_default().contains("affects 3 rows, more than 2"), "{driver:?}");
    // Confirming runs it anyway.
    let r = engine.run_script(sid, "UPDATE tpm_it_rp_nokey SET a = 1", opts(true), None).await.unwrap();
    assert!(r.statements[0].error.is_none(), "{driver:?}");
    let _ = store; // Task 5 continues this function
    run(engine, sid, "DROP TABLE tpm_it_rp_nokey").await;
    run(engine, sid, "DROP TABLE tpm_it_rp").await;
}
```

The `run()` helper confirms everything, so setup statements never trip the confirmation.

- [ ] **Step 2: Run it to verify it fails**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "^error|panicked" | head -5`
Expected: compile errors (`set_restore_store` and `restore_max_rows` are missing).

- [ ] **Step 3: Implement**

**`config.rs`:**
- Add to `ConnectionProfile`:

```rust
    /// Keep restore points (row copies before changes, local only). On by default.
    #[serde(default = "default_true")]
    pub restore_points: bool,
```

- Add the `default_true` helper if there isn't one, and set `restore_points: true` in `ConnectionProfile::new`.

**`engine.rs`:**
- **Engine field:** `restore_store: Mutex<Option<Arc<dyn crate::restore::RestoreStore>>>`, initialised to `Mutex::new(None)` in every constructor. Add:

```rust
    /// Where restore points are kept (the app's local storage); without one, none are made.
    pub fn set_restore_store(&self, store: Arc<dyn crate::restore::RestoreStore>) {
        *lock(&self.restore_store) = Some(store);
    }
    fn restore_store(&self) -> Option<Arc<dyn crate::restore::RestoreStore>> {
        lock(&self.restore_store).clone()
    }
```

- **`SessionHandle`:**
  - `default_schema: Mutex<Option<String>>`, set in `set_default_schema` after a successful switch;
  - `pending_restore: Mutex<Vec<String>>`, used by Task 5.

  Initialise both in the handle constructor.
- **`RunOptions`:** add `#[serde(default)] pub restore_max_rows: Option<u64>` and `#[serde(default)] pub restore_max_mb: Option<u64>`.
- **Helpers:**

```rust
    fn default_schema_of(&self, handle: &SessionHandle) -> String {
        lock(&handle.default_schema).clone().unwrap_or_else(|| match handle.profile.driver {
            crate::config::Driver::Postgres => "public".into(),
            crate::config::Driver::Mysql | crate::config::Driver::Mariadb => handle.info.database.clone(),
            _ => "main".into(),
        })
    }

    fn restore_enabled(&self, handle: &SessionHandle) -> bool {
        handle.profile.restore_points
            && !handle.profile.read_only()
            && handle.profile.driver != crate::config::Driver::Redis
            && self.restore_store().is_some()
    }

    /// Resolves a capture plan against the table and the row limit; Err is the reason it can't.
    async fn resolve_capture(&self, handle: &Arc<SessionHandle>, session_id: &str, plan: crate::restore_plan::CapturePlan, max_rows: u64) -> std::result::Result<ResolvedCapture, String> {
        use crate::restore_plan::{TABLE_UNREADABLE, count_select, structure_reason};
        let schema = plan.table.schema.clone().unwrap_or_else(|| self.default_schema_of(handle));
        let structure = self.table_structure(session_id, &schema, &plan.table.name, true).await.map_err(|_| TABLE_UNREADABLE.to_string())?;
        if let Some(r) = structure_reason(&plan, &structure, handle.profile.driver) {
            return Err(r);
        }
        let sql = count_select(&plan);
        let rs = self
            .with_session(session_id, move |s| Box::pin(async move { s.query(&sql, &[], 1).await }))
            .await
            .map_err(|_| crate::restore_plan::UNREADABLE.to_string())?;
        let n: u64 = rs.rows.first().and_then(|r| r.first()).and_then(|c| c.as_text()).and_then(|t| t.parse().ok()).unwrap_or(0);
        if n > max_rows {
            return Err(format!("affects {n} rows, more than {max_rows}"));
        }
        Ok(ResolvedCapture { plan, structure, schema })
    }
```

- **`run_script`:** replace `Self::enforce_policy(&analysis, opts.confirmed, &handle.info)?;` with:

```rust
        if let PolicyDecision::Block { reason } = &analysis.decision {
            return Err(AppError::new(ErrorKind::PolicyViolation, reason));
        }
        // Plan restore points before anything runs, so one confirmation covers every reason.
        let max_rows = opts.restore_max_rows.unwrap_or(100_000);
        let mut captures: Vec<CaptureState> = vec![CaptureState::Off; analysis.statements.len()];
        let mut restore_reasons = Vec::new();
        if self.restore_enabled(&handle) {
            for (i, stmt) in analysis.statements.iter().enumerate() {
                if stmt.class < crate::safety::StatementClass::Write {
                    continue;
                }
                let skipped = match crate::restore_plan::plan_statement(&stmt.sql, handle.info.dialect) {
                    crate::restore_plan::PlanOutcome::None => None,
                    crate::restore_plan::PlanOutcome::Unsupported(r) => Some(r),
                    crate::restore_plan::PlanOutcome::Capture(plan) => match self.resolve_capture(&handle, session_id, plan, max_rows).await {
                        Ok(rc) => {
                            captures[i] = CaptureState::Planned(rc);
                            None
                        }
                        Err(r) => Some(r),
                    },
                };
                if let Some(r) = skipped {
                    restore_reasons.push(format!("Statement {}: can't keep a restore point ({r})", i + 1));
                    // Task 5 turns this into the statement's "No restore point: <reason>" message.
                    captures[i] = CaptureState::Skipped(r);
                }
            }
        }
        let mut reasons = match &analysis.decision {
            PolicyDecision::Confirm { reasons } => reasons.clone(),
            _ => vec![],
        };
        reasons.extend(restore_reasons);
        if !reasons.is_empty() && !opts.confirmed {
            return Err(AppError::new(
                ErrorKind::ConfirmationRequired,
                format!("Confirm execution on {} ({})", handle.info.connection_name, handle.info.target),
            )
            .with_detail(reasons.join("\n")));
        }
```

  Add the private `#[derive(Clone)] enum CaptureState { Off, Planned(ResolvedCapture), Skipped(String) }`, and derive `Clone` on `ResolvedCapture` (`CapturePlan` and `TableStructure` are `Clone`). The `captures` vector is consumed in Task 5; until then, name it `_captures` to keep clippy quiet, and rename it in Task 5.
- **Tauri `src-tauri/src/lib.rs`:** after `Storage::open`, call `engine.set_restore_store(storage.clone())` (adjust to the actual variable names), and `let _ = storage.purge_restore_points();`.
- **TS:** add `restorePoints?: boolean` to `ConnectionProfile` and `restoreMaxRows?`/`restoreMaxMb?` to `RunOptions` in `backend.ts`. In `stores/connections.ts` `newProfile`, add `restorePoints: true`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "panicked|test result" -A3 | head`
Expected: `8 passed`. Also run `cargo test -p tpm-core --lib` (ok) and the Tauri check (`Finished`).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add -A crates src-tauri src/types/backend.ts src/stores/connections.ts && git commit -m "feat: plan restore points before a script runs and confirm once"
```

---

### Task 5: Engine: capture around the statement, pending points, run messages

**Files:**
- Modify:
  - `crates/tpm-core/src/engine.rs`;
  - `crates/tpm-core/src/browse.rs` (`build_rows_by_key`).
- Test: extend `restore_points` in `integration.rs`.

**Interfaces:**
- **Consumes:** Task 4 `captures: Vec<CaptureState>`, Task 1 `capture_select`, Task 2 `RestorePoint`/`RestoreData`.
- **Produces:**
  - `StatementResult.restore: Option<RestoreNote>`, with `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct RestoreNote { pub point_id: Option<String>, pub reason: Option<String> }` (`point_id` is set when one was saved);
  - `browse::build_rows_by_key(dialect, s, keys: &[Vec<ColumnValue>]) -> Result<BuiltQuery>`, which selects every column with the same projection as `capture_select` (no alias; PostgreSQL `::text`), at most 200 keys;
  - pending restore points: COMMIT keeps them; ROLLBACK, `close_session` and `reconnect` delete them.

- [ ] **Step 1: Write the failing test.** Replace the `let _ = store;` line in `restore_points` with:

```rust
    // UPDATE: captured before → after, kept, and the note says so.
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET status = 'cancelled' WHERE status = 'paid'", opts(true), None).await.unwrap();
    let note = r.statements[0].restore.clone().expect("note");
    let id = note.point_id.clone().expect("saved");
    let p = store.get(&id).unwrap();
    assert_eq!(p.row_count, 2, "{driver:?}");
    assert_eq!(p.data.before.len(), 2);
    assert!(p.data.before.iter().all(|r| r[1].as_deref() == Some("paid")));
    assert!(p.data.after.iter().all(|r| r.as_ref().unwrap()[1].as_deref() == Some("cancelled")));
    assert_eq!(p.status, tpm_core::restore::RestoreStatus::Kept);
    // DELETE: before rows only.
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rp WHERE id = 3", opts(true), None).await.unwrap();
    let p = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert_eq!((p.data.before.len(), p.data.after.len()), (1, 0));
    // Inside the user's transaction: pending; ROLLBACK deletes it, COMMIT keeps it.
    run(engine, sid, "BEGIN").await;
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 99 WHERE id = 1", opts(true), None).await.unwrap();
    let pend = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    assert_eq!(store.get(&pend).unwrap().status, tpm_core::restore::RestoreStatus::Pending, "{driver:?}");
    run(engine, sid, "ROLLBACK").await;
    assert!(store.get(&pend).is_err(), "rolled back: no restore point ({driver:?})");
    run(engine, sid, "BEGIN").await;
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 98 WHERE id = 1", opts(true), None).await.unwrap();
    let kept = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    run(engine, sid, "COMMIT").await;
    assert_eq!(store.get(&kept).unwrap().status, tpm_core::restore::RestoreStatus::Kept);
    // A capture SELECT that fails at run time (Review Focus 3): a role that may count rows (SELECT
    // on `id`) and update, but not read every column. Planning succeeds; the capture SELECT is
    // refused; the UPDATE still runs, the note says why, and the user's transaction survives.
    if driver == Driver::Postgres {
        run(engine, sid, "DROP ROLE IF EXISTS tpm_it_limited").await;
        run(engine, sid, "CREATE ROLE tpm_it_limited").await;
        run(engine, sid, &format!("GRANT USAGE ON SCHEMA \"{schema}\" TO tpm_it_limited")).await;
        run(engine, sid, "GRANT SELECT (id), UPDATE ON tpm_it_rp TO tpm_it_limited").await;
        run(engine, sid, "BEGIN").await;
        run(engine, sid, "SET LOCAL ROLE tpm_it_limited").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 1 WHERE id = 1", opts(true), None).await.unwrap();
        assert!(r.statements[0].error.is_none(), "the statement still runs");
        let note = r.statements[0].restore.clone().expect("note");
        assert!(note.point_id.is_none());
        assert!(note.reason.unwrap_or_default().starts_with("could not read the rows"));
        run(engine, sid, "SELECT 1").await; // the transaction is still usable
        run(engine, sid, "ROLLBACK").await;
        run(engine, sid, "DROP OWNED BY tpm_it_limited").await;
        run(engine, sid, "DROP ROLE tpm_it_limited").await;
    }
    // A statement that can't keep a restore point says why in its note.
    let r = engine.run_script(sid, "UPDATE tpm_it_rp_nokey SET a = 2", opts(true), None).await.unwrap();
    assert_eq!(r.statements[0].restore.as_ref().and_then(|n| n.reason.as_deref()), Some("the table has no primary key"), "{driver:?}");
    // TRUNCATE, DROP COLUMN and DROP TABLE capture rows (and the definition).
    let r = engine.run_script(sid, "ALTER TABLE tpm_it_rp DROP COLUMN qty", opts(true), None).await.unwrap();
    let dc = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert_eq!(dc.data.columns, vec!["id".to_string(), "qty".to_string()], "{driver:?}");
    let r = engine.run_script(sid, "TRUNCATE TABLE tpm_it_rp", opts(true), None).await;
    if let Ok(r) = r {
        // SQLite has no TRUNCATE: the statement errors, and no restore point is kept.
        if r.statements[0].error.is_none() {
            assert_eq!(store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap().row_count, 2);
        }
    }
    let r = engine.run_script(sid, "DROP TABLE tpm_it_rp", opts(true), None).await.unwrap();
    let dt = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert!(dt.data.ddl.is_some(), "{driver:?}");
    run(engine, sid, "CREATE TABLE tpm_it_rp (id integer PRIMARY KEY, status varchar(20), qty integer)").await; // for Task 6
```

The final `DROP TABLE tpm_it_rp` at the end of the function stays, and now drops the re-created table.

The role exists only in the disposable test container and is dropped at the end of the block; `run()` confirms every statement. The count (`SELECT count(*)`) needs SELECT on one column only, so planning succeeds; the capture reads every column, so it is refused.

- [ ] **Step 2: Run it to verify it fails**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "^error|panicked" | head -5`
Expected: compile error (`restore` field missing).

- [ ] **Step 3: Implement**

**`browse.rs`:** add `build_rows_by_key`. Its WHERE is the OR-joined key equalities, like `build_fetch`, and its select list is every column (the PostgreSQL `::text` cast for all).

**`engine.rs`:**
- **`StatementResult`:** add `#[serde(skip_serializing_if = "Option::is_none")] pub restore: Option<RestoreNote>`, with `restore: None` in every literal.
- **Pass the capture into `execute_one`:** change its signature to take `capture: Option<&ResolvedCapture>` and `max_bytes: u64`, and return `Result<(Vec<StatementOutcome>, Option<CapturedRows>)>`, where:

```rust
struct CapturedRows {
    columns: Vec<String>,
    types: Vec<String>,
    key_columns: Vec<String>,
    before: Vec<Vec<Param>>,
    after: Vec<Option<Vec<Param>>>,
    ddl: Option<String>,
    column_type: Option<String>,
    pending: bool,
    /// Why no rows were kept although a capture was planned.
    dropped: Option<String>,
}
```

- **The `with_session` closure** inside `execute_one`, when `capture` is `Some(rc)`:
  1. `in_user_txn = open_txn`. MySQL/MariaDB DDL (DROP TABLE, DROP COLUMN) never gets our transaction. DuckDB inside a user transaction has no savepoint, so it captures nothing (`dropped = Some("inside a transaction on DuckDB")`).
  2. If it's our transaction, `s.execute("BEGIN")`. If it's the user's, `s.execute("SAVEPOINT tpm_restore")`.
  3. `before = s.query(capture_select(plan, structure, dialect, lock = Postgres|MySQL), &[], max_rows + 1)`:
     - **Error:** roll back our transaction (`ROLLBACK`), or `ROLLBACK TO SAVEPOINT tpm_restore` (then `RELEASE SAVEPOINT`). Set `dropped = Some("could not read the rows: <message>")`, then run the statement plainly (as today) and return.
     - **Too many rows** (> max) **or bytes** (sum of value lengths > `max_bytes`): keep going without keeping rows (`dropped = Some("more than …")`).
  4. For DROP TABLE, read the definition before running: `s.object_definition(schema, table, ObjectKind::Table)`. Look up the trait's exact method name in `adapters/mod.rs`.
  5. `outcomes = s.execute(sql, max_rows)`. On error: roll back our transaction or the savepoint, and return the error.
  6. For UPDATE, `after`: for chunks of 200 keys, `s.query(build_rows_by_key(..))`. Match each returned row back to its before row by key text.
  7. Commit our transaction, or `RELEASE SAVEPOINT tpm_restore`.

  Convert `Cell` to `Param`: `Text(t) → Some(t)`, `Null → None`, anything else → `Some(text)` via `to_export_string`.
- **After `execute_one` in `run_script`:** if `CapturedRows` came back with rows and no `dropped`, build a `RestorePoint`:
  - `id`: uuid; `connection_id`: `handle.profile.id`; `created_at`: now RFC 3339;
  - `status`: Pending if `pending`, else Kept;
  - `kind` from the plan; `schema`/`table` from the resolved capture; `statement`: `stmt.sql`;
  - `data` from the captured fields; `row_count`: number of before rows; `bytes`: sum of value lengths.

  Save it through the store, set `r.restore = Some(RestoreNote { point_id: Some(id), reason: None })` on the statement's result, and, if pending, push the id to `handle.pending_restore`. With `dropped`, set `RestoreNote { point_id: None, reason: dropped }`. A statement whose plan state is `CaptureState::Skipped(r)` (from Task 4) gets `RestoreNote { point_id: None, reason: Some(r) }`, so the user sees `No restore point: <reason>` after confirming.
- **Pending points:** extend the transaction tracking with a helper `txn_end(sql) -> Option<bool>`, where `COMMIT`/`END` give `Some(true)` and `ROLLBACK` (not `ROLLBACK TO`)/`ABORT` give `Some(false)`:
  - on `Some(true)`: `store.set_status(&ids, Kept)` and clear the list;
  - on `Some(false)`: `store.delete(&ids)` and clear it.

  `close_session` and `reconnect` also delete and clear the pending ids. Add a unit test for `txn_end` next to `transaction_control_is_tracked`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "panicked|test result" -A3 | head; cargo test -p tpm-core --lib 2>&1 | grep "test result"`
Expected: integration `8 passed`, lib ok.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add -A crates && git commit -m "feat: capture rows around a statement into a restore point"
```

---

### Task 6: Engine: grid-commit capture and restoring

**Files:**
- Modify: `crates/tpm-core/src/engine.rs`
- Test: extend `restore_points` in `integration.rs`.

**Interfaces:**
- **Consumes:** Task 2 `build_restore`, Task 5 capture helpers.
- **Produces:**
  - `Engine::preview_restore(&self, session_id: &str, point_id: &str, rows: Option<Vec<usize>>) -> Result<ChangePreview>`, where the SQL is the DDL plus the change preview;
  - `Engine::apply_restore(&self, session_id: &str, point_id: &str, rows: Option<Vec<usize>>, confirmed: bool) -> Result<Vec<u64>>`;
  - `apply_change_sets` keeps a "grid_edit" restore point per set when restore points are enabled.

- [ ] **Step 1: Write the failing test.** Append before the final `DROP TABLE` in `restore_points`:

```rust
    run(engine, sid, "INSERT INTO tpm_it_rp VALUES (1, 'paid', 5), (2, 'paid', 7)").await;
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET status = 'x', qty = 0", opts(true), None).await.unwrap();
    let pid = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    // Only row 2 (index of id 2 in the point).
    let p = store.get(&pid).unwrap();
    let idx = p.data.before.iter().position(|r| r[0].as_deref() == Some("2")).unwrap();
    let preview = engine.preview_restore(sid, &pid, Some(vec![idx])).await.unwrap();
    assert_eq!(preview.statement_count, 1, "{driver:?}: {}", preview.sql);
    assert!(engine.apply_restore(sid, &pid, Some(vec![idx]), false).await.is_err(), "needs review confirmation");
    engine.apply_restore(sid, &pid, Some(vec![idx]), true).await.unwrap();
    let after = run(engine, sid, "SELECT id, status, qty FROM tpm_it_rp ORDER BY id").await;
    let rows = after.statements[0].rows.clone().unwrap();
    assert_eq!(text(&rows[0][1]), "x", "row 1 untouched ({driver:?})");
    assert_eq!((text(&rows[1][1]), text(&rows[1][2])), ("paid", "7"));
    assert_eq!(store.get(&pid).unwrap().status, tpm_core::restore::RestoreStatus::Restored);
    // Conflict: row 1 changed since; nothing is written.
    run(engine, sid, "UPDATE tpm_it_rp SET qty = 42 WHERE id = 1").await;
    let idx1 = p.data.before.iter().position(|r| r[0].as_deref() == Some("1")).unwrap();
    let err = engine.apply_restore(sid, &pid, Some(vec![idx1]), true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{driver:?}");
    // DELETE restored by re-inserting.
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rp WHERE id = 2", opts(true), None).await.unwrap();
    let did = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    engine.apply_restore(sid, &did, None, true).await.unwrap();
    let back = run(engine, sid, "SELECT count(*) FROM tpm_it_rp WHERE id = 2").await;
    assert_eq!(text(&back.statements[0].rows.as_ref().unwrap()[0][0]), "1");
    // A grid commit keeps a restore point, and a restore keeps its own.
    let set = ChangeSet {
        schema: schema.into(),
        table: "tpm_it_rp".into(),
        changes: vec![RowChange::Update {
            key: vec![ColumnValue { column: "id".into(), value: Some("2".into()) }],
            edits: vec![ColumnEdit { column: "status".into(), value: EditValue::Value { value: Some("grid".into()) }, original: Some(Some("paid".into())) }],
        }],
        check_conflicts: true,
    };
    engine.apply_changes(sid, &set, true).await.unwrap();
    let grid = store.list_restore_points(&engine_connection_id(engine, sid)).unwrap();
    assert!(grid.iter().any(|g| g.kind == tpm_core::restore::RestoreKind::GridEdit), "{driver:?}");
    assert!(grid.iter().any(|g| g.kind == tpm_core::restore::RestoreKind::Restore), "a restore keeps its own point ({driver:?})");
```

Add a small helper in the test file:

```rust
fn engine_connection_id(engine: &Engine, sid: &str) -> String {
    engine.session_info(sid).unwrap().connection_id
}
```

If `session_info` doesn't exist, use the `profile.id` the test already has in scope and pass it into `restore_points`.

- [ ] **Step 2: Run it to verify it fails**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "^error|panicked" | head -5`
Expected: compile error (`preview_restore` and `apply_restore` are missing).

- [ ] **Step 3: Implement**

```rust
    async fn restore_actions(&self, session_id: &str, point_id: &str, rows: Option<Vec<usize>>) -> Result<(crate::restore::RestorePoint, crate::restore::RestoreActions)> {
        let handle = self.handle(session_id)?;
        let store = self.restore_store().ok_or_else(|| AppError::internal("Restore points are not available"))?;
        let point = store.get(point_id)?;
        if point.connection_id != handle.profile.id {
            return Err(AppError::invalid_config("This restore point belongs to another connection"));
        }
        let exists = match point.kind {
            crate::restore::RestoreKind::DropColumn => {
                let col = point.data.columns.iter().find(|c| !point.data.key_columns.contains(c)).cloned().unwrap_or_default();
                self.table_structure(session_id, &point.schema, &point.table, true).await.map(|s| s.column(&col).is_some()).unwrap_or(false)
            }
            _ => self.table_structure(session_id, &point.schema, &point.table, true).await.is_ok(),
        };
        let actions = crate::restore::build_restore(&point, handle.info.dialect, rows.as_deref(), exists)?;
        Ok((point, actions))
    }

    pub async fn preview_restore(&self, session_id: &str, point_id: &str, rows: Option<Vec<usize>>) -> Result<ChangePreview> {
        let (_, actions) = self.restore_actions(session_id, point_id, rows).await?;
        let mut sql: Vec<String> = actions.ddl.iter().map(|d| format!("{d};")).collect();
        let mut count = actions.ddl.len();
        if !actions.sets.is_empty() {
            let p = self.preview_change_sets_unchecked(session_id, &actions.sets).await?;
            sql.push(p.sql);
            count += p.statement_count;
        }
        let atomic = self.handle(session_id)?.info.capabilities.transactions && (actions.ddl.is_empty() || !matches!(self.handle(session_id)?.profile.driver, crate::config::Driver::Mysql | crate::config::Driver::Mariadb));
        Ok(ChangePreview { sql: sql.join("\n"), statement_count: count, atomic })
    }

    pub async fn apply_restore(&self, session_id: &str, point_id: &str, rows: Option<Vec<usize>>, confirmed: bool) -> Result<Vec<u64>> {
        let handle = self.handle(session_id)?;
        if handle.profile.read_only() {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the restore before committing"));
        }
        let (point, actions) = self.restore_actions(session_id, point_id, rows).await?;
        if !actions.ddl.is_empty() {
            self.apply_ddl(session_id, &actions.ddl, true).await?;
            self.invalidate_structures(session_id);
        }
        let counts = if actions.sets.is_empty() {
            vec![]
        } else {
            self.apply_change_sets_kind(session_id, &actions.sets, true, crate::restore::RestoreKind::Restore, &format!("Restore of: {}", point.statement)).await?
        };
        if let Some(store) = self.restore_store() {
            store.set_status(&[point.id.clone()], crate::restore::RestoreStatus::Restored)?;
        }
        Ok(counts)
    }
```

Details for the implementer:
- **`preview_change_sets_unchecked`** is the existing `preview_change_sets` body. Rename it, and keep `preview_change_sets` as a wrapper.
- **`apply_change_sets_kind`** is the existing `apply_change_sets` with two extra parameters: the restore kind (`GridEdit` for normal grid commits, `Restore` for restores) and the statement text (normal grid commits use `"Grid edit"`). `apply_change_sets` calls it with `GridEdit`.
- **Inside `apply_change_sets_kind`,** when `self.restore_enabled(&handle)`, the `with_session` closure does three things:
  1. before `s.apply`, reads before rows by key (`build_rows_by_key`) for each set's Update and Delete changes;
  2. after a successful `s.apply`, reads after rows for the updates (deleted keys stay `None`);
  3. returns them, so the engine can save one restore point per set: kind as given, status Pending if `open_txn`, else Kept.

  The conflict check already guards the short window between the read and the apply.
- **A failed `apply_ddl`** (for example, the table exists again) fails the whole restore before any data changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "panicked|test result" -A3 | head`
Expected: `8 passed`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add -A crates && git commit -m "feat: restore a restore point (whole or chosen rows) and keep points for grid commits"
```

---

### Task 7: Tauri commands and TS bindings

**Files:**
- Modify:
  - `src-tauri/src/commands/query.rs`;
  - `src-tauri/src/commands/library.rs`;
  - `src-tauri/src/lib.rs`;
  - `src/types/backend.ts`;
  - `src/lib/ipc.ts`.

**Interfaces:**
- **Produces, Tauri commands:**
  - `list_restore_points(connection_id)`;
  - `get_restore_point(id)`;
  - `delete_restore_point(id)`;
  - `preview_restore(session_id, point_id, rows: Option<Vec<usize>>)`;
  - `apply_restore(session_id, point_id, rows, confirmed)`.
- **Produces, TS types:**

```ts
export type RestoreKind = "update" | "delete" | "truncate" | "drop_table" | "drop_column" | "grid_edit" | "restore";
export type RestoreStatus = "pending" | "kept" | "restored";
export interface RestorePointSummary { id: string; connectionId: string; createdAt: string; status: RestoreStatus; restoredAt: string | null; kind: RestoreKind; schema: string; table: string; statement: string; rowCount: number; bytes: number }
export interface RestoreData { columns: string[]; types: string[]; keyColumns: string[]; before: (string | null)[][]; after: ((string | null)[] | null)[]; ddl: string | null; columnType: string | null }
export interface RestorePoint extends RestorePointSummary { data: RestoreData }
export interface RestoreNote { pointId?: string | null; reason?: string | null }
```

- **`StatementResult.restore?: RestoreNote`**, and the `api` functions `listRestorePoints`, `getRestorePoint`, `deleteRestorePoint`, `previewRestore`, `applyRestore`.

- [ ] **Step 1: Write the failing test.** `src/lib/ipc.restore.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { api } from "./ipc";

afterEach(() => clearMocks());

describe("restore point commands", () => {
  it("call the backend with the expected arguments", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === "list_restore_points" ? [] : cmd === "preview_restore" ? { sql: "", statementCount: 0, atomic: true } : null;
    });
    await api.listRestorePoints("c1");
    await api.previewRestore("s1", "p1", [0, 2]);
    await api.applyRestore("s1", "p1", null);
    await api.deleteRestorePoint("p1");
    expect(calls.map((c) => c[0])).toEqual(["list_restore_points", "preview_restore", "apply_restore", "delete_restore_point"]);
    expect(calls[1]![1]).toMatchObject({ sessionId: "s1", pointId: "p1", rows: [0, 2] });
    expect(calls[2]![1]).toMatchObject({ rows: null, confirmed: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (the `api` functions don't exist yet).

Run: `npx vitest run src/lib/ipc.restore.test.ts 2>&1 | grep -E "×|Tests "`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Tauri (`library.rs`):**

```rust
#[tauri::command]
pub fn list_restore_points(state: State<'_, AppState>, connection_id: String) -> Result<Vec<RestorePointSummary>> {
    state.storage.list_restore_points(&connection_id)
}
#[tauri::command]
pub fn get_restore_point(state: State<'_, AppState>, id: String) -> Result<RestorePoint> {
    state.storage.get(&id)
}
#[tauri::command]
pub fn delete_restore_point(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete(&[id])
}
```

Import `RestoreStore` for the trait methods.

**Tauri (`query.rs`):**

```rust
#[tauri::command]
pub async fn preview_restore(state: State<'_, AppState>, session_id: String, point_id: String, rows: Option<Vec<usize>>) -> Result<ChangePreview> {
    state.engine.preview_restore(&session_id, &point_id, rows).await
}
#[tauri::command]
pub async fn apply_restore(state: State<'_, AppState>, session_id: String, point_id: String, rows: Option<Vec<usize>>, confirmed: bool) -> Result<Vec<u64>> {
    let r = state.engine.apply_restore(&session_id, &point_id, rows, confirmed).await;
    tracing::info!(session = %session_id, ok = r.is_ok(), "applied a restore point");
    r
}
```

Register all five in `lib.rs`.

**`ipc.ts`:**

```ts
  listRestorePoints: (connectionId: string) => call<RestorePointSummary[]>("list_restore_points", { connectionId }),
  getRestorePoint: (id: string) => call<RestorePoint>("get_restore_point", { id }),
  deleteRestorePoint: (id: string) => call<void>("delete_restore_point", { id }),
  previewRestore: (sessionId: string, pointId: string, rows: number[] | null) => call<ChangePreview>("preview_restore", { sessionId, pointId, rows }),
  applyRestore: (sessionId: string, pointId: string, rows: number[] | null) => call<number[]>("apply_restore", { sessionId, pointId, rows, confirmed: true }),
```

- [ ] **Step 4: Run** `npx vitest run src/lib && npm run typecheck`, plus the Tauri check.
Expected: pass, and `Finished`.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri src/types/backend.ts src/lib && git commit -m "feat: restore point commands and bindings"
```

---

### Task 8: Restore points panel, status bar entry, palette, run messages

**Files:**
- Create:
  - `src/stores/restore.ts`;
  - `src/features/restore/RestorePanel.tsx`;
  - `src/features/restore/RestorePanel.test.tsx`.
- Modify:
  - `src/app/WorkspaceView.tsx` (StatusBar entry, panel render);
  - `src/features/command-palette/OpenAnything.tsx`;
  - `src/features/sql-editor/QueryTab.tsx` (bump after runs);
  - `src/features/sql-editor/ResultsPanel.tsx` (message line);
  - `src/styles/app.css`.

**Interfaces:**
- **Consumes:** Task 7 `api.*` and types; `ReviewChangesDialog` (`session`, `title`, `sql`, `atomic`, `statements`, `summary`, `commitLabel`, `cancelLabel`, `onCommit`, `onClose`).
- **Produces:** `useRestore = create<{ open: boolean; version: number; setOpen(open: boolean): void; bump(): void }>()`.

- [ ] **Step 1: Write the failing tests** (`RestorePanel.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { RestorePanel } from "./RestorePanel";
import { Overlays } from "../../components/Overlays";
import { session } from "../../test/fixtures";

const summary = {
  id: "p1",
  connectionId: session.connectionId,
  createdAt: "2026-10-14T10:42:00Z",
  status: "kept",
  restoredAt: null,
  kind: "update",
  schema: "public",
  table: "orders",
  statement: "UPDATE orders SET status = 'x' WHERE customer_id = 42",
  rowCount: 2,
  bytes: 120,
};
const point = {
  ...summary,
  data: {
    columns: ["id", "status"],
    types: ["integer", "text"],
    keyColumns: ["id"],
    before: [["7", "paid"], ["8", "new"]],
    after: [["7", "x"], ["8", "x"]],
    ddl: null,
    columnType: null,
  },
};
let calls: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  calls = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args as Record<string, unknown>]);
    if (cmd === "list_restore_points") return [summary];
    if (cmd === "get_restore_point") return point;
    if (cmd === "preview_restore") return { sql: "UPDATE \"public\".\"orders\" SET \"status\" = 'paid' …", statementCount: 1, atomic: true };
    if (cmd === "apply_restore") return [1];
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("RestorePanel", () => {
  it("lists restore points and shows before → after", async () => {
    render(<RestorePanel session={session} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /orders · Update · 2 rows/ }));
    const detail = await screen.findByRole("region", { name: "Restore point" });
    expect(within(detail).getByText("UPDATE orders SET status = 'x' WHERE customer_id = 42")).toBeInTheDocument();
    expect(within(detail).getByText("paid")).toBeInTheDocument();
    expect(within(detail).getAllByText("x")).toHaveLength(2);
  });

  it("restores chosen rows through the review dialog", async () => {
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /orders · Update · 2 rows/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Row 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some(([c]) => c === "apply_restore")).toBe(true));
    expect(calls.find(([c]) => c === "preview_restore")![1]).toMatchObject({ rows: [1] });
    expect(calls.find(([c]) => c === "apply_restore")![1]).toMatchObject({ pointId: "p1", rows: [1] });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/restore 2>&1 | grep -E "×|Tests |Error" | head -3`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

**`src/stores/restore.ts`:**

```ts
import { create } from "zustand";

/** The restore points panel (per window) and a version that bumps when new points may exist. */
export const useRestore = create<{ open: boolean; version: number; setOpen: (open: boolean) => void; bump: () => void }>((set) => ({
  open: false,
  version: 0,
  setOpen: (open) => set({ open }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
```

**`RestorePanel.tsx`:**
- An `aside.detail-panel` with `aria-label="Restore points"`, header "Restore points", and a close button.
- **List:** loads `api.listRestorePoints(session.connectionId)` on mount and whenever `useRestore().version` changes. Each item is a `<button>` whose accessible name is `` `${table} · ${kindLabel} · ${pluralize(rowCount, "row")}` ``. `kindLabel` maps update → "Update", delete → "Delete", truncate → "Truncate", drop_table → "Drop table", drop_column → "Drop column", grid_edit → "Grid edit", restore → "Restore". The item shows the time, the size (`formatBytes`) and a tag for Pending or Restored.
- **Detail:** a `section` with `aria-label="Restore point"`, the statement in a `<pre>`, and a table:
  - columns: a checkbox (`aria-label={"Row " + (i + 1)}`), then each column before, then " → after" cells when `after[i]` exists;
  - changed cells get the class `changed`, and deleted rows (`after[i] === null`, or no after) get `deleted`.
- **Buttons:**
  - **Restore all** previews with `rows = null`; **Restore selected** (disabled with no ticks) previews with `rows = [...selected]`. Each calls `api.previewRestore(...)` and sets `review = { sql, statements, atomic, rows }`.
  - **Delete restore point** asks with `confirmAction` (danger), calls `api.deleteRestorePoint`, then refreshes.
- **Review:** `<ReviewChangesDialog session={session} title="Restore" sql={review.sql} atomic={review.atomic} statements={review.statements} summary={`Restore ${pluralize(n, "row")} in ${schema}.${table}`} commitLabel="Restore" cancelLabel="Cancel" onCommit={async () => { await api.applyRestore(session.sessionId, id, review.rows); notify("Restored", "success"); setReview(null); bump(); }} onClose={() => setReview(null)} />`.
- **Read-only:** when `session.readOnly`, the restore buttons are disabled, with the title "This connection is read-only".

**`WorkspaceView.tsx`:**
- **`StatusBar`:** for SQL workspaces with `ws.profile.restorePoints !== false`, add a button "Restore points · N" (`N` from `api.listRestorePoints(ws.profile.id)`, refreshed on `useRestore().version` and on `ws.id` change). It calls `useRestore.getState().setOpen(true)`.
- **Workspace:** render `{useRestore().open && <RestorePanel session={s} onClose={() => setOpen(false)} />}` next to the tab panels, on the right.

**`OpenAnything.tsx`:** when there is an active workspace, add the action `{ kind: "action", label: "Restore points", where: "", run: () => useRestore.getState().setOpen(true) }`.

**`QueryTab.tsx`:** after `setResult(r)`, call `if (r.statements.some((s) => s.restore?.pointId)) useRestore.getState().bump();`.

**`ResultsPanel.tsx`** (the Messages list): for each statement with `restore`, add a line after its summary:
- `restore.pointId` → "Restore point saved", with a link button **Open** that calls `useRestore.getState().setOpen(true)`;
- `restore.reason` → `No restore point: ${restore.reason}`.

**`app.css`:** `.restore-diff td.changed { background: var(--edited-bg, var(--selection)); }` and `.restore-diff tr.deleted td { color: var(--danger-text); text-decoration: line-through; }`. Use existing tokens: check with `grep -- "--danger-text\|--selection" src/styles/tokens.css`.

**Tests:** add a ResultsPanel test (the message line for `restore: { pointId: "p" }` and `restore: { reason: "joins other tables" }`) and a StatusBar test (the count appears, and clicking opens the panel through the store).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/restore src/features/sql-editor src/app src/features/command-palette 2>&1 | grep -E "×|Tests "; npm run typecheck; npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "feat: restore points panel, status bar entry and run messages"
```

---

### Task 9: Connection switch, settings, run limits from settings

**Files:**
- Modify:
  - `src/features/connections/ConnectionForm.tsx`;
  - `src/stores/settings.ts`;
  - `src/features/settings/SettingsDialog.tsx`;
  - `src/features/sql-editor/QueryTab.tsx`.
- Test:
  - the existing `ConnectionForm.test.tsx` (if present; otherwise create a focused one);
  - `SettingsDialog` tests if present.

- [ ] **Step 1: Write the failing tests**
- **Connection form:** the "Safety & timeouts" section has a checkbox "Keep restore points", checked by default. Unchecking it saves `restorePoints: false`, asserted on the `save_connection` IPC args.
- **Settings:** in the Safety section, four number fields with their defaults:
  - "Keep restore points for (days)": 7;
  - "Max rows per restore point": 100000;
  - "Max size per restore point (MB)": 50;
  - "Total space for restore points (MB)": 1024.
- **QueryTab:** `run_query` options carry `restoreMaxRows` and `restoreMaxMb` from the settings. Add this to the WorkspaceView query test by asserting the `run_query` args.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**
- **`settings.ts`:** add the keys `"restore.keepDays"`, `"restore.maxRows"`, `"restore.maxMb"` and `"restore.maxTotalMb"`, defaults 7, 100000, 50 and 1024.
- **`SettingsDialog.tsx`, Safety section:** four `NumberField`s with min/max of 1–365 days, 1–10,000,000 rows, 1–10,000 MB, and 10–100,000 MB.
- **`ConnectionForm.tsx`,** inside "Safety & timeouts":

```tsx
          <label className="check">
            <input type="checkbox" checked={p.restorePoints !== false} onChange={(e) => set({ restorePoints: e.target.checked })} />
            <span>Keep restore points</span>
          </label>
          <span className="hint">Copies of changed rows are kept on this computer for a few days, so a change can be put back.</span>
```

- **`QueryTab.tsx`:** add `restoreMaxRows: settings["restore.maxRows"], restoreMaxMb: settings["restore.maxMb"]` to the `runQuery` options.
- **Retention after a change in Settings:** the backend reads `restore.keepDays`/`restore.maxTotalMb` from the stored settings at each purge, so nothing else is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/connections src/features/settings src/app 2>&1 | grep -E "×|Tests "; npm run typecheck; npm run lint`

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "feat: restore point switch per connection and limits in Settings"
```

---

### Task 10: Docs, manual check, verification, finish

- [ ] **Step 1: Docs**
- **`FEATURE_MATRIX.md`,** a row:

  `| Restore points | UPDATE/DELETE/TRUNCATE/DROP TABLE/DROP COLUMN (query tabs) and grid commits keep the affected rows locally (7 days, size limits); restore all or chosen rows through review, with a conflict check; statements that can't keep one ask first | VERIFIED | restore_plan.rs, restore.rs, storage.rs, engine.rs, RestorePanel.tsx | all | unit (restore_plan, restore, storage); integration restore_points (PG MY MA SQ DuckDB); RestorePanel/ResultsPanel/settings tests; manual (Xvfb) | Joins, WITH, ORDER BY/LIMIT, key changes and binary columns (non-PG) can't keep a restore point |`
- **`SECURITY_MODEL.md`:** a "Restore points" subsection saying they:
  - store copies of changed rows in the local app database;
  - are unencrypted;
  - are kept for 7 days by default, within the size limits;
  - can be turned off per connection;
  - never leave the machine.
- **`ARCHITECTURE.md`:** a "Restore points" section covering plan → count → confirm → capture in the statement's transaction → `RestoreStore` → restore through change sets.

- [ ] **Step 2: Manual check** (Xvfb, isolated data dir, test PostgreSQL)
- **Create the test table:**

```bash
docker exec -i tpm-test-postgres psql -U postgres -d tpm_test -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE tpm_rp_orders (id int PRIMARY KEY, customer_id int, status text, qty int);
INSERT INTO tpm_rp_orders SELECT g, g % 5, 'paid', g FROM generate_series(1, 20) g;
SQL
```

- **Check in a query tab:**
  1. `UPDATE tpm_rp_orders SET status = 'cancelled' WHERE customer_id = 2` → Messages says "Restore point saved", and the status bar count rises.
  2. Open the panel: before → after, with changed cells highlighted.
  3. Restore one row, review, then restore all, and check the values in `psql`.
  4. `DELETE … WHERE customer_id = 3`, then restore all.
  5. `ALTER TABLE tpm_rp_orders DROP COLUMN qty`, then restore. The column and its values are back.
  6. `UPDATE … FROM` another table → the confirmation lists "joins other tables", and **Run anyway** runs it.
  7. A conflict: change a row in `psql`, then restore it → the conflict error, and nothing written.
- **Turn it off** for the connection and check that no points are made.
- **Screenshots:** dark and light, `target/tpm-scratch/shots/rp-*.png`.
- **Drop the test table** afterwards.

- [ ] **Step 3: Full verification**

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test -p tpm-core
eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration
source target/tpm-scratch/sysroot/env.sh && cargo check -p table-pro-max
source ~/.nvm/nvm.sh && nvm use 24 && npm run typecheck && npm run lint && npm test && npm run build
```

Expected: everything passes.

- [ ] **Step 4: Commit the docs**

`git add docs && git commit -m "docs: restore points in the feature matrix, security model and architecture"`

- [ ] **Step 5: Finish**
  - Run the fresh whole-branch review, then the fix pass.
  - Push and open the PR. It touches `src-tauri/`, so add the `full-ci` label.
  - Squash-merge after **CI passed**.
