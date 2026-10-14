//! Large values on demand: which columns an opened table leaves out of its page query, and
//! how query results show long text. See docs/superpowers/specs/2026-10-14-large-values-design.md.

use crate::config::Driver;
use crate::model::{Cell, ColumnMeta, Row, TableStructure};

/// Characters of a long text value shown in a query result before it is opened.
pub const PREVIEW_CHARS: usize = 80;

pub fn defer_by_default(driver: Driver, data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    match driver {
        Driver::Postgres => {
            t.ends_with("[]")
                || matches!(t.as_str(), "text" | "character varying" | "json" | "jsonb" | "xml" | "bytea" | "tsvector")
        }
        Driver::Duckdb => {
            t.ends_with("[]")
                || matches!(t.as_str(), "varchar" | "text" | "json" | "blob" | "bytea")
                || ["struct", "map", "union", "list"].iter().any(|p| t.starts_with(p))
        }
        Driver::Mysql | Driver::Mariadb => {
            let base = t.split(['(', ' ']).next().unwrap_or("");
            matches!(base, "text" | "mediumtext" | "longtext" | "json" | "blob" | "mediumblob" | "longblob")
        }
        Driver::Sqlite => {
            t.is_empty() || matches!(t.as_str(), "text" | "blob" | "json" | "clob" | "mediumtext" | "longtext")
        }
        Driver::Redis => false,
    }
}

pub fn deferred_columns(driver: Driver, s: &TableStructure, load: &[String], defer: &[String]) -> Vec<bool> {
    if s.primary_key().is_empty() {
        // Without a key a value can't be fetched back for one row: load everything, as before.
        return vec![false; s.columns.len()];
    }
    s.columns
        .iter()
        .map(|c| {
            if c.primary_key.is_some() {
                false
            } else if defer.contains(&c.name) {
                true
            } else if load.contains(&c.name) {
                false
            } else {
                defer_by_default(driver, &c.data_type)
            }
        })
        .collect()
}

pub fn expand_deferred(
    s: &TableStructure,
    deferred: &[bool],
    loaded_cols: Vec<ColumnMeta>,
    rows: Vec<Row>,
) -> (Vec<ColumnMeta>, Vec<Row>) {
    let mut loaded = loaded_cols.into_iter();
    let columns = s
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if deferred.get(i).copied().unwrap_or(false) {
                ColumnMeta::deferred(c.name.clone(), c.data_type.clone())
            } else {
                loaded.next().unwrap_or_else(|| ColumnMeta::new(c.name.clone(), c.data_type.clone()))
            }
        })
        .collect();
    let rows = rows
        .into_iter()
        .map(|r| {
            let mut vals = r.into_iter();
            (0..s.columns.len())
                .map(|i| {
                    if deferred.get(i).copied().unwrap_or(false) {
                        Cell::NotLoaded
                    } else {
                        vals.next().unwrap_or(Cell::Null)
                    }
                })
                .collect()
        })
        .collect();
    (columns, rows)
}

pub fn preview_cell(c: &Cell, over: usize) -> Cell {
    if let Cell::Text(t) = c
        && t.len() > over
    {
        let length = t.chars().count();
        if length > over {
            return Cell::Partial { preview: t.chars().take(PREVIEW_CHARS).collect(), length: length as u64 };
        }
    }
    c.clone()
}

pub fn preview_rows(rows: &[Row], over: usize) -> Vec<Row> {
    rows.iter().map(|r| r.iter().map(|c| preview_cell(c, over)).collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnInfo, ObjectKind};

    fn col(name: &str, ty: &str, pk: Option<u32>) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: pk.is_none(),
            default: None,
            primary_key: pk,
            auto_increment: false,
            comment: None,
        }
    }
    fn table(cols: Vec<ColumnInfo>) -> TableStructure {
        TableStructure {
            schema: "public".into(),
            name: "docs".into(),
            kind: ObjectKind::Table,
            columns: cols,
            ..Default::default()
        }
    }

    #[test]
    fn unbounded_types_are_deferred_per_engine() {
        for t in ["text", "character varying", "json", "jsonb", "xml", "bytea", "tsvector", "integer[]", "TEXT"] {
            assert!(defer_by_default(Driver::Postgres, t), "pg {t}");
        }
        for t in ["character varying(255)", "character(1)", "integer", "uuid", "timestamp with time zone", "mood"] {
            assert!(!defer_by_default(Driver::Postgres, t), "pg {t}");
        }
        for t in ["VARCHAR", "JSON", "BLOB", "INTEGER[]", "STRUCT(a INTEGER)", "MAP(VARCHAR, INTEGER)"] {
            assert!(defer_by_default(Driver::Duckdb, t), "duckdb {t}");
        }
        assert!(!defer_by_default(Driver::Duckdb, "VARCHAR(20)"));
        assert!(!defer_by_default(Driver::Duckdb, "BIGINT"));
        for t in ["text", "mediumtext", "longtext", "json", "blob", "mediumblob", "longblob"] {
            assert!(defer_by_default(Driver::Mysql, t), "mysql {t}");
            assert!(defer_by_default(Driver::Mariadb, t), "mariadb {t}");
        }
        for t in ["varchar(255)", "tinytext", "tinyblob", "int(11)", "enum('a','b')", "datetime"] {
            assert!(!defer_by_default(Driver::Mysql, t), "mysql {t}");
        }
        for t in ["", "TEXT", "text", "BLOB", "JSON", "CLOB"] {
            assert!(defer_by_default(Driver::Sqlite, t), "sqlite {t:?}");
        }
        for t in ["INTEGER", "REAL", "NUMERIC", "varchar(20)", "BOOLEAN"] {
            assert!(!defer_by_default(Driver::Sqlite, t), "sqlite {t}");
        }
    }

    #[test]
    fn keys_are_never_deferred_and_overrides_win() {
        let s = table(vec![
            col("slug", "text", Some(1)),
            col("title", "character varying(80)", None),
            col("body", "text", None),
            col("doc", "jsonb", None),
        ]);
        assert_eq!(deferred_columns(Driver::Postgres, &s, &[], &[]), vec![false, false, true, true]);
        assert_eq!(
            deferred_columns(Driver::Postgres, &s, &["body".into()], &["title".into()]),
            vec![false, true, false, true]
        );
        assert_eq!(
            deferred_columns(Driver::Postgres, &s, &[], &["slug".into()]),
            vec![false, false, true, true],
            "a key column cannot be deferred"
        );
    }

    #[test]
    fn tables_without_a_key_defer_nothing() {
        let s = table(vec![col("body", "text", None), col("doc", "jsonb", None)]);
        assert_eq!(deferred_columns(Driver::Postgres, &s, &[], &[]), vec![false, false]);
    }

    #[test]
    fn expands_rows_back_to_the_table_shape() {
        let s = table(vec![col("id", "integer", Some(1)), col("body", "text", None), col("n", "integer", None)]);
        let (cols, rows) = expand_deferred(
            &s,
            &[false, true, false],
            vec![ColumnMeta::new("id", "int4"), ColumnMeta::new("n", "int4")],
            vec![vec![Cell::Text("1".into()), Cell::Text("7".into())]],
        );
        assert_eq!(
            cols.iter().map(|c| (c.name.as_str(), c.deferred)).collect::<Vec<_>>(),
            vec![("id", false), ("body", true), ("n", false)]
        );
        assert_eq!(cols[1].type_name, "text");
        assert_eq!(rows, vec![vec![Cell::Text("1".into()), Cell::NotLoaded, Cell::Text("7".into())]]);
    }

    #[test]
    fn previews_cut_on_characters_and_count_characters() {
        let long = "é".repeat(300);
        match preview_cell(&Cell::Text(long), 256) {
            Cell::Partial { preview, length } => {
                assert_eq!(length, 300);
                assert_eq!(preview.chars().count(), PREVIEW_CHARS);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(preview_cell(&Cell::Text("short".into()), 256), Cell::Text("short".into()));
        assert_eq!(
            preview_cell(&Cell::Text("é".repeat(256)), 256),
            Cell::Text("é".repeat(256)),
            "exactly the limit stays whole"
        );
        assert_eq!(preview_cell(&Cell::Null, 256), Cell::Null);
        assert_eq!(
            preview_rows(&[vec![Cell::Text("x".repeat(300))]], 256)[0][0],
            Cell::Partial { preview: "x".repeat(80), length: 300 }
        );
    }
}
