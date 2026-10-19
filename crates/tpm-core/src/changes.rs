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
use crate::large_values::is_binary_type;
use crate::model::{ColumnInfo, ObjectKind, Param, TableStructure};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditValue {
    Value {
        value: Param,
    },
    /// Use the column default (omitted from INSERT, `DEFAULT` in UPDATE).
    Default,
    /// Bytes for a binary column, as hex digits without a prefix (two per byte). Sent as a text
    /// parameter and decoded by the database, so the adapters bind text as for every value.
    Bytes {
        hex: String,
    },
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
        // `=` is not defined for the LOB, XML and spatial types, bytes are bound as text, and
        // floats do not convert back from their text form exactly.
        Dialect::Mssql => {
            let base = t.split('(').next().unwrap_or_default().trim();
            ![
                "text",
                "ntext",
                "image",
                "xml",
                "geography",
                "geometry",
                "hierarchyid",
                "sql_variant",
                "binary",
                "varbinary",
                "timestamp",
                "rowversion",
                "float",
                "real",
            ]
            .contains(&base)
        }
    }
}

pub fn build_statements(dialect: Dialect, s: &TableStructure, set: &ChangeSet) -> Result<Vec<ParamStatement>> {
    build_statements_with(dialect, s, set, false)
}

/// `build_statements`; with `override_identity` (PostgreSQL restores), inserts keep the given
/// values of `GENERATED ALWAYS AS IDENTITY` columns (`OVERRIDING SYSTEM VALUE`).
pub fn build_statements_with(
    dialect: Dialect,
    s: &TableStructure,
    set: &ChangeSet,
    override_identity: bool,
) -> Result<Vec<ParamStatement>> {
    if s.kind != ObjectKind::Table {
        return Err(AppError::unsupported("Only tables can be edited"));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    let pk: Vec<String> = s.primary_key().iter().map(|c| c.name.clone()).collect();
    let mut out = Vec::with_capacity(set.changes.len());
    for change in &set.changes {
        out.push(match change {
            RowChange::Insert { values } => build_insert(dialect, s, &table, values, override_identity)?,
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

/// A binary value's placeholder: hex digits as the parameter, wrapped in the database's own
/// hex decoding. DuckDB shares the PostgreSQL dialect; its binary type is BLOB, PostgreSQL's bytea.
fn bytes_placeholder(dialect: Dialect, info: &ColumnInfo, params: &mut Vec<Param>, hex: &str) -> Result<String> {
    if !is_binary_type(&info.data_type) {
        return Err(AppError::invalid_config(format!("Column '{}' is not a binary column", info.name)));
    }
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::invalid_config(format!(
            "The value for '{}' must be hex digits, two per byte",
            info.name
        )));
    }
    let p = placeholder(dialect, params, Some(hex.to_ascii_lowercase()));
    let duckdb = info.data_type.trim().eq_ignore_ascii_case("blob");
    Ok(match dialect {
        Dialect::Postgres if duckdb => format!("from_hex({p})"),
        Dialect::Postgres => format!("decode({p}, 'hex')"),
        Dialect::Mysql => format!("UNHEX({p})"),
        Dialect::Sqlite => format!("unhex({p})"),
        Dialect::Mssql => format!("CONVERT(varbinary(max), {p}, 2)"),
    })
}

fn build_insert(
    dialect: Dialect,
    s: &TableStructure,
    table: &str,
    values: &[ColumnEdit],
    override_identity: bool,
) -> Result<ParamStatement> {
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
        } else if let EditValue::Bytes { hex } = &v.value {
            let info = s.column(&v.column).expect("checked");
            cols.push(dialect.quote_ident(&v.column)?);
            vals.push(bytes_placeholder(dialect, info, &mut params, hex)?);
        }
    }
    for c in &s.columns {
        let provided = values
            .iter()
            .any(|v| v.column == c.name && matches!(v.value, EditValue::Value { .. } | EditValue::Bytes { .. }));
        if !provided && !c.nullable && c.default.is_none() && !c.auto_increment && !c.generated {
            return Err(AppError::invalid_config(format!("Column '{}' requires a value", c.name)));
        }
    }
    let sql = if cols.is_empty() {
        match dialect {
            Dialect::Mysql => format!("INSERT INTO {table} () VALUES ()"),
            _ => format!("INSERT INTO {table} DEFAULT VALUES"),
        }
    } else {
        let overriding =
            if override_identity && dialect == Dialect::Postgres { " OVERRIDING SYSTEM VALUE" } else { "" };
        let insert = format!("INSERT INTO {table} ({}){overriding} VALUES ({})", cols.join(", "), vals.join(", "));
        if override_identity && dialect == Dialect::Mssql && s.columns.iter().any(|c| c.auto_increment) {
            // An identity column takes a given value only while IDENTITY_INSERT is on.
            format!("SET IDENTITY_INSERT {table} ON; {insert}; SET IDENTITY_INSERT {table} OFF")
        } else {
            insert
        }
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
            EditValue::Bytes { hex } => {
                let p = bytes_placeholder(dialect, s.column(&e.column).expect("checked"), &mut params, hex)?;
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
            where_sql.push_str(&format!(" AND {}", dialect.null_safe_eq(&lhs, &p)));
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

/// Rows per merged INSERT.
const MERGED_ROWS: usize = 1000;

/// Bind parameters one statement may carry: SQLite before 3.32 allows 999, SQL Server 2,100.
fn max_params(dialect: Dialect) -> usize {
    match dialect {
        Dialect::Sqlite => 999,
        Dialect::Mssql => 2000,
        Dialect::Postgres | Dialect::Mysql => 30_000,
    }
}

/// A single-row `INSERT … VALUES (placeholders)` as built here: its text before ` VALUES (`.
fn single_row_insert(st: &ParamStatement) -> Option<&str> {
    if st.expect_rows != Some(1)
        || !st.sql.starts_with("INSERT INTO ")
        || st.sql.contains(';')
        || !st.sql.ends_with(')')
    {
        return None;
    }
    let (prefix, _) = st.sql.split_once(" VALUES (")?;
    (st.sql.matches(" VALUES (").count() == 1 && !st.params.is_empty()).then_some(prefix)
}

/// Merges runs of single-row INSERTs into the same table and columns into multi-row INSERTs
/// (at most 1,000 rows, within the driver's parameter limit), keeping every other statement and
/// the order. Each merged statement expects as many rows as it inserts.
pub fn merge_inserts(dialect: Dialect, statements: Vec<ParamStatement>) -> Vec<ParamStatement> {
    let mut out: Vec<ParamStatement> = Vec::with_capacity(statements.len());
    let mut run: Vec<ParamStatement> = Vec::new();
    let flush = |run: &mut Vec<ParamStatement>, out: &mut Vec<ParamStatement>| {
        let Some(first) = run.first() else { return };
        let prefix = single_row_insert(first).expect("only inserts are gathered").to_string();
        let width = first.params.len();
        let per = MERGED_ROWS.min((max_params(dialect) / width).max(1));
        for chunk in run.chunks(per) {
            if chunk.len() == 1 {
                out.push(chunk[0].clone());
                continue;
            }
            let mut params = Vec::with_capacity(chunk.len() * width);
            let mut tuples = Vec::with_capacity(chunk.len());
            for st in chunk {
                let marks: Vec<String> = (0..width).map(|i| dialect.placeholder(params.len() + i + 1)).collect();
                tuples.push(format!("({})", marks.join(", ")));
                params.extend(st.params.iter().cloned());
            }
            out.push(ParamStatement {
                sql: format!("{prefix} VALUES {}", tuples.join(", ")),
                params,
                expect_rows: Some(chunk.len() as u64),
            });
        }
        run.clear();
    };
    for st in statements {
        let joins = match (run.first(), single_row_insert(&st)) {
            (Some(first), Some(prefix)) => {
                single_row_insert(first) == Some(prefix) && first.params.len() == st.params.len()
            }
            _ => false,
        };
        if !joins {
            flush(&mut run, &mut out);
        }
        if single_row_insert(&st).is_some() {
            run.push(st);
        } else {
            out.push(st);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Renders statements with parameters inlined as literals, for the review dialog only.
pub fn preview(dialect: Dialect, statements: &[ParamStatement]) -> String {
    statements.iter().map(|st| format!("{};", inline_params(dialect, st))).collect::<Vec<_>>().join("\n")
}

/// How much of a long review is shown: a number of statements, and of characters.
#[derive(Debug, Clone, Copy)]
pub struct PreviewBudget {
    pub statements: usize,
    pub chars: usize,
}

/// Like [`preview`], but only the first `shown` statements: a restore of 100,000 rows reviews a
/// sample and the count, not 100,000 lines.
pub fn preview_first(dialect: Dialect, statements: &[ParamStatement], shown: usize) -> String {
    preview_within(dialect, statements, &mut PreviewBudget { statements: shown, chars: usize::MAX })
}

/// Renders statements while `budget` lasts (spending it, so it carries across tables), then the
/// count of the rest. A merged INSERT can hold 1,000 rows, so size counts as well as number.
pub fn preview_within(dialect: Dialect, statements: &[ParamStatement], budget: &mut PreviewBudget) -> String {
    let mut lines = Vec::new();
    let mut shown = 0;
    for st in statements {
        if budget.statements == 0 || budget.chars == 0 {
            break;
        }
        let line = format!("{};", inline_params(dialect, st));
        budget.statements -= 1;
        budget.chars = budget.chars.saturating_sub(line.len());
        lines.push(line);
        shown += 1;
    }
    let rest = statements.len() - shown;
    if rest > 0 {
        lines.push(format!(
            "-- … and {} more statement{} like these (not shown)",
            group_digits(rest),
            if rest == 1 { "" } else { "s" }
        ));
    }
    lines.join("\n")
}

fn group_digits(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
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
        Dialect::Postgres | Dialect::Sqlite | Dialect::Mssql => {
            let prefix = match dialect {
                Dialect::Postgres => "$",
                Dialect::Mssql => "@P",
                _ => "?",
            };
            // One pass: each placeholder's whole number picks its value ("$10" is not "$1" + "0"),
            // so a merged INSERT with thousands of parameters renders in linear time.
            let sql = st.sql.as_str();
            let mut out = String::with_capacity(sql.len() * 2);
            let mut rest = sql;
            while let Some(at) = rest.find(prefix) {
                out.push_str(&rest[..at]);
                let after = &rest[at + prefix.len()..];
                let digits = after.bytes().take_while(u8::is_ascii_digit).count();
                match after[..digits]
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|i| st.params.get(i))
                {
                    Some(p) => out.push_str(&literal(p)),
                    None => out.push_str(&rest[at..at + prefix.len() + digits]),
                }
                rest = &after[digits..];
            }
            out.push_str(rest);
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

    fn bytes_edit(column: &str, hex: &str) -> ColumnEdit {
        ColumnEdit { column: column.into(), value: EditValue::Bytes { hex: hex.into() }, original: None }
    }

    #[test]
    fn binary_values_are_sent_as_hex_and_decoded_by_the_database() {
        let update = |s: &TableStructure, d: Dialect| {
            let set = ChangeSet {
                schema: s.schema.clone(),
                table: "users".into(),
                check_conflicts: true,
                changes: vec![RowChange::Update { key: key("7"), edits: vec![bytes_edit("avatar", "DEADbeef")] }],
            };
            build_statements(d, s, &set).unwrap().remove(0)
        };
        let pg = update(&users(), Dialect::Postgres);
        assert_eq!(pg.sql, "UPDATE \"public\".\"users\" SET \"avatar\" = decode($1, 'hex') WHERE \"id\" = $2");
        assert_eq!(pg.params, vec![Some("deadbeef".into()), Some("7".into())]);
        // DuckDB shares the PostgreSQL dialect; its binary type is BLOB.
        let mut duck = users();
        duck.columns[2].data_type = "BLOB".into();
        assert!(update(&duck, Dialect::Postgres).sql.contains("\"avatar\" = from_hex($1)"));
        let mut my = users();
        my.columns[2].data_type = "longblob".into();
        assert!(update(&my, Dialect::Mysql).sql.contains("`avatar` = UNHEX(?)"));
        let mut lite = users();
        lite.columns[2].data_type = "BLOB".into();
        assert!(update(&lite, Dialect::Sqlite).sql.contains("\"avatar\" = unhex(?1)"));
        assert!(update(&sql_server_users(), Dialect::Mssql).sql.contains("[avatar] = CONVERT(varbinary(max), @P1, 2)"));
        // Inserts too; an empty value is zero bytes, not NULL.
        let set = ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![RowChange::Insert { values: vec![bytes_edit("avatar", "")] }],
        };
        let ins = build_statements(Dialect::Postgres, &users(), &set).unwrap().remove(0);
        assert_eq!(ins.sql, "INSERT INTO \"public\".\"users\" (\"avatar\") VALUES (decode($1, 'hex'))");
        assert_eq!(ins.params, vec![Some(String::new())]);
    }

    #[test]
    fn binary_values_must_be_hex_for_a_binary_column() {
        let one = |edit: ColumnEdit| {
            let set = ChangeSet {
                schema: "public".into(),
                table: "users".into(),
                check_conflicts: false,
                changes: vec![RowChange::Update { key: key("7"), edits: vec![edit] }],
            };
            build_statements(Dialect::Postgres, &users(), &set)
        };
        for bad in ["abc", "zz", "de ad", "\\xdead", "0xdead"] {
            assert!(one(bytes_edit("avatar", bad)).is_err(), "{bad}");
        }
        let e = one(bytes_edit("email", "dead")).unwrap_err();
        assert!(e.message.contains("not a binary column"), "{}", e.message);
    }

    fn sql_server_users() -> TableStructure {
        let mut s = users();
        s.schema = "dbo".into();
        s.columns[1].data_type = "nvarchar(200)".into();
        s.columns[2].data_type = "varbinary(max)".into();
        s
    }

    #[test]
    fn sql_server_updates_compare_what_converts_back_exactly() {
        let edit = |column: &str, new: &str, old: &str| ColumnEdit {
            column: column.into(),
            value: EditValue::Value { value: Some(new.into()) },
            original: Some(Some(old.into())),
        };
        let set = ChangeSet {
            schema: "dbo".into(),
            table: "users".into(),
            check_conflicts: true,
            changes: vec![RowChange::Update {
                key: key("7"),
                edits: vec![edit("email", "new@x.com", "old@x.com"), edit("avatar", "\\x01", "\\x00")],
            }],
        };
        let st = build_statements(Dialect::Mssql, &sql_server_users(), &set).unwrap();
        assert_eq!(
            st[0].sql,
            "UPDATE [dbo].[users] SET [email] = @P1, [avatar] = @P2 WHERE [id] = @P3 \
             AND ([email] = @P4 OR ([email] IS NULL AND @P4 IS NULL))"
        );
        assert_eq!(st[0].params.len(), 4);
        for ty in ["text", "ntext", "image", "xml", "geography", "sql_variant", "float", "real", "timestamp"] {
            assert!(!comparable(Dialect::Mssql, ty), "{ty}");
        }
        for ty in ["nvarchar(max)", "int", "datetime2(7)", "money", "uniqueidentifier", "bit", "decimal(10,2)"] {
            assert!(comparable(Dialect::Mssql, ty), "{ty}");
        }
    }

    #[test]
    fn sql_server_inserts_and_restores_keep_identity_values() {
        let insert = |id: &str| RowChange::Insert {
            values: vec![
                ColumnEdit { column: "id".into(), value: EditValue::Value { value: Some(id.into()) }, original: None },
                ColumnEdit {
                    column: "email".into(),
                    value: EditValue::Value { value: Some("a".into()) },
                    original: None,
                },
            ],
        };
        let set = ChangeSet {
            schema: "dbo".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![insert("5")],
        };
        let st = build_statements(Dialect::Mssql, &sql_server_users(), &set).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO [dbo].[users] ([id], [email]) VALUES (@P1, @P2)");
        let restore = build_statements_with(Dialect::Mssql, &sql_server_users(), &set, true).unwrap();
        assert_eq!(
            restore[0].sql,
            "SET IDENTITY_INSERT [dbo].[users] ON; INSERT INTO [dbo].[users] ([id], [email]) VALUES (@P1, @P2); \
             SET IDENTITY_INSERT [dbo].[users] OFF"
        );
        // Without an identity column there is nothing to switch on.
        let mut plain = sql_server_users();
        plain.columns[0].auto_increment = false;
        let st = build_statements_with(Dialect::Mssql, &plain, &set, true).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO [dbo].[users] ([id], [email]) VALUES (@P1, @P2)");
        let empty = ChangeSet {
            schema: "dbo".into(),
            table: "users".into(),
            check_conflicts: false,
            changes: vec![RowChange::Insert { values: vec![] }, RowChange::Delete { key: key("3") }],
        };
        let st = build_statements(Dialect::Mssql, &sql_server_users(), &empty).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO [dbo].[users] DEFAULT VALUES");
        assert_eq!(st[1].sql, "DELETE FROM [dbo].[users] WHERE [id] = @P1");
        let many = ParamStatement {
            sql: "SELECT @P1, @P10, @P11".into(),
            params: (1..=11).map(|i| Some(format!("é{i}"))).collect(),
            expect_rows: None,
        };
        assert_eq!(preview(Dialect::Mssql, &[many]), "SELECT N'é1', N'é10', N'é11';");
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

    fn insert(dialect: Dialect, table: &str, values: &[&str]) -> ParamStatement {
        let marks: Vec<String> = (1..=values.len()).map(|n| dialect.placeholder(n)).collect();
        ParamStatement {
            sql: format!("INSERT INTO {table} (\"a\", \"b\") VALUES ({})", marks.join(", ")),
            params: values.iter().map(|v| Some(v.to_string())).collect(),
            expect_rows: Some(1),
        }
    }

    #[test]
    fn single_row_inserts_merge_into_multi_row_inserts() {
        let rows: Vec<_> = (1..=3).map(|i| insert(Dialect::Postgres, "t", &[&i.to_string(), "x"])).collect();
        let merged = merge_inserts(Dialect::Postgres, rows);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].sql, r#"INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4), ($5, $6)"#);
        assert_eq!(merged[0].params.len(), 6);
        assert_eq!(merged[0].params[4].as_deref(), Some("3"));
        assert_eq!(merged[0].expect_rows, Some(3));
        // MySQL's placeholders aren't numbered; SQL Server's are.
        let my = merge_inserts(
            Dialect::Mysql,
            vec![insert(Dialect::Mysql, "t", &["1", "x"]), insert(Dialect::Mysql, "t", &["2", "y"])],
        );
        assert!(my[0].sql.ends_with("VALUES (?, ?), (?, ?)"), "{}", my[0].sql);
        let ms = merge_inserts(
            Dialect::Mssql,
            vec![insert(Dialect::Mssql, "t", &["1", "x"]), insert(Dialect::Mssql, "t", &["2", "y"])],
        );
        assert!(ms[0].sql.ends_with("VALUES (@P1, @P2), (@P3, @P4)"), "{}", ms[0].sql);
    }

    #[test]
    fn a_preview_budget_stops_on_size_too_and_carries_across_tables() {
        let st = |i: usize| insert(Dialect::Postgres, "t", &[&i.to_string(), &"x".repeat(100)]);
        let rows: Vec<_> = (0..50).map(st).collect();
        let mut budget = PreviewBudget { statements: 200, chars: 1000 };
        let text = preview_within(Dialect::Postgres, &rows, &mut budget);
        let shown = text.lines().filter(|l| l.starts_with("INSERT")).count();
        assert!((1..50).contains(&shown), "{shown}");
        assert!(text.ends_with(&format!("-- … and {} more statements like these (not shown)", 50 - shown)));
        // Spent: the next table only gets its count.
        assert_eq!(
            preview_within(Dialect::Postgres, &rows[..2], &mut budget),
            "-- … and 2 more statements like these (not shown)"
        );
    }

    #[test]
    fn previews_of_large_merged_inserts_are_quick_and_exact() {
        // Wide rows: 1,000 rows of 20 values are 20,000 placeholders in one statement.
        for dialect in [Dialect::Postgres, Dialect::Sqlite, Dialect::Mssql, Dialect::Mysql] {
            let rows: Vec<ParamStatement> = (0..1000)
                .map(|i| {
                    let marks: Vec<String> = (1..=20).map(|n| dialect.placeholder(n)).collect();
                    let mut params = vec![Some(i.to_string())];
                    params.extend((1..20).map(|_| Some("it's".to_string())));
                    ParamStatement {
                        sql: format!("INSERT INTO t VALUES ({})", marks.join(", ")),
                        params,
                        expect_rows: Some(1),
                    }
                })
                .collect();
            let merged = merge_inserts(dialect, rows);
            let started = std::time::Instant::now();
            let text = preview(dialect, &merged);
            assert!(started.elapsed() < std::time::Duration::from_millis(500), "{dialect:?}: {:?}", started.elapsed());
            let lit = |v: &str| dialect.quote_literal(v);
            assert!(text.contains(&format!("({}, {}", lit("0"), lit("it's"))), "{dialect:?}");
            assert!(
                text.contains(&format!("({}, {}", lit("999"), lit("it's"))),
                "{dialect:?}: high numbers inlined whole"
            );
            assert!(!text.contains('$') && !text.contains("@P") && !text.contains('?'), "{dialect:?}");
        }
    }

    #[test]
    fn merging_keeps_order_and_limits() {
        // Another table, or anything else in between, starts a new statement; order is kept.
        let other =
            ParamStatement { sql: "UPDATE t SET a = $1".into(), params: vec![Some("1".into())], expect_rows: Some(1) };
        let list = vec![
            insert(Dialect::Postgres, "t", &["1", "x"]),
            insert(Dialect::Postgres, "u", &["2", "y"]),
            other.clone(),
            insert(Dialect::Postgres, "t", &["3", "z"]),
            insert(Dialect::Postgres, "t", &["4", "w"]),
        ];
        let merged = merge_inserts(Dialect::Postgres, list);
        assert_eq!(merged.iter().map(|s| s.expect_rows).collect::<Vec<_>>(), [Some(1), Some(1), Some(1), Some(2)]);
        assert_eq!(merged[2], other);
        // At most 1,000 rows per statement, and within the driver's parameter limit
        // (999 on SQLite: 499 rows of two values).
        let many: Vec<_> = (0..2500).map(|i| insert(Dialect::Postgres, "t", &[&i.to_string(), "x"])).collect();
        assert_eq!(
            merge_inserts(Dialect::Postgres, many).iter().map(|s| s.expect_rows.unwrap()).collect::<Vec<_>>(),
            [1000, 1000, 500]
        );
        let lite: Vec<_> = (0..1000).map(|i| insert(Dialect::Sqlite, "t", &[&i.to_string(), "x"])).collect();
        assert_eq!(
            merge_inserts(Dialect::Sqlite, lite).iter().map(|s| s.expect_rows.unwrap()).collect::<Vec<_>>(),
            [499, 499, 2]
        );
        // SQL Server's IDENTITY_INSERT wrapper is several statements: left alone.
        let wrapped = ParamStatement {
            sql: "SET IDENTITY_INSERT t ON; INSERT INTO t (\"a\") VALUES (@P1); SET IDENTITY_INSERT t OFF".into(),
            params: vec![Some("1".into())],
            expect_rows: Some(1),
        };
        assert_eq!(merge_inserts(Dialect::Mssql, vec![wrapped.clone(), wrapped.clone()]).len(), 2);
    }

    #[test]
    fn long_previews_show_the_first_statements_and_count_the_rest() {
        let st = |i: usize| ParamStatement {
            sql: "DELETE FROM t WHERE id = $1".into(),
            params: vec![Some(i.to_string())],
            expect_rows: Some(1),
        };
        let few: Vec<_> = (1..=3).map(st).collect();
        assert_eq!(preview_first(Dialect::Postgres, &few, 5), preview(Dialect::Postgres, &few));
        let many: Vec<_> = (1..=100_000).map(st).collect();
        let text = preview_first(Dialect::Postgres, &many, 2);
        assert_eq!(
            text,
            "DELETE FROM t WHERE id = '1';\nDELETE FROM t WHERE id = '2';\n-- … and 99,998 more statements like these (not shown)"
        );
        assert_eq!(
            preview_first(Dialect::Postgres, &many[..3], 2).lines().last(),
            Some("-- … and 1 more statement like these (not shown)")
        );
        assert_eq!(
            preview_first(Dialect::Postgres, &many[..3], 0),
            "-- … and 3 more statements like these (not shown)"
        );
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
