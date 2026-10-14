# Editable Query Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit cells in a query's result grid when the database itself says which table row and column a cell came from. The edits go through the existing pending → review → one-transaction commit flow.

**Architecture:**
- **Origins.** Adapters attach each result column's origin (`schema.table.column`) to `ColumnMeta`:
  - MySQL/MariaDB from the protocol's column definition;
  - SQLite through rusqlite's `column_metadata` feature;
  - PostgreSQL through a describe-only `prepare` after the statement ran.
- **Editability.** A pure function in `tpm-core` turns origins plus table structures into a `ResultEditing` description. The engine attaches it to each row-returning `StatementResult`.
- **Commit.** A new multi-table `apply_change_sets` commits in one transaction, reusing `changes::build_statements`.
- **Frontend.** A pure module tracks result edits by cell identity, and `ResultsPanel` gets editable cells, the commit bar, the review dialog and the row inspector.

**Tech Stack:**
- Rust: `tpm-core`, `tokio-postgres` 0.7.18, `mysql_async` 0.37 / `mysql_common` 0.37.3, `rusqlite` 0.40.2 (adds feature `column_metadata`), `duckdb` 1.10506.0.
- Tauri 2 commands.
- React 19 + TypeScript, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-14-editable-query-results-design.md`

## Global Constraints
- **Primary key missing from the result:** that table is read-only, with a hint. The app never changes or re-runs the user's query.
- **Joins:** editable per table when that table's full primary key is in the result. One commit can touch several tables, all in one transaction.
- **DuckDB:** query results are read-only, with the note "Query results can't be edited on DuckDB".
- **Scope:** change values and set NULL only. No delete or insert from query results.
- **Source of truth:** the database's own column-origin metadata. No SQL parsing.
- **Values and identifiers:** values are always bind parameters, and identifiers go through `Dialect::quote_ident` checked against `TableStructure`. Reuse `changes::build_statements` and do not write new SQL builders.
- **Backend checks:** read-only is refused in the backend, and confirmation is required (`confirmed: true`), as in `Engine::apply_changes`.
- **One session per query tab:** never two operations at once. Editing is disabled while the tab is running.
- **No new network calls:** the PostgreSQL describe and catalog lookups go to the user's own database.
- **Origin lookup errors never fail the query.** Columns just get no origin.
- **Code style:** about 160-column lines, no formatter run on whole files, and match the surrounding code. Use `cargo fmt --all` for Rust only on files you touched, and check that the diff stays small.
- **Node 24:** `source ~/.nvm/nvm.sh && nvm use 24`.
- **Integration tests:** `scripts/test-db.sh up && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration`. Only the `tpm-test-*` containers.

## Review Focus
1. **The same table joined to itself** (`FROM users a JOIN users b`). Both sides report the same origin table, so the key columns are ambiguous and the wrong row could be updated. Expected: that table is read-only, with the reason "`users` appears more than once". Task 1 test.
2. **The same column selected twice, or a row repeated across a join.** An edit must show in every identical cell, and must commit only one UPDATE. Task 4 test.
3. **A result that is still loading pages (`fetch_rows`).** Edits on loaded rows must survive further pages arriving, and rows that aren't loaded yet are never touched. Task 5 test.
4. **Run again or closing the tab with pending result edits.** Both must ask first, like a dirty table tab. Task 5 test.
5. **The row changed in the database between query and commit.** Nothing is written, the edits stay pending, and the error is shown. Task 3 integration test.

---

### Task 1: Column origins, `ResultEditing` and the editability rule (core, pure)

**Files:**
- Modify: `crates/tpm-core/src/model.rs` (`ColumnMeta`, new `ColumnOrigin`)
- Create: `crates/tpm-core/src/result_edit.rs`
- Modify: `crates/tpm-core/src/lib.rs` (add `pub mod result_edit;`)
- Test: unit tests inside `result_edit.rs`

**Interfaces:**
- Produces:
  - `model::ColumnOrigin { schema: String, table: String, column: String }`, serde camelCase.
  - `ColumnMeta.origin: Option<ColumnOrigin>`, serde `default` and `skip_serializing_if = "Option::is_none"`.
  - `ColumnMeta::with_origin(self, Option<ColumnOrigin>) -> Self`.
  - `result_edit::ResultEditing { tables: Vec<EditableTable>, columns: Vec<Option<usize>>, read_only: Vec<ReadOnlyReason> }`.
  - `result_edit::EditableTable { schema: String, table: String, key_columns: Vec<usize> }`. `key_columns` holds result indexes in primary-key order.
  - `result_edit::ReadOnlyReason { column: Option<usize>, reason: String }`.
  - `pub fn origin_tables(columns: &[ColumnMeta]) -> Vec<(String, String)>`: distinct `(schema, table)` in first-seen order.
  - `pub fn result_editing(columns: &[ColumnMeta], structures: &[TableStructure]) -> ResultEditing`.
  - `pub fn not_editable(columns: &[ColumnMeta], reason: &str) -> ResultEditing`: every column `None`, one reason with `column: None`.
  - All serde `rename_all = "camelCase"`. `ResultEditing` and its parts derive `Debug, Clone, PartialEq, Serialize`.

- [ ] **Step 1: Write the failing tests** (bottom of the new `result_edit.rs`; create the file with only the test module first, and the `mod` line in `lib.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnInfo, ColumnMeta, ColumnOrigin, ObjectKind, TableStructure};

    fn col(name: &str, origin: Option<(&str, &str, &str)>) -> ColumnMeta {
        ColumnMeta::new(name, "").with_origin(origin.map(|(s, t, c)| ColumnOrigin { schema: s.into(), table: t.into(), column: c.into() }))
    }
    fn table(schema: &str, name: &str, kind: ObjectKind, cols: &[(&str, Option<u32>)]) -> TableStructure {
        TableStructure {
            schema: schema.into(),
            name: name.into(),
            kind,
            columns: cols
                .iter()
                .map(|(n, pk)| ColumnInfo {
                    name: (*n).into(),
                    data_type: "text".into(),
                    nullable: true,
                    default: None,
                    primary_key: *pk,
                    auto_increment: false,
                    comment: None,
                })
                .collect(),
            ..Default::default()
        }
    }
    fn users() -> TableStructure {
        table("public", "users", ObjectKind::Table, &[("id", Some(1)), ("email", None), ("name", None)])
    }

    #[test]
    fn single_table_with_key_is_editable_and_computed_columns_are_not() {
        let cols = vec![col("id", Some(("public", "users", "id"))), col("mail", Some(("public", "users", "email"))), col("n", None)];
        let e = result_editing(&cols, &[users()]);
        assert_eq!(e.tables, vec![EditableTable { schema: "public".into(), table: "users".into(), key_columns: vec![0] }]);
        assert_eq!(e.columns, vec![Some(0), Some(0), None]);
        assert!(e.read_only.iter().any(|r| r.column == Some(2) && r.reason == "Computed column"));
    }

    #[test]
    fn missing_key_makes_the_table_read_only_with_a_hint() {
        let cols = vec![col("email", Some(("public", "users", "email")))];
        let e = result_editing(&cols, &[users()]);
        assert!(e.tables.is_empty());
        assert_eq!(e.columns, vec![None]);
        assert_eq!(e.read_only[0], ReadOnlyReason { column: Some(0), reason: "Add id to the SELECT to edit users".into() });
    }

    #[test]
    fn join_is_editable_per_table() {
        let orders = table("public", "orders", ObjectKind::Table, &[("id", Some(1)), ("status", None), ("user_id", None)]);
        let cols = vec![
            col("id", Some(("public", "orders", "id"))),
            col("status", Some(("public", "orders", "status"))),
            col("email", Some(("public", "users", "email"))),
        ];
        let e = result_editing(&cols, &[orders, users()]);
        assert_eq!(e.tables.len(), 1);
        assert_eq!(e.tables[0].table, "orders");
        assert_eq!(e.columns, vec![Some(0), Some(0), None]);
        assert!(e.read_only.iter().any(|r| r.column == Some(2) && r.reason == "Add id to the SELECT to edit users"));
    }

    #[test]
    fn views_and_tables_without_keys_stay_read_only() {
        let v = table("public", "active_users", ObjectKind::View, &[("id", None), ("email", None)]);
        let nokey = table("public", "log", ObjectKind::Table, &[("msg", None)]);
        let cols = vec![col("id", Some(("public", "active_users", "id"))), col("msg", Some(("public", "log", "msg")))];
        let e = result_editing(&cols, &[v, nokey]);
        assert!(e.tables.is_empty());
        assert_eq!(e.read_only[0].reason, "active_users is a view");
        assert_eq!(e.read_only[1].reason, "log has no primary key");
    }

    #[test]
    fn composite_keys_need_every_part_and_keep_key_order() {
        let t = table("public", "pairs", ObjectKind::Table, &[("b", Some(2)), ("a", Some(1)), ("v", None)]);
        let only_a = vec![col("a", Some(("public", "pairs", "a"))), col("v", Some(("public", "pairs", "v")))];
        assert!(result_editing(&only_a, &[t.clone()]).tables.is_empty());
        let both = vec![col("v", Some(("public", "pairs", "v"))), col("b", Some(("public", "pairs", "b"))), col("a", Some(("public", "pairs", "a")))];
        assert_eq!(result_editing(&both, &[t]).tables[0].key_columns, vec![2, 1]);
    }

    #[test]
    fn a_table_that_appears_twice_is_read_only() {
        // Self-join: two `id` columns from the same table. The key is ambiguous.
        let cols = vec![
            col("id", Some(("public", "users", "id"))),
            col("id", Some(("public", "users", "id"))),
            col("email", Some(("public", "users", "email"))),
        ];
        let e = result_editing(&cols, &[users()]);
        assert!(e.tables.is_empty());
        assert!(e.read_only.iter().any(|r| r.reason == "users appears more than once, so rows cannot be told apart"));
    }

    #[test]
    fn a_missing_structure_is_read_only_not_an_error() {
        let cols = vec![col("id", Some(("public", "gone", "id")))];
        let e = result_editing(&cols, &[]);
        assert!(e.tables.is_empty());
        assert_eq!(e.read_only[0].reason, "Could not read the structure of gone");
    }

    #[test]
    fn not_editable_blocks_everything_with_one_reason() {
        let cols = vec![col("id", Some(("public", "users", "id")))];
        let e = not_editable(&cols, "Read-only connection");
        assert_eq!(e.columns, vec![None]);
        assert_eq!(e.read_only, vec![ReadOnlyReason { column: None, reason: "Read-only connection".into() }]);
    }
}
```

Note on the self-join rule: a table counts as "appearing more than once" when any of its **primary-key** columns appears more than once in the result. Selecting a non-key column twice (for example `email, email`) is fine.

- [ ] **Step 2: Run them to verify they fail.** `cargo test -p tpm-core result_edit`. Expected: compile errors (`ColumnOrigin`, `with_origin` and `result_editing` are not defined).

- [ ] **Step 3: Implement.**

In `model.rs`, replace the `ColumnMeta` struct and its impl with:

```rust
/// Where a result column comes from, as reported by the database (absent for expressions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOrigin {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Server type name when known (empty for drivers that do not report it).
    pub type_name: String,
    /// Base table column this result column was read from, when the driver reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ColumnOrigin>,
}

impl ColumnMeta {
    pub fn new(name: impl Into<String>, type_name: impl Into<String>) -> Self {
        Self { name: name.into(), type_name: type_name.into(), origin: None }
    }

    pub fn with_origin(mut self, origin: Option<ColumnOrigin>) -> Self {
        self.origin = origin;
        self
    }
}
```

If `TableStructure` has no `Default` derive, add `Default` to its derive list (and to any field types that need it, e.g. `ObjectKind`: give it `#[derive(Default)]` with `#[default] Table`). The tests rely on `..Default::default()`.

In `result_edit.rs`, above the tests:

```rust
//! Which cells of a query result can be edited: the database reports each column's origin,
//! and a table is editable in a result when it is a real table whose whole primary key is
//! present exactly once. See docs/superpowers/specs/2026-10-14-editable-query-results-design.md.

use serde::Serialize;

use crate::model::{ColumnMeta, ObjectKind, TableStructure};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableTable {
    pub schema: String,
    pub table: String,
    /// Result column index of each primary-key column, in primary-key order.
    pub key_columns: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyReason {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEditing {
    pub tables: Vec<EditableTable>,
    /// Per result column: index into `tables`, or `None` when the column cannot be edited.
    pub columns: Vec<Option<usize>>,
    pub read_only: Vec<ReadOnlyReason>,
}

/// Distinct origin tables, in the order they first appear.
pub fn origin_tables(columns: &[ColumnMeta]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for o in columns.iter().filter_map(|c| c.origin.as_ref()) {
        let k = (o.schema.clone(), o.table.clone());
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

pub fn not_editable(columns: &[ColumnMeta], reason: &str) -> ResultEditing {
    ResultEditing { tables: vec![], columns: vec![None; columns.len()], read_only: vec![ReadOnlyReason { column: None, reason: reason.into() }] }
}

pub fn result_editing(columns: &[ColumnMeta], structures: &[TableStructure]) -> ResultEditing {
    let mut e = ResultEditing { tables: vec![], columns: vec![None; columns.len()], read_only: vec![] };
    // Reason per origin table that cannot be edited.
    let mut blocked: Vec<((String, String), String)> = Vec::new();
    for (schema, table) in origin_tables(columns) {
        let Some(s) = structures.iter().find(|s| s.schema == schema && s.name == table) else {
            blocked.push(((schema, table.clone()), format!("Could not read the structure of {table}")));
            continue;
        };
        if s.kind != ObjectKind::Table {
            blocked.push(((schema, table.clone()), format!("{table} is a view")));
            continue;
        }
        let mut pk: Vec<&crate::model::ColumnInfo> = s.columns.iter().filter(|c| c.primary_key.is_some()).collect();
        pk.sort_by_key(|c| c.primary_key);
        if pk.is_empty() {
            blocked.push(((schema, table.clone()), format!("{table} has no primary key")));
            continue;
        }
        let from_this = |i: usize, col: &str| {
            columns[i].origin.as_ref().is_some_and(|o| o.schema == schema && o.table == table && o.column == col)
        };
        let mut key_columns = Vec::new();
        let mut missing = Vec::new();
        let mut repeated = false;
        for k in &pk {
            let hits: Vec<usize> = (0..columns.len()).filter(|&i| from_this(i, &k.name)).collect();
            match hits.as_slice() {
                [] => missing.push(k.name.clone()),
                [i] => key_columns.push(*i),
                _ => repeated = true,
            }
        }
        if repeated {
            blocked.push(((schema, table.clone()), format!("{table} appears more than once, so rows cannot be told apart")));
            continue;
        }
        if !missing.is_empty() {
            blocked.push(((schema, table.clone()), format!("Add {} to the SELECT to edit {table}", missing.join(", "))));
            continue;
        }
        let idx = e.tables.len();
        e.tables.push(EditableTable { schema: schema.clone(), table: table.clone(), key_columns });
        for (i, c) in columns.iter().enumerate() {
            if let Some(o) = &c.origin {
                if o.schema == schema && o.table == table && s.columns.iter().any(|sc| sc.name == o.column) {
                    e.columns[i] = Some(idx);
                }
            }
        }
    }
    for (i, c) in columns.iter().enumerate() {
        if e.columns[i].is_some() {
            continue;
        }
        let reason = match &c.origin {
            None => "Computed column".to_string(),
            Some(o) => blocked
                .iter()
                .find(|((s, t), _)| *s == o.schema && *t == o.table)
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| format!("{} is not a column of {}", o.column, o.table)),
        };
        e.read_only.push(ReadOnlyReason { column: Some(i), reason });
    }
    e
}
```

- [ ] **Step 4: Run.** `cargo test -p tpm-core result_edit && cargo clippy -p tpm-core --all-targets`. Expected: 8 tests pass, and no clippy warnings in the new code.

- [ ] **Step 5: Commit.**

```bash
git add crates/tpm-core/src/model.rs crates/tpm-core/src/result_edit.rs crates/tpm-core/src/lib.rs
git commit -m "feat: column origins and the editability rule for query results"
```

---

### Task 2: Adapters report column origins

**Files:**
- Modify: `crates/tpm-core/Cargo.toml` (rusqlite features add `"column_metadata"`)
- Modify: `crates/tpm-core/src/adapters/mysql.rs` (`columns_meta`)
- Modify: `crates/tpm-core/src/adapters/sqlite.rs` (`run_query`)
- Modify: `crates/tpm-core/src/adapters/mod.rs` (new `Session::describe_origins` with a default)
- Modify: `crates/tpm-core/src/adapters/postgres.rs` (implement `describe_origins`, with a cache)
- Modify: `crates/tpm-core/src/engine.rs` (`execute_one` calls `describe_origins` when wanted)
- Test: `crates/tpm-core/tests/integration.rs` (new `origins` section)

**Interfaces:**
- Consumes: `ColumnOrigin` and `ColumnMeta::with_origin` (Task 1).
- Produces:
  - `Session::describe_origins(&mut self, sql: &str) -> Result<Vec<Option<ColumnOrigin>>>`. The default implementation returns `Ok(vec![])`.
  - Engine behaviour: for a statement whose outcome has rows, when every column's origin is `None` and the profile is not read-only, the engine calls `describe_origins` and fills origins by position. Lookup errors and length mismatches are ignored.

- [ ] **Step 1: Write the failing integration test.** In `crates/tpm-core/tests/integration.rs`, add this function and call it from `exercise` just before `// --- cleanup ---`: `origins(&engine, &sid, driver).await;`

```rust
/// Each engine reports where result columns come from (DuckDB cannot).
async fn origins(engine: &Engine, sid: &str, driver: Driver) {
    let r = run(engine, sid, "SELECT i.id, i.name AS label, o.name, i.price * 2 AS doubled, count(*) OVER () AS n FROM tpm_it_items i JOIN tpm_it_owners o ON o.id = i.owner_id").await;
    let cols = r.statements[0].columns.clone().expect("columns");
    let tables: Vec<Option<(String, String)>> = cols.iter().map(|c| c.origin.as_ref().map(|o| (o.table.clone(), o.column.clone()))).collect();
    if driver == Driver::Duckdb {
        assert!(tables.iter().all(Option::is_none), "duckdb reports no origins: {tables:?}");
        return;
    }
    assert_eq!(tables[0], Some(("tpm_it_items".into(), "id".into())), "{driver:?}");
    assert_eq!(tables[1], Some(("tpm_it_items".into(), "name".into())), "aliased column keeps its origin ({driver:?})");
    assert_eq!(tables[2], Some(("tpm_it_owners".into(), "name".into())), "{driver:?}");
    assert_eq!(tables[3], None, "expression has no origin ({driver:?})");
    assert_eq!(tables[4], None, "window aggregate has no origin ({driver:?})");
}
```

- [ ] **Step 2: Run it to verify it fails.**

```bash
scripts/test-db.sh up && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration -- --nocapture
```

Expected: FAIL on every engine except DuckDB, because the origins are `None`. SQLite runs without the containers.

- [ ] **Step 3: Implement.**

`Cargo.toml`:

```toml
rusqlite = { version = "0.40.2", features = ["bundled", "column_decltype", "column_metadata"] }
```

`mysql.rs`, replacing `columns_meta`:

```rust
fn columns_meta(cols: &[Column]) -> Vec<ColumnMeta> {
    cols.iter()
        .map(|c| {
            // org_table/org_name are the base table and column; empty for expressions and derived values.
            let origin = (!c.org_table_str().is_empty() && !c.org_name_str().is_empty()).then(|| ColumnOrigin {
                schema: c.schema_str().into_owned(),
                table: c.org_table_str().into_owned(),
                column: c.org_name_str().into_owned(),
            });
            ColumnMeta::new(c.name_str(), type_name(c)).with_origin(origin)
        })
        .collect()
}
```

Check that the `*_str()` methods return `Cow<str>` in mysql_common 0.37.3 (`packets/mod.rs` around lines 370–428). If they return `&str`, use `.to_string()`. Import `ColumnOrigin` from `crate::model`.

`sqlite.rs`, in `run_query`, replacing the `columns` line:

```rust
    let columns: Vec<ColumnMeta> = stmt
        .columns_with_metadata()
        .iter()
        .zip(stmt.columns().iter())
        .map(|(m, c)| {
            let origin = match (m.database_name(), m.table_name(), m.origin_name()) {
                (Some(d), Some(t), Some(o)) => Some(ColumnOrigin { schema: d.into(), table: t.into(), column: o.into() }),
                _ => None,
            };
            ColumnMeta::new(c.name(), c.decl_type().unwrap_or("")).with_origin(origin)
        })
        .collect();
```

Check the accessor names on `rusqlite::ColumnMetadata` in `~/.cargo/registry/src/*/rusqlite-0.40.2/src/column.rs` (`database_name()`, `table_name()`, `origin_name()`) and adjust if they differ. Import `ColumnOrigin`.

`adapters/mod.rs`, in `trait Session`, after `execute`:

```rust
    /// Base-table origin of each column the statement returns, by position, without running it.
    /// Drivers that report origins while executing (MySQL, SQLite) or cannot at all (DuckDB) keep the default.
    async fn describe_origins(&mut self, _sql: &str) -> Result<Vec<Option<ColumnOrigin>>> {
        Ok(vec![])
    }
```

`postgres.rs`:
- add the field `origin_names: HashMap<(u32, i16), (String, String, String)>` to `PgSession`, initialised empty in the constructor;
- implement the method in the `Session` impl:

```rust
    async fn describe_origins(&mut self, sql: &str) -> Result<Vec<Option<ColumnOrigin>>> {
        // Describe only: prepare parses and plans the statement but never executes it.
        let stmt = self.client.prepare(sql).await.map_err(map_error)?;
        let cols: Vec<(Option<u32>, Option<i16>)> = stmt.columns().iter().map(|c| (c.table_oid(), c.column_id())).collect();
        let missing: Vec<u32> = {
            let mut m: Vec<u32> = cols
                .iter()
                .filter_map(|(t, a)| match (t, a) {
                    (Some(t), Some(a)) if !self.origin_names.contains_key(&(*t, *a)) => Some(*t),
                    _ => None,
                })
                .collect();
            m.sort_unstable();
            m.dedup();
            m
        };
        if !missing.is_empty() {
            let rows = self
                .client
                .query(
                    "SELECT a.attrelid, a.attnum, n.nspname, c.relname, a.attname FROM pg_attribute a \
                     JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped",
                    &[&missing],
                )
                .await
                .map_err(map_error)?;
            for r in rows {
                let oid: u32 = r.get(0);
                let attnum: i16 = r.get(1);
                self.origin_names.insert((oid, attnum), (r.get(2), r.get(3), r.get(4)));
            }
        }
        Ok(cols
            .into_iter()
            .map(|(t, a)| match (t, a) {
                (Some(t), Some(a)) => self
                    .origin_names
                    .get(&(t, a))
                    .map(|(s, tb, c)| ColumnOrigin { schema: s.clone(), table: tb.clone(), column: c.clone() }),
                _ => None,
            })
            .collect())
    }
```

`$1` is `oid[]`: `Vec<u32>` maps to `oid[]` in `postgres-types` (`u32` ↔ `oid`). If the cast is rejected, write `ANY($1::oid[])`.

`engine.rs`, `execute_one`: the closure runs `execute` and then, when wanted, `describe_origins`. Compute `want` before building the future:

```rust
        let want_origins = !handle.profile.read_only();
        let fut = self.with_session(&handle.info.session_id, move |s| {
            Box::pin(async move {
                let mut outcomes = s.execute(&sql_owned, max_rows).await?;
                if want_origins {
                    for o in outcomes.iter_mut() {
                        if let StatementOutcome::Rows { rows } = o {
                            if rows.columns.iter().all(|c| c.origin.is_none()) {
                                // Origins are a bonus: a failed describe leaves the result read-only.
                                if let Ok(found) = s.describe_origins(&sql_owned).await {
                                    if found.len() == rows.columns.len() {
                                        for (c, o) in rows.columns.iter_mut().zip(found) {
                                            c.origin = o;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(outcomes)
            })
        });
```

Keep the rest of `execute_one` unchanged.

- [ ] **Step 4: Run.**

```bash
cargo test -p tpm-core && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration -- --nocapture
```

Expected: PASS on PostgreSQL, MySQL, MariaDB, SQLite and DuckDB.

If MySQL reports an empty `org_table` for window functions, or a table for `i.price * 2`, adapt the assertion to what the engine really reports, then ledger a ruling. The safety property is that an expression must never get an origin. If a driver gives an origin to an expression, that is a real bug: stop and investigate.

- [ ] **Step 5: Commit.**

```bash
git add crates/tpm-core/Cargo.toml Cargo.lock crates/tpm-core/src/adapters crates/tpm-core/src/engine.rs crates/tpm-core/tests/integration.rs
git commit -m "feat: adapters report where query result columns come from"
```

---

### Task 3: Engine attaches `editing` to results, and multi-table preview and apply

**Files:**
- Modify: `crates/tpm-core/src/engine.rs` (`StatementResult.editing`, a new `editing_for`, `preview_change_sets`, `apply_change_sets`; `apply_changes` delegates)
- Modify: `src-tauri/src/commands/query.rs` and `src-tauri/src/lib.rs` (two new commands)
- Modify: `src/types/backend.ts` and `src/lib/ipc.ts` (types and calls)
- Test: `crates/tpm-core/tests/integration.rs` (new `edit_results` section)

**Interfaces:**
- Consumes: `result_edit::{result_editing, not_editable, origin_tables, ResultEditing}`, `changes::{build_statements, preview, ChangeSet}`.
- Produces:
  - Rust: `StatementResult.editing: Option<ResultEditing>` (`skip_serializing_if = "Option::is_none"`).
  - Rust: `Engine::preview_change_sets(&self, session_id: &str, sets: &[ChangeSet]) -> Result<ChangePreview>`.
  - Rust: `Engine::apply_change_sets(&self, session_id: &str, sets: &[ChangeSet], confirmed: bool) -> Result<Vec<u64>>`.
  - Tauri commands `preview_change_sets(session_id, sets)` and `apply_change_sets(session_id, sets, confirmed)`.
  - TS types (exact):

```ts
export interface ColumnOrigin { schema: string; table: string; column: string }
export interface ColumnMeta { name: string; typeName: string; origin?: ColumnOrigin }
export interface EditableTable { schema: string; table: string; keyColumns: number[] }
export interface ReadOnlyReason { column?: number; reason: string }
export interface ResultEditing { tables: EditableTable[]; columns: (number | null)[]; readOnly: ReadOnlyReason[] }
// StatementResult gains: editing?: ResultEditing;
```

  - IPC: `api.previewChangeSets(sessionId: string, sets: ChangeSet[]): Promise<ChangePreview>` and `api.applyChangeSets(sessionId: string, sets: ChangeSet[]): Promise<number[]>` (sends `confirmed: true`, like `applyChanges`).

- [ ] **Step 1: Write the failing integration test.** Add the function below to `integration.rs` and call it from `exercise` right after `origins(...)`: `edit_results(&engine, &sid, &profile, t.password.as_deref(), driver).await;`. Read `exercise`'s signature to see how `profile` and `password` are available.

```rust
/// Edit query results across two tables in one transaction; refuse on conflict; block where the rule says so.
async fn edit_results(engine: &Engine, sid: &str, profile: &ConnectionProfile, password: Option<&str>, driver: Driver) {
    use tpm_core::changes::{ChangeSet, ColumnEdit, ColumnValue, EditValue, RowChange};
    let r = run(engine, sid, "SELECT i.id, i.name, o.id, o.name FROM tpm_it_items i JOIN tpm_it_owners o ON o.id = i.owner_id ORDER BY i.id").await;
    let st = &r.statements[0];
    let editing = st.editing.clone().expect("editing info");
    if driver == Driver::Duckdb {
        assert!(editing.tables.is_empty());
        assert_eq!(editing.read_only[0].reason, "Query results can't be edited on DuckDB");
        return;
    }
    assert_eq!(editing.tables.len(), 2, "{driver:?}: {editing:?}");
    assert_eq!(editing.columns, vec![Some(0), Some(0), Some(1), Some(1)]);
    let row = &st.rows.as_ref().unwrap()[0];
    let item_id = text(&row[0]).to_string();
    let item_name = text(&row[1]).to_string();
    let owner_id = text(&row[2]).to_string();
    let owner_name = text(&row[3]).to_string();
    let edit = |col: &str, new: &str, old: &str| ColumnEdit {
        column: col.into(),
        value: EditValue::Value { value: Some(new.into()) },
        original: Some(Some(old.into())),
    };
    let schema = editing.tables[0].schema.clone();
    let sets = vec![
        ChangeSet {
            schema: schema.clone(),
            table: "tpm_it_items".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some(item_id.clone()) }],
                edits: vec![edit("name", "renamed item", &item_name)],
            }],
            check_conflicts: true,
        },
        ChangeSet {
            schema: schema.clone(),
            table: "tpm_it_owners".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some(owner_id.clone()) }],
                edits: vec![edit("name", "renamed owner", &owner_name)],
            }],
            check_conflicts: true,
        },
    ];
    let preview = engine.preview_change_sets(sid, &sets).await.unwrap();
    assert_eq!(preview.statement_count, 2);
    assert_eq!(engine.apply_change_sets(sid, &sets, false).await.unwrap_err().kind, ErrorKind::ConfirmationRequired);
    assert_eq!(engine.apply_change_sets(sid, &sets, true).await.unwrap(), vec![1, 1]);
    let after = run(engine, sid, &format!("SELECT name FROM tpm_it_items WHERE id = {item_id}")).await;
    assert_eq!(text(&after.statements[0].rows.as_ref().unwrap()[0][0]), "renamed item");

    // Conflict: the same edit again has a stale original, so nothing is written, including the first set.
    let stale = vec![
        ChangeSet {
            schema: schema.clone(),
            table: "tpm_it_owners".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some(owner_id.clone()) }],
                edits: vec![edit("name", "third", "renamed owner")],
            }],
            check_conflicts: true,
        },
        sets[0].clone(),
    ];
    let err = engine.apply_change_sets(sid, &stale, true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{driver:?}");
    let owner = run(engine, sid, &format!("SELECT name FROM tpm_it_owners WHERE id = {owner_id}")).await;
    assert_eq!(text(&owner.statements[0].rows.as_ref().unwrap()[0][0]), "renamed owner", "rolled back ({driver:?})");

    // Missing key: no editable table, and a hint.
    let nokey = run(engine, sid, "SELECT name FROM tpm_it_owners").await;
    let e = nokey.statements[0].editing.clone().unwrap();
    assert!(e.tables.is_empty());
    assert_eq!(e.read_only[0].reason, "Add id to the SELECT to edit tpm_it_owners");

    // Read-only session: nothing is editable.
    let mut ro = profile.clone();
    ro.safety_mode = SafetyMode::ReadOnly;
    let info = engine.open_session(&ro, password, None, ConnectOptions::default()).await.expect("read-only connect");
    let r = run(engine, &info.session_id, "SELECT id, name FROM tpm_it_owners").await;
    assert_eq!(r.statements[0].editing.clone().unwrap().read_only[0].reason, "Read-only connection");
    assert!(engine.apply_change_sets(&info.session_id, &sets, true).await.is_err());
    engine.close_session(&info.session_id).await;
}
```

Adjust these to the real code before running:
- the import paths for the `changes` types (`tpm_core::changes::…`);
- `SafetyMode::ReadOnly`: read `config.rs` `read_only()` to see which field makes a profile read-only;
- the stale case's first-set ordering, so that the conflicting set runs **first**.

The assertions stay as written.

- [ ] **Step 2: Run it to verify it fails.** `cargo test -p tpm-core --test integration` (with the env set as in Task 2). Expected: compile errors (`editing`, `preview_change_sets` and `apply_change_sets` are missing).

- [ ] **Step 3: Implement.**

In `engine.rs`:

1. **`StatementResult`.** Add the field:

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editing: Option<crate::result_edit::ResultEditing>,
```

Then set `editing: None` in every literal `StatementResult { … }`: `store_outcomes` and the error branch in `run_script`.

2. **`run_script`.** After `let mut produced = match res { … };`, add:

```rust
                if stmt.class == crate::safety::StatementClass::Read {
                    for r in produced.iter_mut() {
                        if let Some(cols) = r.columns.clone() {
                            r.editing = Some(self.editing_for(&handle, session_id, &cols).await);
                        }
                    }
                }
```

3. **The new method:**

```rust
    /// Which cells of a result can be edited (see result_edit.rs). Never fails: problems make cells read-only.
    async fn editing_for(&self, handle: &Arc<SessionHandle>, session_id: &str, cols: &[ColumnMeta]) -> crate::result_edit::ResultEditing {
        use crate::result_edit::{not_editable, origin_tables, result_editing};
        if handle.profile.read_only() {
            return not_editable(cols, "Read-only connection");
        }
        if handle.profile.driver == Driver::Duckdb {
            return not_editable(cols, "Query results can't be edited on DuckDB");
        }
        let mut structures = Vec::new();
        for (schema, table) in origin_tables(cols) {
            if let Ok(s) = self.table_structure(session_id, &schema, &table, false).await {
                structures.push(s);
            }
        }
        result_editing(cols, &structures)
    }
```

4. **Multi-table preview and apply.** Replace `preview_changes` and `apply_changes` with set-based versions, and keep the old ones as wrappers:

```rust
    pub async fn preview_changes(&self, session_id: &str, set: &ChangeSet) -> Result<ChangePreview> {
        self.preview_change_sets(session_id, std::slice::from_ref(set)).await
    }

    pub async fn preview_change_sets(&self, session_id: &str, sets: &[ChangeSet]) -> Result<ChangePreview> {
        let handle = self.handle(session_id)?;
        let mut statements = Vec::new();
        for set in sets {
            let structure = self.table_structure(session_id, &set.schema, &set.table, false).await?;
            statements.extend(build_statements(handle.info.dialect, &structure, set)?);
        }
        Ok(ChangePreview {
            sql: preview(handle.info.dialect, &statements),
            statement_count: statements.len(),
            atomic: handle.info.capabilities.transactions,
        })
    }

    /// Commits pending grid edits in one transaction. The review dialog in the UI is
    /// the confirmation step, so `confirmed` must be true.
    pub async fn apply_changes(&self, session_id: &str, set: &ChangeSet, confirmed: bool) -> Result<Vec<u64>> {
        self.apply_change_sets(session_id, std::slice::from_ref(set), confirmed).await
    }

    /// Commits edits to one or more tables (e.g. from a joined query result) in one transaction.
    pub async fn apply_change_sets(&self, session_id: &str, sets: &[ChangeSet], confirmed: bool) -> Result<Vec<u64>> {
        let handle = self.handle(session_id)?;
        if handle.profile.read_only() {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        if !confirmed {
            return Err(AppError::new(ErrorKind::ConfirmationRequired, "Review the pending changes before committing"));
        }
        let mut statements = Vec::new();
        for set in sets {
            let structure = self.table_structure(session_id, &set.schema, &set.table, true).await?;
            statements.extend(build_statements(handle.info.dialect, &structure, set)?);
        }
        let atomic = handle.info.capabilities.transactions;
        self.with_session(session_id, move |s| Box::pin(async move { s.apply(&statements, atomic).await })).await
    }
```

`src-tauri/src/commands/query.rs`, next to `apply_changes`:

```rust
#[tauri::command]
pub async fn preview_change_sets(state: State<'_, AppState>, session_id: String, sets: Vec<ChangeSet>) -> Result<ChangePreview> {
    state.engine.preview_change_sets(&session_id, &sets).await
}

#[tauri::command]
pub async fn apply_change_sets(state: State<'_, AppState>, session_id: String, sets: Vec<ChangeSet>, confirmed: bool) -> Result<Vec<u64>> {
    let r = state.engine.apply_change_sets(&session_id, &sets, confirmed).await;
    tracing::info!(session = %session_id, ok = r.is_ok(), tables = sets.len(), "applied result changes");
    r
}
```

Register both in `src-tauri/src/lib.rs`, next to `commands::query::apply_changes`.

`src/types/backend.ts`: add the TS types above, add `origin?: ColumnOrigin` to `ColumnMeta`, and add `editing?: ResultEditing` to `StatementResult`.

`src/lib/ipc.ts`, next to `applyChanges`:

```ts
  previewChangeSets: (sessionId: string, sets: ChangeSet[]) => call<ChangePreview>("preview_change_sets", { sessionId, sets }),
  applyChangeSets: (sessionId: string, sets: ChangeSet[]) => call<number[]>("apply_change_sets", { sessionId, sets, confirmed: true }),
```

- [ ] **Step 4: Run.**

```bash
cargo test -p tpm-core && cargo clippy --workspace --all-targets && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration -- --nocapture
source ~/.nvm/nvm.sh && nvm use 24 && npm run typecheck
```

Expected: all pass on the five engines, and typecheck is clean. `cargo clippy --workspace` builds `src-tauri` and needs the WebKitGTK dev packages. If they're missing locally, run `cargo check -p table-pro-max` through the sysroot shim (`source target/tpm-scratch/sysroot/env.sh`), as the earlier PRs did.

- [ ] **Step 5: Commit.**

```bash
git add crates/tpm-core src-tauri/src src/types/backend.ts src/lib/ipc.ts
git commit -m "feat: results say which cells can be edited; commit edits to several tables in one transaction"
```

---

### Task 4: Frontend edit model for results (pure)

**Files:**
- Create: `src/features/sql-editor/resultEdits.ts`, `src/features/sql-editor/resultEdits.test.ts`
- Modify: `src/features/data-browser/pending.ts`: export `cellParam` if it isn't exported yet (`export function cellParam(c: Cell): Param | undefined`).

**Interfaces:**
- Consumes: `StatementResult.editing` and `ColumnMeta.origin` (Task 3); `ChangeSet` (existing).
- Produces:

```ts
export interface ResultEdit { table: number; key: ColumnValue[]; column: string; value: Param; original?: Param }
export type ResultEdits = Record<string, ResultEdit>; // keyed by cellId
export function cellId(st: StatementResult, row: Cell[], col: number): string | null;
export function readOnlyReason(st: StatementResult, row: Cell[] | undefined, col: number): string | null; // null = editable
export function setEdit(edits: ResultEdits, st: StatementResult, row: Cell[], col: number, value: Param): ResultEdits;
export function displayCell(edits: ResultEdits, applied: Record<string, Param>, st: StatementResult, row: Cell[], col: number): Cell;
export function buildResultChangeSets(st: StatementResult, edits: ResultEdits): ChangeSet[];
```

`Param` is `string | null`, and `ColumnValue` comes from `src/types/backend.ts`. Check their exact names there.

- [ ] **Step 1: Write the failing tests** (`resultEdits.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import type { StatementResult } from "../../types/backend";
import { buildResultChangeSets, cellId, displayCell, readOnlyReason, setEdit } from "./resultEdits";

const st: StatementResult = {
  index: 0,
  sql: "select …",
  start: 0,
  end: 8,
  durationMs: 1,
  truncated: false,
  columns: [
    { name: "id", typeName: "int4", origin: { schema: "public", table: "orders", column: "id" } },
    { name: "status", typeName: "text", origin: { schema: "public", table: "orders", column: "status" } },
    { name: "cid", typeName: "int4", origin: { schema: "public", table: "customers", column: "id" } },
    { name: "email", typeName: "text", origin: { schema: "public", table: "customers", column: "email" } },
    { name: "n", typeName: "int8" },
  ],
  editing: {
    tables: [
      { schema: "public", table: "orders", keyColumns: [0] },
      { schema: "public", table: "customers", keyColumns: [2] },
    ],
    columns: [0, 0, 1, 1, null],
    readOnly: [{ column: 4, reason: "Computed column" }],
  },
};
const r1 = ["1", "paid", "7", "a@x", "3"];
const r2 = ["2", "new", "7", "a@x", "3"]; // same customer as r1
const rNullKey = ["3", "new", null, null, "3"]; // outer join: no customer

describe("result edits", () => {
  it("knows which cells can be edited and why not", () => {
    expect(readOnlyReason(st, r1, 1)).toBeNull();
    expect(readOnlyReason(st, r1, 4)).toBe("Computed column");
    expect(readOnlyReason(st, rNullKey, 3)).toBe("This row has no customers row");
    expect(readOnlyReason(st, undefined, 1)).toBe("Row not loaded");
  });

  it("one edit shows on every cell with the same identity", () => {
    expect(cellId(st, r1, 3)).toBe(cellId(st, r2, 3));
    const e = setEdit({}, st, r1, 3, "b@x");
    expect(displayCell(e, {}, st, r2, 3)).toBe("b@x");
    expect(displayCell(e, {}, st, r2, 1)).toBe("new");
  });

  it("builds one update per table row, keyed and with originals", () => {
    let e = setEdit({}, st, r1, 1, "shipped");
    e = setEdit(e, st, r2, 3, "b@x"); // the same customer as r1
    e = setEdit(e, st, r1, 3, "c@x"); // last edit wins
    const sets = buildResultChangeSets(st, e);
    expect(sets).toEqual([
      {
        schema: "public",
        table: "orders",
        checkConflicts: true,
        changes: [{ type: "update", key: [{ column: "id", value: "1" }], edits: [{ column: "status", value: { kind: "value", value: "shipped" }, original: "paid" }] }],
      },
      {
        schema: "public",
        table: "customers",
        checkConflicts: true,
        changes: [{ type: "update", key: [{ column: "id", value: "7" }], edits: [{ column: "email", value: { kind: "value", value: "c@x" }, original: "a@x" }] }],
      },
    ]);
  });

  it("applied values show after commit until the next run", () => {
    const id = cellId(st, r1, 1)!;
    expect(displayCell({}, { [id]: "shipped" }, st, r1, 1)).toBe("shipped");
  });

  it("an edit back to the original value is dropped", () => {
    const e = setEdit(setEdit({}, st, r1, 1, "shipped"), st, r1, 1, "paid");
    expect(Object.keys(e)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** `npx vitest run src/features/sql-editor/resultEdits.test.ts`. Expected: FAIL ("Failed to resolve import ./resultEdits").

- [ ] **Step 3: Implement** `resultEdits.ts`:

```ts
import type { Cell, ChangeSet, ColumnValue, RowChange, StatementResult } from "../../types/backend";
import { cellParam } from "../data-browser/pending";

type Param = string | null;

/** One pending result edit, stored once per source cell (table + primary key + column). */
export interface ResultEdit {
  table: number;
  key: ColumnValue[];
  column: string;
  value: Param;
  original?: Param;
}
export type ResultEdits = Record<string, ResultEdit>;

function keyOf(st: StatementResult, row: Cell[], table: number): ColumnValue[] | null {
  const t = st.editing!.tables[table]!;
  const key: ColumnValue[] = [];
  for (const i of t.keyColumns) {
    const v = cellParam(row[i] ?? null);
    if (v === undefined || v === null) return null;
    key.push({ column: st.columns![i]!.origin!.column, value: v });
  }
  return key;
}

/** Why this cell cannot be edited, or null when it can. */
export function readOnlyReason(st: StatementResult, row: Cell[] | undefined, col: number): string | null {
  const ed = st.editing;
  if (!ed) return "This result cannot be edited";
  const table = ed.columns[col];
  if (table === null || table === undefined) {
    return ed.readOnly.find((r) => r.column === col)?.reason ?? ed.readOnly.find((r) => r.column === undefined)?.reason ?? "This column cannot be edited";
  }
  if (!row) return "Row not loaded";
  if (cellParam(row[col] ?? null) === undefined) return "Binary values cannot be edited here";
  if (!keyOf(st, row, table)) return `This row has no ${ed.tables[table]!.table} row`;
  return null;
}

export function cellId(st: StatementResult, row: Cell[], col: number): string | null {
  const table = st.editing?.columns[col];
  if (table === null || table === undefined) return null;
  const key = keyOf(st, row, table);
  if (!key) return null;
  return JSON.stringify([table, key.map((k) => k.value), st.columns![col]!.origin!.column]);
}

export function setEdit(edits: ResultEdits, st: StatementResult, row: Cell[], col: number, value: Param): ResultEdits {
  const id = cellId(st, row, col);
  if (!id || readOnlyReason(st, row, col)) return edits;
  const table = st.editing!.columns[col]!;
  const original = cellParam(row[col] ?? null);
  const next = { ...edits };
  if (value === original) delete next[id];
  else next[id] = { table, key: keyOf(st, row, table)!, column: st.columns![col]!.origin!.column, value, original };
  return next;
}

export function displayCell(edits: ResultEdits, applied: Record<string, Param>, st: StatementResult, row: Cell[], col: number): Cell {
  const id = cellId(st, row, col);
  if (id && id in edits) return edits[id]!.value;
  if (id && id in applied) return applied[id]!;
  return row[col] ?? null;
}

export function buildResultChangeSets(st: StatementResult, edits: ResultEdits): ChangeSet[] {
  const sets: ChangeSet[] = [];
  st.editing!.tables.forEach((t, ti) => {
    const byRow = new Map<string, RowChange & { type: "update" }>();
    for (const e of Object.values(edits).filter((x) => x.table === ti)) {
      const k = JSON.stringify(e.key);
      const change = byRow.get(k) ?? { type: "update" as const, key: e.key, edits: [] };
      change.edits.push({ column: e.column, value: { kind: "value", value: e.value }, ...(e.original !== undefined ? { original: e.original } : {}) });
      byRow.set(k, change);
    }
    if (byRow.size) sets.push({ schema: t.schema, table: t.table, checkConflicts: true, changes: [...byRow.values()] });
  });
  return sets;
}
```

If `RowChange`'s TS union types `update` differently (check `src/types/backend.ts`), adapt the narrowing type, and keep the produced objects exactly as the test expects.

- [ ] **Step 4: Run.** `npx vitest run src/features/sql-editor/resultEdits.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor/resultEdits.ts src/features/sql-editor/resultEdits.test.ts src/features/data-browser/pending.ts
git commit -m "feat: edit model for query results keyed by source row and column"
```

---

### Task 5: Editable result grid, commit bar, review, Run again and close guards, and the row inspector

**Files:**
- Modify: `src/features/sql-editor/ResultsPanel.tsx` (state, grid wiring, commit bar, review dialog, hint line, inspector)
- Modify: `src/features/sql-editor/QueryTab.tsx` (props to ResultsPanel, the Run again confirmation, dirty reporting)
- Modify: `src/app/WorkspaceView.tsx` (query tabs report dirty result edits to `dirtyTables`, so closing asks)
- Modify: `src/styles/app.css` (only if a hint style is missing; reuse `.commit-bar` and `.access-pill`)
- Test: `src/features/sql-editor/ResultsPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: `resultEdits.ts` (Task 4); `api.previewChangeSets` and `api.applyChangeSets` (Task 3); `ReviewChangesDialog`, `RowDetail` and `DataGrid` (existing).
- Produces: `ResultsPanel` props become `{ result; running; dialect; session?: SessionInfo; onRunAgain?: () => void; onDirtyChange?: (dirty: boolean) => void }`.

- [ ] **Step 1: Write the failing tests.** Append to `ResultsPanel.test.tsx`. This reuses its existing imports, and adds `fireEvent`, `waitFor`, `mockIPC`, `clearMocks` and `session` from fixtures.

```tsx
const editable: StatementResult = {
  index: 0,
  sql: "select id, email, count(*) over () n from users",
  start: 0,
  end: 10,
  durationMs: 1,
  truncated: false,
  resultId: "r1",
  totalRows: 2,
  columns: [
    { name: "id", typeName: "int4", origin: { schema: "public", table: "users", column: "id" } },
    { name: "email", typeName: "text", origin: { schema: "public", table: "users", column: "email" } },
    { name: "n", typeName: "int8" },
  ],
  rows: [["1", "ada@example.com", "2"], ["2", "grace@example.com", "2"]],
  editing: { tables: [{ schema: "public", table: "users", keyColumns: [0] }], columns: [0, 0, null], readOnly: [{ column: 2, reason: "Computed column" }] },
};

describe("editable results", () => {
  let calls: { cmd: string; args: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "preview_change_sets") return { sql: "UPDATE …", statementCount: 1, atomic: true };
      if (cmd === "apply_change_sets") return [1];
      return null;
    });
  });
  afterEach(() => clearMocks());
  const scriptOf = (st: StatementResult): ScriptResult => ({ taskId: "t", statements: [st], cancelled: false, durationMs: 1 });

  it("edits a cell, reviews and commits through apply_change_sets", async () => {
    const onDirty = vi.fn();
    render(<ResultsPanel result={scriptOf(editable)} running={false} dialect="postgres" session={session} onDirtyChange={onDirty} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    const editor = screen.getByLabelText("Edit email");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_change_sets")).toBe(true));
    const sets = (calls.find((c) => c.cmd === "apply_change_sets")!.args as { sets: unknown[] }).sets;
    expect(sets).toHaveLength(1);
    expect(await screen.findByText(/Shows values from when the query ran, plus your edits/)).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
  });

  it("explains read-only cells and never edits them", () => {
    render(<ResultsPanel result={scriptOf(editable)} running={false} dialect="postgres" session={session} />);
    const cell = screen.getAllByText("2").find((el) => el.closest(".grid-cell")?.getAttribute("aria-colindex") === "4")!.closest(".grid-cell")!;
    expect(cell).toHaveAttribute("title", "Computed column");
    fireEvent.doubleClick(cell);
    expect(screen.queryByLabelText("Edit n")).not.toBeInTheDocument();
  });

  it("does not edit while the tab is running", () => {
    render(<ResultsPanel result={scriptOf(editable)} running dialect="postgres" session={session} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    expect(screen.queryByLabelText("Edit email")).not.toBeInTheDocument();
  });

  it("shows why a whole result is read-only", () => {
    const st = { ...editable, editing: { tables: [], columns: [null, null, null], readOnly: [{ column: 1, reason: "Add id to the SELECT to edit users" }] } };
    render(<ResultsPanel result={scriptOf(st)} running={false} dialect="postgres" session={session} />);
    expect(screen.getByText("Add id to the SELECT to edit users")).toBeInTheDocument();
  });

  it("keeps edits on loaded rows when more pages arrive", async () => {
    const big = { ...editable, totalRows: 3000, rows: editable.rows };
    const { rerender } = render(<ResultsPanel result={scriptOf(big)} running={false} dialect="postgres" session={session} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    const editor = screen.getByLabelText("Edit email");
    fireEvent.change(editor, { target: { value: "kept@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    rerender(<ResultsPanel result={scriptOf(big)} running={false} dialect="postgres" session={session} />);
    expect(screen.getByText("kept@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 pending change")).toBeInTheDocument();
  });
});
```

The `title` attribute holding the read-only reason requires DataGrid to accept a `cellTitle?: (row: number, col: number) => string | undefined` prop. Add it in this task: render `title={cellTitle?.(ri.index, col)}` on the cell div.

Also add a WorkspaceView-level test to `src/app/WorkspaceView.test.tsx` that covers Review Focus #4 for closing:

```tsx
  it("asks before closing a query tab whose results have pending edits", async () => {
    // Reuse renderWs; dirty result edits are reported through the same dirtyTables path as table tabs.
  });
```

Write this test concretely after implementing `onDirtyChange`. The pattern: render the query tab, simulate the QueryTab's `onDirtyChange(true)` through a result edit, press Ctrl+W, and expect "Close Query 1?". If driving a real edit through CodeMirror and the grid in jsdom proves impractical, test `requestClose` with `dirtyTables` pre-set via an exported helper instead, and ledger the ruling.

- [ ] **Step 2: Run them to verify they fail.** `npx vitest run src/features/sql-editor/ResultsPanel.test.tsx`. Expected: the new tests fail (the cells aren't editable and there's no commit bar).

- [ ] **Step 3: Implement.**

`ResultsPanel.tsx`:
- **State in `ResultsPanel`:** `edits: ResultEdits`, `applied: Record<string, Param>`, `review: { sql: string; statements: number; atomic: boolean } | null` and `detailOpen`. Reset all of them when `result` changes identity (a new run): `useEffect(() => { setEdits({}); setApplied({}); }, [result])`. Report `onDirtyChange?.(Object.keys(edits).length > 0)` in an effect.
- **`ResultGrid`** gets the new props `editable: boolean` (that is `!!session && !running`), `edits`, `applied`, `onEdit(row: Cell[], col: number, value: Param)` and `onSelect`. Wire them into `DataGrid`:
  - `canEdit={(r, c) => editable && readOnlyReason(st, rows[r], c) === null}`;
  - `onEdit={(r, c, v) => rows[r] && onEdit(rows[r]!, c, v)}`;
  - `isEdited={(r, c) => { const id = rows[r] && cellId(st, rows[r]!, c); return !!id && id in edits; }}`;
  - `getRow={(i) => rows[i]?.map((_, c) => displayCell(edits, applied, st, rows[i]!, c))}`;
  - `cellTitle={(r, c) => readOnlyReason(st, rows[r], c) ?? undefined}`.

  The `rows` array keeps the original values, so the originals in `buildResultChangeSets` stay correct, and pages loaded later merge into the same array (unchanged code).
- **Commit bar.** Below the grid when edits exist, using the same markup as TableView's: `<div className="commit-bar" role="region" aria-label="Pending changes">` with `pluralize(n, "pending change")`, Discard (`setEdits({})`) and "Review and commit".
- **Review.** Call `api.previewChangeSets(session.sessionId, buildResultChangeSets(current, edits))`, then open `ReviewChangesDialog` with `title="Review changes"`, `commitLabel="Commit changes"`, `cancelLabel="Keep editing"`, `statements`, `atomic`, and `summary` = "`N` changes to `table, table`". `onCommit` calls `api.applyChangeSets(…)`; on success it moves `edits` into `applied` (id → value), clears `edits` and closes. On failure it throws, so the dialog shows the error and the edits stay.
- **After commit,** when `applied` isn't empty, render a `.notice` row above the grid: "Shows values from when the query ran, plus your edits." with a `Run again` button calling `onRunAgain`.
- **Hint line.** When `current.editing` exists, `current.editing.tables.length === 0` and any reason exists, render `<div className="hint result-hint">{firstReason}</div>` above the grid. `firstReason` is the first reason that isn't "Computed column"; skip the hint when only computed columns exist.
- **Row inspector.** Add a "Row details" toggle button (`aria-label="Toggle row details"`) to the results footer, and render `RowDetail` with:
  - `columns` mapped from `ColumnMeta` as `{ name, dataType: typeName, nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null }`;
  - `row` = the displayed selected row;
  - `editable={(c) => editable && readOnlyReason(st, rows[sel], c) === null}`;
  - `onEdit={(c, v) => onEdit(rows[sel]!, c, v)}`;
  - `isEdited`, `heading={`Row ${sel + 1}`}`, `subheading={current.editing?.tables.map((t) => t.table).join(", ") || "Query result"}`, and `onClose`.

  The selection comes from `DataGrid`'s `onSelectionChange` (`sel = selection.active?.row`).

`QueryTab.tsx`:
- Pass `session={info}`, `onRunAgain={() => void run("all")}` and `onDirtyChange={setResultsDirty}` to `ResultsPanel`.
- In `run()`, before executing: if `resultsDirty`, `await confirmAction({ title: "Discard pending result edits?", body: "Running again replaces the results, and the edits you have not committed are lost.", confirmLabel: "Run and discard", danger: true })`, and return when it isn't confirmed.
- Add the prop `onDirtyChange?: (dirty: boolean) => void` and report `resultsDirty` through it.

`WorkspaceView.tsx`: pass `onDirtyChange={(d) => setDirtyTables((x) => (x[t.id] === d ? x : { ...x, [t.id]: d }))}` to `QueryTab`, exactly as for `TableView`. `requestClose` then asks with the "Pending row changes will be discarded." body. Use that body for query tabs too, when `dirtyTables[t.id]` is set.

- [ ] **Step 4: Run.** `npx vitest run src/features/sql-editor src/app src/features/data-browser && npm run typecheck && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor src/features/data-grid/DataGrid.tsx src/app/WorkspaceView.tsx src/app/WorkspaceView.test.tsx src/styles/app.css
git commit -m "feat: edit query results in the grid and inspector, review and commit in one transaction"
```

---

### Task 6: Docs, manual check, verification

- [ ] **Step 1: Docs.**
  - **`docs/FEATURE_MATRIX.md`.** Add a row next to "Pending changes and review":

    `| Edit query results | Cells whose column the database traces to a table with its full primary key in the result; join results per table; computed, view and DuckDB results read-only with the reason | VERIFIED | result_edit.rs, engine.rs (editing_for, apply_change_sets), adapters, ResultsPanel.tsx, resultEdits.ts | PG MY MA SQ | result_edit unit tests; integration origins + edit_results (PG, MySQL, MariaDB, SQLite, DuckDB read-only); ResultsPanel/resultEdits tests; manual (Xvfb) on PG | PostgreSQL adds one describe round-trip per SELECT on writable sessions |`
  - **`docs/ADAPTERS.md`.** Add a short "Column origins" section per engine, with the same table as the spec.
  - **`docs/ARCHITECTURE.md`.** Add one paragraph under the engine section on `editing_for` and `apply_change_sets`.
- [ ] **Step 2: Manual check.**
  - Use the hidden display and an isolated data dir (see `CLAUDE.md`), with the disposable PostgreSQL connected through a pasted URL (as in the PR 4 screenshots).
  - Run `SELECT i.id, i.name, o.id, o.name, i.price * 2 FROM …join…`, then:
    1. edit both tables' name cells;
    2. hover the computed column;
    3. review, commit, and check the result note;
    4. run again, which asks only when there are pending edits.
  - Screenshot in dark and light into `target/tpm-scratch/shots/editres-*`.
  - Afterwards, remove any test rows or tables you created in `tpm-test-postgres`.
- [ ] **Step 3: Full verification.**

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test -p tpm-core
eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration
source ~/.nvm/nvm.sh && nvm use 24 && npm run typecheck && npm run lint && npm test && npm run build
```

Expected: all pass.

- [ ] **Step 4: Commit the docs.** `git commit -m "docs: editable query results in the feature matrix, adapters and architecture"`.
- [ ] **Step 5: Finish.**
  - Run the fresh whole-branch review, then the fix pass.
  - Push and open the PR. It touches `src-tauri/`: add the `full-ci` label so the desktop builds run on all three platforms.
  - Squash-merge after **CI passed**.
