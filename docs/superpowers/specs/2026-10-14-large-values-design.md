# Large values on demand: design

Date: 2026-10-14. Status: agreed in conversation, awaiting written-spec review.

This is the first of three sub-projects. The other two are restore history and foreign-key
jump, each with its own spec later.

## Goal
Opening a table or running a query should stay fast when rows carry big JSON or long text.
Large values are not loaded until someone asks for them. When asked for, they open in a real
editor inside the app: JSON is checked before it can be saved, and long text can be edited.

Success means:
- A table whose rows hold ~100 KB JSONB values opens a 150-row page without moving those values
  over the network. The PR reports the before/after numbers.
- Every large value shows a short preview and its size. One click opens the full value.
- Every JSON/JSONB value, large or small, is edited in the JSON editor, and invalid JSON can't
  be saved.
- Export, sorting and filtering still use full values.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| What is large | Size, not type: any text value longer than a threshold (default 256 characters). Short JSON and short text show inline. |
| Hidden cell | A short preview (default 80 characters, dimmed, ending "…") and a size tag. |
| Editor | A code editor in a large panel (CodeMirror, as in the SQL tab). No key/value tree. |
| JSON columns | Always edited in the JSON editor, whatever their size, with validation. |
| Text | Short text keeps inline editing. Large text opens the text editor, with no format check. |
| Page size | Opened tables load 150 rows per page by default (was 300). |
| Query results | The SQL is the user's and is never rewritten. Large values are held in the app's result store and shown as previews; opening one reads it from the store, with no database query. |
| Export | Always writes full values. |

## Non-goals
- A JSON tree or key/value editor.
- Rewriting user queries to avoid transferring large values from the database.
- Deferring values in tables without a primary key (there is no reliable way to fetch one row's
  value later).
- Changing binary cells, which already send a 4 KB preview and their size.
- Dashboards and chart widgets.

## The partial cell
A new cell kind carries a preview and the full length:
- Rust: `Cell::Partial { preview: String, length: u64 }` in `model.rs`.
- IPC: `{"$partial": "<preview>", "length": 18234}`. `length` counts characters.
- TS mirror in `src/types/backend.ts`. Helpers in `src/lib/cells.ts` (`isPartial`).

A partial cell is never edited, copied or committed as if it were the value. Every consumer
either fetches the full value first or treats the cell as read-only.

## Opened tables (`browse`)
- **Columns treated:** text-like columns only, taken from the introspected `TableStructure`:
  - PostgreSQL / DuckDB: `text`, `character varying`, `character`, `json`, `jsonb`, `xml`, and
    other types the adapter reports as text-like.
  - MySQL / MariaDB: `char`, `varchar`, `tinytext`, `text`, `mediumtext`, `longtext`, `json`,
    `enum` and `set` excluded.
  - SQLite: columns with TEXT affinity, and columns with no declared type.
  - Numbers, dates, booleans, UUIDs and binary columns are fetched as today.
- **Only when the table has a primary key.** Otherwise every column is fetched in full, as
  today.
- **Page query:** for each treated column `c`, the select list carries two expressions:
  - the value: `CASE WHEN <len(c)> > $threshold THEN <left(c, $preview)> ELSE c END`;
  - its length: `<len(c)>`, aliased to a reserved name that can't clash with a user column.

  | Engine | `len(c)` | `left(c, n)` |
  |---|---|---|
  | PostgreSQL / DuckDB | `length(t.c::text)` | `left(t.c::text, n)` |
  | MySQL / MariaDB | `CHAR_LENGTH(t.c)` | `LEFT(t.c, n)` |
  | SQLite | `length(t.c)` | `substr(t.c, 1, n)` |

  The threshold and preview length are written into the SQL as integers. They come from `u32`
  values in the request, never from text, so nothing user-typed reaches the SQL. Placeholders
  would shift the numbering of the filter's parameters. Identifiers go through `Dialect::quote_ident` and
  are checked against the `TableStructure`, as today.
- **Assembly:** the adapter returns the extra length columns. `browse` folds each pair into one
  cell (`Partial` when the length is over the threshold, the full `Text` otherwise) and drops
  the length columns, so the UI sees the table's own columns only.
- **Default page size:** `grid.pageSize` changes from 300 to 150. Only changed settings are
  stored, so people who never changed it get 150.

### Fetching one value
`Engine::fetch_value(session_id, schema, table, key: Vec<ColumnValue>, column) -> Cell`:
- Runs `SELECT <column> FROM <table> WHERE <pk1> = $1 AND …`, with the PostgreSQL text cast as
  in `browse`.
- The key must be the table's full primary key. Columns are checked against the structure.
- No row → `NotFound` ("This row no longer exists").
- Runs on the tab's session like every other operation, never concurrently with another.

`Engine::fetch_values(session_id, schema, table, requests)` does the same for several cells at
once (for Copy of a block). It uses one query per table: `WHERE (pk) IN (…)`, or OR-joined key
equalities on engines without row values.

## Query results
- The result store keeps full rows, as now.
- When rows go to the UI (the first 500 in `StatementResult.rows`, and every page from
  `fetch_rows`), any `Cell::Text` longer than the threshold is sent as `Partial`. The preview is
  cut on a character boundary.
- `Engine::result_value(result_id, row, column) -> Cell` returns the full cell from the store.
  If the result was evicted: `NotFound` ("This result is no longer in memory; run the query
  again").
- There is no row-count rule. A one-row result behaves the same way, and opening its cell is
  instant because the value is already local.
- Editable query results (the previous feature) keep working:
  - a partial cell can be edited only through the editor, which loads the full value first;
  - that full value becomes the edit's `original` for the conflict check.

## Settings
**Settings › Data grid** gains:
- "Rows per page": `grid.pageSize`, default 150.
- "Hide values longer than": `grid.largeValueChars`, default 256. Minimum 64, maximum 100,000.

The preview length (80 characters) is fixed. The backend receives the threshold with each
`browse` and query request, so no engine-side state is involved.

## UI
### Grid
- **Partial cell:** the preview, dimmed, ends in "…". A size tag sits at the right: `18 KB` for
  JSON, `4,210 chars` for text. The tooltip says "Click to open the full value".
- **Double-click or Enter opens:**
  - **JSON column, any size:** the JSON editor;
  - **partial text:** the text editor;
  - **anything else:** inline editing, as today.

  JSON columns are `json`/`jsonb` (PostgreSQL, DuckDB) and `json` (MySQL, MariaDB), from the
  table structure or the result column's type name. SQLite has no JSON type, so its cells follow
  the text rules.
- **Copy** (Ctrl+C, context menu, row copy) fetches the full value of every partial cell in the
  selection first (one request), then copies. It shows a toast with the size, e.g. "Copied
  18 KB".

### Value editor panel
- A large panel over the workspace, about 80% of the window, with a dimmed backdrop. Focus is
  trapped inside it, and Esc closes it, asking first if there are unsaved changes.
- **Header:** `table · column · <key> = <value>` (or `Query result · column · row n`), the type,
  and the size.
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
- **Loading:** a spinner while the full value is fetched. On failure, the error and **Retry**.
- **Read-only:** a read-only connection, a non-editable result column or a table without a key
  opens the panel read-only, with the reason. **Copy** and **Format** still work.

### Row inspector
A partial field shows the preview, the size and an **Open editor** button. JSON fields open the
JSON editor, as in the grid.

## Safety and privacy
- Values are bind parameters. Identifiers come from `TableStructure` through
  `Dialect::quote_ident`.
- `fetch_value` and `fetch_values` are reads. They are allowed on read-only connections and pass
  through the same session lock.
- The JSON check in the editor is a convenience. PostgreSQL and MySQL also reject invalid JSON
  for their JSON types, and the commit's error is shown as usual.
- No new network calls. Values stay in memory only. Nothing new is written to disk.

## Error handling
| Situation | Behaviour |
|---|---|
| Row deleted or key changed before opening | "This row no longer exists". Close, or Retry. |
| Result evicted from the store | "This result is no longer in memory; run the query again", with **Run again**. |
| Fetch fails (connection lost) | The error with **Retry**. The grid is unchanged. |
| Commit conflict (the value changed meanwhile) | The existing conflict error in the review dialog. The edit stays pending. |
| Invalid JSON rejected by the server | Shown in the review dialog. The edit stays pending. |

## Testing
- **Core unit tests:**
  - the page query per dialect, with the length expression and preview for text-like columns
    only;
  - no treatment without a primary key;
  - `Partial` serialization;
  - character-safe trimming of result rows;
  - folding the length columns away.
- **Integration tests** (disposable PostgreSQL, MySQL, MariaDB, SQLite, DuckDB):
  - `browse` returns `Partial` for long JSON and text, and full values for short ones;
  - `fetch_value` by primary key, and `NotFound` after a delete;
  - `fetch_values` for several rows;
  - `result_value`;
  - committing an edited JSON value, with the conflict check;
  - a table without a primary key returns full values;
  - export writes full values.
- **Frontend tests:**
  - a partial cell renders with its size;
  - double-click opens the right editor for JSON, partial text and short text;
  - invalid JSON disables Save;
  - Save becomes a pending change;
  - Copy fetches full values;
  - read-only cells open read-only;
  - Esc with unsaved changes asks first.
- **Benchmark** (manual, disposable PostgreSQL):
  - 150 rows, each with a ~100 KB JSONB value;
  - page-open time and bytes received, before and after;
  - the numbers go in the PR.
- **Manual (Xvfb, isolated data dir):** the editor in dark and light, invalid JSON, and
  save → review → commit in a table and in an editable query result.
- **Docs:**
  - a `FEATURE_MATRIX.md` row "Large values on demand";
  - a `DATABASE_ADAPTERS.md` note on the length and preview SQL per engine;
  - the new settings;
  - `DEPENDENCY_LICENSES.md` for `@codemirror/lang-json`.

## Risks
- **PostgreSQL still reads large values server-side.** `length()` and `left()` on a JSONB value
  make the server de-TOAST and serialize it. The saving is network transfer and everything after
  it, not the server's read. The benchmark shows the real gain.
- **Type lists per engine.** An unusual text-like type (a domain over text, a MySQL charset
  variant) might be missed. It is then fetched in full, as today: slower, but never wrong.
- **Wider page queries.** Two expressions per text column make the SQL longer. It is still one
  round trip.
