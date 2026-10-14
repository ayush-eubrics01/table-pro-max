# Large Values on Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opened tables never read potentially large columns until asked. Query results show large values as previews from memory. Every large or JSON value opens in an in-app editor, and JSON is validated before saving.

**Architecture:**
- **Core.** A new core module (`large_values.rs`) classifies columns by type and builds the placeholder and preview cells.
- **Page and fetch queries.** `browse.rs` leaves deferred columns out of the page query, and builds the by-key fetch query.
- **Engine.** The engine adds `fetch_value`, `fetch_column` and `result_value`. Overrides live in the local metadata database.
- **UI.**
  - The grid learns to show two new placeholder cells, Not loaded and Partial.
  - A new `ValueEditor` panel, built on CodeMirror, edits large and JSON values.
  - `TableView` and `ResultsPanel` connect the placeholders to loading and to the editor.

**Tech Stack:** Rust (tpm-core, sqlparser not involved), Tauri 2 commands, React/TypeScript, CodeMirror 6 plus `@codemirror/lang-json`, Vitest, and cargo integration tests against the disposable containers.

**Spec:** `docs/superpowers/specs/2026-10-14-large-values-design.md`

## Global Constraints
- **Opened tables never touch deferred columns.** Never select, measure (`length`, `octet_length`), preview (`left`, `substr`) or `CASE` on a deferred column in the page query.
- **Values are always bind parameters.** Identifiers go through `Dialect::quote_ident` and are checked against the introspected `TableStructure`.
- **One session per tab.** `fetch_value` and `fetch_column` go through `with_session` (the session lock), never concurrently with another operation on that session.
- **Export always writes full values.** It never sees a `NotLoaded` or `Partial` cell.
- **Query tabs run the user's SQL unchanged.**
- **No new network calls; nothing new written to disk except column names** (the overrides table).
- **Defaults:** `grid.pageSize` is 150. `grid.largeValueChars` is 256 (minimum 64, maximum 100,000). The preview is 80 characters.
- **Placeholder JSON shapes:**
  - Not loaded: `{"$notLoaded": true}`.
  - Partial: `{"$partial": "<preview>", "length": <chars>}`.
- **Copy (exact wording):**
  - the deferred-cell label "Not loaded" and its tooltip "Click to load";
  - "This row no longer exists";
  - "This result is no longer in memory; run the query again";
  - "Valid JSON", and "Invalid JSON: line L, column C: <message>";
  - the header menu items "Load this column", "Always load", "Don't load", "Use default";
  - the header icon tooltip "Loaded on demand".
- **Node:** `source ~/.nvm/nvm.sh && nvm use 24`. Do not run prettier on whole files.
- **Tauri check:** `source target/tpm-scratch/sysroot/env.sh; cargo check -p table-pro-max`.
- **New dependency:** `@codemirror/lang-json`, pinned to an exact version, with a row in `docs/DEPENDENCY_LICENSES.md`.

## Review Focus
1. **Copying a selection that mixes loaded, Not loaded and NULL cells.** Every cell copies its full value, in grid order, and NULL stays empty. Tested in Task 7.
2. **A primary key whose type would be deferred** (a PostgreSQL `text` slug key). It is always loaded, and fetching by it works. Tested in Task 1 (unit) and Task 2 (integration).
3. **Committing an edit to a loaded large value.** The conflict check's `original` is the full value, never the preview or the placeholder. Tested in Task 7 (table) and Task 8 (results).
4. **Format in the JSON editor.** It never changes data: big integers, `1.0`, `é` escapes and key order all survive. Tested in Task 6.
5. **A row deleted between page load and click.** The user sees "This row no longer exists", and the cell stays Not loaded. Tested in Task 2 (integration) and Task 7 (UI).

---

### Task 1: Core: cell kinds, column classification, page and fetch SQL

**Files:**
- Create: `crates/tpm-core/src/large_values.rs`
- Modify:
  - `crates/tpm-core/src/lib.rs` (declare the module);
  - `crates/tpm-core/src/model.rs` (the `Cell` variants, `ColumnMeta.deferred`);
  - `crates/tpm-core/src/browse.rs` (`build_select_projected`, `build_fetch`);
  - `crates/tpm-core/src/engine.rs` (`approx_row_bytes` arms; the misplaced doc comment above `txn_effect`);
  - `crates/tpm-core/src/transfer.rs` (an `ensure_full_rows` guard in every `write_rows`).
- Test: unit tests in `large_values.rs`, `browse.rs` and `model.rs`.

**Interfaces:**
- **Produces, in `model.rs`:**
  - `Cell::NotLoaded` and `Cell::Partial { preview: String, length: u64 }`;
  - `ColumnMeta.deferred: bool` (skipped in JSON when false);
  - `ColumnMeta::deferred(name, type_name) -> ColumnMeta`.
- **Produces, in `large_values.rs`:**
  - `PREVIEW_CHARS: usize = 80`;
  - `defer_by_default(driver: Driver, data_type: &str) -> bool`;
  - `deferred_columns(driver: Driver, s: &TableStructure, load: &[String], defer: &[String]) -> Vec<bool>`;
  - `expand_deferred(s: &TableStructure, deferred: &[bool], loaded_cols: Vec<ColumnMeta>, rows: Vec<Row>) -> (Vec<ColumnMeta>, Vec<Row>)`;
  - `preview_cell(c: &Cell, over: usize) -> Cell`;
  - `preview_rows(rows: &[Row], over: usize) -> Vec<Row>`.
- **Produces, in `browse.rs`:**
  - `build_select_projected(dialect: Dialect, s: &TableStructure, req: &BrowseRequest, deferred: &[bool]) -> Result<BuiltQuery>`. `build_select` becomes this with `&[]`.
  - `build_fetch(dialect: Dialect, s: &TableStructure, column: &str, keys: &[Vec<ColumnValue>]) -> Result<BuiltQuery>`. Its select list is the primary-key columns in key order, then `column`.

- [ ] **Step 1: Write the failing unit tests**

In `crates/tpm-core/src/large_values.rs`, create the file with only the test module and empty stubs that `todo!()`, so it compiles:

```rust
//! Large values on demand: which columns an opened table leaves out of its page query, and
//! how query results show long text. See docs/superpowers/specs/2026-10-14-large-values-design.md.

use crate::config::Driver;
use crate::model::{Cell, ColumnMeta, Row, TableStructure};

/// Characters of a long text value shown in a query result before it is opened.
pub const PREVIEW_CHARS: usize = 80;

pub fn defer_by_default(_driver: Driver, _data_type: &str) -> bool {
    todo!()
}
pub fn deferred_columns(_driver: Driver, _s: &TableStructure, _load: &[String], _defer: &[String]) -> Vec<bool> {
    todo!()
}
pub fn expand_deferred(
    _s: &TableStructure,
    _deferred: &[bool],
    _loaded_cols: Vec<ColumnMeta>,
    _rows: Vec<Row>,
) -> (Vec<ColumnMeta>, Vec<Row>) {
    todo!()
}
pub fn preview_cell(_c: &Cell, _over: usize) -> Cell {
    todo!()
}
pub fn preview_rows(_rows: &[Row], _over: usize) -> Vec<Row> {
    todo!()
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
        TableStructure { schema: "public".into(), name: "docs".into(), kind: ObjectKind::Table, columns: cols, ..Default::default() }
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
        let s = table(vec![col("slug", "text", Some(1)), col("title", "character varying(80)", None), col("body", "text", None), col("doc", "jsonb", None)]);
        assert_eq!(deferred_columns(Driver::Postgres, &s, &[], &[]), vec![false, false, true, true]);
        assert_eq!(deferred_columns(Driver::Postgres, &s, &["body".into()], &["title".into()]), vec![false, true, false, true]);
        assert_eq!(deferred_columns(Driver::Postgres, &s, &[], &["slug".into()]), vec![false, false, true, true], "a key column cannot be deferred");
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
        assert_eq!(cols.iter().map(|c| (c.name.as_str(), c.deferred)).collect::<Vec<_>>(), vec![("id", false), ("body", true), ("n", false)]);
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
        assert_eq!(preview_cell(&Cell::Text("é".repeat(256)), 256), Cell::Text("é".repeat(256)), "exactly the limit stays whole");
        assert_eq!(preview_cell(&Cell::Null, 256), Cell::Null);
        assert_eq!(preview_rows(&[vec![Cell::Text("x".repeat(300))]], 256)[0][0], Cell::Partial { preview: "x".repeat(80), length: 300 });
    }
}
```

In `crates/tpm-core/src/model.rs`, add to its test module:

```rust
    #[test]
    fn placeholder_cells_serialize_as_tagged_objects() {
        assert_eq!(serde_json::to_string(&Cell::NotLoaded).unwrap(), r#"{"$notLoaded":true}"#);
        assert_eq!(
            serde_json::to_string(&Cell::Partial { preview: "ab".into(), length: 9000 }).unwrap(),
            r#"{"$partial":"ab","length":9000}"#
        );
        let deferred = ColumnMeta::deferred("body", "text");
        assert_eq!(serde_json::to_string(&deferred).unwrap(), r#"{"name":"body","typeName":"text","deferred":true}"#);
        assert_eq!(serde_json::to_string(&ColumnMeta::new("id", "int4")).unwrap(), r#"{"name":"id","typeName":"int4"}"#);
    }
```

In `crates/tpm-core/src/browse.rs` `mod tests`, add (using the module's existing `users()` fixture, whose columns are `id integer` key, `email text`, `avatar bytea`):

```rust
    #[test]
    fn projected_page_query_leaves_deferred_columns_out_entirely() {
        let s = users();
        let req = BrowseRequest { schema: "public".into(), table: "users".into(), limit: 150, ..Default::default() };
        let q = build_select_projected(Dialect::Postgres, &s, &req, &[false, true, true]).unwrap();
        assert_eq!(q.sql, "SELECT t.\"id\"::text AS \"id\" FROM \"public\".\"users\" AS t ORDER BY t.\"id\" LIMIT 150 OFFSET 0");
        for word in ["email", "avatar", "length", "left", "CASE"] {
            assert!(!q.sql.contains(word), "{word} in {}", q.sql);
        }
        // Filtering and sorting may still name a deferred column; it is just not returned.
        let sorted = BrowseRequest { sort: vec![SortSpec { column: "email".into(), descending: true }], ..req };
        let q = build_select_projected(Dialect::Postgres, &s, &sorted, &[false, true, true]).unwrap();
        assert!(q.sql.contains("ORDER BY t.\"email\" DESC") && !q.sql.starts_with("SELECT t.\"id\"::text AS \"id\", t.\"email\""), "{}", q.sql);
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
```

`BrowseRequest` needs `#[derive(Default)]` for `..Default::default()`. Add it in Step 3.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p tpm-core --lib -- large_values placeholder_cells projected_page fetch_query 2>&1 | tail -20`
Expected: compile errors: `Cell::NotLoaded`, `ColumnMeta::deferred` and `build_select_projected` don't exist. Once the stubs compile, the `todo!()` panics instead.

- [ ] **Step 3: Implement**

**`lib.rs`:** add `pub mod large_values;` next to `pub mod result_edit;`.

**`model.rs`:**
- Extend `Cell`:

```rust
pub enum Cell {
    Null,
    Text(String),
    Bytes(Vec<u8>),
    /// A deferred column in an opened table: not read from the database (see large_values.rs).
    NotLoaded,
    /// Long text in a query result, sent to the UI as a preview; the full value stays in the
    /// result store.
    Partial { preview: String, length: u64 },
}
```

- In `impl Serialize for Cell`, add:

```rust
            Cell::NotLoaded => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("$notLoaded", &true)?;
                m.end()
            }
            Cell::Partial { preview, length } => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("$partial", preview)?;
                m.serialize_entry("length", length)?;
                m.end()
            }
```

- In `to_export_string`, add `Cell::NotLoaded | Cell::Partial { .. } => None,` with the comment `// Never reaches export: transfer.rs refuses placeholder rows (ensure_full_rows).`.
- `as_text` already returns `None` for other variants.
- Add the field to `ColumnMeta`:

```rust
    /// A deferred column of an opened table: its cells are `Cell::NotLoaded`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deferred: bool,
```

- `ColumnMeta::new` sets `deferred: false`. Add:

```rust
    pub fn deferred(name: impl Into<String>, type_name: impl Into<String>) -> Self {
        Self { deferred: true, ..Self::new(name, type_name) }
    }
```

- Fix every `ColumnMeta { … }` struct literal the compiler reports by adding `deferred: false`.

**`large_values.rs`** (replace the stubs):

```rust
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
        Driver::Sqlite => t.is_empty() || matches!(t.as_str(), "text" | "blob" | "json" | "clob" | "mediumtext" | "longtext"),
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
                .map(|i| if deferred.get(i).copied().unwrap_or(false) { Cell::NotLoaded } else { vals.next().unwrap_or(Cell::Null) })
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
```

**`browse.rs`:**
- Add `Default` to `BrowseRequest`'s derive.
- Rename the body of `build_select` into `build_select_projected` with the extra `deferred: &[bool]` parameter. Inside the select loop, iterate `for (i, c) in s.columns.iter().enumerate()` and add, first thing in the loop body:

```rust
        if deferred.get(i).copied().unwrap_or(false) {
            continue; // not selected at all: the database never reads it for this page
        }
```

- Then:

```rust
pub fn build_select(dialect: Dialect, s: &TableStructure, req: &BrowseRequest) -> Result<BuiltQuery> {
    build_select_projected(dialect, s, req, &[])
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
    Ok(BuiltQuery { sql: format!("SELECT {} FROM {table} AS t WHERE {}", select.join(", "), ors.join(" OR ")), params: b.params })
}
```

**`engine.rs`:**
- In `approx_row_bytes`, add `Cell::NotLoaded => 8,` and `Cell::Partial { preview, .. } => preview.len() + 24,`.
- Move the two lines starting `/// Statement that switches the default schema, or `None` where names are not resolved` and `/// through a default schema (SQLite searches main, temp and attached databases itself).` from above `fn txn_effect` to directly above `pub fn default_schema_sql`.

**`transfer.rs`:**
- Add near the top:

```rust
/// Export rows must hold full values. Placeholders (`NotLoaded`, `Partial`) belong to the grid only.
fn ensure_full_rows(rows: &[Row]) -> Result<()> {
    if rows.iter().flatten().any(|c| matches!(c, Cell::NotLoaded | Cell::Partial { .. })) {
        return Err(AppError::internal("Export received placeholder values instead of full rows"));
    }
    Ok(())
}
```

- Make `ensure_full_rows(rows)?;` the first line of every `fn write_rows` in the file.
- In each exhaustive `match` on `Cell` there, add `Cell::NotLoaded | Cell::Partial { .. } => unreachable!("rejected by ensure_full_rows"),`. For the xlsx sink's statement match the arm is `Cell::NotLoaded | Cell::Partial { .. } => unreachable!("rejected by ensure_full_rows")`.
- Fix any other exhaustive `match` the compiler reports, in adapters or Tauri code, the same way, or with a `_ =>` arm where the variant can't occur.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tpm-core --lib 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: `test result: ok.`, with the new tests included and 0 failed.

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all && cargo clippy -p tpm-core --all-targets 2>&1 | grep -E "^(warning|error)" ; \
git add crates/tpm-core && git commit -m "feat: core cell placeholders, column deferral by type, and fetch-by-key SQL"
```

---

### Task 2: Engine: lazy browse, fetch_value and fetch_column, Tauri commands, TS types

**Files:**
- Modify:
  - `crates/tpm-core/src/browse.rs` (the `BrowseRequest` fields);
  - `crates/tpm-core/src/engine.rs` (`browse`, `build_select_unchecked`, `FetchedCell`, `fetch_column`, `fetch_value`);
  - `src-tauri/src/commands/query.rs`;
  - `src-tauri/src/lib.rs` (register the commands);
  - `src/types/backend.ts`;
  - `src/lib/ipc.ts`.
- Test: `crates/tpm-core/tests/integration.rs` (a new `lazy_values` function, called for every driver).

**Interfaces:**
- **Consumes, from Task 1:** `deferred_columns`, `expand_deferred`, `build_select_projected`, `build_fetch`, `Cell::NotLoaded`, `ColumnMeta.deferred`.
- **Produces, in Rust:**
  - `BrowseRequest { lazy: bool, load_columns: Vec<String>, defer_columns: Vec<String> }`, all `#[serde(default)]`;
  - `pub struct FetchedCell { pub found: bool, pub value: Cell }`, serialized camelCase;
  - `Engine::fetch_column(&self, session_id: &str, schema: &str, table: &str, column: &str, keys: &[Vec<ColumnValue>]) -> Result<Vec<FetchedCell>>`;
  - `Engine::fetch_value(&self, session_id: &str, schema: &str, table: &str, key: Vec<ColumnValue>, column: &str) -> Result<Cell>`, which returns `NotFound` "This row no longer exists".
- **Produces, Tauri commands:**
  - `fetch_value(session_id, schema, table, key, column)`;
  - `fetch_column(session_id, schema, table, column, keys)`.
- **Produces, in TS:**
  - `Cell = null | string | { $bytes: string; size: number } | { $notLoaded: true } | { $partial: string; length: number }`;
  - `ColumnMeta.deferred?: boolean`;
  - `BrowseRequest.lazy?`, `loadColumns?`, `deferColumns?`;
  - `FetchedCell`;
  - `api.fetchValue(sessionId, schema, table, key, column): Promise<Cell>`;
  - `api.fetchColumn(sessionId, schema, table, column, keys): Promise<FetchedCell[]>`.

- [ ] **Step 1: Write the failing integration test**

In `crates/tpm-core/tests/integration.rs`, add a function and call it next to `edit_results(…)` in the per-driver test, before the cleanup. The call is `lazy_values(&engine, &sid, &t.schema, driver).await;`.

```rust
/// Opened tables leave unbounded columns out of the page; values come back by key on demand.
async fn lazy_values(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::browse::BrowseRequest;
    let (body_ty, doc_ty, big) = match driver {
        Driver::Postgres => ("text", "jsonb", "repeat('x', 100000)"),
        Driver::Mysql | Driver::Mariadb => ("longtext", "json", "REPEAT('x', 100000)"),
        Driver::Sqlite => ("TEXT", "TEXT", "replace(hex(zeroblob(50000)), '0', 'x')"),
        Driver::Duckdb => ("VARCHAR", "VARCHAR", "repeat('x', 100000)"),
        Driver::Redis => unreachable!(),
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_docs").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_nokey").await;
    run(engine, sid, &format!("CREATE TABLE tpm_it_docs (id integer PRIMARY KEY, title varchar(50), body {body_ty}, doc {doc_ty})")).await;
    run(engine, sid, &format!("INSERT INTO tpm_it_docs VALUES (1, 'one', {big}, '{{\"a\": 1}}'), (2, 'two', 'short', NULL)")).await;
    run(engine, sid, &format!("CREATE TABLE tpm_it_nokey (body {body_ty})")).await;
    run(engine, sid, "INSERT INTO tpm_it_nokey VALUES ('kept')").await;

    let req = BrowseRequest { schema: schema.into(), table: "tpm_it_docs".into(), limit: 150, lazy: true, ..Default::default() };
    let page = engine.browse(sid, &req).await.unwrap();
    let names: Vec<(&str, bool)> = page.columns.iter().map(|c| (c.name.as_str(), c.deferred)).collect();
    assert_eq!(names, vec![("id", false), ("title", false), ("body", true), ("doc", true)], "{driver:?}");
    assert_eq!(page.rows[0][2], Cell::NotLoaded, "{driver:?}");
    assert_eq!(page.rows[0][3], Cell::NotLoaded, "{driver:?}");
    assert!(!page.sql.contains("body") && !page.sql.contains("doc"), "page query never names deferred columns: {}", page.sql);

    // One value, by key.
    let key = |id: &str| vec![ColumnValue { column: "id".into(), value: Some(id.into()) }];
    let body = engine.fetch_value(sid, schema, "tpm_it_docs", key("1"), "body").await.unwrap();
    assert_eq!(body.as_text().map(str::len), Some(100_000), "{driver:?}");
    // A column for several rows, matched by key whatever order the database returns.
    let got = engine.fetch_column(sid, schema, "tpm_it_docs", "body", &[key("2"), key("1"), key("9")]).await.unwrap();
    assert_eq!(got[0].value, Cell::Text("short".into()));
    assert_eq!(got[1].value.as_text().map(str::len), Some(100_000));
    assert!(!got[2].found, "missing row reported, not invented");
    // Overrides: load body normally, defer title.
    let req2 = BrowseRequest { load_columns: vec!["body".into()], defer_columns: vec!["title".into()], ..req.clone() };
    let page = engine.browse(sid, &req2).await.unwrap();
    assert_eq!(page.rows[1][2], Cell::Text("short".into()));
    assert_eq!(page.rows[1][1], Cell::NotLoaded);
    // A table without a key defers nothing.
    let nk = BrowseRequest { table: "tpm_it_nokey".into(), ..req.clone() };
    let page = engine.browse(sid, &nk).await.unwrap();
    assert_eq!(page.rows[0][0], Cell::Text("kept".into()));
    // Not lazy (export, other callers): everything, as before.
    let full = engine.browse(sid, &BrowseRequest { lazy: false, ..req.clone() }).await.unwrap();
    assert_eq!(full.rows[0][2].as_text().map(str::len), Some(100_000));
    // A query tab returns every column in full.
    let r = run(engine, sid, "SELECT * FROM tpm_it_docs WHERE id = 1").await;
    assert_eq!(r.statements[0].rows.as_ref().unwrap()[0][2].as_text().map(str::len), Some(100_000), "{driver:?}");
    // Deleted between page and click.
    run(engine, sid, "DELETE FROM tpm_it_docs WHERE id = 2").await;
    let err = engine.fetch_value(sid, schema, "tpm_it_docs", key("2"), "body").await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
    assert_eq!(err.message, "This row no longer exists");

    run(engine, sid, "DROP TABLE tpm_it_docs").await;
    run(engine, sid, "DROP TABLE tpm_it_nokey").await;
}
```

Notes:
- Imports: `Cell` is already imported from `tpm_core::model`, and `ColumnValue` from `tpm_core::changes`.
- If `t.schema` isn't the name the per-driver test uses for the schema, use the variable that `transfer_roundtrip` receives as `schema`.
- `Engine::browse` takes `&self`; `&Arc<Engine>` derefs.

- [ ] **Step 2: Run it to verify it fails**

Run: `scripts/test-db.sh up && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "^error|panicked|test result" | head`
Expected: compile errors: `lazy`, `fetch_value` and `fetch_column` don't exist.

- [ ] **Step 3: Implement the engine**

**`browse.rs`**, add to `BrowseRequest`:

```rust
    /// Leave potentially large columns out of the page (opened tables). Export and other
    /// callers keep the default, `false`, and get every column.
    #[serde(default)]
    pub lazy: bool,
    /// Per-column overrides from the column_fetch store.
    #[serde(default)]
    pub load_columns: Vec<String>,
    #[serde(default)]
    pub defer_columns: Vec<String>,
```

Fix struct literals the compiler reports by adding `..Default::default()`.

**`engine.rs`:**
- Change `build_select_unchecked` to take `deferred: &[bool]` and call `build_select_projected(dialect, s, &capped, deferred)`.
- In `browse`, after loading `structure`:

```rust
        let deferred = if req.lazy {
            crate::large_values::deferred_columns(handle.profile.driver, &structure, &req.load_columns, &req.defer_columns)
        } else {
            vec![false; structure.columns.len()]
        };
        let q = crate::browse::build_select_projected(handle.info.dialect, &structure, &BrowseRequest { limit: req.limit, ..req.clone() }, &deferred)?;
        let probe_q = build_select_unchecked(handle.info.dialect, &structure, &probe, &deferred)?;
```

- Then replace the final `Ok(BrowseResult { columns: rs.columns, rows: rs.rows, … })` with:

```rust
        let (columns, rows) = crate::large_values::expand_deferred(&structure, &deferred, rs.columns, rs.rows);
        Ok(BrowseResult { columns, rows, sql: q.sql, duration_ms: t0.elapsed().as_millis() as u64, has_more })
```

  `has_more` is computed before `rs.rows` is moved. Keep `rs.rows.truncate(limit)` before the call.
- Add next to `BrowseResult`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedCell {
    /// False when no row has that key any more.
    pub found: bool,
    pub value: Cell,
}
```

- Add after `count_rows`:

```rust
    /// One column of an opened table for the given rows, by primary key (large values on demand).
    pub async fn fetch_column(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        column: &str,
        keys: &[Vec<crate::changes::ColumnValue>],
    ) -> Result<Vec<FetchedCell>> {
        let handle = self.handle(session_id)?;
        let structure = self.table_structure(session_id, schema, table, false).await?;
        let q = crate::browse::build_fetch(handle.info.dialect, &structure, column, keys)?;
        let n = keys.len();
        let rs = self
            .with_session(session_id, move |s| Box::pin(async move { s.query(&q.sql, &q.params, n).await }))
            .await?;
        let pk: Vec<String> = structure.primary_key().iter().map(|c| c.name.clone()).collect();
        let mut by_key: HashMap<Vec<String>, Cell> = HashMap::new();
        for row in rs.rows {
            let key = row[..pk.len()].iter().map(|c| c.as_text().unwrap_or_default().to_string()).collect();
            by_key.insert(key, row[pk.len()].clone());
        }
        Ok(keys
            .iter()
            .map(|k| {
                let want: Vec<String> = pk
                    .iter()
                    .map(|p| k.iter().find(|v| &v.column == p).and_then(|v| v.value.clone()).unwrap_or_default())
                    .collect();
                match by_key.get(&want) {
                    Some(c) => FetchedCell { found: true, value: c.clone() },
                    None => FetchedCell { found: false, value: Cell::Null },
                }
            })
            .collect())
    }

    pub async fn fetch_value(
        &self,
        session_id: &str,
        schema: &str,
        table: &str,
        key: Vec<crate::changes::ColumnValue>,
        column: &str,
    ) -> Result<Cell> {
        let mut got = self.fetch_column(session_id, schema, table, column, std::slice::from_ref(&key)).await?;
        let f = got.remove(0);
        if !f.found {
            return Err(AppError::not_found("This row no longer exists"));
        }
        Ok(f.value)
    }
```

  Add `use std::collections::HashMap;` if it isn't already imported.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "panicked|test result" -A3`
Expected: `test result: ok. 8 passed`.

- [ ] **Step 5: Tauri commands and TS types**

**`src-tauri/src/commands/query.rs`:**

```rust
#[tauri::command]
pub async fn fetch_value(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    key: Vec<ColumnValue>,
    column: String,
) -> Result<Cell> {
    state.engine.fetch_value(&session_id, &schema, &table, key, &column).await
}

#[tauri::command]
pub async fn fetch_column(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    column: String,
    keys: Vec<Vec<ColumnValue>>,
) -> Result<Vec<FetchedCell>> {
    state.engine.fetch_column(&session_id, &schema, &table, &column, &keys).await
}
```

Import `tpm_core::changes::ColumnValue`, `tpm_core::model::Cell` and `tpm_core::engine::FetchedCell`. Register both in `src-tauri/src/lib.rs`'s `generate_handler!` list next to `browse_table`.

**`src/types/backend.ts`:**

```ts
export type Cell = null | string | { $bytes: string; size: number } | { $notLoaded: true } | { $partial: string; length: number };
```

- Add `deferred?: boolean;` to `ColumnMeta`.
- Add to `BrowseRequest`:

```ts
  /** Leave potentially large columns out of the page (opened tables). */
  lazy?: boolean;
  loadColumns?: string[];
  deferColumns?: string[];
```

- Add:

```ts
export interface FetchedCell {
  found: boolean;
  value: Cell;
}
```

**`src/lib/ipc.ts`:**
- Import `FetchedCell`.
- Add next to `browseTable`:

```ts
  fetchValue: (sessionId: string, schema: string, table: string, key: { column: string; value: string | null }[], column: string) =>
    call<Cell>("fetch_value", { sessionId, schema, table, key, column }),
  fetchColumn: (sessionId: string, schema: string, table: string, column: string, keys: { column: string; value: string | null }[][]) =>
    call<FetchedCell[]>("fetch_column", { sessionId, schema, table, column, keys }),
```

- [ ] **Step 6: Verify the whole build and commit**

Run: `source target/tpm-scratch/sysroot/env.sh; cargo check -p table-pro-max 2>&1 | tail -1 && source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null && npm run typecheck 2>&1 | grep error | head`
Expected: `Finished`, and no TS errors. If TS reports exhaustive `Cell` handling in existing code, Task 5 owns `cells.ts`. Here, add only the minimal narrowing needed to compile:
- `cellDisplay` returns `"Not loaded"` for `$notLoaded` and `` `${c.$partial}…` `` for `$partial`;
- `cellCopy` returns `""` for both;
- `cellParam` returns `undefined` for both.

```bash
cargo fmt --all && git add -A crates/tpm-core src-tauri src/types/backend.ts src/lib && \
git commit -m "feat: opened tables leave large columns out of the page and fetch them by key"
```

---

### Task 3: Per-column overrides store

**Files:**
- Modify:
  - `crates/tpm-core/src/storage.rs` (migration 2, `ColumnFetch`, `FetchMode`, list/set, `delete_connection`);
  - `src-tauri/src/commands/library.rs`;
  - `src-tauri/src/lib.rs`;
  - `src/types/backend.ts`;
  - `src/lib/ipc.ts`.
- Test: `storage.rs` unit tests.

**Interfaces:**
- **Produces, in Rust:**
  - `pub enum FetchMode { Load, Defer }`, serialized lowercase;
  - `pub struct ColumnFetch { pub column: String, pub mode: FetchMode }`;
  - `Storage::list_column_fetch(&self, connection_id: &str, schema: &str, table: &str) -> Result<Vec<ColumnFetch>>`;
  - `Storage::set_column_fetch(&self, connection_id: &str, schema: &str, table: &str, column: &str, mode: Option<FetchMode>) -> Result<()>`, where `None` removes the override.
- **Produces, Tauri commands:**
  - `list_column_fetch(connection_id, schema, table)`;
  - `set_column_fetch(connection_id, schema, table, column, mode: Option<FetchMode>)`.
- **Produces, in TS:**
  - `type FetchMode = "load" | "defer"`;
  - `interface ColumnFetch { column: string; mode: FetchMode }`;
  - `api.listColumnFetch(connectionId, schema, table)`;
  - `api.setColumnFetch(connectionId, schema, table, column, mode | null)`.

- [ ] **Step 1: Write the failing test** (in `storage.rs`'s `mod tests`)

```rust
    #[test]
    fn column_fetch_overrides_are_per_table_and_removed_with_the_connection() {
        let s = Storage::open_in_memory().unwrap();
        s.set_column_fetch("c1", "public", "docs", "body", Some(FetchMode::Load)).unwrap();
        s.set_column_fetch("c1", "public", "docs", "title", Some(FetchMode::Defer)).unwrap();
        s.set_column_fetch("c1", "public", "docs", "body", Some(FetchMode::Defer)).unwrap(); // replaces
        s.set_column_fetch("c1", "public", "other", "body", Some(FetchMode::Load)).unwrap();
        let got = s.list_column_fetch("c1", "public", "docs").unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|f| f.column == "body" && f.mode == FetchMode::Defer));
        s.set_column_fetch("c1", "public", "docs", "title", None).unwrap();
        assert_eq!(s.list_column_fetch("c1", "public", "docs").unwrap().len(), 1);
        s.delete_connection("c1").unwrap();
        assert!(s.list_column_fetch("c1", "public", "other").unwrap().is_empty());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p tpm-core --lib column_fetch 2>&1 | tail -5`
Expected: compile error: `set_column_fetch` and `FetchMode` don't exist.

- [ ] **Step 3: Implement**

Append to `MIGRATIONS`, as a second element after the first string:

```rust
    r#"
    CREATE TABLE column_fetch (
        connection_id TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('load', 'defer')),
        PRIMARY KEY (connection_id, schema_name, table_name, column_name)
    );
    "#,
```

Types and methods:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchMode {
    Load,
    Defer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFetch {
    pub column: String,
    pub mode: FetchMode,
}
```

```rust
    // ---- column fetch overrides (column names only, never values) --------------------

    pub fn list_column_fetch(&self, connection_id: &str, schema: &str, table: &str) -> Result<Vec<ColumnFetch>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT column_name, mode FROM column_fetch WHERE connection_id = ?1 AND schema_name = ?2 AND table_name = ?3 ORDER BY column_name",
        )?;
        let rows = stmt.query_map(params![connection_id, schema, table], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (column, mode) = row?;
            let mode = if mode == "load" { FetchMode::Load } else { FetchMode::Defer };
            out.push(ColumnFetch { column, mode });
        }
        Ok(out)
    }

    pub fn set_column_fetch(&self, connection_id: &str, schema: &str, table: &str, column: &str, mode: Option<FetchMode>) -> Result<()> {
        let conn = self.lock()?;
        match mode {
            None => {
                conn.execute(
                    "DELETE FROM column_fetch WHERE connection_id = ?1 AND schema_name = ?2 AND table_name = ?3 AND column_name = ?4",
                    params![connection_id, schema, table, column],
                )?;
            }
            Some(m) => {
                let m = if m == FetchMode::Load { "load" } else { "defer" };
                conn.execute(
                    "INSERT INTO column_fetch (connection_id, schema_name, table_name, column_name, mode) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT DO UPDATE SET mode = excluded.mode",
                    params![connection_id, schema, table, column, m],
                )?;
            }
        }
        Ok(())
    }
```

Change `delete_connection` to:

```rust
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM connections WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM column_fetch WHERE connection_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }
```

`self.lock()` returns a guard over `Connection`. If it isn't `mut`-able, bind it as `let mut conn = self.lock()?;`, as `migrate` does.

**Tauri (`library.rs`):**

```rust
#[tauri::command]
pub fn list_column_fetch(state: State<'_, AppState>, connection_id: String, schema: String, table: String) -> Result<Vec<ColumnFetch>> {
    state.storage.list_column_fetch(&connection_id, &schema, &table)
}

#[tauri::command]
pub fn set_column_fetch(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    mode: Option<FetchMode>,
) -> Result<()> {
    state.storage.set_column_fetch(&connection_id, &schema, &table, &column, mode)
}
```

Register both in `lib.rs`.

**TS (`backend.ts`):**

```ts
export type FetchMode = "load" | "defer";
export interface ColumnFetch {
  column: string;
  mode: FetchMode;
}
```

**TS (`ipc.ts`):**

```ts
  listColumnFetch: (connectionId: string, schema: string, table: string) => call<ColumnFetch[]>("list_column_fetch", { connectionId, schema, table }),
  setColumnFetch: (connectionId: string, schema: string, table: string, column: string, mode: FetchMode | null) =>
    call<void>("set_column_fetch", { connectionId, schema, table, column, mode }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p tpm-core --lib storage 2>&1 | grep -E "test result|FAILED"`
Expected: ok. The existing `migrates_and_reopens` test still passes, because it compares against `MIGRATIONS.len()`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && git add -A crates/tpm-core/src/storage.rs src-tauri src/types/backend.ts src/lib/ipc.ts && \
git commit -m "feat: remember per-column load or defer choices locally (column names only)"
```

---

### Task 4: Query results: previews from memory, `result_value`, PostgreSQL result types

**Files:**
- Modify:
  - `crates/tpm-core/src/engine.rs` (`RunOptions.large_value_chars`, `StoredResult.preview_over`, `store_outcomes`, `fetch_rows`, `result_value`, `add_origins` filling type names);
  - `crates/tpm-core/src/adapters/mod.rs` and `adapters/postgres.rs` (describe returns type names too);
  - `src-tauri/src/commands/query.rs`;
  - `src-tauri/src/lib.rs`;
  - `src/types/backend.ts` (`RunOptions`);
  - `src/lib/ipc.ts`.
- Test: `crates/tpm-core/tests/integration.rs` (extend `lazy_values`).

**Interfaces:**
- **Consumes, from Task 1:** `preview_rows`, `Cell::Partial`.
- **Produces, in Rust:**
  - `RunOptions.large_value_chars: Option<u32>`. `None` means no previews, so API callers get full values.
  - `Engine::result_value(&self, result_id: &str, row: usize, col: usize) -> Result<Cell>`, which returns `NotFound` "This result is no longer in memory; run the query again".
  - The `Session` trait's `describe_origins` becomes `async fn describe(&mut self, sql: &str) -> Result<Vec<DescribedColumn>>`, where `pub struct DescribedColumn { pub origin: Option<ColumnOrigin>, pub type_name: String }`.
- **Produces, Tauri command:** `result_value(result_id, row, col)`.
- **Produces, in TS:** `RunOptions.largeValueChars?: number`; `api.resultValue(resultId, row, col): Promise<Cell>`.

- [ ] **Step 1: Write the failing integration test**

Append inside `lazy_values`, before the final `DROP TABLE`s. The `id = 1` row still exists at that point.

```rust
    // Query results: long text goes to the UI as a preview; the full value stays in memory.
    let opts = RunOptions { confirmed: true, large_value_chars: Some(256), ..Default::default() };
    let r = engine.run_script(sid, "SELECT id, body, title FROM tpm_it_docs WHERE id = 1", opts, None).await.unwrap();
    let st = &r.statements[0];
    match &st.rows.as_ref().unwrap()[0][1] {
        Cell::Partial { preview, length } => {
            assert_eq!(*length, 100_000);
            assert_eq!(preview.chars().count(), 80);
        }
        other => panic!("{driver:?}: expected a preview, got {other:?}"),
    }
    assert_eq!(st.rows.as_ref().unwrap()[0][2], Cell::Text("one".into()), "short values untouched");
    let rid = st.result_id.clone().unwrap();
    assert_eq!(engine.result_value(&rid, 0, 1).unwrap().as_text().map(str::len), Some(100_000));
    assert!(matches!(engine.fetch_rows(&rid, 0, 10).unwrap()[0][1], Cell::Partial { .. }), "later pages too");
    let (_, full) = engine.result_snapshot(&rid).unwrap();
    assert_eq!(full[0][1].as_text().map(str::len), Some(100_000), "export reads full rows");
    engine.release_results(&[rid.clone()]);
    assert_eq!(engine.result_value(&rid, 0, 1).unwrap_err().message, "This result is no longer in memory; run the query again");
    if driver == Driver::Postgres {
        let r = run(engine, sid, "SELECT doc FROM tpm_it_docs WHERE id = 1").await;
        assert_eq!(r.statements[0].columns.as_ref().unwrap()[0].type_name, "jsonb", "writable PG results learn their types");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "^error|panicked" | head -5`
Expected: compile errors: `large_value_chars` and `result_value` don't exist.

- [ ] **Step 3: Implement**

**`engine.rs`:**
- Add to `RunOptions`:

```rust
    /// Send text longer than this many characters to the UI as a preview (query results).
    /// `None` sends full values.
    #[serde(default)]
    pub large_value_chars: Option<u32>,
```

- Add `preview_over: Option<usize>` to `StoredResult`.
- Give `store_outcomes` a last parameter `preview_over: Option<usize>`. Its one caller in `run_script` passes `opts.large_value_chars.map(|n| n as usize)`.
- Inside `store_outcomes`, replace the `r.rows = Some(…)` line with:

```rust
                    let first: Vec<Row> = rows.rows.iter().take(FIRST_PAGE_ROWS).cloned().collect();
                    r.rows = Some(match preview_over {
                        Some(n) => crate::large_values::preview_rows(&first, n),
                        None => first,
                    });
```

- Store `preview_over` in the `StoredResult` literal.
- Change `fetch_rows`:

```rust
    pub fn fetch_rows(&self, result_id: &str, offset: usize, limit: usize) -> Result<Vec<Row>> {
        let store = lock(&self.results);
        let r = store
            .results
            .get(result_id)
            .ok_or_else(|| AppError::not_found("This result is no longer available; run the query again"))?;
        let page: Vec<Row> = r.rows.iter().skip(offset).take(limit.min(10_000)).cloned().collect();
        Ok(match r.preview_over {
            Some(n) => crate::large_values::preview_rows(&page, n),
            None => page,
        })
    }

    /// The full value of one result cell, from memory (opening a previewed value).
    pub fn result_value(&self, result_id: &str, row: usize, col: usize) -> Result<Cell> {
        let store = lock(&self.results);
        let r = store
            .results
            .get(result_id)
            .ok_or_else(|| AppError::not_found("This result is no longer in memory; run the query again"))?;
        r.rows
            .get(row)
            .and_then(|cells| cells.get(col))
            .cloned()
            .ok_or_else(|| AppError::not_found("That cell is outside this result"))
    }
```

- In `add_origins`, the describe now returns `DescribedColumn`s:

```rust
                for (c, f) in rows.columns.iter_mut().zip(found.iter()) {
                    c.origin = f.origin.clone();
                    if c.type_name.is_empty() {
                        c.type_name = f.type_name.clone();
                    }
                }
```

  Also, the "all origins unknown" condition must also run when every `type_name` is empty, which is the PostgreSQL simple-protocol case. Change `unknown` to:

```rust
        let unknown = |o: &StatementOutcome| {
            matches!(o, StatementOutcome::Rows { rows } if rows.columns.iter().all(|c| c.origin.is_none()) || rows.columns.iter().all(|c| c.type_name.is_empty()))
        };
```

  Apply the same `||` in the assignment loop's condition.

**`adapters/mod.rs`:**

```rust
/// What a describe reports for one result column.
#[derive(Debug, Clone, Default)]
pub struct DescribedColumn {
    pub origin: Option<ColumnOrigin>,
    pub type_name: String,
}
```

Rename the trait method `describe_origins` to `describe` returning `Result<Vec<DescribedColumn>>`. The default is still `Ok(vec![])`.

**`postgres.rs` `describe`:**
- Build `DescribedColumn { origin: <as before>, type_name: stmt.columns()[i].type_().name().to_string() }`.
- Keep `cols` as `(table_oid, column_id, type name)`.
- Update every other implementer and caller that the compiler reports.

**Tauri:**

```rust
#[tauri::command]
pub fn result_value(state: State<'_, AppState>, result_id: String, row: usize, col: usize) -> Result<Cell> {
    state.engine.result_value(&result_id, row, col)
}
```

Register it.

**TS:**
- Add `largeValueChars?: number;` to the `RunOptions` interface in `backend.ts`.
- `ipc.ts`: `resultValue: (resultId: string, row: number, col: number) => call<Cell>("result_value", { resultId, row, col }),`.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `cargo test -p tpm-core 2>&1 | grep -E "test result|FAILED"; eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration 2>&1 | grep -E "panicked|test result" -A3`
Expected: all `ok`, and integration `8 passed`.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && source target/tpm-scratch/sysroot/env.sh && cargo check -p table-pro-max 2>&1 | tail -1 && \
git add -A crates/tpm-core src-tauri src/types/backend.ts src/lib/ipc.ts && \
git commit -m "feat: query results preview long text from memory and open full values on demand"
```

---

### Task 5: Grid: placeholder cells, large-text display, open/load hooks, settings

**Files:**
- Modify:
  - `src/lib/cells.ts`;
  - `src/features/data-grid/DataGrid.tsx`;
  - `src/styles/app.css`;
  - `src/stores/settings.ts`;
  - `src/features/settings/SettingsDialog.tsx`.
- Test:
  - `src/lib/cells.test.ts` (create it, or extend it if it exists);
  - `src/features/data-grid/DataGrid.test.tsx`;
  - any settings test that asserts `grid.pageSize: 300`.

**Interfaces:**
- **Consumes, from Task 2:** the TS `Cell` union and `ColumnMeta.deferred`.
- **Produces, in `cells.ts`:**
  - `isNotLoaded(c)`;
  - `isPartial(c)`;
  - `needsFetch(c: Cell | undefined): boolean`;
  - `isLargeText(c: Cell | undefined, limit: number): boolean`;
  - `sizeLabel(typeName: string, length: number): string`;
  - `previewText(c: string): string` (first 80 characters).
- **Produces, in `DataGrid`:**
  - prop `onOpenCell?: (row: number, col: number, how: "click" | "open") => boolean`. "click" fires only on a Not loaded cell; "open" fires on double-click or Enter for any cell. Returning `true` means the parent handled it, and no inline editor opens.
  - prop `loadFull?: (cells: CellPos[]) => Promise<Cell[]>`;
  - prop `headerItems?: (col: number) => MenuEntry[]`;
  - prop `isLoading?: (row: number, col: number) => boolean`;
  - prop `largeValueChars?: number` (default 256);
  - `GridColumn.deferred?: boolean`;
  - `GridHandle.startEdit(pos: CellPos): void`.
- **Produces, settings:** `"grid.largeValueChars": number`, default 256; `"grid.pageSize"` default 150.

- [ ] **Step 1: Write the failing tests**

`src/lib/cells.test.ts`. If it already exists, append the `describe` block and merge the imports.

```ts
import { describe, expect, it } from "vitest";
import { cellCopy, cellDisplay, cellParam, isLargeText, isNotLoaded, isPartial, needsFetch, previewText, sizeLabel } from "./cells";

describe("placeholder cells", () => {
  const nl = { $notLoaded: true } as const;
  const part = { $partial: "abc", length: 9000 };
  it("recognises and never round-trips placeholders", () => {
    expect(isNotLoaded(nl)).toBe(true);
    expect(isPartial(part)).toBe(true);
    expect(needsFetch(nl) && needsFetch(part)).toBe(true);
    expect(needsFetch("x") || needsFetch(null) || needsFetch(undefined)).toBe(false);
    expect(cellParam(nl)).toBeUndefined();
    expect(cellParam(part)).toBeUndefined();
    expect(cellCopy(nl)).toBe("");
    expect(cellDisplay(nl)).toBe("Not loaded");
    expect(cellDisplay(part)).toBe("abc…");
  });
  it("labels sizes and previews long text", () => {
    expect(sizeLabel("jsonb", 18_432)).toBe("18.0 KB");
    expect(sizeLabel("text", 4210)).toBe("4,210 chars");
    expect(isLargeText("x".repeat(257), 256)).toBe(true);
    expect(isLargeText("x".repeat(256), 256)).toBe(false);
    expect(previewText("y".repeat(300))).toBe("y".repeat(80));
  });
});
```

`DataGrid.test.tsx`, add:

```tsx
  it("shows Not loaded and previews, loads on click, and opens instead of inline editing", () => {
    const cols = [
      { name: "id", typeName: "integer", primaryKey: true },
      { name: "body", typeName: "text", deferred: true },
      { name: "note", typeName: "text" },
    ];
    const data = [["1", { $notLoaded: true }, "x".repeat(300)]] as Cell[][];
    const opened: [number, number, string][] = [];
    const edits: unknown[] = [];
    render(
      <DataGrid
        ariaLabel="Rows"
        columns={cols}
        rowCount={1}
        getRow={(i) => data[i]}
        canEdit={() => true}
        onEdit={(...a) => edits.push(a)}
        onOpenCell={(r, c, how) => (opened.push([r, c, how]), true)}
      />,
    );
    expect(screen.getByLabelText("Loaded on demand")).toBeInTheDocument();
    const nl = screen.getByText("Not loaded").closest(".grid-cell")!;
    expect(nl).toHaveClass("not-loaded");
    fireEvent.click(nl);
    expect(opened).toEqual([[0, 1, "click"]]);
    const long = screen.getByText("300 chars").closest(".grid-cell")!;
    expect(long).toHaveTextContent("x".repeat(80) + "…");
    fireEvent.doubleClick(long);
    expect(opened[1]).toEqual([0, 2, "open"]);
    expect(screen.queryByLabelText("Edit note")).not.toBeInTheDocument();
    expect(edits).toHaveLength(0);
  });

  it("copies full values, fetching placeholders first", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const data = [
      ["1", { $notLoaded: true }, null],
      ["2", "short", null],
    ] as Cell[][];
    const ref = createRef<GridHandle>();
    render(
      <DataGrid
        ref={ref}
        ariaLabel="Rows"
        columns={[{ name: "id", typeName: "integer" }, { name: "body", typeName: "text" }, { name: "n", typeName: "integer" }]}
        rowCount={2}
        getRow={(i) => data[i]}
        loadFull={async (cells) => cells.map(() => "FULL")}
      />,
    );
    fireEvent.mouseDown(screen.getByText("1").closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getAllByText("NULL")[1]!.closest(".grid-cell")!, { shiftKey: true });
    await act(async () => ref.current!.copySelection(false));
    expect(write).toHaveBeenCalledWith("1\tFULL\t\n2\tshort\t");
  });
```

Update the test file's imports to include `fireEvent`, `act`, `vi`, `createRef`, `GridHandle` and the `Cell` type.

- [ ] **Step 2: Run them to verify they fail**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null && npx vitest run src/lib/cells.test.ts src/features/data-grid 2>&1 | grep -E "×|Tests "`
Expected: the new tests fail, because the helpers and props don't exist.

- [ ] **Step 3: Implement `cells.ts`**

```ts
export function isNotLoaded(c: Cell): c is { $notLoaded: true } {
  return typeof c === "object" && c !== null && "$notLoaded" in c;
}
export function isPartial(c: Cell): c is { $partial: string; length: number } {
  return typeof c === "object" && c !== null && "$partial" in c;
}
/** The grid holds a placeholder; the full value must be fetched before copying or editing. */
export function needsFetch(c: Cell | undefined): boolean {
  return c !== undefined && (isNotLoaded(c) || isPartial(c));
}
export const PREVIEW_CHARS = 80;
export function isLargeText(c: Cell | undefined, limit: number): c is string {
  return typeof c === "string" && c.length > limit;
}
export function previewText(s: string): string {
  return Array.from(s).slice(0, PREVIEW_CHARS).join("");
}
export function sizeLabel(typeName: string, length: number): string {
  return isJsonType(typeName) ? formatBytes(length) : `${length.toLocaleString("en-US")} chars`;
}
```

Update the existing helpers:
- `cellDisplay`: add `if (isNotLoaded(c)) return "Not loaded"; if (isPartial(c)) return `${c.$partial}…`;` after the binary line.
- `cellCopy` and `cellParam`: return `""` and `undefined` respectively for both placeholders.
- `cellTone`: return `null` for both.

`formatBytes(18432)` is `"18.0 KB"`.

- [ ] **Step 4: Implement `DataGrid.tsx`**

- **`GridColumn`:** add `deferred?: boolean`.
- **`GridHandle`:** add `startEdit: (pos: CellPos) => void`. Expose it in `useImperativeHandle` as `startEdit: (pos) => startEdit(pos)`.
- **New props:** destructure `onOpenCell`, `loadFull`, `headerItems`, `isLoading`, and `largeValueChars = 256`.
- **`startEdit`:** after the binary check, add `if (needsFetch(cell) || isLargeText(cell, largeValueChars)) return;`.
- **Double-click handler on cells:** replace it with:

```tsx
                      onDoubleClick={() => {
                        if (onOpenCell?.(ri.index, col, "open")) return;
                        startEdit({ row: ri.index, col });
                      }}
                      onClick={() => {
                        if (v !== undefined && isNotLoaded(v)) onOpenCell?.(ri.index, col, "click");
                      }}
```

- **Enter key:** in the `case "Enter":` branch, call `if (cur.col >= 0 && !onOpenCell?.(cur.row, cur.col, "open")) startEdit(cur);` instead of `startEdit(cur)` directly.
- **`copySelection`:** make it async with full values. Positions are gathered, and `loadFull` is called once for those that need it:

```tsx
  const copySelection = useCallback(
    async (withHeader = false) => {
      if (selection.rows.length === 0) return;
      const data = selection.rows.map((r) => {
        const row = getRow(r);
        return selection.cols.map((c) => (row ? (row[c] ?? null) : null));
      });
      const missing: { pos: CellPos; i: number; j: number }[] = [];
      data.forEach((row, i) => row.forEach((cell, j) => needsFetch(cell) && missing.push({ pos: { row: selection.rows[i]!, col: selection.cols[j]! }, i, j })));
      if (missing.length > 0 && loadFull) {
        const full = await loadFull(missing.map((m) => m.pos));
        missing.forEach((m, k) => (data[m.i]![m.j] = full[k] ?? null));
      }
      const header = withHeader ? selection.cols.map((c) => columns[c]!.name) : undefined;
      const text = toTsv(data, header);
      await navigator.clipboard.writeText(text);
      if (missing.length > 0) notify(`Copied ${pluralize(selection.rows.length, "row")} (${formatBytes(new TextEncoder().encode(text).length)})`, "success");
    },
    [selection, getRow, columns, loadFull],
  );
```

  Import `notify` from `../../stores/ui`, and `pluralize` from `../../lib/text`. Update the `GridHandle` type: `copySelection: (withHeader?: boolean) => Promise<void>`. Callers that ignored the result keep working; add `void` where lint asks.
- **Header menu "Copy column values":** do the same. Gather the column's cells for all rows, `loadFull` the placeholders, then copy. Append `...(headerItems ? (["separator", ...headerItems(col)] as MenuEntry[]) : [])` at the end of `headerMenu`.
- **Header cell:** after the existing key and foreign-key markers, when `c.deferred`, render `<span className="col-deferred" aria-label="Loaded on demand" title="Loaded on demand"><Icon name="visibility" size={12} /></span>`.
- **Cell rendering:**
  - Add classes `v !== undefined && isNotLoaded(v) ? "not-loaded" : ""`, `v !== undefined && (isPartial(v) || isLargeText(v, largeValueChars)) ? "partial" : ""`, and `isLoading?.(ri.index, col) ? "loading" : ""`.
  - Replace the non-editing `<span>` with:

```tsx
                        v !== undefined && isNotLoaded(v) ? (
                          <span className="not-loaded-label" title={cellTitle?.(ri.index, col) ?? "Click to load"}>
                            {isLoading?.(ri.index, col) ? <span className="spinner spinner-xs" /> : "Not loaded"}
                          </span>
                        ) : v !== undefined && (isPartial(v) || isLargeText(v, largeValueChars)) ? (
                          <>
                            <span className="partial-preview">{(isPartial(v) ? v.$partial : previewText(v)).replace(/[\r\n]+/g, " ⏎ ")}…</span>
                            <span className="size-tag">{sizeLabel(c.typeName, isPartial(v) ? v.length : v.length)}</span>
                          </>
                        ) : (
                          <span className={tone === "enum" ? "tag" : undefined}>{v === undefined ? "…" : cellDisplay(v)}</span>
                        )
```

  The cell `title` stays `cellTitle?.(…)`. For a partial cell with no `cellTitle`, use `"Open to see the full value"`. For a large string, `v.length` is the JS string length; good enough for a label.

**`app.css`**, near the existing `.grid-cell.null` rules:

```css
.grid-cell.not-loaded .not-loaded-label {
  color: var(--text-muted);
  font-style: italic;
}
.grid-cell.partial {
  display: flex;
  gap: 6px;
  align-items: center;
}
.grid-cell.partial .partial-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}
.grid-cell .size-tag {
  flex: none;
  font-size: 11px;
  color: var(--text-muted);
  border: 1px solid var(--border-hairline);
  border-radius: 4px;
  padding: 0 4px;
}
.col-deferred {
  color: var(--text-muted);
  display: inline-flex;
  margin-left: 4px;
}
.spinner-xs {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}
```

Use only token names that already exist in `tokens.css`. Check with `grep -n -- "--text-muted\|--text-secondary\|--border-hairline" src/styles/tokens.css`, and substitute the nearest existing token if one is missing.

**Settings:**
- In `settings.ts`, add `"grid.largeValueChars": number;` to `Settings`. Defaults: `"grid.pageSize": 150` and `"grid.largeValueChars": 256`.
- In `SettingsDialog.tsx`, in the grid section, rename the label to "Rows per page" and add:

```tsx
              <NumberField label="Preview query results longer than (characters)" k="grid.largeValueChars" min={64} max={100000} hint="Longer text in query results shows a preview; click to open it." />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib src/features/data-grid src/features/settings 2>&1 | grep -E "×|Tests "; npm run typecheck 2>&1 | grep error; npm run lint 2>&1 | grep -E "error" | head`
Expected: all pass, with no type or lint errors. If a settings test asserted the old 300 default, update it to 150.

- [ ] **Step 6: Commit**

```bash
git add src/lib src/features/data-grid src/styles/app.css src/stores/settings.ts src/features/settings && \
git commit -m "feat: grid shows Not loaded and previewed values, loads on click, copies full values"
```

---

### Task 6: Value editor panel (JSON and text)

**Files:**
- Create:
  - `src/features/value-editor/json.ts`;
  - `src/features/value-editor/json.test.ts`;
  - `src/features/value-editor/ValueEditor.tsx`;
  - `src/features/value-editor/ValueEditor.test.tsx`.
- Modify:
  - `package.json` and `package-lock.json` (`@codemirror/lang-json`);
  - `docs/DEPENDENCY_LICENSES.md`;
  - `src/features/sql-editor/SqlEditor.tsx` (export the highlight style);
  - `src/styles/app.css`.

**Interfaces:**
- **Produces, in `json.ts`:**
  - `validateJson(text: string): { ok: true } | { ok: false; line: number; column: number; message: string }`;
  - `formatJson(text: string): string`, which throws on invalid input and preserves number and string literals exactly.
- **Produces, `<ValueEditor …/>`:**

```ts
export interface ValueEditorProps {
  /** e.g. "orders · payload · id = 42" or "Query result · body · row 3" */
  title: string;
  typeName: string;
  mode: "json" | "text";
  /** Fetches the full value (resolves at once when it is already loaded). */
  load: () => Promise<Cell>;
  /** Why the value can't be changed; null when it can. */
  readOnlyReason: string | null;
  nullable: boolean;
  onSave: (value: string | null) => void;
  onClose: () => void;
}
```

- **Produces, in `SqlEditor.tsx`:** `export const EDITOR_HIGHLIGHT` (rename the module's `highlight` constant and export it).

- [ ] **Step 1: Add the dependency**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null && npm view @codemirror/lang-json version time --json | tail -5`

Pick the newest version that is at least two weeks old, then:
`npm install --save-exact @codemirror/lang-json@<that version>`.

Add a row to `docs/DEPENDENCY_LICENSES.md` in the frontend table, in the same format as `@codemirror/lang-sql`:
`| @codemirror/lang-json | <version> | MIT | github.com/codemirror/lang-json | JSON highlighting in the value editor |`.

- [ ] **Step 2: Write the failing tests**

`json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatJson, validateJson } from "./json";

describe("validateJson", () => {
  it("accepts valid documents", () => {
    for (const t of ['{"a": [1, 2.5e3, true, null, "x"]}', "[]", '"s"', "12345678901234567890", ' { "é": "\\u00e9" } ']) {
      expect(validateJson(t)).toEqual({ ok: true });
    }
  });
  it("reports line and column of the first error", () => {
    expect(validateJson('{\n  "a": 1,\n  }')).toMatchObject({ ok: false, line: 3, column: 3 });
    expect(validateJson('{"a" 1}')).toMatchObject({ ok: false, line: 1, column: 6 });
    expect(validateJson("")).toMatchObject({ ok: false, line: 1, column: 1, message: "Empty document" });
    expect(validateJson("[1,]")).toMatchObject({ ok: false, line: 1, column: 4 });
    expect(validateJson('{"a": 1} x')).toMatchObject({ ok: false, line: 1, column: 10 });
    expect(validateJson("NaN").ok).toBe(false);
  });
});

describe("formatJson", () => {
  it("indents with two spaces and never changes literals", () => {
    const src = '{"big":12345678901234567890,"f":1.0,"s":"\\u00e9\\n","b":[true,null],"o":{}}';
    expect(formatJson(src)).toBe(
      '{\n  "big": 12345678901234567890,\n  "f": 1.0,\n  "s": "\\u00e9\\n",\n  "b": [\n    true,\n    null\n  ],\n  "o": {}\n}',
    );
    expect(formatJson('{"z":1,"a":2}')).toBe('{\n  "z": 1,\n  "a": 2\n}');
    expect(() => formatJson("{")).toThrow();
  });
});
```

`ValueEditor.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { ValueEditor } from "./ValueEditor";
import { Overlays } from "../../components/Overlays";

beforeEach(() => {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

function setText(text: string) {
  const view = EditorView.findFromDOM(document.querySelector(".value-editor .cm-editor") as HTMLElement)!;
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

describe("ValueEditor", () => {
  it("loads, validates JSON, and saves only valid changes", async () => {
    const onSave = vi.fn();
    render(<ValueEditor title="orders · payload · id = 1" typeName="jsonb" mode="json" load={async () => '{"a":1}'} readOnlyReason={null} nullable onSave={onSave} onClose={() => {}} />);
    expect(await screen.findByText("Valid JSON")).toBeInTheDocument();
    setText('{"a": }');
    expect(await screen.findByText(/^Invalid JSON: line 1, column 7/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    setText('{"a": 2}');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith('{"a": 2}');
  });

  it("formats without changing numbers, and sets NULL", async () => {
    const onSave = vi.fn();
    render(<ValueEditor title="t" typeName="json" mode="json" load={async () => '{"n":1.0}'} readOnlyReason={null} nullable onSave={onSave} onClose={() => {}} />);
    await screen.findByText("Valid JSON");
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(document.querySelector(".value-editor .cm-content")!.textContent).toContain('"n": 1.0');
    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("is read-only with a reason, and shows load errors with Retry", async () => {
    let fail = true;
    render(
      <ValueEditor
        title="t"
        typeName="text"
        mode="text"
        load={async () => {
          if (fail) throw { kind: "not_found", message: "This row no longer exists" };
          return "hello";
        }}
        readOnlyReason="Read-only connection"
        nullable
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("This row no longer exists")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Read-only connection")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("asks before closing with unsaved changes", async () => {
    const onClose = vi.fn();
    render(
      <>
        <ValueEditor title="t" typeName="text" mode="text" load={async () => "a"} readOnlyReason={null} nullable={false} onSave={() => {}} onClose={onClose} />
        <Overlays />
      </>,
    );
    await waitFor(() => expect(document.querySelector(".value-editor .cm-content")).not.toBeNull());
    setText("b");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Discard your changes to this value?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Set NULL" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/features/value-editor 2>&1 | grep -E "×|Tests |Error" | head`
Expected: they fail, because the modules don't exist.

- [ ] **Step 4: Implement `json.ts`**

It is a small recursive-descent checker and formatter. It never uses `JSON.parse` for formatting, so literals are preserved byte for byte, and its error positions don't depend on the WebView engine's error messages.

```ts
// JSON checking and formatting for the value editor. Formatting re-emits the original
// tokens, so numbers like 12345678901234567890 or 1.0 and string escapes never change.

export type JsonCheck = { ok: true } | { ok: false; line: number; column: number; message: string };

class JsonError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

type Tok = { kind: "{" | "}" | "[" | "]" | ":" | "," | "lit"; text: string; pos: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if ("{}[]:,".includes(ch)) {
      toks.push({ kind: ch as Tok["kind"], text: ch, pos: i });
      i++;
    } else if (ch === '"') {
      const start = i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          if (e === "u") {
            if (!/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) throw new JsonError("Bad \\u escape", i);
            i += 6;
            continue;
          }
          if (e === undefined || !'"\\/bfnrt'.includes(e)) throw new JsonError("Bad escape", i);
          i += 2;
          continue;
        }
        if (src.charCodeAt(i) < 0x20) throw new JsonError("Control character in string", i);
        i++;
      }
      if (i >= src.length) throw new JsonError("Unterminated string", start);
      i++;
      toks.push({ kind: "lit", text: src.slice(start, i), pos: start });
    } else {
      const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i));
      if (!m) throw new JsonError(`Unexpected character '${ch}'`, i);
      toks.push({ kind: "lit", text: m[0], pos: i });
      i += m[0].length;
    }
  }
  return toks;
}

/** Parses tokens into the same token stream, checking structure; returns the formatted text. */
function format(src: string): string {
  const toks = tokenize(src);
  if (toks.length === 0) throw new JsonError("Empty document", 0);
  let k = 0;
  const out: string[] = [];
  const peek = () => toks[k];
  const fail = (msg: string): never => {
    throw new JsonError(msg, peek()?.pos ?? src.length);
  };
  const value = (depth: number): void => {
    const t = peek() ?? fail("Unexpected end of document");
    const pad = (d: number) => "  ".repeat(d);
    if (t.kind === "lit") {
      out.push(t.text);
      k++;
    } else if (t.kind === "{" || t.kind === "[") {
      const close = t.kind === "{" ? "}" : "]";
      k++;
      if (peek()?.kind === close) {
        out.push(t.kind + close);
        k++;
        return;
      }
      out.push(t.kind + "\n");
      for (;;) {
        out.push(pad(depth + 1));
        if (t.kind === "{") {
          const key = peek();
          if (!key || key.kind !== "lit" || !key.text.startsWith('"')) fail("Expected a property name");
          out.push(key!.text);
          k++;
          if (peek()?.kind !== ":") fail("Expected ':'");
          k++;
          out.push(": ");
        }
        value(depth + 1);
        const sep = peek() ?? fail(`Expected ',' or '${close}'`);
        if (sep.kind === ",") {
          k++;
          if (peek()?.kind === close) fail("Trailing comma");
          out.push(",\n");
        } else if (sep.kind === close) {
          k++;
          out.push("\n" + pad(depth) + close);
          return;
        } else {
          fail(`Expected ',' or '${close}'`);
        }
      }
    } else {
      fail(`Unexpected '${t.text}'`);
    }
  };
  value(0);
  if (k < toks.length) fail("Unexpected text after the document");
  return out.join("");
}

function position(src: string, pos: number): { line: number; column: number } {
  const before = src.slice(0, pos);
  const line = before.split("\n").length;
  return { line, column: pos - before.lastIndexOf("\n") };
}

export function validateJson(text: string): JsonCheck {
  try {
    format(text);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    return { ok: false, ...position(text, e.pos), message: e.message };
  }
}

export function formatJson(text: string): string {
  return format(text);
}
```

Check the test expectations against this code:
- `{\n  "a": 1,\n  }`: the error is "Trailing comma", reported at the `}` token's position, which is line 3, column 3.
- `{"a" 1}`: the error is "Expected ':'", at position 5, which is column 6.
- `[1,]`: the error is at the `]` (position 3), which is column 4.
- `{"a": 1} x`: the error is "Unexpected character 'x'", raised by the tokenizer at position 9, which is column 10.

If any expectation and the code disagree by one, fix the code, not the test: columns are 1-based.

- [ ] **Step 5: Implement `ValueEditor.tsx`**

Rename `const highlight` in `SqlEditor.tsx` to `export const EDITOR_HIGHLIGHT`, and update its single use. Then:

```tsx
import { useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { foldGutter, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import type { Cell } from "../../types/backend";
import { Dialog } from "../../components/Dialog";
import { confirmAction } from "../../stores/ui";
import { formatBytes } from "../../lib/cells";
import { toError } from "../../lib/ipc";
import { EDITOR_HIGHLIGHT, EDITOR_THEME } from "../sql-editor/SqlEditor";
import { formatJson, validateJson } from "./json";

export interface ValueEditorProps {
  title: string;
  typeName: string;
  mode: "json" | "text";
  load: () => Promise<Cell>;
  readOnlyReason: string | null;
  nullable: boolean;
  onSave: (value: string | null) => void;
  onClose: () => void;
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; original: string | null };

export function ValueEditor({ title, typeName, mode, load, readOnlyReason, nullable, onSave, onClose }: ValueEditorProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded({ state: "loading" });
    load()
      .then((c) => {
        if (!alive) return;
        const value = typeof c === "string" ? c : null;
        setText(value ?? "");
        setLoaded({ state: "ready", original: value });
      })
      .catch((e) => alive && setLoaded({ state: "error", message: toError(e).message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (loaded.state !== "ready" || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: loaded.original ?? "",
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          syntaxHighlighting(EDITOR_HIGHLIGHT),
          EditorView.theme(EDITOR_THEME),
          ...(mode === "json" ? [json(), foldGutter()] : [EditorView.lineWrapping]),
          EditorState.readOnly.of(readOnlyReason !== null),
          EditorView.updateListener.of((u) => u.docChanged && setText(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, [loaded, mode, readOnlyReason]);

  const ready = loaded.state === "ready";
  const original = ready ? loaded.original : null;
  const dirty = ready && text !== (original ?? "");
  const check = mode === "json" && ready ? validateJson(text) : null;
  const size = ready ? formatBytes(new TextEncoder().encode(text).length) : null;

  const close = async () => {
    if (dirty && !(await confirmAction({ title: "Discard your changes to this value?", body: "The edits in this editor have not been saved.", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };
  const replace = (next: string) => {
    const v = view.current;
    if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
  };

  return (
    <Dialog
      title={title}
      subtitle={
        <span className="hint">
          {typeName}
          {size ? ` · ${size}` : ""}
        </span>
      }
      className="value-editor"
      onClose={() => void close()}
      footer={
        <>
          <button className="btn btn-ghost" disabled={!ready} onClick={() => void navigator.clipboard.writeText(text)}>
            Copy
          </button>
          {mode === "json" && ready && (
            <button className="btn btn-ghost" disabled={!check?.ok} onClick={() => replace(formatJson(text))}>
              Format
            </button>
          )}
          {readOnlyReason === null && nullable && ready && (
            <button className="btn btn-ghost" disabled={original === null} onClick={() => onSave(null)}>
              Set NULL
            </button>
          )}
          <span className="value-editor-status" role="status">
            {check ? (check.ok ? "Valid JSON" : `Invalid JSON: line ${check.line}, column ${check.column}: ${check.message}`) : null}
          </span>
          <button className="btn" onClick={() => void close()}>
            {readOnlyReason === null ? "Cancel" : "Close"}
          </button>
          {readOnlyReason === null && (
            <button className="btn btn-primary" disabled={!ready || !dirty || (check !== null && !check.ok)} onClick={() => onSave(text)}>
              Save
            </button>
          )}
        </>
      }
    >
      {loaded.state === "loading" && <div className="empty"><div className="spinner" /></div>}
      {loaded.state === "error" && (
        <div className="empty">
          <p>{loaded.message}</p>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {readOnlyReason !== null && ready && <p className="hint">{readOnlyReason}</p>}
      {ready && <div ref={host} className="value-editor-body" />}
    </Dialog>
  );
}
```

**`app.css`:**

```css
.dialog.value-editor {
  width: min(1200px, 80vw);
  height: 80vh;
  max-width: none;
  display: flex;
  flex-direction: column;
}
.value-editor .dialog-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.value-editor-body {
  flex: 1;
  min-height: 0;
}
.value-editor-body .cm-editor {
  height: 100%;
}
.value-editor-status {
  flex: 1;
  color: var(--text-muted);
  font-size: 12px;
}
```

Check the class names `Dialog` renders: `grep -n "className=" src/components/Dialog.tsx`. Adjust `.dialog`/`.dialog-body` if they differ.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/features/value-editor src/features/sql-editor 2>&1 | grep -E "×|Tests "; npm run typecheck 2>&1 | grep error; npm run lint 2>&1 | grep error | head`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json docs/DEPENDENCY_LICENSES.md src/features/value-editor src/features/sql-editor/SqlEditor.tsx src/styles/app.css && \
git commit -m "feat: value editor panel with JSON checking and lossless formatting"
```

---

### Task 7: Opened tables: lazy pages, loading, editor, Load this column, overrides, copy, inspector

**Files:**
- Modify:
  - `src/features/data-browser/TableView.tsx`;
  - `src/features/data-browser/RowDetail.tsx`.
- Test:
  - `src/features/data-browser/TableView.test.tsx`;
  - `src/features/data-browser/RowDetail.test.tsx`.

**Interfaces:**
- **Consumes:**
  - `api.fetchValue`, `api.fetchColumn`, `api.listColumnFetch` and `api.setColumnFetch` (Tasks 2 and 3);
  - the grid props from Task 5;
  - `ValueEditor` from Task 6.
- **Produces, `RowDetail` props:**
  - `onLoad?: (col: number) => void`;
  - `onOpenEditor?: (col: number) => void`;
  - `largeValueChars?: number`.

- [ ] **Step 1: Write the failing tests** (in `TableView.test.tsx`)

Add a fixture and a `describe` block:

```tsx
const docsStructure: TableStructure = {
  ...usersStructure,
  name: "docs",
  columns: [
    { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: 1, autoIncrement: false, comment: null },
    { name: "title", dataType: "character varying(50)", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "body", dataType: "text", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "doc", dataType: "jsonb", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
  ],
  foreignKeys: [],
};

describe("large values in opened tables", () => {
  const NL = { $notLoaded: true };
  let page: unknown[][];
  let fetched: Record<string, unknown>;
  beforeEach(() => {
    calls = [];
    page = [
      ["1", "one", NL, NL],
      ["2", "two", NL, NL],
    ];
    fetched = { "1:body": "x".repeat(5000), "2:body": "short", "1:doc": '{"a":1}', "2:doc": null };
    mockIPC((cmd, args) => {
      const a = args as Record<string, any>;
      calls.push({ cmd, args: a });
      switch (cmd) {
        case "table_structure":
          return docsStructure;
        case "list_column_fetch":
          return [];
        case "browse_table":
          return {
            columns: [
              { name: "id", typeName: "int4" },
              { name: "title", typeName: "varchar" },
              { name: "body", typeName: "text", deferred: true },
              { name: "doc", typeName: "jsonb", deferred: true },
            ],
            rows: page,
            sql: "SELECT …",
            durationMs: 1,
            hasMore: false,
          };
        case "fetch_value":
          if (a.key[0].value === "9") throw { kind: "not_found", message: "This row no longer exists" };
          return fetched[`${a.key[0].value}:${a.column}`];
        case "fetch_column":
          return a.keys.map((k: { value: string }[]) => ({ found: true, value: fetched[`${k[0]!.value}:${a.column}`] }));
        case "preview_changes":
          return { sql: "UPDATE …", statementCount: 1, atomic: true };
        case "apply_changes":
          return [1];
        default:
          return null;
      }
    });
  });

  const view = () =>
    render(
      <>
        <TableView session={session} schema="public" table="docs" onReconnect={async () => {}} />
        <Overlays />
      </>,
    );

  it("asks for a lazy page with the stored overrides and shows Not loaded", async () => {
    view();
    expect(await screen.findAllByText("Not loaded")).toHaveLength(4);
    const browse = calls.find((c) => c.cmd === "browse_table")!;
    expect(browse.args.request).toMatchObject({ lazy: true, loadColumns: [], deferColumns: [], limit: 150 });
  });

  it("loads short text inline on click, and opens long text in the editor", async () => {
    view();
    const cells = await screen.findAllByText("Not loaded");
    fireEvent.click(cells[2]!.closest(".grid-cell")!); // row 2 body
    expect(await screen.findByText("short")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "fetch_value")!.args).toMatchObject({ table: "docs", column: "body", key: [{ column: "id", value: "2" }] });
    fireEvent.click(screen.getAllByText("Not loaded")[0]!.closest(".grid-cell")!); // row 1 body (5000 chars)
    expect(await screen.findByRole("dialog", { name: /docs · body · id = 1/ })).toBeInTheDocument();
  });

  it("edits a loaded value in the editor and commits with the full original", async () => {
    view();
    fireEvent.doubleClick((await screen.findAllByText("Not loaded"))[1]!.closest(".grid-cell")!); // row 1 doc (JSON)
    await screen.findByText("Valid JSON");
    const v = EditorView.findFromDOM(document.querySelector(".value-editor .cm-editor") as HTMLElement)!;
    act(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '{"a":2}' } }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: /Commit/ }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.set as ChangeSet;
    const change = set.changes[0] as Extract<ChangeSet["changes"][number], { type: "update" }>;
    expect(change.edits[0]).toMatchObject({ column: "doc", value: { kind: "value", value: '{"a":2}' }, original: '{"a":1}' });
  });

  it("Load this column fetches the page in one request, without hiding pending edits", async () => {
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /body/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Load this column" }));
    expect(await screen.findByText("short")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "fetch_column")).toHaveLength(1);
  });

  it("an override is saved and reloads the page", async () => {
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /body/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Always load" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "set_column_fetch")).toBe(true));
    expect(calls.find((c) => c.cmd === "set_column_fetch")!.args).toMatchObject({ connectionId: session.connectionId, column: "body", mode: "load" });
    await waitFor(() => expect(calls.filter((c) => c.cmd === "browse_table")).toHaveLength(2));
  });

  it("copies full values for a mixed selection", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    page = [["2", "two", NL, null]];
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.mouseDown(screen.getByText("two").closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getByText("NULL").closest(".grid-cell")!, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledWith("two\tshort\t"));
  });

  it("says when the row is gone", async () => {
    page = [["9", "nine", NL, NL]];
    view();
    fireEvent.click((await screen.findAllByText("Not loaded"))[0]!.closest(".grid-cell")!);
    expect(await screen.findByText("This row no longer exists")).toBeInTheDocument();
    expect(screen.getAllByText("Not loaded")).toHaveLength(2);
  });
});
```

Adjust the imports: `act`, `vi`, `EditorView` from `@codemirror/view`, and the `ChangeSet` type. If the grid's role or name differs (`screen.getByRole("grid")`), use `screen.getByLabelText("Rows of docs")`. Also add the `Range.prototype` patches from `WorkspaceView.test.tsx` to this file's `beforeEach` (CodeMirror needs them).

The existing tests' `browse_table` mock returns `columns: []`. That still works, because TableView falls back to the structure columns when `page.columns` is empty.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/data-browser 2>&1 | grep -E "×|Tests "`
Expected: the new tests fail.

- [ ] **Step 3: Implement `TableView.tsx`**

- **State:**
  - `const largeValueChars = useSettings((s) => s.settings["grid.largeValueChars"]);`
  - `const [overrides, setOverrides] = useState<ColumnFetch[] | null>(null);`
  - `const [loadingCells, setLoadingCells] = useState<Set<string>>(new Set());`
  - `const [editorAt, setEditorAt] = useState<{ row: number; col: number } | null>(null);`
  - `const gridRef` already exists.
- **Load overrides** together with the structure. In the effect that fetches `table_structure`, also run `api.listColumnFetch(session.connectionId, schema, table).then(setOverrides).catch(() => setOverrides([]))`. Change the effect that first calls `load()` to wait until both `structure` and `overrides !== null`.
- **The browse request** in `load` adds:

```ts
          lazy: true,
          loadColumns: (overrides ?? []).filter((o) => o.mode === "load").map((o) => o.column),
          deferColumns: (overrides ?? []).filter((o) => o.mode === "defer").map((o) => o.column),
```

  Add `overrides` to `load`'s dependency list.
- **Deferred flags for grid columns:** `const deferredCols = new Set((page?.columns ?? []).filter((c) => c.deferred).map((c) => c.name));`. Pass `deferred: deferredCols.has(c.name)` in the grid `columns` mapping.
- **Key of a loaded row:**

```ts
  const keyOf = useCallback(
    (row: number) =>
      (structure?.columns ?? [])
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.primaryKey !== null)
        .sort((a, b) => (a.c.primaryKey ?? 0) - (b.c.primaryKey ?? 0))
        .map(({ c, i }) => ({ column: c.name, value: cellParam(rows[row]?.[i] ?? null) ?? null })),
    [structure, rows],
  );
```

- **Put a fetched value into the page** (the page is the cache, cleared by any reload):

```ts
  const putCells = (updates: { row: number; col: number; value: Cell }[]) =>
    setPage((p) => {
      if (!p) return p;
      const next = p.rows.map((r) => r.slice());
      for (const u of updates) if (next[u.row]) next[u.row]![u.col] = u.value;
      return { ...p, rows: next };
    });
```

- **Load one cell**, de-duplicated by `row:col`, with a toast on failure:

```ts
  const inflight = useRef(new Map<string, Promise<Cell | undefined>>());
  const loadCell = (row: number, col: number): Promise<Cell | undefined> => {
    const k = `${row}:${col}`;
    const existing = inflight.current.get(k);
    if (existing) return existing;
    setLoadingCells((s) => new Set(s).add(k));
    const p = api
      .fetchValue(session.sessionId, schema, table, keyOf(row), columns[col]!.name)
      .then((value) => {
        putCells([{ row, col, value }]);
        return value;
      })
      .catch((e) => {
        notifyError(e, "Could not load the value");
        return undefined;
      })
      .finally(() => {
        inflight.current.delete(k);
        setLoadingCells((s) => {
          const n = new Set(s);
          n.delete(k);
          return n;
        });
      });
    inflight.current.set(k, p);
    return p;
  };
```

  When the error message is "This row no longer exists", `notifyError` shows it as the toast text. Use `notifyError(e)` with no title if the helper puts the title first. Check how `notifyError` renders, and make the test's `findByText("This row no longer exists")` match the visible text.
- **Open a cell:**

```ts
  const needsEditor = (row: number, col: number, cell: Cell | undefined) =>
    isJsonType(columns[col]?.dataType ?? "") || isLargeText(cell, largeValueChars);

  const onOpenCell = (row: number, col: number, how: "click" | "open") => {
    if (row >= rows.length) return false; // inserted rows edit inline
    const cell = getRow(row)?.[col];
    if (cell !== undefined && isNotLoaded(cell)) {
      void loadCell(row, col).then((v) => {
        if (v === undefined) return;
        if (needsEditor(row, col, v)) setEditorAt({ row, col });
        else if (how === "open") gridRef.current?.startEdit({ row, col });
      });
      return true;
    }
    if (how === "open" && needsEditor(row, col, cell)) {
      setEditorAt({ row, col });
      return true;
    }
    return false;
  };
```

- **Copy and "Load this column":**

```ts
  const loadFull = async (cells: CellPos[]): Promise<Cell[]> => {
    const out: Cell[] = cells.map((p) => getRow(p.row)?.[p.col] ?? null);
    const byCol = new Map<number, number[]>();
    cells.forEach((p, i) => {
      const c = getRow(p.row)?.[p.col];
      if (c !== undefined && isNotLoaded(c) && p.row < rows.length) byCol.set(p.col, [...(byCol.get(p.col) ?? []), i]);
    });
    for (const [col, idx] of byCol) {
      const got = await api.fetchColumn(session.sessionId, schema, table, columns[col]!.name, idx.map((i) => keyOf(cells[i]!.row)));
      const updates: { row: number; col: number; value: Cell }[] = [];
      got.forEach((f, k) => {
        if (!f.found) return;
        out[idx[k]!] = f.value;
        updates.push({ row: cells[idx[k]!]!.row, col, value: f.value });
      });
      putCells(updates);
    }
    return out;
  };

  const loadColumn = (col: number) =>
    void loadFull(rows.map((_, r) => ({ row: r, col }))).catch((e) => notifyError(e, "Could not load the column"));
```

- **Header items**, only for tables with a key, and not for key columns:

```ts
  const setOverride = (column: string, mode: FetchMode | null) =>
    guard(async () => {
      await api.setColumnFetch(session.connectionId, schema, table, column, mode);
      const next = await api.listColumnFetch(session.connectionId, schema, table);
      setOverrides(next);
    });
  const headerItems = (col: number): MenuEntry[] => {
    const c = columns[col];
    if (!c || !hasPk || c.primaryKey !== null || !isTable) return [];
    const current = overrides?.find((o) => o.column === c.name)?.mode ?? null;
    return [
      { label: "Load this column", onSelect: () => loadColumn(col), disabled: !deferredCols.has(c.name) },
      { label: "Always load", onSelect: () => setOverride(c.name, "load"), disabled: current === "load" },
      { label: "Don't load", onSelect: () => setOverride(c.name, "defer"), disabled: current === "defer" },
      { label: "Use default", onSelect: () => setOverride(c.name, null), disabled: current === null },
    ];
  };
```

  Reloading after an override: add an effect `useEffect(() => { if (structure && overrides) void load(); }, [overrides])`, with the exhaustive-deps comment explaining that the reload follows a changed override. `guard` (which already exists) asks before discarding pending edits.
- **The grid:** pass `onOpenCell`, `loadFull`, `headerItems`, `isLoading={(r, c) => loadingCells.has(`${r}:${c}`)}` and `largeValueChars`.
- **The editor:**

```tsx
      {editorAt && structure && (
        <ValueEditor
          title={`${table} · ${columns[editorAt.col]!.name} · ${keyOf(editorAt.row).map((k) => `${k.column} = ${k.value ?? "NULL"}`).join(", ")}`}
          typeName={columns[editorAt.col]!.dataType}
          mode={isJsonType(columns[editorAt.col]!.dataType) ? "json" : "text"}
          load={async () => {
            const c = getRow(editorAt.row)?.[editorAt.col] ?? null;
            if (c !== null && isNotLoaded(c)) {
              const v = await api.fetchValue(session.sessionId, schema, table, keyOf(editorAt.row), columns[editorAt.col]!.name);
              putCells([{ row: editorAt.row, col: editorAt.col, value: v }]);
              return v;
            }
            return c;
          }}
          readOnlyReason={canEdit(editorAt.row, editorAt.col) ? null : (readOnlyReason ?? "This value can't be changed here")}
          nullable={columns[editorAt.col]!.nullable}
          onSave={(v) => {
            onEdit(editorAt.row, editorAt.col, v);
            setEditorAt(null);
          }}
          onClose={() => setEditorAt(null)}
        />
      )}
```

  `readOnlyReason` is the existing variable used by the access pill.
- **`canEdit`:** keep it, but make `v !== undefined && !isBinary(v) && !isNotLoaded(v)` the last line. A Not loaded cell becomes editable only after it's loaded.
- **The editor's `original`:** `editCell` in `pending.ts` compares with `rows[row][col]`. That is the full value after `putCells`, so the commit's `original` is the full value (Review Focus 3).
- **Pending edits:** `displayRow` lays pending edits over `rows`, so loading a column never hides an edit.
- **Imports:**
  - `isNotLoaded`, `isLargeText`, `isJsonType`, `cellParam` from `../../lib/cells`;
  - `ValueEditor` from `../value-editor/ValueEditor`;
  - the `ColumnFetch`, `FetchMode` and `Cell` types;
  - `MenuEntry` from `../../components/Menu`;
  - `CellPos` from the grid.

**`RowDetail.tsx`:**
- Add the optional props `onLoad`, `onOpenEditor` and `largeValueChars = 256`.
- In `Field`, take `onLoad` and `onOpenEditor` as props. Before the binary branch:

```tsx
      {isNotLoaded(value) ? (
        <button className="btn btn-ghost" onClick={onLoad}>
          Load
        </button>
      ) : (isJsonType(column.dataType) || isLargeText(value, largeValueChars)) && onOpenEditor ? (
        <div>
          <pre className="hint">{typeof value === "string" ? previewText(value) + (value.length > 80 ? "…" : "") : "NULL"}</pre>
          <button className="btn btn-ghost" onClick={onOpenEditor}>
            Open editor
          </button>
        </div>
      ) : isBinary(value) ? ( /* existing binary branch continues */
```

- TableView passes `onLoad={(c) => selectedRowIndex !== null && void loadCell(selectedRowIndex, c)}`, `onOpenEditor={(c) => selectedRowIndex !== null && setEditorAt({ row: selectedRowIndex, col: c })}` and `largeValueChars`. Use the existing selected-row variable, whatever TableView calls it (`selection.active?.row`).
- **`RowDetail.test.tsx`:** add a test: a Not loaded field shows **Load** and calls `onLoad(col)`; a JSON field shows **Open editor** and calls `onOpenEditor(col)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/data-browser src/features/data-grid 2>&1 | grep -E "×|Tests "; npm run typecheck 2>&1 | grep error; npm run lint 2>&1 | grep error | head`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/data-browser && git commit -m "feat: opened tables load large values on demand, with editor, Load this column and overrides"
```

---

### Task 8: Query results: open previews in the editor, edit through it, copy full values

**Files:**
- Modify:
  - `src/features/sql-editor/ResultsPanel.tsx`;
  - `src/features/sql-editor/QueryTab.tsx` (pass `largeValueChars`).
- Test: `src/features/sql-editor/ResultsPanel.test.tsx`.

**Interfaces:**
- **Consumes:**
  - `api.resultValue` (Task 4);
  - the grid props (Task 5);
  - `ValueEditor` (Task 6);
  - `setEdit`, `readOnlyReason` and `cellId` from `resultEdits.ts`.

- [ ] **Step 1: Write the failing tests** (append to the `editable results` describe)

```tsx
  it("opens a previewed value from memory and edits it with the full original", async () => {
    const big = "y".repeat(1000);
    const st: StatementResult = {
      ...editable,
      rows: [["1", { $partial: "y".repeat(80), length: 1000 }, "2"]],
      totalRows: 1,
    };
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "result_value") return big;
      if (cmd === "preview_change_sets") return { sql: "UPDATE …", statementCount: 1, atomic: true };
      if (cmd === "apply_change_sets") return [1];
      return null;
    });
    render(
      <>
        <ResultsPanel result={scriptOf(st)} running={false} dialect="postgres" session={session} />
        <Overlays />
      </>,
    );
    expect(screen.getByText("1,000 chars")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("1,000 chars").closest(".grid-cell")!);
    await screen.findByRole("dialog", { name: /Query result · email · row 1/ });
    expect(calls.find((c) => c.cmd === "result_value")!.args).toMatchObject({ resultId: "r1", row: 0, col: 1 });
    const v = EditorView.findFromDOM(document.querySelector(".value-editor .cm-editor") as HTMLElement)!;
    await waitFor(() => expect(v.state.doc.length).toBe(1000));
    act(() => v.dispatch({ changes: { from: 0, to: 1, insert: "z" } }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_change_sets")).toBe(true));
    const sets = (calls.find((c) => c.cmd === "apply_change_sets")!.args as { sets: ChangeSet[] }).sets;
    const ch = sets[0]!.changes[0] as Extract<ChangeSet["changes"][number], { type: "update" }>;
    expect(ch.edits[0]).toMatchObject({ column: "email", original: big });
  });
```

Add the `Range.prototype` patches to this file's `beforeEach` if they aren't already there, and import `EditorView`, `act` and `ChangeSet`. The `editable` fixture's column 1 is `email`, with origin `users.email`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/sql-editor/ResultsPanel.test.tsx 2>&1 | grep -E "×|Tests "`
Expected: the new test fails.

- [ ] **Step 3: Implement**

**In `ResultGrid`:**
- Add a prop `onOpenValue: (rowIndex: number, col: number) => void`.
- Pass `largeValueChars` to the grid.
- Pass:

```tsx
      onOpenCell={(r, c, how) => {
        const cell = rows[r]?.[c];
        const json = isJsonType(st.columns![c]!.typeName);
        if (how === "open" && cell !== undefined && (isPartial(cell) || json || isLargeText(cell, largeValueChars))) {
          onOpenValue(r, c);
          return true;
        }
        return false;
      }}
      loadFull={async (cells) =>
        Promise.all(
          cells.map(async (p) => {
            const c = rows[p.row]?.[p.col] ?? null;
            return c !== null && isPartial(c) && st.resultId ? api.resultValue(st.resultId, p.row, p.col) : c;
          }),
        )
      }
```

- Expose a `putCell(row, col, value)` from `ResultGrid` that updates its `rows` state, so the editor can swap in the full value. Implement it with a callback ref: `onReady?: (put: (r: number, c: number, v: Cell) => void) => void`, called in an effect. `ResultsPanel` stores it in `putCellRef`.

**In `ResultsPanel`:**
- Add state `const [valueAt, setValueAt] = useState<{ row: number; col: number } | null>(null);`.
- Add `const largeValueChars = useSettings((s) => s.settings["grid.largeValueChars"]);`.
- The editor needs the row's cells for key and edit purposes: `const rowCells = useRef<Cell[] | null>(null);`, filled in `load`.

```tsx
      {valueAt && current && (
        <ValueEditor
          title={`Query result · ${current.columns![valueAt.col]!.name} · row ${valueAt.row + 1}`}
          typeName={current.columns![valueAt.col]!.typeName}
          mode={isJsonType(current.columns![valueAt.col]!.typeName) ? "json" : "text"}
          load={async () => {
            const row = (await api.fetchRows(current.resultId!, valueAt.row, 1))[0] ?? [];
            const full = await api.resultValue(current.resultId!, valueAt.row, valueAt.col);
            const cells = row.map((c, i) => (i === valueAt.col ? full : c));
            rowCells.current = cells;
            setValueReason(!editable ? "Query results can't be edited here" : readOnlyReason(current, cells, valueAt.col, curApplied));
            putCellRef.current?.(valueAt.row, valueAt.col, full);
            return full;
          }}
          readOnlyReason={valueReason}
          nullable
          onSave={(v) => {
            if (rowCells.current) onEdit(rowCells.current, valueAt.col, v);
            setValueAt(null);
          }}
          onClose={() => setValueAt(null)}
        />
      )}
```

Notes on `load`:
- `api.fetchRows` returns previews for other long cells in that row. Key columns are never long, so `cellId` and `keyOf` work.
- `onEdit` → `setEdit` takes `original` from `cells[col]`, which is now the full value (Review Focus 3).
- `valueReason` is state: `const [valueReason, setValueReason] = useState<string | null>(null);`. It's set inside `load` once the row is known, and reset to `null` whenever `valueAt` changes.
- Wire `onOpenValue={(r, c) => setValueAt({ row: r, col: c })}` on `ResultGrid`.

**`QueryTab.tsx`:** in the `api.runQuery(…)` options, add `largeValueChars: settings["grid.largeValueChars"],`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/sql-editor src/app 2>&1 | grep -E "×|Tests "; npm run typecheck 2>&1 | grep error; npm run lint 2>&1 | grep error | head`
Expected: all pass, including the earlier editable-results and WorkspaceView tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor && git commit -m "feat: query results open previewed values in the editor and copy full values"
```

---

### Task 9: Docs, benchmark, manual check, full verification

**Files:**
- Modify:
  - `docs/FEATURE_MATRIX.md`;
  - `docs/DATABASE_ADAPTERS.md`;
  - `docs/ARCHITECTURE.md` (the "Result transport" section).

- [ ] **Step 1: Docs**

- **`FEATURE_MATRIX.md`:** add a row next to the table-browsing rows:

  `| Large values on demand | Opened tables leave unbounded columns (text, json/jsonb, xml, blobs, arrays) out of the page query and load them by key on click; per-column overrides; query results preview long text from memory; JSON/text editor with JSON checking | VERIFIED | large_values.rs, browse.rs (build_select_projected, build_fetch), engine.rs (fetch_value, fetch_column, result_value), DataGrid.tsx, ValueEditor.tsx | all | unit (large_values, browse, json); integration lazy_values (PG MY MA SQ DuckDB); TableView/ResultsPanel/ValueEditor tests; manual (Xvfb); benchmark in PR | Tables without a primary key load every column |`
- **`DATABASE_ADAPTERS.md`:** add a section "Large values on demand" containing:
  - the type table from the spec ("Which columns are deferred");
  - the sentence "The page query never selects a deferred column; PostgreSQL leaves those values in TOAST storage";
  - the fetch query shape.
- **`ARCHITECTURE.md`:** under "Result transport", add one paragraph covering:
  - the lazy page;
  - `fetch_value`/`fetch_column` by key;
  - query results previewing text longer than `grid.largeValueChars` with `Cell::Partial`, opened through `result_value`;
  - export always reading full rows.

- [ ] **Step 2: Benchmark (disposable PostgreSQL only)**

```bash
eval "$(scripts/test-db.sh env)"
docker exec -i tpm-test-postgres psql -U postgres -d tpm_test -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE tpm_bench_docs (id int PRIMARY KEY, title varchar(50), body text, doc jsonb);
INSERT INTO tpm_bench_docs
SELECT g, 'row ' || g, repeat('lorem ipsum ', 9000),
       (SELECT jsonb_object_agg('k' || i, repeat('v', 90)) FROM generate_series(1, 1000) i)
FROM generate_series(1, 150) g;
SQL
docker exec tpm-test-postgres psql -U postgres -d tpm_test -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id::text, title::text, body::text, doc::text FROM tpm_bench_docs ORDER BY id LIMIT 150"
docker exec tpm-test-postgres psql -U postgres -d tpm_test -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id::text, title::text FROM tpm_bench_docs ORDER BY id LIMIT 150"
```

Record:
- execution time and shared buffers (the TOAST reads) for both queries;
- `browse` wall-clock time and response size, measured with a throwaway `#[ignore]`d test or a `cargo run --example`, not committed: lazy against non-lazy, timed with `Instant`, size from `serde_json::to_vec(&result).len()`.

Put the numbers in the PR description, separating the server, network and client effects. Then drop the table:
`docker exec tpm-test-postgres psql -U postgres -d tpm_test -c "DROP TABLE tpm_bench_docs"`.

- [ ] **Step 3: Manual check (Xvfb, isolated data dir, test PostgreSQL)**

Build: `source target/tpm-scratch/sysroot/env.sh; cargo build -p table-pro-max`. Launch with `target/tpm-scratch/shots/launch.sh` (isolated XDG dirs, no D-Bus), and connect the test PostgreSQL by pasting its URL. With `tpm_bench_docs` re-created, check:
1. Opening the table shows "Not loaded" for `body` and `doc`, and `title` inline.
2. Clicking `body` opens the text editor.
3. Double-clicking `doc` opens the JSON editor showing "Valid JSON":
   - breaking the JSON disables Save and shows the line and column;
   - Format leaves numbers unchanged.
4. Saving makes the cell amber; review and commit, then verify it in `psql`.
5. "Load this column" and "Always load" work, and the latter survives reopening the table.
6. Copying a row puts the full text on the clipboard.
7. In a query tab, `SELECT * FROM tpm_bench_docs LIMIT 5` shows previews with sizes, and opening one is instant.

Take screenshots in dark and light into `target/tpm-scratch/shots/lv-*.png`. Stop the app and drop the table afterwards.

- [ ] **Step 4: Full verification**

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test -p tpm-core
eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration
source target/tpm-scratch/sysroot/env.sh && cargo check -p table-pro-max
source ~/.nvm/nvm.sh && nvm use 24 && npm run typecheck && npm run lint && npm test && npm run build
```

Expected: everything passes.

- [ ] **Step 5: Commit the docs**

`git add docs && git commit -m "docs: large values on demand in the feature matrix, adapters and architecture"`

- [ ] **Step 6: Finish**
  - Run the fresh whole-branch review, then the fix pass.
  - Push and open the PR. It touches `src-tauri/`, so add the `full-ci` label.
  - Put the benchmark numbers in the PR.
  - Squash-merge after **CI passed**.
