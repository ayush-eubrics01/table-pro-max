//! Query parameters: `:name` placeholders in user SQL (and `$1` placeholders on PostgreSQL and
//! DuckDB), rewritten for the driver and always bound as values, never pasted into the SQL.

use crate::dialect::Dialect;
use crate::error::{AppError, Result};

/// A placeholder found in the SQL: its byte span and what it names.
enum Hole {
    Named(String),
    Numbered(usize),
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80
}

/// The end (exclusive) of a quoted run starting at `start`; a doubled quote stays inside, and so
/// does a backslash-escaped one where `backslash` is set.
fn skip_quoted(b: &[u8], start: usize, quote: u8, backslash: bool) -> usize {
    let mut j = start + 1;
    while j < b.len() {
        if backslash && b[j] == b'\\' {
            j += 2;
        } else if b[j] == quote {
            if b.get(j + 1) == Some(&quote) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    b.len()
}

/// Placeholders outside strings, quoted names, comments and dollar-quoted bodies. `::` casts,
/// `a[lo:hi]` slices and MySQL `:=` are not placeholders.
fn holes(sql: &str, dialect: Dialect) -> Vec<(usize, usize, Hole)> {
    // Bodies of prepared statements and routines have their own `$1`s and are not run with values.
    let head: String = sql.trim_start().chars().take(40).collect::<String>().to_ascii_uppercase();
    let head = head.split_whitespace().collect::<Vec<_>>().join(" ");
    if [
        "PREPARE ",
        "DO ",
        "CREATE FUNCTION",
        "CREATE PROCEDURE",
        "CREATE OR REPLACE FUNCTION",
        "CREATE OR REPLACE PROCEDURE",
    ]
    .iter()
    .any(|p| head.starts_with(p))
    {
        return Vec::new();
    }
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let next = b.get(i + 1).copied();
        match b[i] {
            b'\'' => {
                // MySQL strings and PostgreSQL E'...' strings take backslash escapes.
                let e_string = dialect == Dialect::Postgres
                    && i > 0
                    && matches!(b[i - 1], b'E' | b'e')
                    && (i < 2 || !is_ident(b[i - 2]));
                i = skip_quoted(b, i, b'\'', dialect == Dialect::Mysql || e_string);
            }
            b'"' => i = skip_quoted(b, i, b'"', dialect == Dialect::Mysql),
            b'`' if dialect != Dialect::Postgres => i = skip_quoted(b, i, b'`', false),
            // MySQL starts a `--` comment only before whitespace (`5--3` is arithmetic).
            b'-' if next == Some(b'-')
                && (dialect != Dialect::Mysql || b.get(i + 2).is_none_or(|c| c.is_ascii_whitespace())) =>
            {
                i = sql[i..].find('\n').map_or(n, |k| i + k)
            }
            b'#' if dialect == Dialect::Mysql => i = sql[i..].find('\n').map_or(n, |k| i + k),
            b'/' if next == Some(b'*') => i = comment_end(b, i, dialect == Dialect::Postgres),
            b'$' if dialect == Dialect::Postgres => {
                let mut j = i + 1;
                // `a$1` is a name, not a placeholder.
                let after_name = i > 0 && is_ident(b[i - 1]);
                if next.is_some_and(|c| c.is_ascii_digit()) && !after_name {
                    while j < n && b[j].is_ascii_digit() {
                        j += 1;
                    }
                    if let Ok(k) = sql[i + 1..j].parse() {
                        out.push((i, j, Hole::Numbered(k)));
                    }
                    i = j;
                    continue;
                }
                while j < n && is_ident(b[j]) {
                    j += 1;
                }
                if j < n && b[j] == b'$' {
                    // $tag$ ... $tag$
                    let tag = &sql[i..=j];
                    i = sql[j + 1..].find(tag).map_or(n, |k| j + 1 + k + tag.len());
                } else {
                    i += 1;
                }
            }
            b':' if next == Some(b':') => i += 2,
            b':' => {
                let prev = if i > 0 { b[i - 1] } else { b' ' };
                // Not after a name or `]` (`a[lo:hi]`), a quote (`{'a':x}` struct keys) or a `[`
                // that opens a slice (`arr[:n]`); an ARRAY[ constructor takes values.
                let before = sql[..i].trim_end();
                let slice = before.ends_with('[')
                    && !before[..before.len() - 1].trim_end().to_ascii_uppercase().ends_with("ARRAY");
                if !is_ident(prev)
                    && !matches!(prev, b']' | b'\'' | b'"')
                    && !slice
                    && next.is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
                {
                    let mut j = i + 1;
                    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                        j += 1;
                    }
                    out.push((i, j, Hole::Named(sql[i + 1..j].to_string())));
                    i = j;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    out
}

/// The end of a `/* */` comment starting at `start`; PostgreSQL nests them.
fn comment_end(b: &[u8], start: usize, nested: bool) -> usize {
    let mut depth = 0;
    let mut j = start;
    while j + 1 < b.len() {
        if b[j] == b'/' && b[j + 1] == b'*' {
            depth += 1;
            j += 2;
        } else if b[j] == b'*' && b[j + 1] == b'/' {
            depth -= 1;
            j += 2;
            if depth == 0 || !nested {
                return j;
            }
        } else {
            j += 1;
        }
    }
    b.len()
}

fn mixed() -> AppError {
    AppError::invalid_config("Use either :name or $1 placeholders in a statement, not both")
}

/// Parameter names a statement uses, in first-use order, each once (`$1`-style ones by number).
pub fn parameter_names(sql: &str, dialect: Dialect) -> Result<Vec<String>> {
    let holes = holes(sql, dialect);
    let named = holes.iter().any(|h| matches!(h.2, Hole::Named(_)));
    let max = holes.iter().filter_map(|h| if let Hole::Numbered(k) = h.2 { Some(k) } else { None }).max();
    match (named, max) {
        (true, Some(_)) => Err(mixed()),
        (false, Some(max)) => Ok((1..=max).map(|k| format!("${k}")).collect()),
        _ => {
            let mut names: Vec<String> = Vec::new();
            for (_, _, h) in holes {
                if let Hole::Named(name) = h
                    && !names.contains(&name)
                {
                    names.push(name);
                }
            }
            Ok(names)
        }
    }
}

/// The statement with its `:name` placeholders rewritten for the driver, and the parameter names
/// to bind in order (a name used twice is bound twice where the driver has no numbered
/// placeholders). `$1`-style placeholders are left as they are.
pub fn bind_parameters(sql: &str, dialect: Dialect) -> Result<(String, Vec<String>)> {
    let names = parameter_names(sql, dialect)?;
    if names.first().is_some_and(|n| n.starts_with('$')) {
        return Ok((sql.to_string(), names));
    }
    let mut out = String::with_capacity(sql.len());
    let mut order = Vec::new();
    let mut last = 0;
    for (start, end, hole) in holes(sql, dialect) {
        let Hole::Named(name) = hole else { continue };
        out.push_str(&sql[last..start]);
        if dialect == Dialect::Mysql {
            out.push('?');
            order.push(name);
        } else {
            let k = names.iter().position(|n| *n == name).unwrap_or(0) + 1;
            out.push_str(&dialect.placeholder(k));
        }
        last = end;
    }
    out.push_str(&sql[last..]);
    if dialect != Dialect::Mysql {
        order = names;
    }
    Ok((out, order))
}

/// The parameters a whole script asks for: each statement's names, each once, in order.
pub fn script_parameter_names(sql: &str, dialect: Dialect) -> Result<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    for stmt in crate::split::split_statements(sql, dialect) {
        for name in parameter_names(&stmt.sql, dialect)? {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_asks_for_each_name_once() {
        let sql = "UPDATE t SET a = :a WHERE id = :id;\nSELECT * FROM t WHERE id = :id AND b = ':no'";
        assert_eq!(script_parameter_names(sql, Dialect::Mysql).unwrap(), ["a", "id"]);
    }

    #[test]
    fn named_placeholders_are_rewritten_for_each_driver() {
        let sql = "SELECT * FROM t WHERE id = :id AND name = :name OR id = :id";
        assert_eq!(parameter_names(sql, Dialect::Postgres).unwrap(), ["id", "name"]);
        assert_eq!(
            bind_parameters(sql, Dialect::Postgres).unwrap(),
            ("SELECT * FROM t WHERE id = $1 AND name = $2 OR id = $1".to_string(), vec!["id".into(), "name".into()])
        );
        assert_eq!(
            bind_parameters(sql, Dialect::Sqlite).unwrap(),
            ("SELECT * FROM t WHERE id = ?1 AND name = ?2 OR id = ?1".to_string(), vec!["id".into(), "name".into()])
        );
        assert_eq!(
            bind_parameters(sql, Dialect::Mysql).unwrap(),
            (
                "SELECT * FROM t WHERE id = ? AND name = ? OR id = ?".to_string(),
                vec!["id".into(), "name".into(), "id".into()]
            )
        );
        assert_eq!(
            bind_parameters("UPDATE t SET a=:new_a WHERE b IN (:x,:y)", Dialect::Postgres).unwrap().0,
            "UPDATE t SET a=$1 WHERE b IN ($2,$3)"
        );
    }

    #[test]
    fn strings_comments_casts_and_slices_are_not_placeholders() {
        let pg =
            "SELECT ':a', \"b:c\", x::int, arr[lo:hi], E'it\\'s :d', $$ :e $$, $tag$ :f $tag$ -- :g\n/* :h */ FROM t";
        assert!(
            parameter_names(pg, Dialect::Postgres).unwrap().is_empty(),
            "{:?}",
            parameter_names(pg, Dialect::Postgres)
        );
        assert_eq!(bind_parameters(pg, Dialect::Postgres).unwrap().0, pg);
        let my = "SELECT `a:b`, @v := 1, 'it\\'s :x', \"y:z\" # :c\nFROM t";
        assert!(parameter_names(my, Dialect::Mysql).unwrap().is_empty(), "{:?}", parameter_names(my, Dialect::Mysql));
        assert_eq!(parameter_names("SELECT 'a''b' || :name", Dialect::Sqlite).unwrap(), ["name"]);
    }

    #[test]
    fn slices_struct_keys_prepared_bodies_and_comments_are_left_alone() {
        let none =
            |sql: &str, d| assert!(parameter_names(sql, d).unwrap().is_empty(), "{sql}: {:?}", parameter_names(sql, d));
        none("SELECT arr[:n], arr[1:n] FROM t", Dialect::Postgres);
        none("SELECT {'a':col, \"b\":2} FROM t", Dialect::Postgres); // DuckDB struct literal
        none("SELECT a$1 FROM t", Dialect::Postgres);
        none("PREPARE p(int) AS SELECT * FROM t WHERE id = $1", Dialect::Postgres);
        none("create or replace function f(a int) returns int language sql as $$ select :x $$", Dialect::Postgres);
        none("CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT $1; END", Dialect::Postgres);
        none("SELECT 1 /* outer /* inner */ :x */", Dialect::Postgres);
        // MySQL: `--` starts a comment only before whitespace.
        assert_eq!(parameter_names("SELECT 5--3 + :n", Dialect::Mysql).unwrap(), ["n"]);
        none("SELECT 1 -- :n", Dialect::Mysql);
        // A placeholder right after an opening bracket of a call or list still counts.
        assert_eq!(
            parameter_names("SELECT f(:a), ARRAY[:b, :c], array [ :d ]", Dialect::Postgres).unwrap(),
            ["a", "b", "c", "d"]
        );
    }

    #[test]
    fn numbered_placeholders_on_postgres() {
        assert_eq!(parameter_names("SELECT $2, $1::int, $2", Dialect::Postgres).unwrap(), ["$1", "$2"]);
        assert_eq!(
            bind_parameters("SELECT $2, $1::int", Dialect::Postgres).unwrap(),
            ("SELECT $2, $1::int".to_string(), vec!["$1".into(), "$2".into()])
        );
        assert!(parameter_names("SELECT :a, $1", Dialect::Postgres).is_err(), "mixing the two styles");
    }
}
