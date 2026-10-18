//! Structured filter trees compiled to parameterised SQL.
//!
//! Column names are checked against the table's known columns and quoted for the
//! dialect; every value becomes a bind parameter. There is no limit on the number of
//! conditions; nesting depth is capped only to keep recursion bounded.

use serde::{Deserialize, Serialize};

use crate::dialect::Dialect;
use crate::error::{AppError, Result};
use crate::model::Param;

const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Logic {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    /// User-supplied LIKE pattern (wildcards are the user's).
    Like,
    NotLike,
    /// Case-insensitive substring match; wildcards in the value are escaped.
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    In,
    NotIn,
    Between,
    NotBetween,
    IsNull,
    IsNotNull,
    IsTrue,
    IsFalse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FilterNode {
    #[serde(rename_all = "camelCase")]
    Group {
        logic: Logic,
        #[serde(default)]
        negate: bool,
        children: Vec<FilterNode>,
    },
    #[serde(rename_all = "camelCase")]
    Condition {
        column: String,
        op: FilterOp,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        value2: Option<String>,
        #[serde(default)]
        values: Vec<String>,
        #[serde(default = "enabled_default")]
        enabled: bool,
    },
    /// A raw SQL boolean expression typed by the user. It runs with the user's own
    /// database privileges, exactly like SQL typed in the editor.
    #[serde(rename_all = "camelCase")]
    Raw {
        sql: String,
        #[serde(default = "enabled_default")]
        enabled: bool,
    },
}

fn enabled_default() -> bool {
    true
}

/// Accumulates bind parameters and produces dialect-specific placeholders.
pub struct SqlBuilder {
    pub dialect: Dialect,
    pub params: Vec<Param>,
}

impl SqlBuilder {
    pub fn new(dialect: Dialect) -> Self {
        Self { dialect, params: Vec::new() }
    }

    pub fn bind(&mut self, value: Param) -> String {
        self.params.push(value);
        self.dialect.placeholder(self.params.len())
    }
}

/// Compiles `node` to a boolean SQL expression. Returns `None` when the tree contains
/// no enabled conditions.
pub fn compile(node: &FilterNode, columns: &[String], b: &mut SqlBuilder) -> Result<Option<String>> {
    compile_with(node, columns, &[], b)
}

/// `compile`, with the columns whose equality must compare text (`needs_text_equality`): the
/// value is the text the grid shows, and the stored value may not convert back to it exactly.
pub fn compile_with(
    node: &FilterNode,
    columns: &[String],
    text_eq: &[String],
    b: &mut SqlBuilder,
) -> Result<Option<String>> {
    compile_node(node, columns, text_eq, b, 0)
}

/// Columns where `col = 'text'` can miss a row the grid shows as that text: SQLite columns with
/// no declared type (a stored 42 never equals '42'), and MySQL floating point (FLOAT 0.1 is not
/// the double 0.1). Their equality compares the column's text instead.
pub fn needs_text_equality(dialect: Dialect, data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    match dialect {
        Dialect::Sqlite => t.is_empty(),
        Dialect::Mysql => {
            let base = t.split(['(', ' ']).next().unwrap_or("");
            matches!(base, "float" | "double" | "real")
        }
        // A float compared with the text the grid shows converts that text to float, which matches.
        Dialect::Postgres | Dialect::Mssql => false,
    }
}

fn compile_node(
    node: &FilterNode,
    columns: &[String],
    text_eq: &[String],
    b: &mut SqlBuilder,
    depth: usize,
) -> Result<Option<String>> {
    if depth > MAX_DEPTH {
        return Err(AppError::invalid_config("Filter groups are nested too deeply"));
    }
    match node {
        FilterNode::Group { logic, negate, children } => {
            let mut parts = Vec::new();
            for c in children {
                if let Some(sql) = compile_node(c, columns, text_eq, b, depth + 1)? {
                    parts.push(sql);
                }
            }
            if parts.is_empty() {
                return Ok(None);
            }
            let joiner = match logic {
                Logic::And => " AND ",
                Logic::Or => " OR ",
            };
            let inner = if parts.len() == 1 { parts.remove(0) } else { format!("({})", parts.join(joiner)) };
            Ok(Some(if *negate { format!("NOT {inner}") } else { inner }))
        }
        FilterNode::Raw { sql, enabled } => {
            if !enabled || sql.trim().is_empty() {
                return Ok(None);
            }
            if sql.contains(';') && crate::split::split_statements(sql, b.dialect).len() > 1 {
                return Err(AppError::invalid_config("A raw filter must be a single expression"));
            }
            Ok(Some(format!("({})", sql.trim())))
        }
        FilterNode::Condition { column, op, value, value2, values, enabled } => {
            if !enabled {
                return Ok(None);
            }
            if !columns.iter().any(|c| c == column) {
                return Err(AppError::invalid_config(format!("Unknown column '{column}' in filter")));
            }
            let col = b.dialect.quote_ident(column)?;
            let as_text = text_eq.iter().any(|c| c == column);
            compile_condition(&col, *op, value.as_deref(), value2.as_deref(), values, as_text, b).map(Some)
        }
    }
}

fn text_expr(dialect: Dialect, col: &str) -> String {
    match dialect {
        Dialect::Postgres | Dialect::Sqlite => format!("CAST({col} AS TEXT)"),
        Dialect::Mysql => format!("CAST({col} AS CHAR)"),
        Dialect::Mssql => format!("CAST({col} AS NVARCHAR(MAX))"),
    }
}

fn escape_like(dialect: Dialect, v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for ch in v.chars() {
        // `[` opens a character class in SQL Server patterns.
        if matches!(ch, '!' | '%' | '_') || (ch == '[' && dialect == Dialect::Mssql) {
            out.push('!');
        }
        out.push(ch);
    }
    out
}

fn compile_condition(
    col: &str,
    op: FilterOp,
    value: Option<&str>,
    value2: Option<&str>,
    values: &[String],
    as_text: bool,
    b: &mut SqlBuilder,
) -> Result<String> {
    let d = b.dialect;
    // Equality on the column's text where the stored value may not convert back exactly.
    let eq_col = if as_text { text_expr(d, col) } else { col.to_string() };
    let col_for_eq = eq_col.as_str();
    let need = |v: Option<&str>| -> Result<String> {
        v.map(str::to_string).ok_or_else(|| AppError::invalid_config("Filter value is required"))
    };
    // '!' rather than backslash: backslash handling in literals differs between
    // dialects and server modes (e.g. MySQL NO_BACKSLASH_ESCAPES).
    let escape = " ESCAPE '!'";
    let cmp = |b: &mut SqlBuilder, sym: &str, v: Option<&str>| -> Result<String> {
        let p = b.bind(Some(need(v)?));
        Ok(format!("{col} {sym} {p}"))
    };
    Ok(match op {
        FilterOp::Eq => {
            let p = b.bind(Some(need(value)?));
            format!("{col_for_eq} = {p}")
        }
        FilterOp::Ne => {
            let p = b.bind(Some(need(value)?));
            format!("({col_for_eq} <> {p} OR {col} IS NULL)")
        }
        FilterOp::Gt => cmp(b, ">", value)?,
        FilterOp::Gte => cmp(b, ">=", value)?,
        FilterOp::Lt => cmp(b, "<", value)?,
        FilterOp::Lte => cmp(b, "<=", value)?,
        FilterOp::Like | FilterOp::NotLike => {
            let p = b.bind(Some(need(value)?));
            let not = if op == FilterOp::NotLike { "NOT " } else { "" };
            format!("{} {not}LIKE {p}", text_expr(d, col))
        }
        FilterOp::Contains | FilterOp::NotContains | FilterOp::StartsWith | FilterOp::EndsWith => {
            let v = escape_like(d, &need(value)?);
            let pattern = match op {
                FilterOp::StartsWith => format!("{v}%"),
                FilterOp::EndsWith => format!("%{v}"),
                _ => format!("%{v}%"),
            };
            let p = b.bind(Some(pattern));
            let not = if op == FilterOp::NotContains { "NOT " } else { "" };
            let expr = format!("{} {not}{} {p}{escape}", text_expr(d, col), d.ilike());
            if op == FilterOp::NotContains { format!("({expr} OR {col} IS NULL)") } else { expr }
        }
        FilterOp::In | FilterOp::NotIn => {
            if values.is_empty() {
                return Err(AppError::invalid_config("IN requires at least one value"));
            }
            let ps: Vec<String> = values.iter().map(|v| b.bind(Some(v.clone()))).collect();
            let not = if op == FilterOp::NotIn { "NOT " } else { "" };
            format!("{col_for_eq} {not}IN ({})", ps.join(", "))
        }
        FilterOp::Between | FilterOp::NotBetween => {
            let p1 = b.bind(Some(need(value)?));
            let p2 = b.bind(Some(need(value2)?));
            let not = if op == FilterOp::NotBetween { "NOT " } else { "" };
            format!("{col} {not}BETWEEN {p1} AND {p2}")
        }
        FilterOp::IsNull => format!("{col} IS NULL"),
        FilterOp::IsNotNull => format!("{col} IS NOT NULL"),
        // SQL Server has no boolean type to test; its bit columns hold 1 and 0.
        FilterOp::IsTrue if d == Dialect::Mssql => format!("{col} = 1"),
        FilterOp::IsFalse if d == Dialect::Mssql => format!("{col} = 0"),
        FilterOp::IsTrue => format!("{col} IS TRUE"),
        FilterOp::IsFalse => format!("{col} IS FALSE"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<String> {
        vec!["id".into(), "name".into(), "created".into()]
    }

    fn cond(column: &str, op: FilterOp, value: Option<&str>) -> FilterNode {
        FilterNode::Condition {
            column: column.into(),
            op,
            value: value.map(str::to_string),
            value2: None,
            values: vec![],
            enabled: true,
        }
    }

    #[test]
    fn equality_compares_as_text_where_values_are_not_text() {
        let mut b = SqlBuilder::new(Dialect::Sqlite);
        let text_eq = vec!["k".to_string()];
        let cols = vec!["k".to_string(), "v".to_string()];
        let sql = compile_with(&cond("k", FilterOp::Eq, Some("42")), &cols, &text_eq, &mut b).unwrap().unwrap();
        assert_eq!(sql, r#"CAST("k" AS TEXT) = ?1"#);
        let sql = compile_with(&cond("v", FilterOp::Eq, Some("a")), &cols, &text_eq, &mut b).unwrap().unwrap();
        assert_eq!(sql, r#""v" = ?2"#, "other columns keep a plain comparison (indexes)");
        assert!(needs_text_equality(Dialect::Sqlite, ""));
        assert!(!needs_text_equality(Dialect::Sqlite, "INTEGER"));
        assert!(needs_text_equality(Dialect::Mysql, "float"));
        assert!(needs_text_equality(Dialect::Mysql, "double unsigned"));
        assert!(!needs_text_equality(Dialect::Mysql, "decimal(10,2)"));
        assert!(!needs_text_equality(Dialect::Postgres, ""));
    }

    #[test]
    fn compiles_nested_groups_with_parameters() {
        let tree = FilterNode::Group {
            logic: Logic::And,
            negate: false,
            children: vec![
                cond("id", FilterOp::Gt, Some("10")),
                FilterNode::Group {
                    logic: Logic::Or,
                    negate: false,
                    children: vec![
                        cond("name", FilterOp::Contains, Some("50%_off")),
                        cond("name", FilterOp::IsNull, None),
                    ],
                },
            ],
        };
        let mut b = SqlBuilder::new(Dialect::Postgres);
        let sql = compile(&tree, &cols(), &mut b).unwrap().unwrap();
        assert_eq!(sql, r#"("id" > $1 AND (CAST("name" AS TEXT) ILIKE $2 ESCAPE '!' OR "name" IS NULL))"#);
        assert_eq!(b.params, vec![Some("10".into()), Some("%50!%!_off%".into())]);
    }

    #[test]
    fn values_never_appear_in_sql() {
        let evil = "'; DROP TABLE users; --";
        for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite, Dialect::Mssql] {
            let mut b = SqlBuilder::new(d);
            let sql = compile(&cond("name", FilterOp::Eq, Some(evil)), &cols(), &mut b).unwrap().unwrap();
            assert!(!sql.contains("DROP"), "{sql}");
            assert_eq!(b.params[0].as_deref(), Some(evil));
        }
    }

    #[test]
    fn sql_server_filters() {
        let tree = FilterNode::Group {
            logic: Logic::And,
            negate: false,
            children: vec![
                cond("id", FilterOp::Gte, Some("10")),
                cond("name", FilterOp::Contains, Some("a[1]_%")),
                cond("active", FilterOp::IsTrue, None),
                cond("deleted", FilterOp::IsFalse, None),
            ],
        };
        let cols: Vec<String> = ["id", "name", "active", "deleted"].map(String::from).to_vec();
        let mut b = SqlBuilder::new(Dialect::Mssql);
        let sql = compile(&tree, &cols, &mut b).unwrap().unwrap();
        assert_eq!(
            sql,
            "([id] >= @P1 AND CAST([name] AS NVARCHAR(MAX)) LIKE @P2 ESCAPE '!' AND [active] = 1 AND [deleted] = 0)"
        );
        // `[` starts a character class in SQL Server patterns.
        assert_eq!(b.params, vec![Some("10".into()), Some("%a![1]!_!%%".into())]);
        assert!(!needs_text_equality(Dialect::Mssql, "float"));
    }

    #[test]
    fn rejects_unknown_columns() {
        let mut b = SqlBuilder::new(Dialect::Postgres);
        let err = compile(&cond("password_hash", FilterOp::Eq, Some("x")), &cols(), &mut b).unwrap_err();
        assert!(err.message.contains("Unknown column"));
    }

    #[test]
    fn in_between_and_dialect_placeholders() {
        let tree = FilterNode::Group {
            logic: Logic::Or,
            negate: true,
            children: vec![
                FilterNode::Condition {
                    column: "id".into(),
                    op: FilterOp::In,
                    value: None,
                    value2: None,
                    values: vec!["1".into(), "2".into()],
                    enabled: true,
                },
                FilterNode::Condition {
                    column: "created".into(),
                    op: FilterOp::Between,
                    value: Some("2024-01-01".into()),
                    value2: Some("2024-12-31".into()),
                    values: vec![],
                    enabled: true,
                },
            ],
        };
        let mut b = SqlBuilder::new(Dialect::Mysql);
        let sql = compile(&tree, &cols(), &mut b).unwrap().unwrap();
        assert_eq!(sql, "NOT (`id` IN (?, ?) OR `created` BETWEEN ? AND ?)");
        assert_eq!(b.params.len(), 4);
        let mut b = SqlBuilder::new(Dialect::Sqlite);
        let sql = compile(&tree, &cols(), &mut b).unwrap().unwrap();
        assert_eq!(sql, "NOT (\"id\" IN (?1, ?2) OR \"created\" BETWEEN ?3 AND ?4)");
    }

    #[test]
    fn disabled_and_empty_groups_compile_to_nothing() {
        let tree = FilterNode::Group {
            logic: Logic::And,
            negate: false,
            children: vec![FilterNode::Condition {
                column: "id".into(),
                op: FilterOp::Eq,
                value: Some("1".into()),
                value2: None,
                values: vec![],
                enabled: false,
            }],
        };
        let mut b = SqlBuilder::new(Dialect::Postgres);
        assert_eq!(compile(&tree, &cols(), &mut b).unwrap(), None);
    }

    #[test]
    fn many_conditions_are_allowed() {
        let children = (0..500).map(|i| cond("id", FilterOp::Ne, Some(&i.to_string()))).collect();
        let tree = FilterNode::Group { logic: Logic::And, negate: false, children };
        let mut b = SqlBuilder::new(Dialect::Postgres);
        compile(&tree, &cols(), &mut b).unwrap();
        assert_eq!(b.params.len(), 500);
    }

    #[test]
    fn raw_filters_must_be_single_expressions() {
        let mut b = SqlBuilder::new(Dialect::Postgres);
        let raw = FilterNode::Raw { sql: "id = 1; drop table x".into(), enabled: true };
        assert!(compile(&raw, &cols(), &mut b).is_err());
        let raw = FilterNode::Raw { sql: "name = 'a;b'".into(), enabled: true };
        assert_eq!(compile(&raw, &cols(), &mut b).unwrap().unwrap(), "(name = 'a;b')");
    }

    #[test]
    fn deserializes_from_frontend_json() {
        let json =
            r#"{"type":"group","logic":"and","children":[{"type":"condition","column":"id","op":"gte","value":"5"}]}"#;
        let node: FilterNode = serde_json::from_str(json).unwrap();
        let mut b = SqlBuilder::new(Dialect::Postgres);
        assert_eq!(compile(&node, &cols(), &mut b).unwrap().unwrap(), "\"id\" >= $1");
    }
}
