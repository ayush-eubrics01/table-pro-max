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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Leave potentially large columns out of the page (opened tables). Export and other
    /// callers keep the default, `false`, and get every column.
    #[serde(default)]
    pub lazy: bool,
    /// Per-column overrides from the column_fetch store.
    #[serde(default)]
    pub load_columns: Vec<String>,
    #[serde(default)]
    pub defer_columns: Vec<String>,
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
    build_select_projected(dialect, s, req, &[])
}

/// The page query with `deferred[i]` columns left out of the select list entirely (no length,
/// no preview): the database never reads them for this page (see large_values.rs).
pub fn build_select_projected(
    dialect: Dialect,
    s: &TableStructure,
    req: &BrowseRequest,
    deferred: &[bool],
) -> Result<BuiltQuery> {
    if req.limit == 0 || req.limit > MAX_PAGE_SIZE {
        return Err(AppError::invalid_config(format!("Page size must be between 1 and {MAX_PAGE_SIZE}")));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    let mut select = Vec::with_capacity(s.columns.len());
    for (i, c) in s.columns.iter().enumerate() {
        if deferred.get(i).copied().unwrap_or(false) {
            continue; // not selected at all: the database never reads it for this page
        }
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

/// One table's `column` for each key: `SELECT <pk…>, <column> FROM t WHERE (pk = $1 …) OR (…)`.
/// The key must be the whole primary key. Results come back in any order; callers match them
/// by the key columns.
pub fn build_fetch(
    dialect: Dialect,
    s: &TableStructure,
    column: &str,
    keys: &[Vec<crate::changes::ColumnValue>],
) -> Result<BuiltQuery> {
    let pk = s.primary_key();
    if pk.is_empty() {
        return Err(AppError::invalid_config(format!("{} has no primary key", s.name)));
    }
    let target = s.column(column).ok_or_else(|| AppError::invalid_config(format!("Unknown column '{column}'")))?;
    if keys.is_empty() || keys.len() > 1000 {
        return Err(AppError::invalid_config("Fetch between 1 and 1000 rows at a time"));
    }
    let proj = |name: &str, ty: &str| -> Result<String> {
        let q = dialect.quote_ident(name)?;
        Ok(match dialect {
            Dialect::Postgres if ty != "bytea" => format!("t.{q}::text AS {q}"),
            _ => format!("t.{q}"),
        })
    };
    let mut select = Vec::new();
    for c in &pk {
        select.push(proj(&c.name, &c.data_type)?);
    }
    select.push(proj(&target.name, &target.data_type)?);
    let mut b = SqlBuilder::new(dialect);
    let mut ors = Vec::with_capacity(keys.len());
    for key in keys {
        if key.len() != pk.len() || !pk.iter().all(|c| key.iter().any(|v| v.column == c.name)) {
            return Err(AppError::invalid_config("A row is identified by its whole primary key"));
        }
        let mut ands = Vec::with_capacity(pk.len());
        for c in &pk {
            let v = key.iter().find(|v| v.column == c.name).expect("checked above");
            ands.push(format!("t.{} = {}", dialect.quote_ident(&c.name)?, b.bind(v.value.clone())));
        }
        ors.push(format!("({})", ands.join(" AND ")));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    Ok(BuiltQuery {
        sql: format!("SELECT {} FROM {table} AS t WHERE {}", select.join(", "), ors.join(" OR ")),
        params: b.params,
    })
}
/// Every column of the rows with these keys (restore points). On PostgreSQL every value is read
/// as text (bytea as `\x` hex), the same rendering the conflict check compares against, so values
/// round-trip as bind parameters. Results come back in any order; callers match them by key.
pub fn build_rows_by_key(
    dialect: Dialect,
    s: &TableStructure,
    keys: &[Vec<crate::changes::ColumnValue>],
) -> Result<BuiltQuery> {
    let pk = s.primary_key();
    if pk.is_empty() {
        return Err(AppError::invalid_config(format!("{} has no primary key", s.name)));
    }
    if keys.is_empty() || keys.len() > 1000 {
        return Err(AppError::invalid_config("Read between 1 and 1000 rows at a time"));
    }
    let mut select = Vec::with_capacity(s.columns.len());
    for c in &s.columns {
        let q = dialect.quote_ident(&c.name)?;
        select.push(match dialect {
            Dialect::Postgres => format!("t.{q}::text AS {q}"),
            _ => format!("t.{q}"),
        });
    }
    let mut b = SqlBuilder::new(dialect);
    let mut ors = Vec::with_capacity(keys.len());
    for key in keys {
        if key.len() != pk.len() || !pk.iter().all(|c| key.iter().any(|v| v.column == c.name)) {
            return Err(AppError::invalid_config("A row is identified by its whole primary key"));
        }
        let mut ands = Vec::with_capacity(pk.len());
        for c in &pk {
            let v = key.iter().find(|v| v.column == c.name).expect("checked above");
            ands.push(format!("t.{} = {}", dialect.quote_ident(&c.name)?, b.bind(v.value.clone())));
        }
        ors.push(format!("({})", ands.join(" AND ")));
    }
    let table = dialect.qualified(Some(&s.schema), &s.name)?;
    Ok(BuiltQuery {
        sql: format!("SELECT {} FROM {table} AS t WHERE {}", select.join(", "), ors.join(" OR ")),
        params: b.params,
    })
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
    fn projected_page_query_leaves_deferred_columns_out_entirely() {
        let s = users();
        let req = BrowseRequest { schema: "public".into(), table: "users".into(), limit: 150, ..Default::default() };
        let q = build_select_projected(Dialect::Postgres, &s, &req, &[false, true, true]).unwrap();
        assert_eq!(
            q.sql,
            "SELECT t.\"id\"::text AS \"id\" FROM \"public\".\"users\" AS t ORDER BY t.\"id\" LIMIT 150 OFFSET 0"
        );
        for word in ["email", "avatar", "length", "left", "CASE"] {
            assert!(!q.sql.contains(word), "{word} in {}", q.sql);
        }
        // Filtering and sorting may still name a deferred column; it is just not returned.
        let sorted = BrowseRequest { sort: vec![SortSpec { column: "email".into(), descending: true }], ..req };
        let q = build_select_projected(Dialect::Postgres, &s, &sorted, &[false, true, true]).unwrap();
        assert!(
            q.sql.contains("ORDER BY t.\"email\" DESC")
                && !q.sql.starts_with("SELECT t.\"id\"::text AS \"id\", t.\"email\""),
            "{}",
            q.sql
        );
    }

    #[test]
    fn rows_by_key_select_every_column_as_text() {
        use crate::changes::ColumnValue;
        let s = users();
        let k = |v: &str| vec![ColumnValue { column: "id".into(), value: Some(v.into()) }];
        let q = build_rows_by_key(Dialect::Postgres, &s, &[k("1"), k("2")]).unwrap();
        assert_eq!(
            q.sql,
            "SELECT t.\"id\"::text AS \"id\", t.\"email\"::text AS \"email\", t.\"avatar\"::text AS \"avatar\" FROM \"public\".\"users\" AS t WHERE (t.\"id\" = $1) OR (t.\"id\" = $2)"
        );
        assert_eq!(q.params, vec![Some("1".into()), Some("2".into())]);
        let q = build_rows_by_key(Dialect::Mysql, &s, &[k("1")]).unwrap();
        assert_eq!(q.sql, "SELECT t.`id`, t.`email`, t.`avatar` FROM `public`.`users` AS t WHERE (t.`id` = ?)");
        assert!(build_rows_by_key(Dialect::Postgres, &s, &[]).is_err(), "no keys");
    }

    #[test]
    fn fetch_query_selects_key_then_column_for_each_key() {
        use crate::changes::ColumnValue;
        let s = users();
        let k = |v: &str| vec![ColumnValue { column: "id".into(), value: Some(v.into()) }];
        let q = build_fetch(Dialect::Postgres, &s, "email", &[k("1"), k("2")]).unwrap();
        assert_eq!(
            q.sql,
            "SELECT t.\"id\"::text AS \"id\", t.\"email\"::text AS \"email\" FROM \"public\".\"users\" AS t WHERE (t.\"id\" = $1) OR (t.\"id\" = $2)"
        );
        assert_eq!(q.params, vec![Some("1".into()), Some("2".into())]);
        let q = build_fetch(Dialect::Mysql, &s, "avatar", &[k("1")]).unwrap();
        assert_eq!(q.sql, "SELECT t.`id`, t.`avatar` FROM `public`.`users` AS t WHERE (t.`id` = ?)");
        assert!(build_fetch(Dialect::Postgres, &s, "nope", &[k("1")]).is_err(), "unknown column");
        assert!(build_fetch(Dialect::Postgres, &s, "email", &[]).is_err(), "no keys");
        let wrong = vec![ColumnValue { column: "email".into(), value: Some("x".into()) }];
        assert!(build_fetch(Dialect::Postgres, &s, "email", &[wrong]).is_err(), "key must be the primary key");
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
            ..Default::default()
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
            ..Default::default()
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
