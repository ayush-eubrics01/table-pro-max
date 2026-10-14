# Editable query results: design

Date: 2026-10-14. Status: agreed in conversation, awaiting written-spec review.

## Goal
Let people change values directly in a query's result grid, TablePlus-style, whenever a cell
can be traced to exactly one row and column of a real table. Everything else stays read-only
and says why. Saving uses the same pending → review → one-transaction commit flow as the
table view, with the same safety checks.

Success means:
- In `SELECT id, email FROM users WHERE …`, `email` cells can be edited and committed.
- In a join, each table's columns can be edited when that table's primary key is in the result.
- Computed columns (`COUNT(*)`, `price * qty`, `CONCAT(…)`, aggregates, literals) are never
  editable, and nothing guesses from the SQL text.
- A wrong update is impossible by construction. Every `UPDATE` is keyed by the primary key and
  checks the original value; a concurrent change aborts the commit.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| Primary key not in the result | Read-only, with a hint ("Add `id` to the SELECT to edit `users`"). The app never changes or re-runs the user's query. |
| Joins | Editable per table, when that table's full primary key is in the result. One commit can touch several tables, in one transaction. |
| DuckDB | Query results are read-only (the driver reports no column origins); a short note says so. Editing an opened DuckDB table is unchanged. |
| Scope | Change values and set NULL (grid and row inspector). No delete or insert from query results; those stay in the table view. |
| Source of truth | The database's own column-origin metadata. No SQL parsing to *grant* editability. Amended after review: origins name the table, not the alias or UNION branch, so a parse of the statement may only *remove* editability (self-joins, compound selects, repeated CTEs, views on SQLite/MySQL; see `result_sql.rs`). |

## Non-goals
- Deleting or inserting rows from a query result.
- Editing through views (a result column whose origin is a view is read-only). SQLite reports
  origins through views to the base table; those are allowed under the same key rule.
- Editing DuckDB results, or results of `EXPLAIN`, `SHOW`, `PRAGMA` and other non-SELECT output.
- Re-running or rewriting the user's query to add keys.

## The editability rule
**Per result column** the backend records its origin, `{ schema, table, column }`, or `null`
when the database reports none (expressions, aggregates, literals, functions).

**Per origin table** (distinct `schema.table` among the result's origins) the backend loads the
table structure. It already does this, and caches it, for the table browser. The table is
**editable in this result** when all of these hold:
1. its kind is `table` (not a view, materialized view or foreign table);
2. it has a primary key;
3. every primary-key column appears in the result as some column whose origin is that table and
   that column.

**Per cell** (row *r*, result column *c*) editing is allowed when:
- *c* has an origin whose table is editable in this result;
- the key values for that table in row *r* are all non-NULL (outer joins can produce NULL keys);
- the cell is not binary and not truncated (same rule as the table view);
- the session is not read-only, the dialect supports origins (not DuckDB), and no statement is
  running in that query tab (one operation per session).

**Read-only reasons**, shown on hover and in a one-line hint above the grid when the whole
result is read-only:
- "Computed column";
- "Add `<key>` to the SELECT to edit `<table>`" (lists missing key columns);
- "`<name>` is a view";
- "Read-only connection";
- "Query results can't be edited on DuckDB".

**The same source cell shown more than once** (the same column selected twice, or one row
repeated across join rows): an edit is stored once, keyed by `table + primary-key values +
column`, and shows in every result cell with that identity.

## How column origins are obtained
| Engine | Mechanism | Cost |
|---|---|---|
| MySQL / MariaDB | `mysql_common::Column` from `query_iter` already carries `schema`, `org_table`, `org_name` (text protocol). Record them; an empty `org_table` means no origin. | none |
| PostgreSQL | The script path uses `simple_query_raw`, which carries no origins. For a statement that returned columns, call `Client::prepare(sql)` (describe only, never executes) and read `Column::table_oid()` and `column_id()`. Resolve `oid → (schema, table)` and `(oid, attnum) → column name` with one `pg_attribute`/`pg_class`/`pg_namespace` query per new table OID, cached per session. If prepare fails, there are no origins (read-only). Skipped on read-only sessions. | one extra round-trip per row-returning SELECT |
| SQLite | Enable rusqlite feature `column_metadata` (which compiles SQLite with `SQLITE_ENABLE_COLUMN_METADATA`). Read `column_database_name`, `column_table_name` and `column_origin_name` per column. | none |
| DuckDB | Not available. Columns have no origin. | — |

Origins are attached to `ColumnMeta` as an optional field and serialized to the frontend.

## Data model changes
Rust `model.rs` and the TS mirror in `src/types/backend.ts`:
- `ColumnMeta` gains `origin?: { schema: string; table: string; column: string } | null`.
- `StatementResult` gains `editing?: ResultEditing`, computed by the engine after the statement:
  ```
  ResultEditing {
    tables: { schema, table, keyColumns: number[] /* result column indexes, one per PK column */ }[]
    columns: (number | null)[]   // per result column: index into tables, or null
    readOnly: { column?: number; reason: string }[]   // reasons for the hint and tooltips
  }
  ```
  `tables` lists only the editable origin tables. Read-only origins produce a reason instead.

## Saving
- **Pending edits** live in the query tab's results state, keyed by `tableIndex` + key values
  + `column`. They are cleared by Discard or by running the tab again (with a confirmation if
  any are pending, like closing a dirty tab).
- **Review** builds one `ChangeSet` per touched table: `RowChange::Update` with a key from the
  result's key columns, plus edits with `original` taken from the result cell. It uses the
  existing `changes::build_statements` per table, which needs the `TableStructure` the engine
  already loaded, so typing, quoting and the `original` checks are unchanged. The review dialog
  shows all statements, grouped by table, with the connection and environment.
- **Commit** uses a new engine call, `apply_change_sets(session, sets: Vec<ChangeSet>, confirmed)`,
  and a matching Tauri command and IPC. It runs every set's statements in **one transaction**
  and keeps the existing per-statement `expect_rows: Some(1)` conflict check and the backend
  confirmation rules from `apply_changes`. The single-table `apply_changes` keeps working and
  becomes a thin wrapper.
- **After a successful commit** the grid keeps the new values in place and drops the amber. A
  note "Shows values from when the query ran, plus your edits", with **Run again**, appears
  until the tab runs again.
- **On failure** (conflict, constraint, connection) nothing is applied. The error is shown in
  the review dialog and the edits stay pending.

## UI
- **Result grid** (`ResultsPanel`): `canEdit(row, col)` follows the rule, and `isEdited` marks
  pending cells. The floating commit bar matches the table view: "N pending changes ·
  Discard · Review and commit".
- **Row inspector** for result rows: available as in the table view. Fields are editable per
  the same rule; read-only fields show their reason.
- **Hint line** above the grid when nothing in the result is editable but origins exist. It
  names the missing key or the view. Hidden for purely computed results.

## Safety and privacy
- Values are bind parameters; identifiers come from `TableStructure` via
  `Dialect::quote_ident`. This is unchanged code (`changes.rs`).
- Read-only sessions never offer editing, and the backend refuses `apply_change_sets` on them,
  as it does for `apply_changes`.
- Production confirmation stays in the backend (`engine.rs`).
- No new network calls. The PostgreSQL describe and catalog lookups go to the user's own database.

## Testing
- **Core unit tests** for the rule:
  - single table;
  - an aliased column;
  - a join with both keys, and a join missing one key;
  - `COUNT(*)` and expressions;
  - a view;
  - an outer-join NULL key;
  - the same column twice;
  - a composite primary key.
- **Integration tests** on the disposable test databases (PostgreSQL, MySQL, MariaDB, SQLite):
  - reported origins for those shapes (including a CTE and a subquery);
  - a two-table `apply_change_sets` in one transaction;
  - a conflict, where the row changes between query and commit: nothing written, conflict error.
- **Frontend tests:**
  - editable versus read-only cells and their reasons;
  - one edit shown on every identical cell;
  - the multi-table review;
  - no editing while running;
  - Run again asks when edits are pending.
- **Manual:** Xvfb against the test PostgreSQL, isolated data dir.
- **Docs:** a `FEATURE_MATRIX.md` row "Edit query results" (with evidence), an `ADAPTERS.md`
  note on column origins per engine, and the `ARCHITECTURE.md` engine section.

## Risks
- **PostgreSQL describe round-trip.** It adds latency to every row-returning SELECT. It is
  skipped on read-only sessions, and could become a setting later if users notice.
- **Server variations.** Some proxies or poolers (e.g. PgBouncer in transaction mode with
  prepared statements disabled) may reject prepare. The result is then simply read-only.
- **MySQL `org_table`** for derived tables or `UNION` is empty or unreliable. Those columns get
  no origin, so they are read-only, which is the safe outcome.
