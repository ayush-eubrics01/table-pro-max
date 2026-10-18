//! SQL dialect helpers: identifier quoting, placeholders and qualified names.
//!
//! Values are always passed as bind parameters. Identifiers cannot be parameterised,
//! so they are validated and quoted here, using the escaping rules of each dialect.

use serde::{Deserialize, Serialize};
use sqlparser::dialect::{Dialect as ParserDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    /// Microsoft SQL Server (T-SQL).
    Mssql,
}

/// Upper bound on identifier length. PostgreSQL truncates at 63 bytes, MySQL at 64
/// characters; we reject anything absurdly long before it reaches the server.
const MAX_IDENT_LEN: usize = 256;

impl Dialect {
    /// Validates and quotes a single identifier part.
    pub fn quote_ident(self, ident: &str) -> Result<String> {
        validate_ident(ident)?;
        Ok(match self {
            Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
            Dialect::Mysql => format!("`{}`", ident.replace('`', "``")),
            Dialect::Mssql => format!("[{}]", ident.replace(']', "]]")),
        })
    }

    /// Quotes `schema.table`, omitting the schema when it is empty.
    pub fn qualified(self, schema: Option<&str>, name: &str) -> Result<String> {
        match schema.filter(|s| !s.is_empty()) {
            Some(s) => Ok(format!("{}.{}", self.quote_ident(s)?, self.quote_ident(name)?)),
            None => self.quote_ident(name),
        }
    }

    /// Bind placeholder for the 1-based parameter `n`.
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::Postgres => format!("${n}"),
            Dialect::Mysql => "?".to_string(),
            Dialect::Sqlite => format!("?{n}"),
            Dialect::Mssql => format!("@P{n}"),
        }
    }

    /// `lhs` equals `rhs`, where two NULLs count as equal.
    pub fn null_safe_eq(self, lhs: &str, rhs: &str) -> String {
        match self {
            Dialect::Postgres => format!("{lhs} IS NOT DISTINCT FROM {rhs}"),
            Dialect::Mysql => format!("{lhs} <=> {rhs}"),
            Dialect::Sqlite => format!("{lhs} IS {rhs}"),
            // IS NOT DISTINCT FROM needs SQL Server 2022; spelled out it works on every version.
            Dialect::Mssql => format!("({lhs} = {rhs} OR ({lhs} IS NULL AND {rhs} IS NULL))"),
        }
    }

    /// Case-insensitive LIKE operator.
    pub fn ilike(self) -> &'static str {
        match self {
            Dialect::Postgres => "ILIKE",
            // MySQL's default collations are case-insensitive; SQLite's LIKE is
            // case-insensitive for ASCII.
            // SQL Server's default collations are case-insensitive too.
            Dialect::Mysql | Dialect::Sqlite | Dialect::Mssql => "LIKE",
        }
    }

    /// Quotes a string literal. Only used for SQL *previews* and generated scripts
    /// (exports, DDL), never on the execution path for user-supplied values.
    pub fn quote_literal(self, value: &str) -> String {
        match self {
            Dialect::Mysql => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
            Dialect::Postgres => {
                if value.contains('\\') {
                    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
                } else {
                    format!("'{}'", value.replace('\'', "''"))
                }
            }
            Dialect::Sqlite => format!("'{}'", value.replace('\'', "''")),
            // N'' keeps text outside the database's code page.
            Dialect::Mssql => format!("N'{}'", value.replace('\'', "''")),
        }
    }

    /// The SQL parser's dialect, for analysing statements.
    pub(crate) fn parser(self) -> Box<dyn ParserDialect> {
        match self {
            Dialect::Postgres => Box::new(PostgreSqlDialect {}),
            Dialect::Mysql => Box::new(MySqlDialect {}),
            Dialect::Sqlite => Box::new(SQLiteDialect {}),
            Dialect::Mssql => Box::new(MsSqlDialect {}),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Dialect::Postgres => "PostgreSQL",
            Dialect::Mysql => "MySQL",
            Dialect::Sqlite => "SQLite",
            Dialect::Mssql => "SQL Server",
        }
    }
}

pub fn validate_ident(ident: &str) -> Result<()> {
    if ident.is_empty() {
        return Err(AppError::invalid_config("Identifier must not be empty"));
    }
    if ident.len() > MAX_IDENT_LEN {
        return Err(AppError::invalid_config("Identifier is too long"));
    }
    if ident.chars().any(|c| c == '\0') {
        return Err(AppError::invalid_config("Identifier must not contain NUL characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::Postgres.quote_ident("users").unwrap(), "\"users\"");
        assert_eq!(Dialect::Postgres.quote_ident("we\"ird").unwrap(), "\"we\"\"ird\"");
        assert_eq!(Dialect::Mysql.quote_ident("we`ird").unwrap(), "`we``ird`");
        assert_eq!(Dialect::Sqlite.quote_ident("a b").unwrap(), "\"a b\"");
    }

    #[test]
    fn injection_attempts_stay_inside_quotes() {
        let evil = "x\"; DROP TABLE users; --";
        let q = Dialect::Postgres.quote_ident(evil).unwrap();
        assert_eq!(q, "\"x\"\"; DROP TABLE users; --\"");
        let evil = "x`; DROP TABLE users; --";
        assert_eq!(Dialect::Mysql.quote_ident(evil).unwrap(), "`x``; DROP TABLE users; --`");
    }

    #[test]
    fn rejects_invalid_identifiers() {
        assert!(Dialect::Postgres.quote_ident("").is_err());
        assert!(Dialect::Postgres.quote_ident("a\0b").is_err());
        assert!(Dialect::Postgres.quote_ident(&"a".repeat(300)).is_err());
    }

    #[test]
    fn qualified_names_and_placeholders() {
        assert_eq!(Dialect::Postgres.qualified(Some("public"), "t").unwrap(), "\"public\".\"t\"");
        assert_eq!(Dialect::Sqlite.qualified(None, "t").unwrap(), "\"t\"");
        assert_eq!(Dialect::Mysql.qualified(Some(""), "t").unwrap(), "`t`");
        assert_eq!(Dialect::Postgres.placeholder(3), "$3");
        assert_eq!(Dialect::Mysql.placeholder(3), "?");
        assert_eq!(Dialect::Sqlite.placeholder(3), "?3");
    }

    #[test]
    fn literal_quoting_for_previews() {
        assert_eq!(Dialect::Postgres.quote_literal("it's"), "'it''s'");
        assert_eq!(Dialect::Postgres.quote_literal("a\\b"), "E'a\\\\b'");
        assert_eq!(Dialect::Mysql.quote_literal("a\\'b"), "'a\\\\''b'");
    }

    #[test]
    fn sql_server_brackets_placeholders_and_literals() {
        let d = Dialect::Mssql;
        assert_eq!(d.quote_ident("order").unwrap(), "[order]");
        assert_eq!(d.quote_ident("a]b").unwrap(), "[a]]b]");
        assert_eq!(d.quote_ident("x]; DROP TABLE t; --").unwrap(), "[x]]; DROP TABLE t; --]");
        assert_eq!(d.qualified(Some("dbo"), "t").unwrap(), "[dbo].[t]");
        assert_eq!(d.placeholder(3), "@P3");
        // N'' keeps non-ASCII text intact; backslashes are ordinary characters.
        assert_eq!(d.quote_literal("it's é\\n"), "N'it''s é\\n'");
        assert_eq!(d.ilike(), "LIKE");
        assert_eq!(d.null_safe_eq("[a]", "@P1"), "([a] = @P1 OR ([a] IS NULL AND @P1 IS NULL))");
        assert_eq!(d.name(), "SQL Server");
    }
}
