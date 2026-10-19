//! SQL safety analysis and execution policy.
//!
//! The analyzer parses each statement with `sqlparser` and classifies it. It is a
//! *warning and policy* layer: SQL can have side effects the AST does not reveal (a
//! `SELECT` calling a function that writes, a procedure call, vendor syntax the parser
//! does not know). Read-only connections are therefore also enforced by the database
//! session itself (see the adapters); this module only adds confirmation prompts and
//! an extra refusal layer on top.

use serde::Serialize;
use sqlparser::ast::{
    AlterTableOperation, ConditionalStatementBlock, CopySource, MergeAction, MergeClauseKind, Query, SetExpr, Statement,
};
use sqlparser::parser::Parser;

use crate::config::SafetyMode;
use crate::dialect::Dialect;
use crate::split::{StatementSpan, split_statements};

/// Ordered from least to most risky.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementClass {
    /// No data modification detected.
    Read,
    /// Transaction control (BEGIN/COMMIT/ROLLBACK/SAVEPOINT).
    Transaction,
    /// Session settings (SET, USE, RESET).
    Session,
    /// Data modification (INSERT, UPDATE/DELETE with a WHERE clause, MERGE, COPY FROM, CALL...).
    Write,
    /// Schema change that does not obviously destroy data (CREATE, most ALTERs, GRANT).
    Ddl,
    /// Could not be analyzed; side effects unknown.
    Unknown,
    /// Destroys data or objects (DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER ... DROP).
    Destructive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementAnalysis {
    pub sql: String,
    pub start: usize,
    pub end: usize,
    pub class: StatementClass,
    pub reasons: Vec<String>,
    pub parsed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    Confirm { reasons: Vec<String> },
    Block { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptAnalysis {
    pub statements: Vec<StatementAnalysis>,
    pub decision: PolicyDecision,
}

pub fn analyze_script(sql: &str, dialect: Dialect, mode: SafetyMode) -> ScriptAnalysis {
    let statements: Vec<StatementAnalysis> =
        split_statements(sql, dialect).into_iter().map(|span| analyze_span(span, dialect)).collect();
    let decision = decide(&statements, mode);
    ScriptAnalysis { statements, decision }
}

pub fn analyze_statement(sql: &str, dialect: Dialect) -> StatementAnalysis {
    analyze_span(StatementSpan { sql: sql.to_string(), start: 0, end: sql.len() }, dialect)
}

fn analyze_span(span: StatementSpan, dialect: Dialect) -> StatementAnalysis {
    let parser_dialect = dialect.parser();
    let mut reasons = Vec::new();
    let (class, parsed) = match Parser::parse_sql(parser_dialect.as_ref(), &span.sql) {
        Ok(stmts) if !stmts.is_empty() => {
            let class = stmts.iter().map(|s| classify(s, &mut reasons)).max().unwrap_or(StatementClass::Read);
            (class, true)
        }
        // A T-SQL batch holds many statements, often without `;` between them: judge each one,
        // and an unreadable one by every keyword in it rather than its first.
        _ if dialect == Dialect::Mssql => {
            let mut class = StatementClass::Read;
            for part in crate::split::mssql_statement_spans(&span.sql) {
                class = class.max(match Parser::parse_sql(parser_dialect.as_ref(), &part.sql) {
                    Ok(stmts) if !stmts.is_empty() => {
                        stmts.iter().map(|s| classify(s, &mut reasons)).max().unwrap_or(StatementClass::Read)
                    }
                    _ => mssql_keyword_fallback(&part.sql, &mut reasons),
                });
            }
            (class, false)
        }
        _ => {
            let class = keyword_fallback(&span.sql, &mut reasons);
            (class, false)
        }
    };
    // OPENQUERY and friends run their own SQL on another server, whatever the outer statement is.
    let class = if dialect == Dialect::Mssql
        && crate::split::mssql_words(&span.sql)
            .iter()
            .any(|w| matches!(w.as_str(), "OPENQUERY" | "OPENROWSET" | "OPENDATASOURCE"))
    {
        reasons.push("Runs SQL on another server (OPENQUERY, OPENROWSET or OPENDATASOURCE)".into());
        class.max(StatementClass::Unknown)
    } else {
        class
    };
    StatementAnalysis { sql: span.sql, start: span.start, end: span.end, class, reasons, parsed }
}

fn classify(stmt: &Statement, reasons: &mut Vec<String>) -> StatementClass {
    use StatementClass::*;
    match stmt {
        Statement::Query(q) => classify_query(q, reasons),
        Statement::Explain { analyze, statement, .. } => {
            if *analyze {
                reasons.push("EXPLAIN ANALYZE executes the statement".into());
                classify(statement, reasons)
            } else {
                Read
            }
        }
        Statement::ExplainTable { .. }
        | Statement::ShowFunctions { .. }
        | Statement::ShowVariable { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowCatalogs { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowProcessList { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowCharset(_)
        | Statement::ShowObjects(_)
        | Statement::ShowTables { .. }
        | Statement::ShowViews { .. }
        | Statement::ShowCollation { .. }
        | Statement::Fetch { .. }
        | Statement::Close { .. } => Read,
        Statement::Declare { .. } => Read,
        // MERGE … WHEN NOT MATCHED BY SOURCE THEN DELETE removes every row the source lacks.
        Statement::Merge(m)
            if m.clauses.iter().any(|c| {
                c.clause_kind == MergeClauseKind::NotMatchedBySource && matches!(c.action, MergeAction::Delete { .. })
            }) =>
        {
            reasons.push("MERGE deletes every row the source does not have".into());
            Destructive
        }
        Statement::Insert(_) | Statement::Merge(_) | Statement::LoadData { .. } => {
            reasons.push("Modifies table data".into());
            Write
        }
        Statement::Update(u) => {
            // With FROM and no WHERE, every row of the table is joined, and changed.
            if u.selection.is_none() {
                reasons.push("UPDATE without a WHERE clause changes every row".into());
                Destructive
            } else {
                reasons.push("Modifies table data".into());
                Write
            }
        }
        Statement::Delete(d) => {
            if d.selection.is_none() && d.using.is_none() {
                reasons.push("DELETE without a WHERE clause removes every row".into());
                Destructive
            } else {
                reasons.push("Deletes rows".into());
                Write
            }
        }
        Statement::Copy { source, to, .. } => {
            if *to && matches!(source, CopySource::Query(_) | CopySource::Table { .. }) {
                Read
            } else {
                reasons.push("COPY FROM loads data".into());
                Write
            }
        }
        Statement::Truncate(_) => {
            reasons.push("TRUNCATE removes every row".into());
            Destructive
        }
        Statement::Drop { object_type, .. } => {
            reasons.push(format!("DROP {object_type} permanently removes objects"));
            Destructive
        }
        Statement::DropFunction(_)
        | Statement::DropDomain(_)
        | Statement::DropProcedure { .. }
        | Statement::DropSecret { .. }
        | Statement::DropPolicy(_)
        | Statement::DropConnector { .. }
        | Statement::DropExtension(_)
        | Statement::DropOperator(_)
        | Statement::DropOperatorFamily(_)
        | Statement::DropOperatorClass(_)
        | Statement::DropTrigger(_)
        | Statement::DetachDuckDBDatabase { .. } => {
            reasons.push("DROP permanently removes objects".into());
            Destructive
        }
        Statement::AlterTable(at) => {
            let destructive = at.operations.iter().any(|op| {
                matches!(
                    op,
                    AlterTableOperation::DropColumn { .. }
                        | AlterTableOperation::DropConstraint { .. }
                        | AlterTableOperation::DropPrimaryKey { .. }
                        | AlterTableOperation::DropForeignKey { .. }
                        | AlterTableOperation::DropIndex { .. }
                        | AlterTableOperation::DropPartitions { .. }
                        | AlterTableOperation::DropProjection { .. }
                )
            });
            if destructive {
                reasons.push("ALTER TABLE drops columns, constraints or partitions".into());
                Destructive
            } else {
                reasons.push("Changes table structure".into());
                Ddl
            }
        }
        Statement::StartTransaction { .. }
        | Statement::Commit { .. }
        | Statement::Rollback { .. }
        | Statement::Savepoint { .. }
        | Statement::ReleaseSavepoint { .. } => Transaction,
        Statement::Set(_) | Statement::Use(_) | Statement::Reset(_) | Statement::Discard { .. } => Session,
        Statement::Pragma { .. } => classify_pragma(&stmt.to_string(), reasons),
        Statement::Call(_) | Statement::Execute { .. } => {
            reasons.push("Procedure calls can modify data".into());
            Unknown
        }
        Statement::Kill { .. }
        | Statement::Lock(_)
        | Statement::LockTables { .. }
        | Statement::Vacuum(_)
        | Statement::Analyze(_)
        | Statement::OptimizeTable { .. } => {
            reasons.push("Administrative command".into());
            Write
        }
        Statement::Grant(_)
        | Statement::Deny(_)
        | Statement::Revoke(_)
        | Statement::CreateRole(_)
        | Statement::CreateUser(_)
        | Statement::AlterUser(_)
        | Statement::AlterRole { .. } => {
            reasons.push("Changes privileges or roles".into());
            Ddl
        }
        Statement::CreateTable(ct) => {
            if ct.or_replace {
                reasons.push("CREATE OR REPLACE TABLE drops the existing table".into());
                Destructive
            } else {
                reasons.push("Creates objects".into());
                Ddl
            }
        }
        Statement::RenameTable(_) => {
            reasons.push("Renames tables".into());
            Ddl
        }
        // T-SQL control flow: as strong as the statements it may run.
        Statement::If(s) => {
            let blocks = std::iter::once(&s.if_block).chain(&s.elseif_blocks).chain(&s.else_block);
            classify_blocks(blocks, reasons)
        }
        Statement::While(s) => classify_blocks(std::iter::once(&s.while_block), reasons),
        Statement::Case(s) => classify_blocks(s.when_blocks.iter().chain(&s.else_block), reasons),
        other => {
            let text = other.to_string();
            let head = text.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
            match head.as_str() {
                "CREATE" | "ALTER" | "COMMENT" => {
                    reasons.push("Changes database schema".into());
                    Ddl
                }
                _ => {
                    reasons.push("Statement side effects could not be determined".into());
                    Unknown
                }
            }
        }
    }
}

fn classify_blocks<'a>(
    blocks: impl Iterator<Item = &'a ConditionalStatementBlock>,
    reasons: &mut Vec<String>,
) -> StatementClass {
    blocks.flat_map(|b| b.statements()).map(|s| classify(s, reasons)).max().unwrap_or(StatementClass::Read)
}

fn classify_query(q: &Query, reasons: &mut Vec<String>) -> StatementClass {
    let mut class = StatementClass::Read;
    if let Some(with) = &q.with {
        for cte in &with.cte_tables {
            class = class.max(classify_query(&cte.query, reasons));
        }
    }
    class = class.max(classify_set_expr(&q.body, reasons));
    if !q.locks.is_empty() {
        reasons.push("Row locking clause (FOR UPDATE/SHARE)".into());
        class = class.max(StatementClass::Write);
    }
    class
}

fn classify_set_expr(body: &SetExpr, reasons: &mut Vec<String>) -> StatementClass {
    match body {
        SetExpr::Select(s) => {
            if s.into.is_some() {
                reasons.push("SELECT INTO creates a table".into());
                StatementClass::Ddl
            } else {
                StatementClass::Read
            }
        }
        SetExpr::Query(q) => classify_query(q, reasons),
        SetExpr::SetOperation { left, right, .. } => {
            classify_set_expr(left, reasons).max(classify_set_expr(right, reasons))
        }
        SetExpr::Insert(s) | SetExpr::Update(s) | SetExpr::Delete(s) | SetExpr::Merge(s) => {
            reasons.push("Data-modifying statement inside a query (e.g. in a CTE)".into());
            classify(s, reasons).max(StatementClass::Write)
        }
        _ => StatementClass::Read,
    }
}

/// Used only when the parser cannot handle a statement. Errs on the side of caution.
fn keyword_fallback(sql: &str, reasons: &mut Vec<String>) -> StatementClass {
    let first = first_keyword(sql);
    if first == "PRAGMA" {
        return classify_pragma(sql, reasons);
    }
    reasons.push("The statement could not be parsed; classification is approximate".into());
    match first.as_str() {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "VALUES" | "TABLE" => {
            // A parse failure on a read keyword still might hide side effects; keep it Unknown
            // so confirm-writes and read-only modes treat it conservatively.
            StatementClass::Unknown
        }
        "DROP" | "TRUNCATE" | "DELETE" | "UPDATE" | "ALTER" | "REPLACE" => {
            reasons.push(format!("{first} statements can destroy data"));
            StatementClass::Destructive
        }
        _ => StatementClass::Unknown,
    }
}

/// An unparsed T-SQL statement: destructive when any destructive keyword appears in it outside
/// strings, `[names]` and comments, otherwise unknown.
fn mssql_keyword_fallback(sql: &str, reasons: &mut Vec<String>) -> StatementClass {
    reasons.push("The statement could not be parsed; classification is approximate".into());
    let words = crate::split::mssql_words(sql);
    let repair = words.iter().any(|w| w == "DBCC") && words.iter().any(|w| w.starts_with("REPAIR_"));
    let found = words
        .into_iter()
        .find(|w| {
            matches!(w.as_str(), "DROP" | "TRUNCATE" | "DELETE" | "UPDATE" | "ALTER" | "MERGE" | "RESTORE" | "SHUTDOWN")
        })
        .or(repair.then(|| "DBCC REPAIR".to_string()));
    match found {
        Some(word) => {
            reasons.push(format!("{word} statements can destroy data"));
            StatementClass::Destructive
        }
        None => StatementClass::Unknown,
    }
}

/// SQLite pragmas that only report information, with or without an argument.
const READ_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "database_list",
    "collation_list",
    "function_list",
    "module_list",
    "pragma_list",
    "compile_options",
    "integrity_check",
    "quick_check",
    "page_count",
    "freelist_count",
    "data_version",
];

/// sqlparser rejects pragma arguments that are identifiers, so pragmas are classified
/// here: assignments write; known informational pragmas read; anything else is unknown.
fn classify_pragma(sql: &str, reasons: &mut Vec<String>) -> StatementClass {
    let start = sql.to_ascii_lowercase().find("pragma").map_or(0, |i| i + 6);
    let body = sql[start..].trim();
    let name = body
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let has_arg = body.contains('(');
    if body.contains('=') {
        reasons.push("PRAGMA changes database settings".into());
        StatementClass::Write
    } else if READ_PRAGMAS.contains(&name.as_str())
        || (!has_arg
            && !matches!(name.as_str(), "optimize" | "shrink_memory" | "incremental_vacuum" | "wal_checkpoint"))
    {
        StatementClass::Read
    } else {
        reasons.push(format!("PRAGMA {name} may modify the database"));
        StatementClass::Unknown
    }
}

fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--").or_else(|| rest.strip_prefix('#')) {
            rest = r.find('\n').map_or("", |p| &r[p + 1..]).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.find("*/").map_or("", |p| &r[p + 2..]).trim_start();
        } else {
            break;
        }
    }
    rest.split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase()
}

fn overrides_read_only(sql: &str) -> bool {
    let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    normalized.contains("read write")
        || normalized.contains("read_only")
        || normalized.contains("query_only")
        || normalized.contains("transaction_read_only")
        || normalized.contains("session_authorization")
        || normalized.contains("set role")
}

/// On production, statements that destroy data are confirmed by typing the connection name
/// instead of a click. A mode that never asks (Normal) or always refuses (ReadOnly) is left as is.
pub fn needs_typed_confirmation(
    statements: &[StatementAnalysis],
    mode: SafetyMode,
    environment: crate::config::Environment,
) -> bool {
    environment == crate::config::Environment::Production
        && matches!(mode, SafetyMode::ConfirmDestructive | SafetyMode::ConfirmWrites)
        && statements.iter().any(|s| s.class == StatementClass::Destructive)
}

pub fn decide(statements: &[StatementAnalysis], mode: SafetyMode) -> PolicyDecision {
    use StatementClass::*;
    match mode {
        SafetyMode::Normal => PolicyDecision::Allow,
        SafetyMode::ReadOnly => {
            for s in statements {
                let blocked = match s.class {
                    Read => false,
                    Transaction | Session => overrides_read_only(&s.sql),
                    _ => true,
                };
                if blocked {
                    let why = s.reasons.first().cloned().unwrap_or_else(|| "Not a read-only statement".into());
                    return PolicyDecision::Block {
                        reason: format!("This connection is read-only. {why}: {}", truncate(&s.sql, 120)),
                    };
                }
            }
            PolicyDecision::Allow
        }
        SafetyMode::ConfirmDestructive | SafetyMode::ConfirmWrites => {
            let threshold = |c: StatementClass| match mode {
                SafetyMode::ConfirmDestructive => c == Destructive,
                _ => matches!(c, Write | Ddl | Unknown | Destructive),
            };
            let reasons: Vec<String> = statements
                .iter()
                .filter(|s| threshold(s.class))
                .map(|s| {
                    let why = s.reasons.first().cloned().unwrap_or_default();
                    format!("{why}: {}", truncate(&s.sql, 120))
                })
                .collect();
            if reasons.is_empty() { PolicyDecision::Allow } else { PolicyDecision::Confirm { reasons } }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!("{}…", one_line.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatementClass::*;

    fn class(sql: &str) -> StatementClass {
        analyze_statement(sql, Dialect::Postgres).class
    }

    #[test]
    fn classifies_reads() {
        assert_eq!(class("select * from users where id = 1"), Read);
        assert_eq!(class("with x as (select 1) select * from x"), Read);
        assert_eq!(class("explain select 1"), Read);
        assert_eq!(class("select 1 union select 2"), Read);
    }

    #[test]
    fn detects_writes_hidden_in_ctes_and_explain_analyze() {
        assert_eq!(class("with d as (delete from t where id = 1 returning *) select * from d"), Write);
        assert_eq!(class("with d as (delete from t returning *) select * from d"), Destructive);
        assert_eq!(class("explain analyze delete from t"), Destructive);
        assert_eq!(class("select * from t for update"), Write);
    }

    #[test]
    fn classifies_destructive_statements() {
        assert_eq!(class("drop table users"), Destructive);
        assert_eq!(class("truncate users"), Destructive);
        assert_eq!(class("delete from users"), Destructive);
        assert_eq!(class("update users set a = 1"), Destructive);
        assert_eq!(class("alter table users drop column email"), Destructive);
        assert_eq!(class("update users set a = 1 where id = 2"), Write);
        assert_eq!(class("delete from users where id = 2"), Write);
        assert_eq!(class("alter table users add column x int"), Ddl);
        assert_eq!(class("create table t (id int)"), Ddl);
    }

    #[test]
    fn sql_server_batches() {
        let class = |sql: &str| {
            let a = analyze_script(sql, Dialect::Mssql, SafetyMode::ConfirmDestructive);
            assert_eq!(a.statements.len(), 1, "{sql}: one batch");
            a.statements[0].class
        };
        assert_eq!(class("SELECT TOP 10 * FROM t WITH (NOLOCK)"), Read);
        assert_eq!(class("DECLARE @x int = 1;\nSELECT @x;"), Read);
        assert_eq!(class("SELECT a INTO #t FROM x"), Ddl);
        assert_eq!(class("EXEC sp_who"), Unknown);
        assert_eq!(class("EXEC('DELETE FROM t')"), Unknown);
        // Blocks are classified by what they contain.
        assert_eq!(class("IF EXISTS (SELECT 1 FROM t) BEGIN DELETE FROM t END"), Destructive);
        assert_eq!(class("IF @x = 1 SELECT 1 ELSE SELECT 2"), Read);
        assert_eq!(class("WHILE @i < 3 BEGIN UPDATE t SET a = 1 WHERE id = @i; SET @i = @i + 1; END"), Write);
        // Unparsed (the parser wants `;` before END), the UPDATE keyword makes it destructive: cautious.
        assert_eq!(class("WHILE @i < 3 BEGIN UPDATE t SET a = 1 WHERE id = @i; SET @i += 1 END"), Destructive);
        // A batch the parser can't read is judged by every statement in it, not its first word.
        assert_eq!(class("SELECT 1\nDELETE FROM t"), Destructive);
        assert_eq!(class("SELECT 1; SELECT * FROM OPENROWSET(BULK 'x', SINGLE_CLOB) AS x; DROP TABLE t"), Destructive);
        assert_eq!(class("BEGIN TRY SELECT 1/0 END TRY BEGIN CATCH SELECT ERROR_MESSAGE() END CATCH"), Unknown);
        assert_eq!(class("SELECT [update], 'DELETE' FROM t -- DROP\nSELECT 2 FROM OPENJSON(@j)"), Unknown);
        assert_eq!(class("DELETE TOP (10) FROM t"), Destructive);
        // Found in review: each ran without a prompt under ConfirmDestructive.
        assert_eq!(class("UPDATE t SET v = 1 FROM t"), Destructive, "a join without WHERE changes every row");
        assert_eq!(class("UPDATE t SET v = 1 FROM t JOIN s ON s.id = t.id WHERE s.x = 1"), Write);
        assert_eq!(
            class("MERGE t USING s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE;"),
            Destructive,
            "deletes every row the source lacks"
        );
        assert_eq!(class("RESTORE DATABASE x FROM DISK = 'y' WITH REPLACE"), Destructive);
        assert_eq!(class("SHUTDOWN WITH NOWAIT"), Destructive);
        assert_eq!(class("DBCC CHECKDB (x, REPAIR_ALLOW_DATA_LOSS)"), Destructive);
        assert_eq!(class("DBCC CHECKDB"), Unknown);
        // Pass-through queries run on another server, whatever the outer SELECT says.
        assert_eq!(class("SELECT * FROM OPENQUERY(lnk, 'DELETE FROM t')"), Unknown);

        let ro = |sql: &str| {
            decide(&analyze_script(sql, Dialect::Mssql, SafetyMode::ReadOnly).statements, SafetyMode::ReadOnly)
        };
        assert_eq!(ro("SET NOCOUNT ON;\nDECLARE @x int = 1;\nSELECT @x"), PolicyDecision::Allow);
        assert!(matches!(ro("IF 1 = 1 BEGIN DELETE FROM t END"), PolicyDecision::Block { .. }));
        assert!(matches!(ro("EXEC sp_who"), PolicyDecision::Block { .. }));
        assert!(matches!(ro("SELECT 1\nGO\nUPDATE t SET a = 1 WHERE id = 1"), PolicyDecision::Block { .. }));
    }

    #[test]
    fn mysql_and_sqlite_specifics() {
        let a = analyze_statement("SHOW TABLES", Dialect::Mysql);
        assert_eq!(a.class, Read);
        let a = analyze_statement("PRAGMA table_info(t)", Dialect::Sqlite);
        assert_eq!(a.class, Read);
        let a = analyze_statement("PRAGMA journal_mode = WAL", Dialect::Sqlite);
        assert_eq!(a.class, Write);
        assert_eq!(analyze_statement("pragma main.index_list(t)", Dialect::Sqlite).class, Read);
        assert_eq!(analyze_statement("PRAGMA user_version", Dialect::Sqlite).class, Read);
        assert_eq!(analyze_statement("PRAGMA optimize", Dialect::Sqlite).class, Unknown);
        assert_eq!(analyze_statement("PRAGMA wal_checkpoint(TRUNCATE)", Dialect::Sqlite).class, Unknown);
    }

    #[test]
    fn unparseable_statements_are_conservative() {
        let a = analyze_statement("DROP SOMETHING WEIRD !!", Dialect::Postgres);
        assert!(!a.parsed);
        assert_eq!(a.class, Destructive);
        let a = analyze_statement("FROBNICATE everything", Dialect::Postgres);
        assert_eq!(a.class, Unknown);
    }

    #[test]
    fn comments_do_not_hide_statements() {
        assert_eq!(class("/* harmless */ drop table x"), Destructive);
        assert_eq!(class("-- select\ndelete from x"), Destructive);
    }

    #[test]
    fn production_asks_for_the_name_before_destroying_data() {
        use crate::config::Environment::{Local, Production};
        let a = |sql: &str| analyze_script(sql, Dialect::Postgres, SafetyMode::ConfirmDestructive).statements;
        let typed = |sql: &str, mode, env| needs_typed_confirmation(&a(sql), mode, env);
        for sql in ["drop table t", "truncate t", "delete from t", "update t set a = 1", "select 1; drop table t"] {
            assert!(typed(sql, SafetyMode::ConfirmDestructive, Production), "{sql}");
            assert!(typed(sql, SafetyMode::ConfirmWrites, Production), "{sql}");
        }
        assert!(!typed("delete from t where id = 1", SafetyMode::ConfirmWrites, Production));
        assert!(!typed("insert into t values (1)", SafetyMode::ConfirmWrites, Production));
        assert!(!typed("drop table t", SafetyMode::ConfirmDestructive, Local));
        // Normal never asks; read-only refuses.
        assert!(!typed("drop table t", SafetyMode::Normal, Production));
        assert!(!typed("drop table t", SafetyMode::ReadOnly, Production));
    }

    #[test]
    fn policy_decisions() {
        let script = "select 1; delete from t where id = 1; drop table t";
        let a = analyze_script(script, Dialect::Postgres, SafetyMode::Normal);
        assert_eq!(a.decision, PolicyDecision::Allow);

        let a = analyze_script(script, Dialect::Postgres, SafetyMode::ConfirmDestructive);
        match a.decision {
            PolicyDecision::Confirm { reasons } => {
                assert_eq!(reasons.len(), 1);
                assert!(reasons[0].contains("drop table t"));
            }
            d => panic!("{d:?}"),
        }

        let a = analyze_script(script, Dialect::Postgres, SafetyMode::ConfirmWrites);
        assert!(matches!(a.decision, PolicyDecision::Confirm { ref reasons } if reasons.len() == 2));

        let a = analyze_script(script, Dialect::Postgres, SafetyMode::ReadOnly);
        assert!(matches!(a.decision, PolicyDecision::Block { .. }));

        let a = analyze_script("select 1; select 2", Dialect::Postgres, SafetyMode::ReadOnly);
        assert_eq!(a.decision, PolicyDecision::Allow);
    }

    #[test]
    fn read_only_blocks_session_overrides() {
        for sql in [
            "begin read write",
            "set transaction read write",
            "set default_transaction_read_only = off",
            "SET SESSION TRANSACTION READ WRITE",
            "set role admin",
        ] {
            let a = analyze_script(sql, Dialect::Postgres, SafetyMode::ReadOnly);
            assert!(matches!(a.decision, PolicyDecision::Block { .. }), "{sql}");
        }
        let a = analyze_script("begin; select 1; commit", Dialect::Postgres, SafetyMode::ReadOnly);
        assert_eq!(a.decision, PolicyDecision::Allow);
        let a = analyze_script("set search_path to app", Dialect::Postgres, SafetyMode::ReadOnly);
        assert_eq!(a.decision, PolicyDecision::Allow);
    }
}
