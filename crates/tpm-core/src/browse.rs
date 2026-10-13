//! Paginated table browsing queries.

use serde::{Deserialize, Serialize};

use crate::dialect::Dialect;
use crate::error::{AppError, Result};
use crate::filter::{FilterNode, SqlBuilder, compile};
use crate::model::{ObjectKind, Param, TableStructure};

/// Hard ceiling on a single page; keeps one IPC response bounded.
pub const MAX_PAGE_SIZE: u32 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filter: Option<FilterNode>,
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuiltQuery {
    pub sql: String,
    pub params: Vec<Param>,
}

fn column_names(s: &TableStructure) -> Vec<String> {
    s.columns.iter().map(|c| c.name.clone()).collect()
}

fn where_clause(s: &TableStructure, filter: Option<&FilterNode>, b: &mut SqlBuilder) -> Result<String> {
    match filter {
        Some(f) => Ok(compile(f, &column_names(s), b)?.map(|w| format!(" WHERE {w}")).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// Builds the page query. PostgreSQL columns are cast to text (except `bytea`) so every
/// type, including extension types, can be displayed without a client-side decoder.
pub fn build_select(dialect: Dialect, s: &TableStructure, req: &BrowseRequest) -> Result<BuiltQuery> {
    if req.limit == 0 || req.limit > MAX_PAGE_SIZE {
        return Err(AppError::invalid_config(format!("Page size must be between 1 and {MAX_PAGE_SIZE}")));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    let mut select = Vec::with_capacity(s.columns.len());
    for c in &s.columns {
        let q = dialect.quote_ident(&c.name)?;
        select.push(match dialect {
            Dialect::Postgres if c.data_type != "bytea" => format!("t.{q}::text AS {q}"),
            _ => format!("t.{q}"),
        });
    }
    if select.is_empty() {
        select.push("*".into());
    }
    let mut b = SqlBuilder::new(dialect);
    let where_sql = where_clause(s, req.filter.as_ref(), &mut b)?;

    let mut order = Vec::new();
    for spec in &req.sort {
        if s.column(&spec.column).is_none() {
            return Err(AppError::invalid_config(format!("Unknown sort column '{}'", spec.column)));
        }
        order.push(format!("t.{}{}", dialect.quote_ident(&spec.column)?, if spec.descending { " DESC" } else { "" }));
    }
    if order.is_empty() && s.kind == ObjectKind::Table {
        // Stable pagination: without an ORDER BY, pages may overlap or skip rows.
        for c in s.primary_key() {
            order.push(format!("t.{}", dialect.quote_ident(&c.name)?));
        }
    }
    let order_sql = if order.is_empty() { String::new() } else { format!(" ORDER BY {}", order.join(", ")) };
    // The filter references bare column names, which resolve against the aliased table.
    let sql = format!(
        "SELECT {} FROM {table} AS t{where_sql}{order_sql} LIMIT {} OFFSET {}",
        select.join(", "),
        req.limit,
        req.offset
    );
    Ok(BuiltQuery { sql, params: b.params })
}

pub fn build_count(dialect: Dialect, s: &TableStructure, filter: Option<&FilterNode>) -> Result<BuiltQuery> {
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    let mut b = SqlBuilder::new(dialect);
    let where_sql = where_clause(s, filter, &mut b)?;
    Ok(BuiltQuery { sql: format!("SELECT count(*) FROM {table} AS t{where_sql}"), params: b.params })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::filter::{FilterOp, Logic};
    use crate::model::ColumnInfo;

    pub fn users() -> TableStructure {
        let col = |name: &str, ty: &str, pk: Option<u32>| ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: pk.is_none(),
            default: None,
            primary_key: pk,
            auto_increment: pk.is_some(),
            comment: None,
        };
        TableStructure {
            schema: "public".into(),
            name: "users".into(),
            kind: ObjectKind::Table,
            columns: vec![col("id", "integer", Some(1)), col("email", "text", None), col("avatar", "bytea", None)],
            indexes: vec![],
            foreign_keys: vec![],
            constraints: vec![],
            triggers: vec![],
        }
    }

    #[test]
    fn builds_postgres_page_query() {
        let req = BrowseRequest {
            schema: "public".into(),
            table: "users".into(),
            filter: Some(FilterNode::Group {
                logic: Logic::And,
                negate: false,
                children: vec![FilterNode::Condition {
                    column: "email".into(),
                    op: FilterOp::EndsWith,
                    value: Some("@x.com".into()),
                    value2: None,
                    values: vec![],
                    enabled: true,
                }],
            }),
            sort: vec![],
            limit: 100,
            offset: 200,
        };
        let q = build_select(Dialect::Postgres, &users(), &req).unwrap();
        assert_eq!(
            q.sql,
            "SELECT t.\"id\"::text AS \"id\", t.\"email\"::text AS \"email\", t.\"avatar\" FROM \"public\".\"users\" AS t \
             WHERE CAST(\"email\" AS TEXT) ILIKE $1 ESCAPE '!' ORDER BY t.\"id\" LIMIT 100 OFFSET 200"
        );
        assert_eq!(q.params, vec![Some("%@x.com".into())]);
    }

    #[test]
    fn explicit_sort_and_validation() {
        let mut req = BrowseRequest {
            schema: "public".into(),
            table: "users".into(),
            filter: None,
            sort: vec![SortSpec { column: "email".into(), descending: true }],
            limit: 50,
            offset: 0,
        };
        let q = build_select(Dialect::Mysql, &users(), &req).unwrap();
        assert!(q.sql.ends_with("ORDER BY t.`email` DESC LIMIT 50 OFFSET 0"), "{}", q.sql);
        req.sort[0].column = "nope".into();
        assert!(build_select(Dialect::Mysql, &users(), &req).is_err());
        req.sort.clear();
        req.limit = MAX_PAGE_SIZE + 1;
        assert!(build_select(Dialect::Mysql, &users(), &req).is_err());
    }

    #[test]
    fn count_query() {
        let q = build_count(Dialect::Sqlite, &users(), None).unwrap();
        assert_eq!(q.sql, "SELECT count(*) FROM \"public\".\"users\" AS t");
    }
}
