# Architecture

Table Pro Max is a Tauri 2 desktop application. All database work happens in Rust; the
React frontend renders state and sends typed commands over Tauri IPC. There is no server
component. Network traffic goes to the databases the user connects to, plus two optional
destinations: the AI service the user configures, and GitHub for update checks the user allows.

```
┌──────────────────────────── webview (React + TypeScript) ────────────────────────────┐
│ app/ (shell, restore) · features/ (connections, explorer, data-grid, data-browser,   │
│ filters, sql-editor, explain, history, palette, settings) · stores/ (zustand)        │
└───────────────────────────────┬──────────────────────────────────────────────────────┘
                                │  invoke("command", args) → Result<T, AppError>
┌───────────────────────────────▼──────── src-tauri (crate table-pro-max) ─────────────┐
│ commands/{connections, query, library, ai, update} · state.rs (AppState, secrets)    │
│ logging.rs (redacting file logger) · capabilities/default.json (minimal permissions)│
└───────────────────────────────┬──────────────────────────────────────────────────────┘
                                │  plain Rust calls
┌───────────────────────────────▼──────────── crates/tpm-core (no Tauri, no UI) ───────┐
│ engine.rs      session registry, execution, cancellation, timeouts, result store     │
│ adapters/      Session trait + postgres.rs · mysql.rs · sqlite.rs · tls.rs           │
│ safety.rs      sqlparser-based statement classification + policy decisions           │
│ split.rs       dialect-aware statement splitting with byte offsets                   │
│ filter.rs      filter trees → parameterised WHERE clauses                            │
│ browse.rs      paginated SELECT/COUNT builders                                       │
│ changes.rs     pending edits → parameterised INSERT/UPDATE/DELETE (+ conflict check) │
│ ddl.rs         CREATE/ALTER generation for the structure editor                      │
│ storage.rs     local SQLite metadata DB with versioned migrations                    │
│ credentials.rs CredentialStore trait, OS keyring, in-memory store                    │
│ ssh.rs         SSH tunnels (russh), known-hosts verification, ssh_config aliases      │
│ transfer.rs    streaming import/export (CSV, JSON, JSON Lines, SQL, XLSX)            │
│ redis_kv.rs    Redis key browser and console with command classification            │
│ ai.rs          optional AI: prompt builder, Anthropic / OpenAI-compatible HTTPS      │
│ updates.rs     update-check rules: consent, daily interval, versions, install kinds  │
│ config.rs      ConnectionProfile, URL parsing · dialect.rs quoting · redact.rs       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Why the core is a separate crate

`tpm-core` compiles and tests on any machine with a Rust toolchain. The desktop shell needs
a webview toolchain (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS). Keeping
all logic in the core means CI can run every database test without building the shell, and
the workspace `default-members` keeps a plain `cargo test` portable.

## Sessions and concurrency

* A **session** is one live database connection (`adapters::Session`). The engine stores each
  in a `tokio::sync::Mutex`, so statements on one session run strictly in order. This matches
  driver guarantees and keeps transaction state coherent.
* Each **query tab** opens its own session lazily, so tabs never share transactions or
  results. Each **workspace** (open connection) has one more session for the schema tree,
  table browsing and grid edits.
* A global semaphore bounds concurrent executions (32).
* **Cancellation** uses a `Canceller` obtained when the session opens, because the session
  itself is locked while a query runs:
  * PostgreSQL: protocol cancel request (`CancelToken`).
  * MySQL/MariaDB: `KILL QUERY <id>` from a short-lived second connection.
  * SQLite: `sqlite3_interrupt` via rusqlite's `InterruptHandle`.
* **Timeouts** send the cancel and then wait (up to 15 s) for the driver to report it. If the
  server never acknowledges, the session is marked broken and the UI offers a reconnect, so a
  connection in an unknown state is never reused silently.

## Result transport

User SQL results are capped (`query.maxRows`, default 100,000) and kept in a bounded,
backend-side result store (512 MB budget, oldest evicted first). Each statement result carries
the first 500 rows. The grid fetches further pages by `result_id` as the user scrolls. When the
cap is hit the driver query is cancelled server-side instead of drained. Table browsing uses
`LIMIT/OFFSET` pages with a one-row probe, so `COUNT(*)` only runs on request.

Values cross IPC as text (`null | string | {"$bytes": hex, size}`), using the server's own
text representation. That avoids precision loss in JavaScript and supports every type,
including extension types.

## Large values on demand

`browse` with `lazy: true` (opened tables) leaves deferred columns out of the select list
(`large_values.rs` decides by type and per-column overrides; `build_select_projected`) and
returns `Cell::NotLoaded` placeholders in their place. The grid fetches one value with
`fetch_value`, or a page of one column with `fetch_column`, by primary key, and puts it into
the page, which is the cache. Query results keep full rows in the result store; text longer
than `grid.largeValueChars` goes to the UI as `Cell::Partial` (preview and length) and opens
through `result_value`. Export never sees placeholders: table export runs its own full queries,
result export reads the store, and `transfer.rs` refuses placeholder rows. The value editor
(`ValueEditor.tsx`) loads the full value first, so an edit's `original` is always the full value.

## Editing query results

After a row-returning statement, `engine.rs` (`editing_for`) asks the adapter for each result
column's origin (`schema.table.column`, reported by the database itself) and loads the
introspected `TableStructure` of every origin table. `result_edit.rs` then decides, per table,
whether it can be edited in this result: a real table (not a view) with a primary key whose
columns all appear in the result. Because origins name the table and not the alias, a
block-only check on the statement (`result_sql.rs`) also makes self-joins, compound selects,
repeated CTEs and views on SQLite/MySQL read-only. Everything else gets a reason ("Computed column", "Add `id`
to the SELECT to edit `users`", "Read-only connection", …) that the grid shows on hover. The
frontend keeps pending edits keyed by table, key values and column, so a source cell shown in
several result cells has one edit. Commit goes through `apply_change_sets`: one `ChangeSet` per
touched table, statements built by the same `changes::build_statements` as the table view
(primary-key `WHERE`, original-value check, one row expected), all in one transaction, with the
same backend confirmation and read-only rules as `apply_changes`. It refuses to run while the
session has a transaction the user opened, since its own BEGIN/COMMIT would end it.

## Restore points

Before a script runs, `run_script` plans each write (`restore_plan.rs`): UPDATE, DELETE, TRUNCATE,
DROP TABLE and ALTER … DROP COLUMN get a capture plan (the table, its alias and the statement's
own WHERE, re-emitted by sqlparser); joins, WITH, ORDER BY/LIMIT, key changes, tables without a
key (UPDATE, DROP COLUMN) and binary columns off PostgreSQL get a reason instead. The server
names the table (PostgreSQL `to_regclass`, SQLite and DuckDB case-insensitively, otherwise the
current schema or database), and a bounded count (`LIMIT max + 1`) checks the row limit and
estimates the size. Planning runs under the script's task, so Cancel stops it; a USE/SET or DDL
statement makes later captures plan again when they run. Every reason joins the destructive-statement confirmation, so a
script asks once. At run time `run_captured` asks the session whether a transaction is open (MySQL
`autocommit=0`, SQLite savepoints count) and otherwise wraps the statement in its own transaction (none
for MySQL DDL, which commits implicitly; inside the user's transaction, a PostgreSQL savepoint
guards the reads): read the rows `FOR UPDATE` as text, run the statement, read the updated rows
by key, commit. A read that fails leaves the statement to run without a restore point and says
why in its message. The engine saves points through `RestoreStore` (implemented by `Storage`,
which purges by age and total size). Points made inside the user's transaction are pending: kept
on COMMIT, deleted on ROLLBACK, reconnect or close, and on a COMMIT after a PostgreSQL error
(the server rolls back). Grid commits read before and after rows inside their own transaction.
Restoring (`restore.rs`) turns a point into DDL (a dropped table's definition, ADD COLUMN) plus
change sets: updates whose conflict check is the value the change left behind, re-inserts for
deleted rows. They run through `apply_change_sets`, which keeps a point of the restore itself.
Before writing, the current rows are compared as text with what the change left: rows already
back are skipped, and any row changed since stops the restore. A dropped table's saved
definition runs statement by statement (PostgreSQL serial sequences recreated and moved past the
restored keys); generated columns are never written, and PostgreSQL re-inserts use
`OVERRIDING SYSTEM VALUE`. Rows of a table without a key come back all at once, once.

## Driver choices

| Database | Library | Notes |
|---|---|---|
| PostgreSQL | `tokio-postgres` + `tokio-postgres-rustls` | Simple-query protocol for user SQL (text values, multi-result); extended protocol with text-format bind parameters for generated SQL; native cancel. |
| MySQL / MariaDB | `mysql_async` (rustls/ring) | Text protocol for user SQL (multiple result sets); prepared statements for generated SQL; `KILL QUERY` cancel. |
| SQLite | `rusqlite` (bundled SQLite) | Runs on the blocking pool; `sqlite3_interrupt` cancel; read-only via `SQLITE_OPEN_READ_ONLY` + `query_only`. |
| App metadata | `rusqlite` | Same bundled SQLite; WAL; migrations via `PRAGMA user_version`. |

See `DECISIONS.md` for why these were chosen over SQLx.

## Parameter binding

Values are always bind parameters. PostgreSQL parameters are sent in **text format**
(`TextParam`), so the server infers each parameter's type from context and parses the text
exactly as it would a literal. A string can therefore be bound to an `integer`, `uuid`,
`jsonb` or extension-typed column without client-side type mapping, and without string
interpolation. Identifiers are validated and quoted per dialect (`dialect.rs`). Columns in
filters, sorts and edits must exist in the introspected table structure.

## Frontend state

* `stores/workspaces.ts` holds open connections, their schema caches and tabs (pure data).
* Per-tab runtime state (results, pending edits, grid selection) lives inside the tab
  components. Panels stay mounted while hidden, so switching tabs never loses state, and one
  tab cannot overwrite another's.
* The workspace (open connections, tabs, unsaved query text) is persisted to the local DB with
  an 800 ms debounce and restored on startup.

## Offsets

The backend reports statement spans and error positions as UTF-8 byte offsets. The editor
uses UTF-16 indices. `lib/text.ts` converts between them, so non-ASCII SQL highlights the
correct range.

## SSH tunnels

When a profile has an `ssh` section, the engine opens a tunnel (`ssh.rs`) before the
driver connects. The tunnel listens on `127.0.0.1:<random>` and forwards each accepted
connection over an SSH `direct-tcpip` channel. Drivers connect to the local port, but TLS
still verifies the profile's real host name (PostgreSQL `hostaddr`, MySQL TLS hostname
override). The tunnel lives in the `SessionHandle` and closes with the session; reconnect
opens a fresh tunnel. Cancel requests (PostgreSQL) and `KILL QUERY` connections (MySQL)
travel through the same tunnel because they reuse the session's connection settings.

## Optional AI assistance

`ai.rs` is the only module that talks to anything other than a user database, and only when
`ai.enabled` is set. `build_prompt` turns a task (explain, explain error, improve, generate)
plus the user-chosen SQL, error text, description and optional table/column names into a
system and user message. The UI shows that output (`ai_preview`) and sends it back unchanged
(`ai_send`). The backend re-reads the settings, refuses a preview made for another endpoint or
model, loads the key from the credential store, and posts it with `reqwest` (rustls + ring).
The UI renders answers as text. The first SQL block can be inserted into the editor; it is never
executed. In-flight requests are cancelled through a `CancellationToken`.

## In-app updates

`commands/update.rs` wraps `tauri-plugin-updater`. `update_check(manual)` refuses automatic
checks unless `updates.auto` is `"on"` and a day has passed (`updates::auto_check_due`), then
reads `latest.json` from the latest GitHub release and keeps the found `Update` in `AppState`.
`update_install` downloads it with progress events (`update-progress`), cancellable through a
`CancellationToken`; the plugin verifies the minisign signature and the signed version before
returning the bytes. It then installs (AppImage replaced in place; `.deb`/`.rpm` through
`pkexec`; NSIS/MSI in passive mode; the macOS `.app` replaced) and restarts. The frontend
(`features/updates/`) asks for consent once, shows the banner, warns about uncommitted grid
edits (`stores/pendingEdits.ts`) and saves the workspace before installing. The release
workflow signs the updater files and writes the manifest with `scripts/updater-manifest.mjs`.

## Import and export

`transfer.rs` writes rows through a `RowSink` (CSV, JSON, JSON Lines, SQL INSERT, XLSX in
constant-memory mode). Table exports page through the table 5,000 rows at a time, so memory
stays flat. Imports read the file on the blocking pool and send parameterised multi-row
INSERT batches through a bounded channel (capacity 4) to the session. The session runs them
inside one transaction and commits only when the whole file succeeded. Batch size keeps
every statement under SQLite's 32,766-parameter limit.
