//! Which cells of a query result can be edited: the database reports each column's origin,
//! and a table is editable in a result when it is a real table whose whole primary key is
//! present exactly once. See docs/superpowers/specs/2026-10-14-editable-query-results-design.md.

use serde::Serialize;

use crate::model::{ColumnMeta, ObjectKind, TableStructure};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableTable {
    pub schema: String,
    pub table: String,
    /// Result column index of each primary-key column, in primary-key order.
    pub key_columns: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyReason {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEditing {
    pub tables: Vec<EditableTable>,
    /// Per result column: index into `tables`, or `None` when the column cannot be edited.
    pub columns: Vec<Option<usize>>,
    pub read_only: Vec<ReadOnlyReason>,
}

/// Distinct origin tables, in the order they first appear.
pub fn origin_tables(columns: &[ColumnMeta]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for o in columns.iter().filter_map(|c| c.origin.as_ref()) {
        let k = (o.schema.clone(), o.table.clone());
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

/// Why a result can't be edited when the server didn't say where its columns come from (the
/// describe failed, as behind a connection pooler): not every column is computed.
pub const ORIGINS_NOT_REPORTED: &str = "The server didn't report which table these columns come from";

pub fn not_editable(columns: &[ColumnMeta], reason: &str) -> ResultEditing {
    ResultEditing {
        tables: vec![],
        columns: vec![None; columns.len()],
        read_only: vec![ReadOnlyReason { column: None, reason: reason.into() }],
    }
}

pub fn result_editing(columns: &[ColumnMeta], structures: &[TableStructure]) -> ResultEditing {
    result_editing_with(columns, structures, &[], &[])
}

/// As `result_editing`, with origin tables already ruled out (by `result_sql`) and the reason why,
/// and the tables the statement names exactly once: for those, a key column shown twice
/// (`SELECT *, id AS x`) is the same value twice, not a second row.
pub fn result_editing_with(
    columns: &[ColumnMeta],
    structures: &[TableStructure],
    pre_blocked: &[((String, String), String)],
    appears_once: &[(String, String)],
) -> ResultEditing {
    let mut e = ResultEditing { tables: vec![], columns: vec![None; columns.len()], read_only: vec![] };
    // Reason per origin table that cannot be edited.
    let mut blocked: Vec<((String, String), String)> = Vec::new();
    for (schema, table) in origin_tables(columns) {
        if let Some((_, reason)) = pre_blocked.iter().find(|((s, t), _)| *s == schema && *t == table) {
            blocked.push(((schema, table), reason.clone()));
            continue;
        }
        let Some(s) = structures.iter().find(|s| s.schema == schema && s.name == table) else {
            blocked.push(((schema, table.clone()), format!("Could not read the structure of {table}")));
            continue;
        };
        if s.kind != ObjectKind::Table {
            let what = match s.kind {
                ObjectKind::MaterializedView => "a materialized view",
                ObjectKind::ForeignTable => "a foreign table",
                _ => "a view",
            };
            blocked.push(((schema, table.clone()), format!("{table} is {what}")));
            continue;
        }
        let mut pk: Vec<&crate::model::ColumnInfo> = s.columns.iter().filter(|c| c.primary_key.is_some()).collect();
        pk.sort_by_key(|c| c.primary_key);
        if pk.is_empty() {
            blocked.push(((schema, table.clone()), format!("{table} has no primary key")));
            continue;
        }
        let from_this = |i: usize, col: &str| {
            columns[i].origin.as_ref().is_some_and(|o| o.schema == schema && o.table == table && o.column == col)
        };
        let mut key_columns = Vec::new();
        let mut missing = Vec::new();
        let mut repeated = false;
        let once = appears_once.iter().any(|(s, t)| *s == schema && *t == table);
        for k in &pk {
            let hits: Vec<usize> = (0..columns.len()).filter(|&i| from_this(i, &k.name)).collect();
            match hits.as_slice() {
                [] => missing.push(k.name.clone()),
                [i] => key_columns.push(*i),
                [first, ..] if once => key_columns.push(*first),
                _ => repeated = true,
            }
        }
        if repeated {
            blocked.push((
                (schema, table.clone()),
                format!("{table} appears more than once, so rows cannot be told apart"),
            ));
            continue;
        }
        if !missing.is_empty() {
            blocked
                .push(((schema, table.clone()), format!("Add {} to the SELECT to edit {table}", missing.join(", "))));
            continue;
        }
        let idx = e.tables.len();
        e.tables.push(EditableTable { schema: schema.clone(), table: table.clone(), key_columns });
        for (i, c) in columns.iter().enumerate() {
            if let Some(o) = &c.origin
                && o.schema == schema
                && o.table == table
                && s.columns.iter().any(|sc| sc.name == o.column)
            {
                e.columns[i] = Some(idx);
            }
        }
    }
    for (i, c) in columns.iter().enumerate() {
        if e.columns[i].is_some() {
            continue;
        }
        let reason = match &c.origin {
            None => "Computed column".to_string(),
            Some(o) => blocked
                .iter()
                .find(|((s, t), _)| *s == o.schema && *t == o.table)
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| format!("{} is not a column of {}", o.column, o.table)),
        };
        e.read_only.push(ReadOnlyReason { column: Some(i), reason });
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnInfo, ColumnMeta, ColumnOrigin, ObjectKind, TableStructure};

    fn col(name: &str, origin: Option<(&str, &str, &str)>) -> ColumnMeta {
        ColumnMeta::new(name, "").with_origin(origin.map(|(s, t, c)| ColumnOrigin {
            schema: s.into(),
            table: t.into(),
            column: c.into(),
        }))
    }
    fn table(schema: &str, name: &str, kind: ObjectKind, cols: &[(&str, Option<u32>)]) -> TableStructure {
        TableStructure {
            schema: schema.into(),
            name: name.into(),
            kind,
            columns: cols
                .iter()
                .map(|(n, pk)| ColumnInfo {
                    enum_values: Vec::new(),
                    name: (*n).into(),
                    data_type: "text".into(),
                    nullable: true,
                    default: None,
                    primary_key: *pk,
                    auto_increment: false,
                    comment: None,
                    generated: false,
                })
                .collect(),
            ..Default::default()
        }
    }
    fn users() -> TableStructure {
        table("public", "users", ObjectKind::Table, &[("id", Some(1)), ("email", None), ("name", None)])
    }

    #[test]
    fn a_key_column_selected_twice_stays_editable() {
        // SELECT *, id AS x FROM users: the table appears once; its key is just shown twice.
        let cols = [
            col("id", Some(("public", "users", "id"))),
            col("email", Some(("public", "users", "email"))),
            col("x", Some(("public", "users", "id"))),
        ];
        let once = [("public".to_string(), "users".to_string())];
        let e = result_editing_with(&cols, &[users()], &[], &once);
        assert_eq!(e.tables.len(), 1, "{e:?}");
        assert_eq!(e.tables[0].key_columns, vec![0]);
        assert_eq!(e.columns, vec![Some(0), Some(0), Some(0)]);
        assert!(e.read_only.is_empty(), "{:?}", e.read_only);
    }

    #[test]
    fn materialized_views_and_foreign_tables_are_named_as_such() {
        let mv = table("public", "daily", ObjectKind::MaterializedView, &[("id", None)]);
        let ft = table("public", "remote", ObjectKind::ForeignTable, &[("id", None)]);
        let cols = [col("id", Some(("public", "daily", "id"))), col("rid", Some(("public", "remote", "id")))];
        let e = result_editing(&cols, &[mv, ft]);
        assert_eq!(e.read_only[0].reason, "daily is a materialized view");
        assert_eq!(e.read_only[1].reason, "remote is a foreign table");
    }

    #[test]
    fn single_table_with_key_is_editable_and_computed_columns_are_not() {
        let cols = vec![
            col("id", Some(("public", "users", "id"))),
            col("mail", Some(("public", "users", "email"))),
            col("n", None),
        ];
        let e = result_editing(&cols, &[users()]);
        assert_eq!(
            e.tables,
            vec![EditableTable { schema: "public".into(), table: "users".into(), key_columns: vec![0] }]
        );
        assert_eq!(e.columns, vec![Some(0), Some(0), None]);
        assert!(e.read_only.iter().any(|r| r.column == Some(2) && r.reason == "Computed column"));
    }

    #[test]
    fn missing_key_makes_the_table_read_only_with_a_hint() {
        let cols = vec![col("email", Some(("public", "users", "email")))];
        let e = result_editing(&cols, &[users()]);
        assert!(e.tables.is_empty());
        assert_eq!(e.columns, vec![None]);
        assert_eq!(
            e.read_only[0],
            ReadOnlyReason { column: Some(0), reason: "Add id to the SELECT to edit users".into() }
        );
    }

    #[test]
    fn join_is_editable_per_table() {
        let orders =
            table("public", "orders", ObjectKind::Table, &[("id", Some(1)), ("status", None), ("user_id", None)]);
        let cols = vec![
            col("id", Some(("public", "orders", "id"))),
            col("status", Some(("public", "orders", "status"))),
            col("email", Some(("public", "users", "email"))),
        ];
        let e = result_editing(&cols, &[orders, users()]);
        assert_eq!(e.tables.len(), 1);
        assert_eq!(e.tables[0].table, "orders");
        assert_eq!(e.columns, vec![Some(0), Some(0), None]);
        assert!(e.read_only.iter().any(|r| r.column == Some(2) && r.reason == "Add id to the SELECT to edit users"));
    }

    #[test]
    fn views_and_tables_without_keys_stay_read_only() {
        let v = table("public", "active_users", ObjectKind::View, &[("id", None), ("email", None)]);
        let nokey = table("public", "log", ObjectKind::Table, &[("msg", None)]);
        let cols = vec![col("id", Some(("public", "active_users", "id"))), col("msg", Some(("public", "log", "msg")))];
        let e = result_editing(&cols, &[v, nokey]);
        assert!(e.tables.is_empty());
        assert_eq!(e.read_only[0].reason, "active_users is a view");
        assert_eq!(e.read_only[1].reason, "log has no primary key");
    }

    #[test]
    fn composite_keys_need_every_part_and_keep_key_order() {
        let t = table("public", "pairs", ObjectKind::Table, &[("b", Some(2)), ("a", Some(1)), ("v", None)]);
        let only_a = vec![col("a", Some(("public", "pairs", "a"))), col("v", Some(("public", "pairs", "v")))];
        assert!(result_editing(&only_a, std::slice::from_ref(&t)).tables.is_empty());
        let both = vec![
            col("v", Some(("public", "pairs", "v"))),
            col("b", Some(("public", "pairs", "b"))),
            col("a", Some(("public", "pairs", "a"))),
        ];
        assert_eq!(result_editing(&both, &[t]).tables[0].key_columns, vec![2, 1]);
    }

    #[test]
    fn a_table_that_appears_twice_is_read_only() {
        // Self-join: two `id` columns from the same table. The key is ambiguous.
        let cols = vec![
            col("id", Some(("public", "users", "id"))),
            col("id", Some(("public", "users", "id"))),
            col("email", Some(("public", "users", "email"))),
        ];
        let e = result_editing(&cols, &[users()]);
        assert!(e.tables.is_empty());
        assert!(e.read_only.iter().any(|r| r.reason == "users appears more than once, so rows cannot be told apart"));
    }

    #[test]
    fn a_missing_structure_is_read_only_not_an_error() {
        let cols = vec![col("id", Some(("public", "gone", "id")))];
        let e = result_editing(&cols, &[]);
        assert!(e.tables.is_empty());
        assert_eq!(e.read_only[0].reason, "Could not read the structure of gone");
    }

    #[test]
    fn not_editable_blocks_everything_with_one_reason() {
        let cols = vec![col("id", Some(("public", "users", "id")))];
        let e = not_editable(&cols, "Read-only connection");
        assert_eq!(e.columns, vec![None]);
        assert_eq!(e.read_only, vec![ReadOnlyReason { column: None, reason: "Read-only connection".into() }]);
    }
}
