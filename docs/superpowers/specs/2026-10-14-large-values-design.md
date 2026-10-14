# Large values on demand: design

Date: 2026-10-14. Status: agreed in conversation (revised: zero server load for opened
tables), awaiting written-spec review.

This is the first of three sub-projects. The other two are restore history and foreign-key
jump, each with its own spec later.

## Goal
Opening a table should be near-instant and put no extra load on the database, even when rows
carry big JSON, transcripts or logs. Potentially large columns aren't read at all while you
browse. A value is fetched only when you ask for it, and it opens in a real editor inside the
app. JSON is checked before it can be saved, and long text can be edited.

Success means:
- Opening a table never selects, measures or previews a deferred column. PostgreSQL leaves
  those values in TOAST storage: they are not read, de-TOASTed, serialized or sent.
- A 150-row page of a table whose rows hold ~100 KB JSONB and text values opens as fast as the
  same table without those columns. The PR reports before/after numbers.
- Clicking a cell fetches only that column of that row.
- Every JSON/JSONB value is edited in the JSON editor, and invalid JSON can't be saved.
- Export, sorting and filtering still work on full values. Query tabs run the user's SQL
  unchanged.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| Which columns are deferred | Chosen by type from the schema, never by looking at the data. Deferred by default: unbounded types (see below). Loaded: everything with a bounded size. |
| Per-column override | Any column can be set to **Always load** or **Don't load**, remembered per connection, table and column. Only column names are stored, never data. |
| Deferred cell | A neutral **Not loaded** state, distinct from NULL and empty text. No preview, no size, no NULL check. |
| Opening a value | Fetches that one column for that row, by primary key. Short text then edits inline. Long text and all JSON open the editor. |
| Load a column | A column-header action fetches that column for the rows on screen, in one query. |
| Editor | A code editor in a large panel (CodeMirror, as in the SQL tab). No key/value tree. |
| JSON | Always edited in the JSON editor, whatever its size, with validation. |
| Page size | Opened tables load 150 rows per page by default (was 300). |
| Query results | The user's SQL is never rewritten; the database has already sent every value. Text over 256 characters is shown as a dimmed ~80-character preview and a size, from the app's own result store, at no server cost. Opening one reads the store, with no new query. |
| Export | Always fetches and writes full values, in its own queries. |
| Tables without a primary key | No deferral: all columns load as today, since one row's value can't be fetched back reliably. |

## Non-goals
- A JSON tree or key/value editor.
- Rewriting user queries in query tabs.
- Measuring, previewing or sampling deferred values in opened tables.
- Deferral in tables without a primary key, or in views (no key to fetch a row by).
- Dashboards and chart widgets.

## Which columns are deferred
Classification uses the type names in the introspected `TableStructure` (no catalog queries
beyond those already made and cached).

| Engine | Deferred by default | Loaded |
|---|---|---|
| PostgreSQL / DuckDB | `text`, `character varying` / `varchar` with no length, `json`, `jsonb`, `xml`, `bytea`, any array type (`[]`), `tsvector` | `varchar(n)`, `char(n)`, numbers, booleans, dates and times, `uuid`, enums, `inet` and the other scalar types |
| MySQL / MariaDB | `text`, `mediumtext`, `longtext`, `json`, `blob`, `mediumblob`, `longblob` | `char`, `varchar(n)`, `tinytext`, `tinyblob`, `binary`, `varbinary`, numbers, dates, `enum`, `set` |
| SQLite | declared `TEXT`, `BLOB`, `JSON`, `CLOB`, or no declared type | `INTEGER`, `REAL`, `NUMERIC`, and types with an integer, real or numeric affinity |

- Domains and custom types that the adapter can't classify are **loaded**: the risk is only
  slowness, never a wrong value.
- **Primary-key columns are never deferred**, whatever their type: they are needed to fetch the
  rest.
- **Overrides** take precedence over the defaults. They live in a new metadata table
  `column_fetch (connection_id, schema, table, column, mode)`, where `mode` is `load` or `defer`.
  Overrides are cleared with the connection, like its other local metadata.
- If every non-key column ends up deferred, the page still loads the key columns, so rows can
  be counted, selected and opened.

## Opened tables (`browse`)
- The page query lists the loaded columns explicitly and omits deferred ones:
  `SELECT t."id"::text AS "id", t."status"::text AS "status" FROM "public"."orders" AS t … LIMIT 150 OFFSET 0`.
  No `length()`, no `left()`, no `CASE`, no `count(*)`.
- Sorting and filtering may still name a deferred column: they run inside the database, and the
  column just isn't returned. Sorting by a large column remains a heavy query, but only when
  you ask for that sort.
- `BrowseResult` keeps one entry per table column, in table order. Deferred columns carry
  `deferred: true` in their `ColumnMeta`, and their cells are a placeholder
  (`Cell::NotLoaded`, sent as `{"$notLoaded": true}`), so the grid's row shape is unchanged.
- Default page size: `grid.pageSize` changes from 300 to 150. Only changed settings are stored,
  so people who never changed it get 150.

### Fetching values
- `Engine::fetch_value(session_id, schema, table, key: Vec<ColumnValue>, column) -> Cell`:
  - runs `SELECT <column> FROM <table> WHERE <pk1> = $1 AND …`, with the PostgreSQL text cast
    as in `browse`;
  - the key must be the table's full primary key; columns are checked against the structure;
    values are bind parameters;
  - no row → `NotFound` ("This row no longer exists").
- `Engine::fetch_column(session_id, schema, table, column, keys: Vec<Vec<ColumnValue>>) -> Vec<Cell>`,
  for **Load this column** and for **Copy** of a block:
  - one query for the given keys: `WHERE (pk) IN ((…), (…))` on engines with row values,
    OR-joined key equalities otherwise;
  - at most one page (150 by default, 1,000 maximum) per call.
- Both run on the tab's session, through the session lock, never concurrently with another
  operation on it.
- The grid caches loaded values by `(column, key)` for the open tab. The cache is cleared by
  **Reload**, by a commit, and when the table's structure changes. Two clicks on the same cell
  while it is loading make one request.

## Query results
- The result store keeps full rows, as now.
- When rows go to the UI (the first 500 in `StatementResult.rows`, and every page from
  `fetch_rows`), any `Cell::Text` longer than `grid.largeValueChars` (default 256) is sent as
  `Cell::Partial { preview, length }`, serialized as `{"$partial": "<first 80 chars>", "length": 18234}`.
  The preview is cut on a character boundary, and the work is done in Rust on values already in
  memory.
- `Engine::result_value(result_id, row, column) -> Cell` returns the full cell from the store.
  If the result was evicted: `NotFound` ("This result is no longer in memory; run the query
  again").
- Editable query results keep working. A partial cell can be edited only through the editor,
  which loads the full value first. That full value becomes the edit's `original` for the
  conflict check.

## Settings
**Settings › Data grid** gains:
- "Rows per page": `grid.pageSize`, default 150.
- "Preview query results longer than": `grid.largeValueChars`, default 256, from 64 to 100,000.
  It applies only to query results; opened tables use the type rules.

Per-column overrides are set from the column header menu (**Always load**, **Don't load**,
**Use default**), not in Settings.

## UI
### Grid
- **Not loaded cell:** the text "Not loaded" in a muted, italic style, distinct from `NULL`
  (which keeps its own style) and from an empty string. The tooltip says "Click to load".
- **Partial cell** (query results): the dimmed preview ending "…", and a size tag (`18 KB` for
  JSON, `4,210 chars` for text).
- **Click or Enter on a Not loaded cell** loads it. The cell shows a small spinner while the
  value loads. Then:
  - **short text** (up to `grid.largeValueChars`), numbers, NULL: shown inline. The cell then
    behaves like any loaded cell, including inline editing;
  - **long text:** the cell shows the partial preview and size, and the text editor opens;
  - **JSON column:** the JSON editor opens.
- **Double-click or Enter on any JSON/JSONB cell** opens the JSON editor, loaded or not. JSON
  columns are `json`/`jsonb` (PostgreSQL, DuckDB) and `json` (MySQL, MariaDB), from the table
  structure or the result column's type name. SQLite has no JSON type, so its cells follow the
  text rules.
- **Column header menu** on a deferred column:
  - **Load this column:** fetches it for the rows on this page, in one query;
  - **Always load / Don't load / Use default:** the override. Changing it reloads the page.
  - Deferred column headers carry a small icon whose tooltip reads "Loaded on demand".
- **Copy** (Ctrl+C, context menu, row copy) first fetches every Not loaded or partial cell in
  the selection (one request per column), then copies. A toast confirms it, e.g. "Copied 3
  rows (240 KB)".

### Value editor panel
- A large panel over the workspace, about 80% of the window, with a dimmed backdrop. Focus is
  trapped inside it, and Esc closes it, asking first if there are unsaved changes.
- **Header:** `table · column · <key> = <value>` (or `Query result · column · row n`), and the
  type. The size is shown once the value has loaded.
- **Body:** CodeMirror with the app's editor theme.
  - **JSON mode:** `@codemirror/lang-json`, highlighting and folding.
  - **Text mode:** plain text with line wrapping.
  - Search with Ctrl+F in both modes.
- **JSON mode:**
  - a **Format** button (two-space indent);
  - a live status line: "Valid JSON", or "Invalid JSON: line 3, column 14: <parser message>";
  - **Save** stays disabled while the JSON is invalid. An empty document is invalid; use
    **Set NULL** instead.
- **Footer:** **Copy**, **Set NULL** (when the column is nullable or the nullability is
  unknown), **Cancel** and **Save**.
  - **Save** stores a pending change (amber cell) in the table view's or the query result's
    pending edits. The existing **Review and commit** writes it.
  - Saving an unchanged value does nothing.
- **Loading:** a spinner while the value is fetched. On failure, the error and **Retry**.
- **Read-only:** a read-only connection, a non-editable result column, or a table opened from a
  view opens the panel read-only, with the reason. **Copy** and **Format** still work.

### Row inspector
- **Not loaded fields:** a **Load** button.
- **Long text and JSON fields:** **Open editor**, as in the grid.

## Safety and privacy
- Values are bind parameters. Identifiers come from `TableStructure` through
  `Dialect::quote_ident`.
- `fetch_value`, `fetch_column` and `result_value` are reads. They are allowed on read-only
  connections and pass through the same session lock.
- Overrides store column names only. Values are held in memory only, and nothing new is written
  to disk.
- The JSON check in the editor is a convenience. PostgreSQL and MySQL also reject invalid JSON
  for their JSON types, and the commit's error is shown as usual.
- No new network calls.

## Error handling
| Situation | Behaviour |
|---|---|
| Row deleted or key changed before loading | The cell shows "Row no longer exists". The editor offers Close. |
| Result evicted from the store | "This result is no longer in memory; run the query again", with **Run again**. |
| Fetch fails (connection lost) | The cell returns to Not loaded, with the error in a toast. The editor shows **Retry**. |
| Commit conflict (the value changed meanwhile) | The existing conflict error in the review dialog. The edit stays pending. |
| Invalid JSON rejected by the server | Shown in the review dialog. The edit stays pending. |

## Testing
- **Core unit tests:**
  - classification per dialect: defaults, overrides, key columns never deferred, unknown types
    loaded;
  - the page query omits deferred columns and contains no length, left or CASE;
  - the `fetch_value` and `fetch_column` SQL, including composite keys and quoted names;
  - `NotLoaded` and `Partial` serialization;
  - character-safe trimming of result rows.
- **Integration tests** (disposable PostgreSQL, MySQL, MariaDB, SQLite, DuckDB):
  - `browse` returns NotLoaded for deferred columns, and their values never appear in the
    response;
  - an override loads a deferred column;
  - `fetch_value` by single and composite key, and NotFound after a delete;
  - `fetch_column` for a page of keys;
  - `result_value`;
  - committing an edited JSON value, with the conflict check;
  - a table without a primary key loads every column;
  - export writes full values;
  - a query tab's `SELECT *` returns every column in full.
- **Server-side proof (PostgreSQL):** in the integration test, after `browse`, the statement the
  server ran (from `pg_stat_statements` if available, otherwise the SQL `browse` reports) does
  not name the deferred column.
- **Frontend tests:**
  - Not loaded, NULL and empty render differently;
  - a click loads a value and shows short text inline;
  - long text and JSON open the right editor;
  - invalid JSON disables Save;
  - Save becomes a pending change;
  - Copy fetches unloaded values;
  - Load this column makes one request;
  - an override reloads the page;
  - read-only cells open read-only;
  - Esc with unsaved changes asks first.
- **Benchmark** (manual, disposable PostgreSQL, never against a user's database):
  - a table of 150 rows with ~100 KB JSONB and ~100 KB text per row;
  - page-open time, bytes received, and server execution time (`EXPLAIN (ANALYZE, BUFFERS)` run
    by hand on the test container), before and after;
  - the numbers go in the PR, separating the server, network and client savings.
- **Manual (Xvfb, isolated data dir):** the editor in dark and light, invalid JSON, Load this
  column, overrides, and save → review → commit in a table and in an editable query result.
- **Docs:**
  - a `FEATURE_MATRIX.md` row "Large values on demand";
  - a `DATABASE_ADAPTERS.md` section with the type rules per engine;
  - the new settings;
  - `DEPENDENCY_LICENSES.md` for `@codemirror/lang-json`.

## Risks
- **PostgreSQL `text` used for short columns.** Schemas that use plain `text` for names and
  emails will show those columns as Not loaded until they are set to **Always load**. The
  override is one click from the header and is remembered.
- **Type lists per engine.** An unusual text-like type might be missed. It is then loaded in
  full, as today: slower, but never wrong.
- **Query results still transfer full values from the database.** The user's SQL is theirs. The
  saving there is on the client side only, and the docs say so.
