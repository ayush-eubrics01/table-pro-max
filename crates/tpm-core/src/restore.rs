//! Restore points, part 2: what a restore point holds, where it is kept (`RestoreStore`), and the
//! changes that put its rows back (as `ChangeSet`s for the existing review and commit path).

use serde::{Deserialize, Serialize};

use crate::changes::{ChangeSet, ColumnEdit, ColumnValue, EditValue, RowChange};
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

/// Where restore points are kept (the app's local storage).
pub trait RestoreStore: Send + Sync {
    fn save(&self, point: &RestorePoint) -> Result<()>;
    fn get(&self, id: &str) -> Result<RestorePoint>;
    fn set_status(&self, ids: &[String], status: RestoreStatus) -> Result<()>;
    fn delete(&self, ids: &[String]) -> Result<()>;
}

#[derive(Debug)]
pub struct RestoreActions {
    pub ddl: Vec<String>,
    pub sets: Vec<ChangeSet>,
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
    dialect: Dialect,
    rows: Option<&[usize]>,
    table_exists: bool,
) -> Result<RestoreActions> {
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
                ddl.push(
                    d.ddl.clone().ok_or_else(|| AppError::internal("This restore point has no table definition"))?,
                );
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
    Ok(RestoreActions { ddl, sets })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(build_restore(&p, Dialect::Postgres, Some(&[]), true).is_err(), "no rows chosen");
    }

    #[test]
    fn deletes_and_truncates_reinsert_every_column() {
        let p = point(RestoreKind::Delete, vec![vec![s("1"), s("paid"), None]], vec![]);
        let a = build_restore(&p, Dialect::Postgres, None, true).unwrap();
        let RowChange::Insert { values } = &a.sets[0].changes[0] else { panic!() };
        assert_eq!(values.len(), 3);
        assert!(matches!(&values[2].value, EditValue::Value { value: None }));
        let t = point(RestoreKind::Truncate, vec![vec![s("1"), s("a"), None], vec![s("2"), s("b"), None]], vec![]);
        assert_eq!(build_restore(&t, Dialect::Postgres, None, true).unwrap().sets[0].changes.len(), 2);
    }

    #[test]
    fn grid_edits_mix_updates_and_reinserts() {
        let p = point(
            RestoreKind::GridEdit,
            vec![vec![s("1"), s("a"), None], vec![s("2"), s("b"), None]],
            vec![Some(vec![s("1"), s("z"), None]), None],
        );
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
        assert_eq!(
            (key[0].value.clone(), edits[0].column.as_str(), edits[0].original.clone()),
            (s("1"), "status", None)
        );
    }
}
