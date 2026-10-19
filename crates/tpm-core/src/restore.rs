//! Restore points, part 2: what a restore point holds, where it is kept (`RestoreStore`), and the
//! changes that put its rows back (as `ChangeSet`s for the existing review and commit path).

use serde::{Deserialize, Serialize};

use crate::changes::{ChangeSet, ColumnEdit, ColumnValue, EditValue, RowChange};
use crate::config::Driver;
use crate::dialect::Dialect;
use crate::error::{AppError, Result};
use crate::model::Param;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreKind {
    Update,
    Delete,
    Truncate,
    DropTable,
    DropColumn,
    GridEdit,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStatus {
    /// Made inside the user's open transaction; kept on COMMIT, deleted on ROLLBACK.
    Pending,
    Kept,
    Restored,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreData {
    pub columns: Vec<String>,
    pub types: Vec<String>,
    pub key_columns: Vec<String>,
    /// The rows as they were before the change, values as text.
    pub before: Vec<Vec<Param>>,
    /// Per before row: its values after the change, or `None` when it was deleted.
    pub after: Vec<Option<Vec<Param>>>,
    /// DROP TABLE: the table's definition, run first when the table is gone.
    pub ddl: Option<String>,
    /// DROP COLUMN: the dropped column's type.
    pub column_type: Option<String>,
    /// Columns the database computes: kept for display, never written back.
    #[serde(default)]
    pub generated: Vec<String>,
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

/// How many restore points are kept on this computer, and their size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreUsage {
    pub count: u64,
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

/// Where restore points are kept (the app's local storage).
pub trait RestoreStore: Send + Sync {
    fn save(&self, point: &RestorePoint) -> Result<()>;
    fn get(&self, id: &str) -> Result<RestorePoint>;
    fn set_status(&self, ids: &[String], status: RestoreStatus) -> Result<()>;
    fn delete(&self, ids: &[String]) -> Result<()>;
}

#[derive(Debug)]
pub struct RestoreActions {
    /// Run first, one statement each (the table or column comes back).
    pub ddl: Vec<String>,
    pub sets: Vec<ChangeSet>,
    /// Run after the rows are back (sequences moved past the restored keys).
    pub after: Vec<String>,
}

fn value_at(d: &RestoreData, row: &[Param], column: &str) -> Param {
    d.columns.iter().position(|c| c == column).and_then(|i| row.get(i).cloned()).flatten()
}

fn key_of(d: &RestoreData, row: &[Param]) -> Vec<ColumnValue> {
    d.key_columns.iter().map(|k| ColumnValue { column: k.clone(), value: value_at(d, row, k) }).collect()
}

fn reinsert(d: &RestoreData, row: &[Param]) -> RowChange {
    RowChange::Insert {
        values: d
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| !d.generated.contains(c))
            .map(|(i, c)| ColumnEdit {
                column: c.clone(),
                value: EditValue::Value { value: row.get(i).cloned().flatten() },
                original: None,
            })
            .collect(),
    }
}

/// The DDL and row changes that put a restore point's rows back: all rows, or the chosen
/// indexes into `data.before`. `table_exists` says whether the table (for DROP COLUMN: the
/// column) is there again, in which case no DDL is generated.
pub fn build_restore(
    point: &RestorePoint,
    driver: Driver,
    rows: Option<&[usize]>,
    table_exists: bool,
) -> Result<RestoreActions> {
    let dialect = driver.dialect();
    let d = &point.data;
    let chosen: Vec<usize> = match rows {
        Some(r) => r.iter().copied().filter(|i| *i < d.before.len()).collect(),
        None => (0..d.before.len()).collect(),
    };
    // A dropped table or column with no rows still comes back (DDL only).
    if chosen.is_empty() && (rows.is_some() || !matches!(point.kind, RestoreKind::DropTable | RestoreKind::DropColumn))
    {
        return Err(AppError::invalid_config("Choose at least one row to restore"));
    }
    let mut ddl = Vec::new();
    let mut after = Vec::new();
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
                            .filter(|(j, c)| {
                                !d.key_columns.contains(c)
                                    && !d.generated.contains(c)
                                    && before.get(*j) != after.get(*j)
                            })
                            .map(|(j, c)| ColumnEdit {
                                column: c.clone(),
                                value: EditValue::Value { value: before.get(j).cloned().flatten() },
                                // The value the change left behind: if it differs now, someone
                                // changed the row since, and the restore stops.
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
        RestoreKind::Delete | RestoreKind::Truncate => {
            changes.extend(chosen.iter().map(|i| reinsert(d, &d.before[*i])))
        }
        RestoreKind::DropTable => {
            if !table_exists {
                let def =
                    d.ddl.clone().ok_or_else(|| AppError::internal("This restore point has no table definition"))?;
                let (before, statements, then) = table_ddl(driver, &point.schema, &point.table, &def)?;
                ddl.extend(before);
                ddl.extend(statements);
                after.extend(then);
            }
            changes.extend(chosen.iter().map(|i| reinsert(d, &d.before[*i])));
        }
        RestoreKind::DropColumn => {
            let col = d
                .columns
                .iter()
                .find(|c| !d.key_columns.contains(c))
                .cloned()
                .ok_or_else(|| AppError::internal("This restore point has no dropped column"))?;
            if !table_exists {
                let table = dialect.qualified(Some(&point.schema), &point.table)?;
                let ty = d.column_type.clone().unwrap_or_else(|| "text".into());
                ddl.push(format!("ALTER TABLE {table} ADD COLUMN {} {ty}", dialect.quote_ident(&col)?));
            }
            for i in chosen {
                let before = &d.before[i];
                changes.push(RowChange::Update {
                    key: key_of(d, before),
                    edits: vec![ColumnEdit {
                        column: col.clone(),
                        value: EditValue::Value { value: value_at(d, before, &col) },
                        original: None,
                    }],
                });
            }
        }
    }
    let sets = if changes.is_empty() {
        vec![]
    } else {
        vec![ChangeSet { schema: point.schema.clone(), table: point.table.clone(), changes, check_conflicts: true }]
    };
    Ok(RestoreActions { ddl, sets, after })
}

/// A saved table definition as separate statements, the table name put in `schema` when the
/// definition leaves it out (MySQL `SHOW CREATE TABLE`, DuckDB), plus, on PostgreSQL, the
/// sequences of `serial` columns, which DROP TABLE dropped with the table: created before it,
/// and moved past the restored keys after the rows are back.
type TableDdl = (Vec<String>, Vec<String>, Vec<String>);

fn table_ddl(driver: Driver, schema: &str, table: &str, def: &str) -> Result<TableDdl> {
    let dialect = driver.dialect();
    // A SQL Server definition is one batch: run its statements one by one, like the others'.
    let spans = if dialect == Dialect::Mssql {
        crate::split::mssql_statement_spans(def)
    } else {
        crate::split::split_statements(def, dialect)
    };
    let mut statements: Vec<String> = spans.into_iter().map(|s| s.sql).filter(|s| !s.is_empty()).collect();
    if let Some(first) = statements.first_mut() {
        *first = qualify_create_table(first, dialect, schema)?;
    }
    let (mut before, mut after) = (Vec::new(), Vec::new());
    if driver == Driver::Postgres
        && let Some(create) = statements.first()
    {
        let qualified = dialect.qualified(Some(schema), table)?;
        for line in create.lines() {
            let Some(at) = line.find("nextval('") else { continue };
            let rest = &line[at + "nextval('".len()..];
            let Some(end) = rest.find("'::regclass") else { continue };
            let seq = &rest[..end];
            // The column is the line's leading (quoted) identifier.
            let Some((col, _)) = line.trim_start().strip_prefix('"').and_then(|c| c.split_once('"')) else {
                continue;
            };
            let col = dialect.quote_ident(col)?;
            before.push(format!("CREATE SEQUENCE IF NOT EXISTS {seq}"));
            after.push(format!("ALTER SEQUENCE {seq} OWNED BY {qualified}.{col}"));
            after.push(format!("SELECT setval('{seq}', COALESCE((SELECT max({col}) FROM {qualified}), 0) + 1, false)"));
        }
    }
    Ok((before, statements, after))
}

/// `CREATE TABLE name …` → `CREATE TABLE schema.name …` when the name is not qualified.
fn qualify_create_table(sql: &str, dialect: Dialect, schema: &str) -> Result<String> {
    let upper = sql.to_ascii_uppercase();
    let Some(mut at) = upper.find("TABLE") else { return Ok(sql.to_string()) };
    let skip_ws = |i: usize| i + sql[i..].len() - sql[i..].trim_start().len();
    at = skip_ws(at + "TABLE".len());
    if upper[at..].starts_with("IF NOT EXISTS") {
        at = skip_ws(at + "IF NOT EXISTS".len());
    }
    // The name: a quoted identifier, or a bare word.
    let bytes = sql.as_bytes();
    let mut end = at;
    match bytes.get(at) {
        Some(&q @ (b'"' | b'`')) => {
            end += 1;
            while end < bytes.len() {
                if bytes[end] == q {
                    if bytes.get(end + 1) == Some(&q) {
                        end += 2;
                        continue;
                    }
                    end += 1;
                    break;
                }
                end += 1;
            }
        }
        _ => {
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] >= 0x80)
            {
                end += 1;
            }
        }
    }
    if end == at || bytes.get(end) == Some(&b'.') {
        return Ok(sql.to_string());
    }
    Ok(format!("{}{}.{}", &sql[..at], dialect.quote_ident(schema)?, &sql[at..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Driver;

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
                generated: vec![],
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
        let a = build_restore(&p, Driver::Postgres, None, true).unwrap();
        assert!(a.ddl.is_empty());
        let RowChange::Update { key, edits } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(key[0].value, s("1"));
        assert_eq!(edits.len(), 1, "unchanged columns are left alone");
        assert_eq!(edits[0].column, "status");
        assert!(matches!(&edits[0].value, EditValue::Value { value } if *value == s("paid")));
        assert_eq!(edits[0].original, Some(s("x")));
        assert!(a.sets[0].check_conflicts);
        let only_second = build_restore(&p, Driver::Postgres, Some(&[1]), true).unwrap();
        assert_eq!(only_second.sets[0].changes.len(), 1);
        let RowChange::Update { key, .. } = &only_second.sets[0].changes[0] else { panic!() };
        assert_eq!(key[0].value, s("2"));
        assert!(build_restore(&p, Driver::Postgres, Some(&[]), true).is_err(), "no rows chosen");
    }

    #[test]
    fn deletes_and_truncates_reinsert_every_column() {
        let p = point(RestoreKind::Delete, vec![vec![s("1"), s("paid"), None]], vec![]);
        let a = build_restore(&p, Driver::Postgres, None, true).unwrap();
        let RowChange::Insert { values } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(values.len(), 3);
        assert!(matches!(&values[2].value, EditValue::Value { value: None }));
        let t = point(RestoreKind::Truncate, vec![vec![s("1"), s("a"), None], vec![s("2"), s("b"), None]], vec![]);
        assert_eq!(build_restore(&t, Driver::Postgres, None, true).unwrap().sets[0].changes.len(), 2);
    }

    #[test]
    fn grid_edits_mix_updates_and_reinserts() {
        let p = point(
            RestoreKind::GridEdit,
            vec![vec![s("1"), s("a"), None], vec![s("2"), s("b"), None]],
            vec![Some(vec![s("1"), s("z"), None]), None],
        );
        let a = build_restore(&p, Driver::Postgres, None, true).unwrap();
        assert!(matches!(a.sets[0].changes[0], RowChange::Update { .. }));
        assert!(matches!(a.sets[0].changes[1], RowChange::Insert { .. }));
    }

    #[test]
    fn dropped_tables_and_columns_come_back_with_ddl_first() {
        let mut t = point(RestoreKind::DropTable, vec![vec![s("1"), s("a"), None]], vec![]);
        t.data.ddl =
            Some("CREATE TABLE \"public\".\"orders\" (id integer PRIMARY KEY, status text, note text);".into());
        let a = build_restore(&t, Driver::Postgres, None, false).unwrap();
        assert_eq!(
            a.ddl,
            vec!["CREATE TABLE \"public\".\"orders\" (id integer PRIMARY KEY, status text, note text)".to_string()]
        );
        assert!(build_restore(&t, Driver::Postgres, None, true).unwrap().ddl.is_empty(), "the table exists again");
        let mut c = point(RestoreKind::DropColumn, vec![vec![s("1"), s("gone")]], vec![]);
        c.data.columns = vec!["id".into(), "status".into()];
        c.data.column_type = Some("text".into());
        let a = build_restore(&c, Driver::Postgres, None, false).unwrap();
        assert_eq!(a.ddl, vec!["ALTER TABLE \"public\".\"orders\" ADD COLUMN \"status\" text".to_string()]);
        let RowChange::Update { key, edits } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(
            (key[0].value.clone(), edits[0].column.as_str(), edits[0].original.clone()),
            (s("1"), "status", None)
        );
    }

    #[test]
    fn a_dropped_table_comes_back_statement_by_statement_with_its_sequences() {
        let mut t = point(RestoreKind::DropTable, vec![vec![s("1"), s("a"), None]], vec![]);
        t.data.ddl = Some(
            "CREATE TABLE \"public\".\"orders\" (\n  \"id\" integer DEFAULT nextval('orders_id_seq'::regclass) NOT NULL,\n  \"status\" text,\n  \"note\" text\n);\nCREATE INDEX orders_status ON public.orders USING btree (status);\nCOMMENT ON COLUMN \"public\".\"orders\".\"note\" IS 'n; m';"
                .into(),
        );
        let a = build_restore(&t, Driver::Postgres, None, false).unwrap();
        assert_eq!(a.ddl.len(), 4, "{:?}", a.ddl);
        assert_eq!(a.ddl[0], "CREATE SEQUENCE IF NOT EXISTS orders_id_seq");
        assert!(a.ddl[1].starts_with("CREATE TABLE \"public\".\"orders\""));
        assert!(a.ddl[2].starts_with("CREATE INDEX orders_status"));
        assert_eq!(a.ddl[3], "COMMENT ON COLUMN \"public\".\"orders\".\"note\" IS 'n; m'");
        assert_eq!(
            a.after,
            vec![
                "ALTER SEQUENCE orders_id_seq OWNED BY \"public\".\"orders\".\"id\"".to_string(),
                "SELECT setval('orders_id_seq', COALESCE((SELECT max(\"id\") FROM \"public\".\"orders\"), 0) + 1, false)".to_string(),
            ]
        );
    }

    #[test]
    fn unqualified_table_definitions_are_put_in_the_point_schema() {
        let mut t = point(RestoreKind::DropTable, vec![vec![s("1"), s("a"), None]], vec![]);
        t.schema = "shop".into();
        t.data.ddl =
            Some("CREATE TABLE `orders` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB".into());
        let a = build_restore(&t, Driver::Mysql, None, false).unwrap();
        assert!(a.ddl[0].starts_with("CREATE TABLE `shop`.`orders` ("), "{}", a.ddl[0]);
        t.schema = "main".into();
        t.data.ddl = Some("CREATE TABLE orders(id INTEGER PRIMARY KEY, status VARCHAR);".into());
        let a = build_restore(&t, Driver::Duckdb, None, false).unwrap();
        assert_eq!(a.ddl[0], "CREATE TABLE \"main\".orders(id INTEGER PRIMARY KEY, status VARCHAR)");
        assert!(a.after.is_empty());
    }

    #[test]
    fn generated_columns_are_left_to_the_database() {
        let mut p =
            point(RestoreKind::Update, vec![vec![s("1"), s("2"), s("4")]], vec![Some(vec![s("1"), s("5"), s("10")])]);
        p.data.columns = vec!["id".into(), "qty".into(), "total".into()];
        p.data.generated = vec!["total".into()];
        let a = build_restore(&p, Driver::Postgres, None, true).unwrap();
        let RowChange::Update { edits, .. } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(edits.iter().map(|e| e.column.as_str()).collect::<Vec<_>>(), vec!["qty"]);
        p.kind = RestoreKind::Delete;
        p.data.after = vec![];
        let a = build_restore(&p, Driver::Postgres, None, true).unwrap();
        let RowChange::Insert { values } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(values.iter().map(|e| e.column.as_str()).collect::<Vec<_>>(), vec!["id", "qty"]);
    }
}
