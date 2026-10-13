//! Dialect-aware SQL script splitting.
//!
//! Splits on top-level `;` while respecting string literals, quoted identifiers,
//! comments, PostgreSQL dollar-quoting and MySQL `#` comments. Each statement keeps its
//! byte offset in the original text so server error positions can be mapped back.

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
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut stmt_start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' => i = skip_quoted(bytes, i, b'\'', dialect == Dialect::Mysql),
            b'"' => i = skip_quoted(bytes, i, b'"', dialect == Dialect::Mysql),
            b'`' if dialect != Dialect::Postgres => i = skip_quoted(bytes, i, b'`', false),
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
    let spans = split_statements(input, dialect);
    spans
        .iter()
        .find(|s| cursor >= s.start && cursor <= s.end)
        .or_else(|| spans.iter().rev().find(|s| s.end <= cursor))
        .or_else(|| spans.first())
        .cloned()
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
        for s in ["select 'abc", "select $$ x", "/* open", "select \"x", "$", "$a", "--"] {
            let _ = split_statements(s, Dialect::Postgres);
            let _ = split_statements(s, Dialect::Mysql);
        }
    }
}
