//! A check on the statement text that can only take editability away from a query result.
//!
//! Column origins name the base table, not the alias, so the database cannot tell two
//! instances of one table apart (`users a JOIN users b`), and SQLite reports the origins of a
//! compound SELECT from one branch only. Editing such a result could update the wrong row.
//! This check never makes a cell editable: the database's origins stay the source of truth,
//! and the statement's shape only removes editability where those origins are ambiguous.

use std::collections::HashMap;
use std::ops::ControlFlow;

use sqlparser::ast::{Query, SetExpr, Statement, TableFactor, Visit, Visitor};
use sqlparser::parser::Parser;

use crate::dialect::Dialect;

/// A table (or view) named in the statement's FROM clauses, CTE references excluded.
#[derive(Debug, Clone, PartialEq)]
pub struct Relation {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// Nothing in this result can be edited, for this reason.
    Blocked(String),
    /// Every table reference in the statement, once per occurrence.
    Tables(Vec<Relation>),
}

pub const COMBINED: &str = "Results that combine queries (UNION, INTERSECT, EXCEPT) can't be edited";
pub const UNREADABLE: &str = "This query could not be analysed, so its results can't be edited";

pub fn shape(sql: &str, dialect: Dialect) -> Shape {
    let parser_dialect = dialect.parser();
    let stmts = match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(s) => s,
        Err(_) => return Shape::Blocked(UNREADABLE.into()),
    };
    let [stmt @ Statement::Query(_)] = stmts.as_slice() else {
        return Shape::Blocked(UNREADABLE.into());
    };
    let mut v = Collect::default();
    if let ControlFlow::Break(reason) = stmt.visit(&mut v) {
        return Shape::Blocked(reason);
    }
    let mut ctes: HashMap<String, usize> = v.ctes.into_iter().map(|c| (c, 0)).collect();
    let mut tables = Vec::new();
    for r in v.relations {
        match (&r.schema, ctes.get_mut(&r.name.to_lowercase())) {
            (None, Some(n)) => *n += 1,
            _ => tables.push(r),
        }
    }
    if let Some((name, _)) = ctes.iter().find(|(_, n)| **n > 1) {
        return Shape::Blocked(format!("{name} is used more than once, so rows cannot be told apart"));
    }
    Shape::Tables(tables)
}

#[derive(Default)]
struct Collect {
    relations: Vec<Relation>,
    ctes: Vec<String>,
}

impl Visitor for Collect {
    type Break = String;

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<String> {
        if matches!(*query.body, SetExpr::SetOperation { .. }) {
            return ControlFlow::Break(COMBINED.into());
        }
        if let Some(with) = &query.with {
            self.ctes.extend(with.cte_tables.iter().map(|c| c.alias.name.value.to_lowercase()));
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<String> {
        // Table-valued functions (`generate_series(…)`, `json_each(…)`) carry arguments; they are not tables.
        if let TableFactor::Table { name, args: None, .. } = factor {
            let parts: Vec<String> =
                name.0.iter().map(|p| p.as_ident().map(|i| i.value.clone()).unwrap_or_default()).collect();
            if let Some((table, rest)) = parts.split_last() {
                self.relations.push(Relation { schema: rest.last().cloned(), name: table.clone() });
            }
        }
        ControlFlow::Continue(())
    }
}

/// How often the statement names `schema.table` (case-insensitive; an unqualified name matches any schema).
pub fn occurrences(relations: &[Relation], schema: &str, table: &str) -> usize {
    relations
        .iter()
        .filter(|r| {
            r.name.eq_ignore_ascii_case(table) && r.schema.as_deref().is_none_or(|s| s.eq_ignore_ascii_case(schema))
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(sql: &str) -> Vec<(Option<String>, String)> {
        match shape(sql, Dialect::Postgres) {
            Shape::Tables(t) => t.into_iter().map(|r| (r.schema, r.name)).collect(),
            Shape::Blocked(r) => panic!("blocked: {r}"),
        }
    }

    fn blocked(sql: &str, dialect: Dialect) -> String {
        match shape(sql, dialect) {
            Shape::Blocked(r) => r,
            Shape::Tables(t) => panic!("not blocked: {t:?}"),
        }
    }

    #[test]
    fn lists_every_table_reference_including_subqueries() {
        let t = tables("SELECT e.id, m.name FROM employees e LEFT JOIN employees m ON m.id = e.manager_id");
        assert_eq!(t, vec![(None, "employees".into()), (None, "employees".into())]);
        let t = tables("SELECT u.id FROM shop.users u WHERE u.id IN (SELECT user_id FROM orders)");
        assert_eq!(t, vec![(Some("shop".into()), "users".into()), (None, "orders".into())]);
        let t = tables("SELECT * FROM (SELECT id, name FROM users) s");
        assert_eq!(t, vec![(None, "users".into())]);
    }

    #[test]
    fn counts_occurrences_by_name_and_schema() {
        let Shape::Tables(t) =
            shape("SELECT * FROM users a JOIN public.users b ON true JOIN other.users c ON true", Dialect::Postgres)
        else {
            panic!()
        };
        assert_eq!(occurrences(&t, "public", "users"), 2);
        assert_eq!(occurrences(&t, "PUBLIC", "Users"), 2);
        assert_eq!(occurrences(&t, "public", "orders"), 0);
    }

    #[test]
    fn compound_selects_are_blocked_on_every_dialect() {
        for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite] {
            assert_eq!(blocked("SELECT id, name FROM a UNION ALL SELECT id, name FROM b", d), COMBINED);
            assert_eq!(blocked("SELECT * FROM (SELECT id FROM a EXCEPT SELECT id FROM b) x", d), COMBINED);
        }
    }

    #[test]
    fn ctes_are_followed_and_a_cte_used_twice_is_blocked() {
        let t = tables("WITH x AS (SELECT id, name FROM users) SELECT id, name FROM x");
        assert_eq!(t, vec![(None, "users".into())]);
        let r = blocked(
            "WITH x AS (SELECT * FROM users) SELECT a.id, b.name FROM x a JOIN x b ON b.id = a.boss",
            Dialect::Postgres,
        );
        assert!(r.starts_with("x is used more than once"), "{r}");
    }

    #[test]
    fn functions_are_not_tables_and_other_statements_are_unreadable() {
        assert_eq!(tables("SELECT g FROM generate_series(1, 3) g"), Vec::<(Option<String>, String)>::new());
        assert_eq!(blocked("SELECT 1; SELECT 2", Dialect::Postgres), UNREADABLE);
        assert_eq!(blocked("UPDATE t SET a = 1 RETURNING id", Dialect::Postgres), UNREADABLE);
        assert_eq!(blocked("SELECT * FROM", Dialect::Postgres), UNREADABLE);
    }
}
