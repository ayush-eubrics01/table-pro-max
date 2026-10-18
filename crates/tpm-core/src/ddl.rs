//! DDL generation: table definitions for display and schema-change statements from the
//! structure editor. Generated SQL is always shown to the user before it runs.

use serde::{Deserialize, Serialize};

use crate::dialect::{Dialect, validate_ident};
use crate::error::{AppError, Result};
use crate::model::TableStructure;

/// `CREATE TABLE` for an introspected table (used where the server has no native
/// "show create" facility, i.e. PostgreSQL).
pub fn create_table_sql(dialect: Dialect, s: &TableStructure) -> Result<String> {
    let mut lines = Vec::new();
    for c in &s.columns {
        // SQL Server: a computed column is its expression (kept as the default); identity is a property.
        if dialect == Dialect::Mssql && c.generated {
            lines.push(format!("  {} AS {}", dialect.quote_ident(&c.name)?, c.default.as_deref().unwrap_or("NULL")));
            continue;
        }
        let mut line = format!("  {} {}", dialect.quote_ident(&c.name)?, c.data_type);
        if dialect == Dialect::Mssql && c.auto_increment {
            line.push_str(" IDENTITY");
        }
        if let Some(d) = &c.default {
            line.push_str(&format!(" DEFAULT {d}"));
        }
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        lines.push(line);
    }
    for con in &s.constraints {
        lines.push(format!("  CONSTRAINT {} {}", dialect.quote_ident(&con.name)?, con.definition));
    }
    let mut sql = format!("CREATE TABLE {} (\n{}\n);", dialect.qualified(Some(&s.schema), &s.name)?, lines.join(",\n"));
    let constraint_names: Vec<&str> = s.constraints.iter().map(|c| c.name.as_str()).collect();
    for idx in &s.indexes {
        if constraint_names.contains(&idx.name.as_str()) {
            continue;
        }
        if let Some(def) = &idx.definition {
            sql.push_str(&format!("\n{def};"));
        }
    }
    for c in s.columns.iter().filter(|_| dialect != Dialect::Mssql) {
        if let Some(comment) = &c.comment {
            sql.push_str(&format!(
                "\nCOMMENT ON COLUMN {}.{} IS {};",
                dialect.qualified(Some(&s.schema), &s.name)?,
                dialect.quote_ident(&c.name)?,
                dialect.quote_literal(comment)
            ));
        }
    }
    for t in &s.triggers {
        sql.push_str(&format!("\n{};", t.definition));
    }
    Ok(sql)
}

/// A column in the structure editor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    #[serde(default = "yes")]
    pub nullable: bool,
    /// Raw SQL default expression (e.g. `now()`, `'draft'`). Shown in the preview.
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub primary_key: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableRequest {
    pub schema: String,
    pub name: String,
    pub columns: Vec<ColumnDef>,
}

/// One structural change from the structure editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AlterOp {
    #[serde(rename_all = "camelCase")]
    AddColumn { column: ColumnDef },
    #[serde(rename_all = "camelCase")]
    DropColumn { name: String },
    #[serde(rename_all = "camelCase")]
    RenameColumn { from: String, to: String },
    #[serde(rename_all = "camelCase")]
    SetType { name: String, data_type: String },
    #[serde(rename_all = "camelCase")]
    SetNullable { name: String, nullable: bool },
    #[serde(rename_all = "camelCase")]
    SetDefault { name: String, default: Option<String> },
    #[serde(rename_all = "camelCase")]
    RenameTable { to: String },
    #[serde(rename_all = "camelCase")]
    CreateIndex { name: String, columns: Vec<String>, unique: bool },
    #[serde(rename_all = "camelCase")]
    DropIndex { name: String },
}

/// Data types are free text in the editor; allow only characters that appear in real
/// type names so a type field cannot smuggle in extra statements.
fn validate_type(t: &str) -> Result<&str> {
    let t = t.trim();
    let ok =
        !t.is_empty() && t.len() <= 128 && t.chars().all(|c| c.is_ascii_alphanumeric() || " _(),.[]\"".contains(c));
    if ok { Ok(t) } else { Err(AppError::invalid_config(format!("Invalid data type '{t}'"))) }
}

/// Defaults are SQL expressions by nature; reject statement separators and comments.
fn validate_default(d: &str) -> Result<&str> {
    let d = d.trim();
    if d.is_empty() || d.contains(';') || d.contains("--") || d.contains("/*") {
        return Err(AppError::invalid_config(format!("Invalid default expression '{d}'")));
    }
    Ok(d)
}

fn column_sql(dialect: Dialect, c: &ColumnDef, inline_pk: bool) -> Result<String> {
    let mut s = format!("{} {}", dialect.quote_ident(&c.name)?, validate_type(&c.data_type)?);
    if inline_pk {
        s.push_str(" PRIMARY KEY");
    }
    if !c.nullable && !inline_pk {
        s.push_str(" NOT NULL");
    }
    if let Some(d) = c.default.as_deref().filter(|d| !d.trim().is_empty()) {
        s.push_str(&format!(" DEFAULT {}", validate_default(d)?));
    }
    Ok(s)
}

pub fn build_create_table(dialect: Dialect, req: &CreateTableRequest) -> Result<Vec<String>> {
    if req.columns.is_empty() {
        return Err(AppError::invalid_config("A table needs at least one column"));
    }
    let pk: Vec<&ColumnDef> = req.columns.iter().filter(|c| c.primary_key).collect();
    let mut lines = Vec::new();
    for c in &req.columns {
        // SQLite: a single INTEGER PRIMARY KEY must be declared inline to alias rowid.
        let inline = pk.len() == 1 && c.primary_key && dialect == Dialect::Sqlite;
        lines.push(format!("  {}", column_sql(dialect, c, inline)?));
    }
    if !pk.is_empty() && !(pk.len() == 1 && dialect == Dialect::Sqlite) {
        let cols: Result<Vec<String>> = pk.iter().map(|c| dialect.quote_ident(&c.name)).collect();
        lines.push(format!("  PRIMARY KEY ({})", cols?.join(", ")));
    }
    let schema = if dialect == Dialect::Sqlite && req.schema == "main" { None } else { Some(req.schema.as_str()) };
    Ok(vec![format!("CREATE TABLE {} (\n{}\n)", dialect.qualified(schema, &req.name)?, lines.join(",\n"))])
}

pub fn build_alter(dialect: Dialect, schema: &str, table: &str, ops: &[AlterOp]) -> Result<Vec<String>> {
    let schema_opt = if dialect == Dialect::Sqlite && schema == "main" { None } else { Some(schema) };
    let t = dialect.qualified(schema_opt, table)?;
    let q = |n: &str| dialect.quote_ident(n);
    let mut out = Vec::new();
    for op in ops {
        match op {
            AlterOp::AddColumn { column } => {
                // T-SQL's ADD takes no COLUMN keyword.
                let add = if dialect == Dialect::Mssql { "ADD" } else { "ADD COLUMN" };
                out.push(format!("ALTER TABLE {t} {add} {}", column_sql(dialect, column, false)?))
            }
            AlterOp::DropColumn { name } => out.push(format!("ALTER TABLE {t} DROP COLUMN {}", q(name)?)),
            AlterOp::RenameColumn { from, to } => out.push(match dialect {
                Dialect::Mysql | Dialect::Postgres | Dialect::Sqlite => {
                    format!("ALTER TABLE {t} RENAME COLUMN {} TO {}", q(from)?, q(to)?)
                }
                // sp_rename takes the old name quoted and the new one as plain text.
                Dialect::Mssql => {
                    validate_ident(to)?;
                    format!(
                        "EXEC sp_rename {}, {}, N'COLUMN'",
                        dialect.quote_literal(&format!("{t}.{}", q(from)?)),
                        dialect.quote_literal(to)
                    )
                }
            }),
            AlterOp::SetType { name, data_type } => out.push(match dialect {
                Dialect::Postgres => {
                    format!("ALTER TABLE {t} ALTER COLUMN {} TYPE {}", q(name)?, validate_type(data_type)?)
                }
                Dialect::Mysql => format!("ALTER TABLE {t} MODIFY COLUMN {} {}", q(name)?, validate_type(data_type)?),
                // Like MySQL's MODIFY, the type carries NULL / NOT NULL (it is reset otherwise).
                Dialect::Mssql => format!("ALTER TABLE {t} ALTER COLUMN {} {}", q(name)?, validate_type(data_type)?),
                Dialect::Sqlite => {
                    return Err(AppError::unsupported(
                        "SQLite cannot change a column type in place; recreate the table instead",
                    ));
                }
            }),
            AlterOp::SetNullable { name, nullable } => out.push(match dialect {
                Dialect::Postgres => format!(
                    "ALTER TABLE {t} ALTER COLUMN {} {} NOT NULL",
                    q(name)?,
                    if *nullable { "DROP" } else { "SET" }
                ),
                _ => {
                    return Err(AppError::unsupported(
                        "Changing nullability requires the full column definition on this database; use 'change type' with the complete definition",
                    ));
                }
            }),
            AlterOp::SetDefault { name, default } => out.push(match (dialect, default.as_deref()) {
                (Dialect::Sqlite, _) => return Err(AppError::unsupported("SQLite cannot change a column default in place")),
                // SQL Server keeps defaults as named constraints.
                (Dialect::Mssql, Some(d)) if !d.trim().is_empty() => {
                    format!("ALTER TABLE {t} ADD DEFAULT ({}) FOR {}", validate_default(d)?, q(name)?)
                }
                (Dialect::Mssql, _) => {
                    return Err(AppError::unsupported(
                        "SQL Server keeps a default as a named constraint: drop it with ALTER TABLE … DROP CONSTRAINT <name> \
                         (the name is in the table's constraints)",
                    ));
                }
                (_, Some(d)) if !d.trim().is_empty() => {
                    format!("ALTER TABLE {t} ALTER COLUMN {} SET DEFAULT {}", q(name)?, validate_default(d)?)
                }
                _ => format!("ALTER TABLE {t} ALTER COLUMN {} DROP DEFAULT", q(name)?),
            }),
            AlterOp::RenameTable { to } => out.push(match dialect {
                Dialect::Mysql => format!("RENAME TABLE {t} TO {}", dialect.qualified(Some(schema), to)?),
                Dialect::Mssql => {
                    validate_ident(to)?;
                    format!("EXEC sp_rename {}, {}", dialect.quote_literal(&t), dialect.quote_literal(to))
                }
                _ => format!("ALTER TABLE {t} RENAME TO {}", q(to)?),
            }),
            AlterOp::CreateIndex { name, columns, unique } => {
                if columns.is_empty() {
                    return Err(AppError::invalid_config("An index needs at least one column"));
                }
                let cols: Result<Vec<String>> = columns.iter().map(|c| q(c)).collect();
                let idx_name = match dialect {
                    Dialect::Sqlite => dialect.qualified(schema_opt, name)?,
                    _ => q(name)?,
                };
                let target = match dialect {
                    Dialect::Sqlite => q(table)?,
                    _ => t.clone(),
                };
                out.push(format!(
                    "CREATE {}INDEX {idx_name} ON {target} ({})",
                    if *unique { "UNIQUE " } else { "" },
                    cols?.join(", ")
                ));
            }
            AlterOp::DropIndex { name } => out.push(match dialect {
                Dialect::Mysql | Dialect::Mssql => format!("DROP INDEX {} ON {t}", q(name)?),
                _ => format!("DROP INDEX {}", dialect.qualified(schema_opt, name)?),
            }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, pk: bool) -> ColumnDef {
        ColumnDef { name: name.into(), data_type: ty.into(), nullable: !pk, default: None, primary_key: pk }
    }

    #[test]
    fn create_table_per_dialect() {
        let req = CreateTableRequest {
            schema: "main".into(),
            name: "todo".into(),
            columns: vec![
                col("id", "INTEGER", true),
                ColumnDef { default: Some("'open'".into()), ..col("state", "TEXT", false) },
            ],
        };
        assert_eq!(
            build_create_table(Dialect::Sqlite, &req).unwrap()[0],
            "CREATE TABLE \"todo\" (\n  \"id\" INTEGER PRIMARY KEY,\n  \"state\" TEXT DEFAULT 'open'\n)"
        );
        let req = CreateTableRequest { schema: "public".into(), ..req };
        assert_eq!(
            build_create_table(Dialect::Postgres, &req).unwrap()[0],
            "CREATE TABLE \"public\".\"todo\" (\n  \"id\" INTEGER NOT NULL,\n  \"state\" TEXT DEFAULT 'open',\n  PRIMARY KEY (\"id\")\n)"
        );
    }

    #[test]
    fn rejects_injection_in_types_and_defaults() {
        let req = CreateTableRequest {
            schema: "public".into(),
            name: "t".into(),
            columns: vec![col("a", "int); drop table x; --", false)],
        };
        assert!(build_create_table(Dialect::Postgres, &req).is_err());
        let req = CreateTableRequest {
            schema: "public".into(),
            name: "t".into(),
            columns: vec![ColumnDef { default: Some("1; drop table x".into()), ..col("a", "int", false) }],
        };
        assert!(build_create_table(Dialect::Postgres, &req).is_err());
        assert!(validate_type("numeric(10, 2)").is_ok());
        assert!(validate_type("character varying(255)").is_ok());
        assert!(validate_type("int[]").is_ok());
    }

    #[test]
    fn alter_statements() {
        let ops = vec![
            AlterOp::AddColumn { column: col("note", "text", false) },
            AlterOp::RenameColumn { from: "a".into(), to: "b".into() },
            AlterOp::SetNullable { name: "b".into(), nullable: false },
            AlterOp::CreateIndex { name: "ix_b".into(), columns: vec!["b".into()], unique: true },
            AlterOp::DropColumn { name: "old".into() },
        ];
        let sql = build_alter(Dialect::Postgres, "public", "t", &ops).unwrap();
        assert_eq!(sql[0], "ALTER TABLE \"public\".\"t\" ADD COLUMN \"note\" text");
        assert_eq!(sql[2], "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"b\" SET NOT NULL");
        assert_eq!(sql[3], "CREATE UNIQUE INDEX \"ix_b\" ON \"public\".\"t\" (\"b\")");
        assert_eq!(sql[4], "ALTER TABLE \"public\".\"t\" DROP COLUMN \"old\"");
        assert!(
            build_alter(
                Dialect::Sqlite,
                "main",
                "t",
                &[AlterOp::SetType { name: "a".into(), data_type: "int".into() }]
            )
            .is_err()
        );
        let sql = build_alter(Dialect::Sqlite, "main", "t", &[AlterOp::DropIndex { name: "ix".into() }]).unwrap();
        assert_eq!(sql[0], "DROP INDEX \"ix\"");
    }

    #[test]
    fn sql_server_ddl() {
        let req = CreateTableRequest {
            schema: "dbo".into(),
            name: "todo".into(),
            columns: vec![col("id", "INT IDENTITY(1,1)", true), col("title", "NVARCHAR(200)", false)],
        };
        assert_eq!(
            build_create_table(Dialect::Mssql, &req).unwrap()[0],
            "CREATE TABLE [dbo].[todo] (\n  [id] INT IDENTITY(1,1) NOT NULL,\n  [title] NVARCHAR(200),\n  PRIMARY KEY ([id])\n)"
        );
        let ops = vec![
            AlterOp::AddColumn { column: col("note", "nvarchar(max)", false) },
            AlterOp::RenameColumn { from: "a".into(), to: "it's".into() },
            AlterOp::SetType { name: "b".into(), data_type: "bigint NOT NULL".into() },
            AlterOp::SetDefault { name: "b".into(), default: Some("0".into()) },
            AlterOp::RenameTable { to: "t2".into() },
            AlterOp::CreateIndex { name: "ix_b".into(), columns: vec!["b".into()], unique: false },
            AlterOp::DropIndex { name: "ix_b".into() },
            AlterOp::DropColumn { name: "old".into() },
        ];
        let sql = build_alter(Dialect::Mssql, "dbo", "t", &ops).unwrap();
        assert_eq!(
            sql,
            [
                "ALTER TABLE [dbo].[t] ADD [note] nvarchar(max)",
                "EXEC sp_rename N'[dbo].[t].[a]', N'it''s', N'COLUMN'",
                "ALTER TABLE [dbo].[t] ALTER COLUMN [b] bigint NOT NULL",
                "ALTER TABLE [dbo].[t] ADD DEFAULT (0) FOR [b]",
                "EXEC sp_rename N'[dbo].[t]', N't2'",
                "CREATE INDEX [ix_b] ON [dbo].[t] ([b])",
                "DROP INDEX [ix_b] ON [dbo].[t]",
                "ALTER TABLE [dbo].[t] DROP COLUMN [old]",
            ]
        );
        let drop_default = [AlterOp::SetDefault { name: "b".into(), default: None }];
        assert!(build_alter(Dialect::Mssql, "dbo", "t", &drop_default).unwrap_err().message.contains("constraint"));
        let nullable = [AlterOp::SetNullable { name: "b".into(), nullable: true }];
        assert!(build_alter(Dialect::Mssql, "dbo", "t", &nullable).is_err());
    }
}
