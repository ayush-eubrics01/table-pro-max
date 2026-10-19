//! Dialect-aware SQL script splitting.
//!
//! Splits on top-level `;` while respecting string literals, quoted identifiers,
//! comments, PostgreSQL dollar-quoting and MySQL `#` comments. Each statement keeps its
//! byte offset in the original text so server error positions can be mapped back.
//!
//! SQL Server scripts run as batches separated by `GO` lines, as in SSMS: variables, `IF … BEGIN
//! … END` blocks and procedure bodies all span `;`. The statement at the cursor is finer: the
//! top-level `;`-statement within its batch, with blocks and procedure bodies kept whole.

use serde::Serialize;

use crate::dialect::Dialect;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementSpan {
    /// Statement text, trimmed, without the trailing semicolon.
    pub sql: String,
    /// Byte offset of the first character of `sql` in the input.
    pub start: usize,
    /// Byte offset just past the end of `sql` in the input.
    pub end: usize,
}

pub fn split_statements(input: &str, dialect: Dialect) -> Vec<StatementSpan> {
    if dialect == Dialect::Mssql {
        return mssql_batches(input);
    }
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut stmt_start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' => i = skip_quoted(bytes, i, b'\'', dialect == Dialect::Mysql),
            b'"' => i = skip_quoted(bytes, i, b'"', dialect == Dialect::Mysql),
            b'`' if matches!(dialect, Dialect::Mysql | Dialect::Sqlite) => i = skip_quoted(bytes, i, b'`', false),
            b'[' if dialect == Dialect::Sqlite => {
                i = bytes[i..].iter().position(|&c| c == b']').map_or(bytes.len(), |p| i + p + 1)
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => i = skip_line(bytes, i),
            b'#' if dialect == Dialect::Mysql => i = skip_line(bytes, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = skip_block_comment(bytes, i, dialect == Dialect::Postgres),
            b'$' if dialect == Dialect::Postgres => i = skip_dollar_quote(bytes, i),
            b';' => {
                push_span(input, stmt_start, i, &mut out);
                i += 1;
                stmt_start = i;
            }
            _ => i += 1,
        }
    }
    push_span(input, stmt_start, bytes.len(), &mut out);
    out
}

/// Returns the statement containing byte offset `cursor` (or the closest preceding one).
pub fn statement_at(input: &str, dialect: Dialect, cursor: usize) -> Option<StatementSpan> {
    let spans = if dialect == Dialect::Mssql {
        mssql_batches(input).iter().flat_map(|b| mssql_statements(input, b.start, b.end)).collect()
    } else {
        split_statements(input, dialect)
    };
    spans
        .iter()
        .find(|s| cursor >= s.start && cursor <= s.end)
        .or_else(|| spans.iter().rev().find(|s| s.end <= cursor))
        .or_else(|| spans.first())
        .cloned()
}

/// Skips a T-SQL string, quoted name, `[bracketed]` name or comment starting at `i`.
fn mssql_skip(bytes: &[u8], i: usize) -> Option<usize> {
    match bytes[i] {
        b'\'' => Some(skip_quoted(bytes, i, b'\'', false)),
        b'"' => Some(skip_quoted(bytes, i, b'"', false)),
        b'[' => Some(skip_quoted(bytes, i, b']', false)),
        b'-' if bytes.get(i + 1) == Some(&b'-') => Some(skip_line(bytes, i)),
        b'/' if bytes.get(i + 1) == Some(&b'*') => Some(skip_block_comment(bytes, i, true)),
        _ => None,
    }
}

fn is_word_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'@' | b'#' | b'$') || c >= 0x80
}

/// Letters and digits in any script, and `_ @ # $`. Anything else separates words, including
/// the non-breaking and other Unicode spaces SQL Server reads as blanks (pasted SQL has them).
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '@' | '#' | '$')
}

/// The character at byte `i`, which callers keep on a character boundary.
fn char_at(s: &str, i: usize) -> char {
    s[i..].chars().next().unwrap_or(' ')
}

/// Where the word starting at `i` ends.
fn word_end(s: &str, mut i: usize, to: usize) -> usize {
    while i < to {
        let c = char_at(s, i);
        if !is_word_char(c) {
            break;
        }
        i += c.len_utf8();
    }
    i.min(to)
}

/// Most times `GO n` repeats a batch; a larger count is left to the server to refuse.
const MAX_GO_COUNT: usize = 1000;

/// A `GO` line starting at `i` (the line's first non-blank byte): `GO`, an optional count
/// (`GO 5` runs the batch five times), then only blanks or a `--` comment. Returns where the next
/// line starts and the count.
fn go_line(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    if !bytes[i..].get(..2).is_some_and(|w| w.eq_ignore_ascii_case(b"go")) {
        return None;
    }
    let mut j = i + 2;
    if bytes.get(j).is_some_and(|&c| is_word_byte(c)) {
        return None;
    }
    let blanks = |j: &mut usize| {
        while *j < bytes.len() && matches!(bytes[*j], b' ' | b'\t' | b'\r') {
            *j += 1;
        }
    };
    blanks(&mut j);
    let digits = bytes[j..].iter().take_while(|c| c.is_ascii_digit()).count();
    let count = if digits == 0 {
        1
    } else {
        let n: usize = std::str::from_utf8(&bytes[j..j + digits]).ok()?.parse().ok()?;
        if !(1..=MAX_GO_COUNT).contains(&n) || bytes.get(j + digits).is_some_and(|&c| is_word_byte(c)) {
            return None;
        }
        j += digits;
        blanks(&mut j);
        n
    };
    let next = match bytes.get(j) {
        None => j,
        Some(b'\n') => j + 1,
        Some(b'-') if bytes.get(j + 1) == Some(&b'-') => skip_line(bytes, j),
        _ => return None,
    };
    Some((next, count))
}

fn mssql_batches(input: &str) -> Vec<StatementSpan> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i, mut line_start) = (0, 0, true);
    while i < bytes.len() {
        if line_start && let Some((next, count)) = go_line(bytes, i) {
            let before = out.len();
            push_span(input, start, i, &mut out);
            // `GO n`: the batch runs n times, each run a statement of its own.
            if let Some(batch) = out.get(before).cloned() {
                out.extend(std::iter::repeat_n(batch, count - 1));
            }
            (start, i) = (next, next);
            continue;
        }
        if let Some(j) = mssql_skip(bytes, i) {
            line_start = bytes[j - 1] == b'\n';
            i = j;
            continue;
        }
        match bytes[i] {
            b'\n' => line_start = true,
            c if !c.is_ascii_whitespace() => line_start = false,
            _ => {}
        }
        i += 1;
    }
    push_span(input, start, bytes.len(), &mut out);
    out
}

/// The next word at or after `i`, upper-cased (blanks and comments skipped).
fn word_after(input: &str, mut i: usize, to: usize) -> String {
    let bytes = input.as_bytes();
    while i < to {
        let c = char_at(input, i);
        if matches!(bytes[i], b'-' | b'/')
            && let Some(j) = mssql_skip(bytes, i)
        {
            i = j.min(to);
        } else if c.is_whitespace() || (!c.is_ascii() && !is_word_char(c)) {
            i += c.len_utf8();
        } else {
            break;
        }
    }
    input[i..word_end(input, i, to)].to_ascii_uppercase()
}

/// A statement SQL Server only takes as the first in its batch (CREATE VIEW, PROCEDURE, FUNCTION,
/// TRIGGER, SCHEMA …): nothing may be put before or after it in the same batch.
pub(crate) fn starts_batch_object(sql: &str) -> bool {
    let words = leading_words(sql, 0, sql.len());
    let kind = match words.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["CREATE", "OR", "ALTER", k, ..] | ["CREATE", k, ..] | ["ALTER", k, ..] => k.to_string(),
        _ => return false,
    };
    matches!(kind.as_str(), "PROC" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "VIEW" | "SCHEMA" | "DEFAULT" | "RULE")
}

/// The first four words from `start`, upper-cased, skipping comments.
fn leading_words(input: &str, start: usize, to: usize) -> Vec<String> {
    let mut words = Vec::new();
    let mut i = start;
    let bytes = input.as_bytes();
    while i < to && words.len() < 4 {
        if let Some(j) = mssql_skip(bytes, i) {
            i = j;
        } else if is_word_char(char_at(input, i)) {
            let end = word_end(input, i, to);
            words.push(input[i..end].to_ascii_uppercase());
            i = end;
        } else {
            i += char_at(input, i).len_utf8();
        }
    }
    words
}

/// CREATE [OR ALTER] or ALTER of a procedure, function or trigger: its body runs to the batch end.
fn starts_module(input: &str, start: usize, to: usize) -> bool {
    let words = leading_words(input, start, to);
    let kind = match words.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["CREATE", "OR", "ALTER", k, ..] | ["CREATE", k, ..] | ["ALTER", k, ..] => k.to_string(),
        _ => return false,
    };
    matches!(kind.as_str(), "PROC" | "PROCEDURE" | "FUNCTION" | "TRIGGER")
}

/// The top-level `;`-statements of one T-SQL batch (blocks and procedure bodies kept whole).
pub(crate) fn mssql_statement_spans(batch: &str) -> Vec<StatementSpan> {
    mssql_statements(batch, 0, batch.len())
}

/// The upper-cased words of T-SQL text outside strings, quoted and `[bracketed]` names and comments.
pub(crate) fn mssql_words(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let (mut words, mut i) = (Vec::new(), 0);
    while i < bytes.len() {
        if let Some(j) = mssql_skip(bytes, i) {
            i = j;
        } else if is_word_char(char_at(sql, i)) {
            let end = word_end(sql, i, bytes.len());
            words.push(sql[i..end].to_ascii_uppercase());
            i = end;
        } else {
            i += char_at(sql, i).len_utf8();
        }
    }
    words
}

/// The top-level `;`-statements of the batch `input[from..to]`.
fn mssql_statements(input: &str, from: usize, to: usize) -> Vec<StatementSpan> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i, mut depth) = (from, from, 0usize);
    let mut module: Option<bool> = None;
    while i < to {
        if let Some(j) = mssql_skip(bytes, i) {
            i = j.min(to);
            continue;
        }
        let b = bytes[i];
        if is_word_char(char_at(input, i)) {
            let end = word_end(input, i, to);
            let after_dot = i > 0 && bytes[i - 1] == b'.';
            if !after_dot {
                if module.is_none() {
                    module = Some(starts_module(input, start, to));
                }
                match input[i..end].to_ascii_uppercase().as_str() {
                    // BEGIN TRAN and friends are statements, not blocks.
                    "BEGIN" => {
                        let next = word_after(input, end, to);
                        if !matches!(next.as_str(), "TRAN" | "TRANSACTION" | "DISTRIBUTED" | "DIALOG" | "CONVERSATION")
                        {
                            depth += 1;
                        }
                    }
                    "CASE" => depth += 1,
                    "END" if word_after(input, end, to) != "CONVERSATION" => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            i = end;
            continue;
        }
        if b == b';' && depth == 0 && module != Some(true) {
            push_span(input, start, i, &mut out);
            i += 1;
            (start, module) = (i, None);
            continue;
        }
        i += char_at(input, i).len_utf8();
    }
    push_span(input, start, to, &mut out);
    out
}

fn push_span(input: &str, start: usize, end: usize, out: &mut Vec<StatementSpan>) {
    let raw = &input[start..end];
    let trimmed_start = raw.len() - raw.trim_start().len();
    let sql = raw.trim();
    if sql.is_empty() || is_only_comments(sql) {
        return;
    }
    let s = start + trimmed_start;
    out.push(StatementSpan { sql: sql.to_string(), start: s, end: s + sql.len() });
}

fn is_only_comments(sql: &str) -> bool {
    let mut rest = sql.trim_start();
    loop {
        if rest.is_empty() {
            return true;
        }
        if let Some(r) = rest.strip_prefix("--").or_else(|| rest.strip_prefix('#')) {
            rest = r.find('\n').map_or("", |p| &r[p + 1..]).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            match r.find("*/") {
                Some(p) => rest = r[p + 2..].trim_start(),
                None => return true,
            }
        } else {
            return false;
        }
    }
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8, backslash_escapes: bool) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        let c = bytes[i];
        if backslash_escapes && c == b'\\' {
            i += 2;
            continue;
        }
        if c == quote {
            if bytes.get(i + 1) == Some(&quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn skip_line(bytes: &[u8], start: usize) -> usize {
    bytes[start..].iter().position(|&c| c == b'\n').map_or(bytes.len(), |p| start + p + 1)
}

fn skip_block_comment(bytes: &[u8], start: usize, nested: bool) -> usize {
    let mut depth = 1;
    let mut i = start + 2;
    while i < bytes.len() {
        if nested && bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            depth += 1;
            i += 2;
        } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    bytes.len()
}

/// Skips `$tag$ ... $tag$`. A `$` not starting a valid tag (e.g. `$1`) is skipped alone.
fn skip_dollar_quote(bytes: &[u8], start: usize) -> usize {
    let mut j = start + 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] >= 0x80) {
        j += 1;
    }
    let tag_ok =
        j < bytes.len() && bytes[j] == b'$' && !bytes[start + 1..j].first().is_some_and(|c| c.is_ascii_digit());
    if !tag_ok {
        return start + 1;
    }
    let tag = &bytes[start..=j];
    let body = j + 1;
    bytes[body..].windows(tag.len()).position(|w| w == tag).map_or(bytes.len(), |p| body + p + tag.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(input: &str, d: Dialect) -> Vec<String> {
        split_statements(input, d).into_iter().map(|s| s.sql).collect()
    }

    #[test]
    fn splits_simple_scripts() {
        assert_eq!(sqls("select 1; select 2;\n\n", Dialect::Postgres), ["select 1", "select 2"]);
        assert_eq!(sqls("  ;; select 1  ", Dialect::Postgres), ["select 1"]);
    }

    #[test]
    fn respects_strings_and_comments() {
        let s = "insert into t values ('a;b', \"c;d\"); -- x; y\nselect 1 /* ; */; select ';'";
        assert_eq!(
            sqls(s, Dialect::Postgres),
            ["insert into t values ('a;b', \"c;d\")", "-- x; y\nselect 1 /* ; */", "select ';'"]
        );
        assert_eq!(sqls("select 'it''s; fine'; select 2", Dialect::Sqlite), ["select 'it''s; fine'", "select 2"]);
    }

    #[test]
    fn handles_dollar_quotes() {
        let s = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql; select $1;select 2";
        let v = sqls(s, Dialect::Postgres);
        assert_eq!(v.len(), 3);
        assert!(v[0].ends_with("language plpgsql"));
        let s = "do $body$ begin perform 1; end $body$; select 1";
        assert_eq!(sqls(s, Dialect::Postgres).len(), 2);
    }

    #[test]
    fn mysql_specifics() {
        let s = "select 'a\\';b'; # comment; here\nselect `x;y` from t";
        assert_eq!(sqls(s, Dialect::Mysql), ["select 'a\\';b'", "# comment; here\nselect `x;y` from t"]);
    }

    #[test]
    fn drops_comment_only_fragments_and_tracks_offsets() {
        let s = "select 1;\n-- trailing comment\n";
        assert_eq!(sqls(s, Dialect::Postgres), ["select 1"]);
        let s = "  select 1 ;  select 2";
        let spans = split_statements(s, Dialect::Postgres);
        assert_eq!(&s[spans[1].start..spans[1].end], "select 2");
        assert_eq!(&s[spans[0].start..spans[0].end], "select 1");
    }

    #[test]
    fn finds_statement_at_cursor() {
        let s = "select 1;\nselect 2;\nselect 3";
        assert_eq!(statement_at(s, Dialect::Postgres, 12).unwrap().sql, "select 2");
        assert_eq!(statement_at(s, Dialect::Postgres, 9).unwrap().sql, "select 1");
        assert_eq!(statement_at(s, Dialect::Postgres, s.len()).unwrap().sql, "select 3");
    }

    #[test]
    fn unterminated_constructs_do_not_panic() {
        for s in ["select 'abc", "select $$ x", "/* open", "select \"x", "$", "$a", "--", "[open", "begin", "go"] {
            let _ = split_statements(s, Dialect::Postgres);
            let _ = split_statements(s, Dialect::Mysql);
            let _ = split_statements(s, Dialect::Mssql);
            let _ = statement_at(s, Dialect::Mssql, s.len());
        }
    }

    #[test]
    fn sql_server_runs_batches_split_on_go() {
        let s = "DECLARE @x int = 1;\nSELECT @x;\nGO\nselect 'GO;'\n  go  \n/* GO\n /* nested */ GO\n*/ SELECT [a;b]]] FROM t; -- ;\n\
                 go -- next\nCREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\n-- only a comment\nGO";
        assert_eq!(
            sqls(s, Dialect::Mssql),
            [
                "DECLARE @x int = 1;\nSELECT @x;",
                "select 'GO;'",
                "/* GO\n /* nested */ GO\n*/ SELECT [a;b]]] FROM t; -- ;",
                "CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END",
            ]
        );
        // GO is a whole line; a column or table called go is not a separator.
        assert_eq!(sqls("SELECT go FROM t\nGO", Dialect::Mssql), ["SELECT go FROM t"]);
        assert_eq!(sqls("SELECT 1\nGOTO done", Dialect::Mssql), ["SELECT 1\nGOTO done"]);
        let spans = split_statements("SELECT 1\nGO\n  SELECT 2", Dialect::Mssql);
        assert_eq!(&"SELECT 1\nGO\n  SELECT 2"[spans[1].start..spans[1].end], "SELECT 2");
    }

    #[test]
    fn sql_server_go_n_runs_the_batch_n_times() {
        let s = "INSERT INTO t VALUES (1)\nGO 3\nSELECT 1\n  go 2 -- twice\nSELECT 2";
        assert_eq!(
            sqls(s, Dialect::Mssql),
            [
                "INSERT INTO t VALUES (1)",
                "INSERT INTO t VALUES (1)",
                "INSERT INTO t VALUES (1)",
                "SELECT 1",
                "SELECT 1",
                "SELECT 2"
            ]
        );
        // The repeats point at the same text (error positions and the editor's highlight).
        let spans = split_statements(s, Dialect::Mssql);
        assert_eq!((spans[1].start, spans[1].end), (spans[0].start, spans[0].end));
        // GO 1 is a plain GO; a count of 0, over 1,000 or not a number isn't a separator, so the
        // server reports it instead of a typo running a batch a million times.
        assert_eq!(sqls("SELECT 1\nGO 1", Dialect::Mssql), ["SELECT 1"]);
        for bad in ["GO 0", "GO 1001", "GO x", "GO 3x"] {
            assert_eq!(sqls(&format!("SELECT 1\n{bad}"), Dialect::Mssql), [format!("SELECT 1\n{bad}")], "{bad}");
        }
    }

    #[test]
    fn sql_server_statement_at_cursor_keeps_blocks_whole() {
        let s = "DECLARE @x int = 1;\nIF @x = 1 BEGIN\n  UPDATE t SET a = 1;\n  \
                 SELECT CASE WHEN a = 1 THEN 'x' END FROM t;\nEND;\nSELECT 2\nGO\n\
                 CREATE OR ALTER PROC p AS SELECT 1; SELECT 2;\nGO\nBEGIN TRAN; DELETE FROM t; COMMIT";
        let at = |needle: &str| statement_at(s, Dialect::Mssql, s.find(needle).unwrap() + 1).unwrap().sql;
        assert_eq!(at("DECLARE"), "DECLARE @x int = 1");
        assert_eq!(
            at("UPDATE"),
            "IF @x = 1 BEGIN\n  UPDATE t SET a = 1;\n  SELECT CASE WHEN a = 1 THEN 'x' END FROM t;\nEND"
        );
        assert_eq!(at("SELECT 2\nGO"), "SELECT 2");
        assert_eq!(at("PROC p"), "CREATE OR ALTER PROC p AS SELECT 1; SELECT 2;");
        assert_eq!(at("DELETE"), "DELETE FROM t");
        assert_eq!(at("COMMIT"), "COMMIT");
        // A comment between BEGIN and TRAN still makes it a statement, not a block.
        assert_eq!(
            mssql_words("SELECT 1;\u{a0}COMMIT;\u{3000}SET\u{a0}ROWCOUNT 1 -- é\n[x y] N'z' é1"),
            ["SELECT", "1", "COMMIT", "SET", "ROWCOUNT", "1", "N", "é1"]
        );
        let nb = "BEGIN\u{a0}TRAN; DELETE FROM t WHERE id = 1; SELECT 1";
        assert_eq!(statement_at(nb, Dialect::Mssql, nb.len()).unwrap().sql, "SELECT 1");
        let c = "BEGIN /*c*/ TRAN; DELETE FROM t WHERE id = 1; COMMIT; SELECT 1";
        assert_eq!(statement_at(c, Dialect::Mssql, c.len()).unwrap().sql, "SELECT 1");
        let spans_ok = statement_at(s, Dialect::Mssql, s.find("DELETE").unwrap()).unwrap();
        assert_eq!(&s[spans_ok.start..spans_ok.end], "DELETE FROM t");
    }
}
