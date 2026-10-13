//! Pending grid edits compiled to parameterised INSERT/UPDATE/DELETE statements.
//!
//! Rows are identified by their primary key. Updates and deletes must affect exactly
//! one row; when optimistic concurrency checking is on, updates additionally require
//! the edited columns to still hold the values that were loaded, so a concurrent
//! change by another client is reported as a conflict instead of being overwritten.

use serde::{Deserialize, Serialize};

use crate::adapters::ParamStatement;
use crate::dialect::Dialect;
use crate::error::{AppError, Result};
use crate::model::{ObjectKind, Param, TableStructure};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditValue {
    Value {
        value: Param,
    },
    /// Use the column default (omitted from INSERT, `DEFAULT` in UPDATE).
    Default,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    pub column: String,
    pub value: Param,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnEdit {
    pub column: String,
    pub value: EditValue,
    /// The value as loaded, used for the concurrency check. `None` inside `Some` means
    /// the loaded value was NULL; an absent field skips the check for this column.
    #[serde(default, deserialize_with = "present_or_null")]
    pub original: Option<Param>,
}

/// Distinguishes an explicit JSON `null` (`Some(None)`) from an absent field (`None`).
fn present_or_null<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Param>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RowChange {
    #[serde(rename_all = "camelCase")]
    Insert { values: Vec<ColumnEdit> },
    #[serde(rename_all = "camelCase")]
    Update { key: Vec<ColumnValue>, edits: Vec<ColumnEdit> },
    #[serde(rename_all = "camelCase")]
    Delete { key: Vec<ColumnValue> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub schema: String,
    pub table: String,
    pub changes: Vec<RowChange>,
    #[serde(default = "default_true")]
    pub check_conflicts: bool,
}

fn default_true() -> bool {
    true
}

/// Column types whose text form does not compare reliably with a bound string.
fn comparable(dialect: Dialect, data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    match dialect {
        // Comparisons are done on the ::text rendering, which is what was loaded.
        Dialect::Postgres => true,
        Dialect::Mysql => !["float", "double", "real", "json", "blob", "binary", "geometry", "bit", "point", "polygon"]
            .iter()
            .any(|x| t.contains(x)),
        Dialect::Sqlite => !t.contains("blob"),
    }
}

pub fn build_statements(dialect: Dialect, s: &TableStructure, set: &ChangeSet) -> Result<Vec<ParamStatement>> {
    if s.kind != ObjectKind::Table {
        return Err(AppError::unsupported("Only tables can be edited"));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    let pk: Vec<String> = s.primary_key().iter().map(|c| c.name.clone()).collect();
    let mut out = Vec::with_capacity(set.changes.len());
    for change in &set.changes {
        out.push(match change {
            RowChange::Insert { values } => build_insert(dialect, s, &table, values)?,
            RowChange::Update { key, edits } => build_update(dialect, s, &table, &pk, key, edits, set.check_conflicts)?,
            RowChange::Delete { key } => build_delete(dialect, &table, &pk, key)?,
        });
    }
    Ok(out)
}

fn check_column(s: &TableStructure, name: &str) -> Result<()> {
    s.column(name).map(|_| ()).ok_or_else(|| AppError::invalid_config(format!("Unknown column '{name}'")))
}

fn placeholder(dialect: Dialect, params: &mut Vec<Param>, v: Param) -> String {
    params.push(v);
    dialect.placeholder(params.len())
}

fn build_insert(dialect: Dialect, s: &TableStructure, table: &str, values: &[ColumnEdit]) -> Result<ParamStatement> {
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    let mut params = Vec::new();
    for v in values {
        check_column(s, &v.column)?;
        if let EditValue::Value { value } = &v.value {
            let info = s.column(&v.column).expect("checked");
            if value.is_none() && !info.nullable {
                return Err(AppError::invalid_config(format!("Column '{}' cannot be NULL", v.column)));
            }
            cols.push(dialect.quote_ident(&v.column)?);
            vals.push(placeholder(dialect, &mut params, value.clone()));
        }
    }
    for c in &s.columns {
        let provided = values.iter().any(|v| v.column == c.name && matches!(v.value, EditValue::Value { .. }));
        if !provided && !c.nullable && c.default.is_none() && !c.auto_increment {
            return Err(AppError::invalid_config(format!("Column '{}' requires a value", c.name)));
        }
    }
    let sql = if cols.is_empty() {
        match dialect {
            Dialect::Mysql => format!("INSERT INTO {table} () VALUES ()"),
            _ => format!("INSERT INTO {table} DEFAULT VALUES"),
        }
    } else {
        format!("INSERT INTO {table} ({}) VALUES ({})", cols.join(", "), vals.join(", "))
    };
    Ok(ParamStatement { sql, params, expect_rows: Some(1) })
}

fn key_clause(dialect: Dialect, pk: &[String], key: &[ColumnValue], params: &mut Vec<Param>) -> Result<String> {
    if pk.is_empty() {
        return Err(AppError::unsupported("This table has no primary key, so rows cannot be identified for editing"));
    }
    let mut parts = Vec::new();
    for col in pk {
        let kv = key
            .iter()
            .find(|k| &k.column == col)
            .ok_or_else(|| AppError::invalid_config(format!("Missing primary key value for '{col}'")))?;
        let v = kv.value.clone().ok_or_else(|| AppError::invalid_config(format!("Primary key '{col}' is NULL")))?;
        let p = placeholder(dialect, params, Some(v));
        parts.push(format!("{} = {p}", dialect.quote_ident(col)?));
    }
    Ok(parts.join(" AND "))
}

fn build_update(
    dialect: Dialect,
    s: &TableStructure,
    table: &str,
    pk: &[String],
    key: &[ColumnValue],
    edits: &[ColumnEdit],
    check_conflicts: bool,
) -> Result<ParamStatement> {
    if edits.is_empty() {
        return Err(AppError::invalid_config("An update must change at least one column"));
    }
    let mut params = Vec::new();
    let mut sets = Vec::new();
    for e in edits {
        check_column(s, &e.column)?;
        let q = dialect.quote_ident(&e.column)?;
        match &e.value {
            EditValue::Value { value } => {
                if value.is_none() && !s.column(&e.column).expect("checked").nullable {
                    return Err(AppError::invalid_config(format!("Column '{}' cannot be NULL", e.column)));
                }
                let p = placeholder(dialect, &mut params, value.clone());
                sets.push(format!("{q} = {p}"));
            }
            EditValue::Default => {
                if dialect == Dialect::Sqlite {
                    return Err(AppError::unsupported("SQLite does not support DEFAULT in UPDATE"));
                }
                sets.push(format!("{q} = DEFAULT"));
            }
        }
    }
    let mut where_sql = key_clause(dialect, pk, key, &mut params)?;
    if check_conflicts {
        for e in edits {
            let Some(original) = &e.original else { continue };
            let info = s.column(&e.column).expect("checked");
            if !comparable(dialect, &info.data_type) {
                continue;
            }
            let q = dialect.quote_ident(&e.column)?;
            let lhs = if dialect == Dialect::Postgres { format!("{q}::text") } else { q };
            let p = placeholder(dialect, &mut params, original.clone());
            where_sql.push_str(&format!(" AND {lhs} {} {p}", dialect.null_safe_eq()));
        }
    }
    Ok(ParamStatement {
        sql: format!("UPDATE {table} SET {} WHERE {where_sql}", sets.join(", ")),
        params,
        expect_rows: Some(1),
    })
}

fn build_delete(dialect: Dialect, table: &str, pk: &[String], key: &[ColumnValue]) -> Result<ParamStatement> {
    let mut params = Vec::new();
    let where_sql = key_clause(dialect, pk, key, &mut params)?;
    Ok(ParamStatement { sql: format!("DELETE FROM {table} WHERE {where_sql}"), params, expect_rows: Some(1) })
}

/// Renders statements with parameters inlined as literals, for the review dialog only.
pub fn preview(dialect: Dialect, statements: &[ParamStatement]) -> String {
    statements.iter().map(|st| format!("{};", inline_params(dialect, st))).collect::<Vec<_>>().join("\n")
}

fn inline_params(dialect: Dialect, st: &ParamStatement) -> String {
    let literal = |p: &Param| p.as_deref().map_or_else(|| "NULL".to_string(), |v| dialect.quote_literal(v));
    match dialect {
        Dialect::Mysql => {
            let mut out = String::new();
            let mut i = 0;
            for ch in st.sql.chars() {
                if ch == '?' && i < st.params.len() {
                    out.push_str(&literal(&st.params[i]));
                    i += 1;
                } else {
                    out.push(ch);
                }
            }
            out
        }
        Dialect::Postgres | Dialect::Sqlite => {
            let prefix = if dialect == Dialect::Postgres { "$" } else { "?" };
            let mut out = st.sql.clone();
            // Replace higher indexes first so "$1" does not clobber "$10".
            for (i, p) in st.params.iter().enumerate().rev() {
                out = out.replace(&format!("{prefix}{}", i + 1), &literal(p));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browse::tests::users;

    fn key(id: &str) -> Vec<ColumnValue> {
        vec![ColumnValue { column: "id".into(), value: Some(id.into()) }]
    }

    #[test]
    fn update_with_conflict_check() {
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: true,
            changes: vec![RowChange::Update {
                key: key("7"),
                edits: vec![ColumnEdit {
                    column: "email".into(),
                    value: EditValue::Value { value: Some("new@x.com".into()) },
                    original: Some(Some("old@x.com".into())),
                }],
            }],
        };
        let st = build_statements(Dialect::Postgres, &users(), &set).unwrap();
        assert_eq!(
            st[0].sql,
            "UPDATE \"public\".\"users\" SET \"email\" = $1 WHERE \"id\" = $2 AND \"email\"::text IS NOT DISTINCT FROM $3"
        );
        assert_eq!(st[0].params, vec![Some("new@x.com".into()), Some("7".into()), Some("old@x.com".into())]);
        assert_eq!(st[0].expect_rows, Some(1));
        let mysql = build_statements(Dialect::Mysql, &users(), &set).unwrap();
        assert_eq!(mysql[0].sql, "UPDATE `public`.`users` SET `email` = ? WHERE `id` = ? AND `email` <=> ?");
    }

    #[test]
    fn insert_and_delete() {
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: true,
            changes: vec![
                RowChange::Insert {
                    values: vec![
                        ColumnEdit { column: "id".into(), value: EditValue::Default, original: None },
                        ColumnEdit {
                            column: "email".into(),
                            value: EditValue::Value { value: Some("a@b.c".into()) },
                            original: None,
                        },
                    ],
                },
                RowChange::Delete { key: key("3") },
            ],
        };
        let st = build_statements(Dialect::Sqlite, &users(), &set).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO \"public\".\"users\" (\"email\") VALUES (?1)");
        assert_eq!(st[1].sql, "DELETE FROM \"public\".\"users\" WHERE \"id\" = ?1");
        assert_eq!(
            preview(Dialect::Sqlite, &st),
            "INSERT INTO \"public\".\"users\" (\"email\") VALUES ('a@b.c');\nDELETE FROM \"public\".\"users\" WHERE \"id\" = '3';"
        );
    }

    #[test]
    fn validation_errors() {
        let mut s = users();
        // No primary key -> editing refused.
        for c in &mut s.columns {
            c.primary_key = None;
        }
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![RowChange::Delete { key: key("1") }],
        };
        assert!(build_statements(Dialect::Postgres, &s, &set).is_err());

        // NOT NULL violation caught before reaching the server.
        let mut s = users();
        s.columns[1].nullable = false;
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![RowChange::Update {
                key: key("1"),
                edits: vec![ColumnEdit {
                    column: "email".into(),
                    value: EditValue::Value { value: None },
                    original: None,
                }],
            }],
        };
        assert!(build_statements(Dialect::Postgres, &s, &set).unwrap_err().message.contains("cannot be NULL"));

        // Unknown columns are rejected (no arbitrary identifiers reach SQL).
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![RowChange::Update {
                key: key("1"),
                edits: vec![ColumnEdit {
                    column: "x\"; drop table users; --".into(),
                    value: EditValue::Value { value: None },
                    original: None,
                }],
            }],
        };
        assert!(build_statements(Dialect::Postgres, &users(), &set).is_err());
    }

    #[test]
    fn preview_handles_many_params() {
        let st = ParamStatement {
            sql: "SELECT $1, $10, $11".into(),
            params: (1..=11).map(|i| Some(i.to_string())).collect(),
            expect_rows: None,
        };
        assert_eq!(preview(Dialect::Postgres, &[st]), "SELECT '1', '10', '11';");
    }

    #[test]
    fn deserializes_frontend_payload() {
        let json = r#"{"schema":"public","table":"users","changes":[
            {"type":"update","key":[{"column":"id","value":"1"}],
             "edits":[{"column":"email","value":{"kind":"value","value":null},"original":"x"}]},
            {"type":"insert","values":[{"column":"email","value":{"kind":"default"}}]}]}"#;
        let set: ChangeSet = serde_json::from_str(json).unwrap();
        assert!(set.check_conflicts);
        let RowChange::Update { edits, .. } = &set.changes[0] else { panic!() };
        assert_eq!(edits[0].original, Some(Some("x".into())));
        let RowChange::Insert { values } = &set.changes[1] else { panic!() };
        assert_eq!(values[0].original, None);
        let e: ColumnEdit =
            serde_json::from_str(r#"{"column":"a","value":{"kind":"default"},"original":null}"#).unwrap();
        assert_eq!(e.original, Some(None));
        assert_eq!(set.changes.len(), 2);
    }
}
