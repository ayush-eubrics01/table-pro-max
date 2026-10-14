# Feature matrix

Statuses: **NOT_STARTED**, **IN_PROGRESS**, **IMPLEMENTED** (code exists, not yet proven by
a test or a reproducible manual check), **VERIFIED** (proven by the evidence named), and
**BLOCKED**.

Drivers: PG = PostgreSQL, MY = MySQL 8.4, MA = MariaDB 11.4, SQ = SQLite (bundled 3.x).
"Integration" means `crates/tpm-core/tests/integration.rs` against disposable servers from
`scripts/test-db.sh`. "Manual (Xvfb)" means the real desktop app was driven under Xvfb on
Linux and checked with screenshots and database queries (see TESTING_STRATEGY.md).

No feature has a paid tier, license check, quota or artificial limit.

## Connections and credentials

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Saved profiles (unlimited) | Create, edit, duplicate, delete, reorder | IMPLEMENTED (create/save VERIFIED) | `storage.rs`, `ConnectionForm.tsx`, `Home.tsx` | all | storage unit tests; `ConnectionForm.test.tsx`; manual (Xvfb): PG, MySQL and SQLite profiles created and connected | Duplicate/delete not yet exercised in the UI |
| Groups, environments, tags | Group headings; Local/Development/Testing/Staging/Production; production styled distinctly | VERIFIED (environments) | `Home.tsx`, `env.ts` | all | manual (Xvfb) | Tags editable only through import, not the form |
| Search and sort | By name/host/db/tag; custom, name, recent | IMPLEMENTED | `Home.tsx` | all | — | |
| Connection URL import | `postgres://`, `mysql://`, `mariadb://`, `sqlite:`; encoded credentials; sslmode mapping | VERIFIED | `config.rs` | all | `config::*` unit tests; manual (Xvfb) | |
| Profile file import/export | JSON bundle without secrets; imported profiles get new ids and ask for passwords | IMPLEMENTED | `config.rs::ProfileBundle`, `Home.tsx` | all | `bundle_tests` | |
| Test connection | Connects with unsaved settings and reports the server version | VERIFIED | `test_connection` | PG | manual (Xvfb): "Connected to PostgreSQL 16.15" | |
| Reconnect after loss | Network errors mark the session broken; reconnect keeps tab state | VERIFIED (engine) / IMPLEMENTED (UI) | `engine.rs`, `connectFlow.ts` | PG MY MA | integration: backend killed, reconnect, query OK | |
| Health indicator | Every 30 s each open connection is pinged; a lost connection is flagged on its tab and in the status bar with a Reconnect action | VERIFIED | `App.tsx`, `WorkspaceView.tsx` | all | manual (Xvfb): server-side termination detected, reconnect restored the session | |
| Timeouts and keep-alive | Connect timeout, per-query timeout, TCP keepalive | VERIFIED (query timeout) | adapters, `engine.rs` | all | integration timeout test | |
| TLS | Prefer, require+verify, require without verification, disable; custom CA | IMPLEMENTED | `adapters/tls.rs` | PG MY MA | config unit tests | Not yet tested against a TLS-enabled server (BLOCKED on a TLS test fixture) |
| SSH tunnelling | Password or private-key auth; `~/.ssh/config` aliases (HostName, User, Port, IdentityFile); host keys verified against `~/.ssh/known_hosts` + an app file; unknown hosts confirmed by SHA-256 fingerprint; changed keys refused; TLS through the tunnel still verifies the real host name | VERIFIED | `ssh.rs`, `connectFlow.tsx`, `ConnectionForm.tsx` | PG MY MA | `ssh::*` unit tests; integration `ssh_tunnel` (trust flow, queries, cancel through tunnel, wrong password, key auth, changed key); manual (Xvfb): trust dialog fingerprint matched the server key, test + connect + browse | No ssh-agent or jump-host (`ProxyJump`) support yet; MySQL path covered by the shared tunnel code but only PG is integration-tested |
| OS credential store | Keychain, Credential Manager, Secret Service via `keyring` | IMPLEMENTED | `credentials.rs` | all | — | Linux Secret Service not exercised in tests (to avoid touching the developer keyring); Windows/macOS unverified |
| Ask every time | Password prompted and kept in memory for the session; automatic fallback when no store exists | VERIFIED | `state.rs`, `connectFlow.ts` | all | `ConnectionForm.test.tsx`; manual (Xvfb) with D-Bus isolated, prompt on connect and on restore | |

## SQL editor

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Syntax highlighting, dialects | CodeMirror 6 with PostgreSQL, MySQL, MariaDB or SQLite dialect | VERIFIED | `SqlEditor.tsx` | all | manual (Xvfb) | |
| Autocomplete | Keywords, schemas, tables, and columns (including through aliases) for tables the query references; columns are fetched once per table and cached | VERIFIED | `SqlEditor.tsx`, `QueryTab.tsx`, `workspaces.ts` | all | `referencedTables.test.ts`; manual (Xvfb): `n.ti` → `title` on SQLite | Functions are completed only as keywords |
| Multiple query tabs | Each tab has its own session, results and state | VERIFIED | `QueryTab.tsx`, `workspaces.ts` | all | `workspaces.test.ts` (isolation); manual (Xvfb) | |
| Default schema | Unqualified names resolve in the schema picked in the sidebar, at connect and when it changes (PG `search_path` keeping `public`, MySQL/MariaDB `USE`, DuckDB `SET schema`; SQLite resolves itself) | VERIFIED | `engine.rs::set_default_schema`, `QueryTab.tsx` | PG MY MA DU | `schema_tests`; integration (all four); manual (Xvfb) on PG: shop → public switch followed by an open tab | A `SET search_path` typed in the editor is overridden on the next sidebar switch |
| Run current / selection / all | Ctrl+Enter, selection, Ctrl+Shift+Enter; backend splitter handles quotes, comments, `$$` | VERIFIED | `split.rs`, `QueryTab.tsx` | all | split unit tests; manual (Xvfb) | MySQL `DELIMITER` not supported |
| Results, timing, affected rows | Result tab per statement, Messages tab | VERIFIED | `ResultsPanel.tsx`, `engine.rs` | all | integration; manual (Xvfb) | Ad-hoc result columns have no type names (simple-query protocol) |
| Large results | Capped (default 100,000), paged fetch, server query stopped at the cap | VERIFIED | `engine.rs`, adapters | all | integration: 1M rows capped at 100k, page fetch | Rows are not streamed to the UI while the query is still running |
| Cancellation | Driver-level cancel | VERIFIED | adapters, `engine.rs` | all | integration (< 5 s) | Cancel is racy by nature |
| Query timeout | Per connection and global setting | VERIFIED | `engine.rs` | all | integration | |
| Error location | Server position mapped into the editor buffer | VERIFIED (PG) / IMPLEMENTED (others) | `engine.rs`, `QueryTab.tsx` | PG | integration (position 10) | MySQL reports "near …" text only |
| Destructive confirmation | Modal naming the connection, target and reason | VERIFIED | `safety.rs`, `engine.rs`, `QueryTab.tsx` | all | unit + integration + manual (Xvfb) | |
| Formatting | sql-formatter with dialect | IMPLEMENTED | `QueryTab.tsx` | all | | |
| Find and replace | CodeMirror search panel | IMPLEMENTED | `SqlEditor.tsx` | — | | |
| Saved queries | Save (Ctrl+S), list in sidebar, open without running | IMPLEMENTED | `storage.rs`, `Sidebar.tsx` | all | storage tests | Folders stored but not editable in the UI |
| Query history | Local, searchable, per connection; retention by days and count | VERIFIED (storage) / IMPLEMENTED (UI) | `storage.rs`, `HistoryPanel.tsx` | all | storage tests | |
| Query parameters (`:name`) | | NOT_STARTED | | | | |
| Bookmarks / snippets | | NOT_STARTED | | | | Saved queries cover part of this |
| Split editor panes | | NOT_STARTED | | | | Editor/results split only |
| Explain | Plan tree (PG JSON), MySQL JSON/tree, SQLite plan; ANALYZE behind confirmation | VERIFIED (PG) | `engine.rs`, `ExplainView.tsx` | PG MY MA SQ | integration (all four); manual (Xvfb) PG | |

## Data browser and editing

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Table and view browsing | Paged with a probe row, stable PK order, configurable page size | VERIFIED | `browse.rs`, `TableView.tsx` | all | integration; manual (Xvfb) | |
| Sorting | Header click cycles asc, desc, none | VERIFIED (backend) / IMPLEMENTED (UI) | `browse.rs`, `DataGrid.tsx` | all | integration | Single-column sort from the UI |
| Virtualized grid | Rows and columns virtualized; sticky header and row numbers | VERIFIED | `DataGrid.tsx` | — | manual (Xvfb) | |
| Column resize, reorder, hide | Drag edge, double-click to fit, drag header, header menu | IMPLEMENTED | `DataGrid.tsx` | — | | Layout not persisted between sessions |
| Keyboard navigation and selection | Arrows, Page Up/Down, Home/End, Shift to extend, Ctrl+A, Ctrl+C (TSV) | IMPLEMENTED | `DataGrid.tsx` | — | | |
| NULL, binary, JSON display | Italic NULL; binary size and hex preview; pretty JSON in the detail panel | IMPLEMENTED | `cells.ts`, `RowDetail.tsx` | all | | Binary cells are read-only |
| Inline editing | Double-click, Enter or type to edit; detail panel for long values | VERIFIED | `DataGrid.tsx`, `pending.ts` | PG MY | `TableView.test.tsx`; manual (Xvfb) on PG and MySQL with DB checks | |
| Insert, duplicate, delete rows | Pending until commit | VERIFIED (delete, insert) | `pending.ts`, `changes.rs` | all | unit + integration + manual | |
| Pending changes and review | Highlighted cells and rows, count in a floating bar, highlighted SQL preview with the target named, Copy SQL, commit or discard | VERIFIED | `changes.rs`, `ReviewChangesDialog.tsx` | all | integration; `ReviewChangesDialog.test.tsx`; manual (Xvfb): FK failure rolled back, then commit verified in DB | |
| Transactional commit | One transaction; any failure rolls everything back | VERIFIED | adapters `apply` | all | integration | MySQL DDL is not transactional (shown in the review dialog) |
| Optimistic concurrency | UPDATE checks loaded values; conflict means rollback | VERIFIED | `changes.rs` | all | integration | Skipped for MySQL float/JSON/binary columns |
| Read-only indicators | Read-only connection, views, tables without a PK | IMPLEMENTED | `TableView.tsx` | all | | |
| Filter builder | Nested AND/OR groups, negation, type-aware operators, IN, BETWEEN, NULL, LIKE, raw SQL, unlimited conditions, preview | VERIFIED | `filter.rs`, `FilterBuilder.tsx` | all | unit + integration; `FilterBuilder.test.tsx`; manual (Xvfb) on SQLite | |
| Filter presets | Save and load per table | IMPLEMENTED | `storage.rs`, `FilterBuilder.tsx` | all | storage tests | |
| Row count | On demand, honouring filters | VERIFIED | `browse.rs` | all | integration | |

## Schema

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Databases and schemas | DB switcher (PG); schema selector | VERIFIED | adapters | all | integration; manual (Xvfb) | |
| Objects | Tables, views, materialized views, foreign tables, functions, procedures, sequences | VERIFIED (tables) | adapters, `Sidebar.tsx` | all | integration; manual (Xvfb) | Loaded per schema, not per object |
| Structure | Columns, PK, indexes, FKs, constraints, triggers | VERIFIED | adapters, `StructureView.tsx` | all | integration | |
| Definitions (DDL) | Server DDL for MySQL/SQLite; generated for PG tables; views, functions, sequences; line numbers, Copy SQL, Open in editor (new query tab, not run) | VERIFIED (tables) | adapters, `ddl.rs`, `DefinitionView.tsx` | all | integration; `DefinitionView.test.tsx` | Generated PG DDL omits partitioning, ownership and grants |
| Create table | Form with preview | IMPLEMENTED | `ddl.rs`, `CreateTableDialog.tsx` | all | ddl unit tests | |
| Alter table | Add, drop, rename column; type, nullability, default; create and drop index; rename table — staged and previewed | IMPLEMENTED | `ddl.rs`, `StructureView.tsx` | all | ddl unit tests | SQLite cannot change types or defaults in place; MySQL nullability changes need "change type" |
| Drop table | Previewed, confirmed in the review dialog | IMPLEMENTED | `Sidebar.tsx` | all | | |
| Open Anything | Ctrl+K (or Ctrl+P) fuzzy search over cached objects, schemas, saved queries, connections, actions | IMPLEMENTED | `OpenAnything.tsx`, `fuzzy.ts` | all | fuzzy unit tests | Searches only schemas already loaded |

## Safety

| Feature | Behaviour | Status | Evidence |
|---|---|---|---|
| Safety modes | Normal, confirm destructive, confirm writes, read-only | VERIFIED | `safety::*` unit tests; integration |
| AST analysis | CTE writes, EXPLAIN ANALYZE, FOR UPDATE, DROP, TRUNCATE, UPDATE/DELETE without WHERE, ALTER … DROP, pragmas, conservative fallback | VERIFIED | `safety::*` |
| Database-level read-only | PG `default_transaction_read_only`, MySQL `SET SESSION TRANSACTION READ ONLY`, SQLite read-only open | VERIFIED | integration |
| Blocks read-only overrides | `BEGIN READ WRITE`, `SET … read_only`, `SET ROLE` | VERIFIED | `safety::read_only_blocks_session_overrides` |

## Workspace, settings, appearance

| Feature | Status | Evidence / limitations |
|---|---|---|
| Multiple open connections (connection strip) | VERIFIED | manual (Xvfb) |
| Tab drag reordering, reopen closed (Ctrl+Shift+T), unsaved warnings | VERIFIED (store) / IMPLEMENTED (drag UI) | `workspaces.test.ts` |
| Workspace restore including unsaved query text | VERIFIED | manual (Xvfb): connection, schema and tabs restored after restart; snapshot unit test. Fixed a bug where restore-in-progress overwrote the saved session |
| Multiple OS windows | VERIFIED | manual (Xvfb): Ctrl+Shift+N / toolbar opens an independent window; only the main window saves and restores the workspace |
| Light and dark themes | VERIFIED | manual (Xvfb) screenshots in both |
| Settings (theme, editor, limits, history, logs, reset) | IMPLEMENTED | |
| Customizable shortcuts | NOT_STARTED | |
| Redacted local logs | VERIFIED (redaction) | `redact::*`; log level setting applies on restart |

## Metrics board

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Dashboards | Named dashboards per connection, stored locally; open as tabs; restored with the workspace | VERIFIED | `DashboardView.tsx`, `storage.rs` | all | storage tests; manual (Xvfb) | |
| Widgets | Number (KPI with previous-period delta), line, bar, donut (top 5 + Other), table; half or full width; reorder; edit with live preview | VERIFIED | `Charts.tsx`, `WidgetContent.tsx`, `WidgetEditor.tsx`, `chartData.ts` | all | `chartData.test.ts`; manual (Xvfb): all five types rendered on PG | Charts take the first column as x/label and numeric columns as series (max 8) |
| Read-only execution | Widgets run on a separate session opened read-only at the database level; each query must be one statement that passes the read-only policy; 30 s timeout; 5,000-row cap | VERIFIED | `engine.rs::run_widget`, `run_widget_query` | all | integration (all drivers: policy refusal, multi-statement refusal, timeout) | |
| Date range | `{{from}}` / `{{to}}` placeholders replaced by strictly validated date literals | VERIFIED | `substitute_dashboard_params` | all | unit test (injection attempt refused) | Only date/time values are accepted |
| Refresh | Manual, per widget, or every 30 s to 15 min while the tab is visible; widgets run one at a time, a failing widget shows its own error | IMPLEMENTED | `DashboardView.tsx` | all | manual (Xvfb) | |
| Chart accessibility | Validated palette (light and dark), legend for 2+ series, tooltips with crosshair, table view per widget, text never in series colours | VERIFIED | `tokens.css`, `Charts.tsx` | — | Palette validator (the dataviz skill's `validate_palette.js`, not in this repo) re-run 2026-10-14 after the redesign: dark series pass every check on `#13161A` and `#0F1215`; light passes on `#FFFFFF` with three series below 3:1, relieved by the legend and the table view | Light series 3, 4 and 5 are under 3:1 against white |

## DuckDB (Tier 2)

| Feature | Status | Evidence | Limitations |
|---|---|---|---|
| Open/create `.duckdb` files, browse schemas, tables, views, sequences, structure (PK, FKs, indexes, constraints) and DDL | VERIFIED | integration `duckdb` (shared scenario); manual (Xvfb) | No query plans yet (Explain hidden) |
| SQL execution with every DuckDB type rendered by DuckDB (lists, structs, decimals, timestamps) | VERIFIED | integration; manual (Xvfb) | |
| Grid edits, filters, import/export, dashboards, conflict checks, rollback | VERIFIED | integration (same scenario as other drivers) | |
| Cancellation (`interrupt`), timeouts, capped large results | VERIFIED | integration | |
| Read-only | VERIFIED | Every statement runs in `BEGIN TRANSACTION READ ONLY`, enforced by DuckDB even on an instance shared with read-write sessions; `nextval` and raw INSERT refused in tests | A file open read-only cannot be reopened read-write in the same app run until those tabs close |

## Redis (Tier 2)

| Feature | Status | Evidence | Limitations |
|---|---|---|---|
| Connect (TCP, TLS via `rediss://`, ACL user, password, database number, SSH tunnel) | VERIFIED (TCP) | integration `redis_kv`; manual (Xvfb) | TLS and SSH paths share the tested code but have no Redis-specific test yet; verified TLS through an SSH tunnel is refused |
| Key browser: SCAN with pattern, type and TTL per key, incremental "Load more" | VERIFIED | integration; manual (Xvfb) | Binary keys are shown as hex and cannot be edited |
| Type-aware viewers: string (JSON formatting), hash, list, set, sorted set, stream; capped at 500 items / 1 MB with totals | VERIFIED | integration; manual (Xvfb) | Module types (JSON, search) are shown as "other"; use the console |
| Edits: string value (keeps TTL), hash field set/delete, key delete, TTL set/remove, new string key | VERIFIED | integration; manual (Xvfb) | Lists, sets, sorted sets and streams are edited through the console |
| Console with history, redis-cli style output | VERIFIED | integration; manual (Xvfb) | |
| Safety: commands classified by name; read-only connections run only read commands; dangerous commands (FLUSHDB, FLUSHALL, CONFIG SET, KEYS, DEL…) need confirmation; blocking and pub/sub commands refused | VERIFIED | unit + integration; manual (Xvfb): FLUSHDB stopped at confirmation | Redis has no server-side read-only session on a primary, so read-only is enforced by this allowlist |

## Import and export

| Feature | Behaviour | Status | Modules | Drivers | Evidence | Limitations |
|---|---|---|---|---|---|---|
| Export query results | CSV (delimiter, header, NULL text), JSON, JSON Lines, SQL INSERT, XLSX | VERIFIED | `transfer.rs`, `ExportDialog.tsx` | all | unit tests per format; integration `export_result` | |
| Export tables | Whole table or current filter and sort, streamed in pages of 5,000 with progress and cancel; partial file removed on failure | VERIFIED | `engine.rs::export_table` | all | integration (all formats, all drivers); manual (Xvfb): 2,500 rows to CSV through the native dialog | Paging uses LIMIT/OFFSET (slower on very large tables than keyset paging) |
| Export selected rows | From the grid context menu | IMPLEMENTED | `export_rows` | all | | |
| Import CSV/TSV/JSON/JSON Lines | Preview, delimiter, header, UTF-8/Latin-1, NULL tokens, trim; type inference (leading zeros stay text) | VERIFIED | `transfer.rs`, `ImportDialog.tsx` | all | unit tests; integration | JSON arrays limited to 256 MB (JSON Lines streams) |
| Import into existing or new table | Column mapping by name; CREATE TABLE previewed; parameterised multi-row INSERTs in one transaction; a failure rolls everything back; cancel | VERIFIED | `engine.rs::import_file` | all | integration (round trip + rollback); manual (Xvfb): 2,500 rows into a new PG table | |
| SQL files | Open into an editor tab (never auto-run), save editor to file, run a dump with an explicit warning, safety policy, progress and stop | IMPLEMENTED | `commands/transfer.rs`, `QueryTab.tsx` | all | | Dumps up to 512 MB are read into memory; MySQL `DELIMITER` scripts not supported |

## AI assistance (optional, off by default)

| Feature | Behaviour | Status | Code | Tests | Known limitations |
|---|---|---|---|---|---|
| Opt-in and configuration | Off by default; turning it on shows what will be sent. Providers: Anthropic Messages API (default model `claude-opus-5-5`) or any OpenAI-compatible `/chat/completions` server (Ollama, LM Studio…). Plain http only to localhost; API key in the OS credential store (memory only when none) | VERIFIED | `ai.rs`, `commands/ai.rs`, `AiSettings.tsx` | `ai::*` unit tests; manual (Xvfb) | |
| Explain, fix error, improve, write SQL | Exact request previewed before each send; table/column names only when ticked; editable error text; row data never sent; answer rendered as text; SQL only inserted at the cursor, never run; cancel | VERIFIED | `ai.rs`, `AiPanel.tsx`, `answer.ts` | `ai_http` (local fake server: body equals the preview, auth header, 404, cancel, connection refused); `answer.test.ts`; manual (Xvfb) against a fake local server, request body inspected | Not exercised against a real model (no API key or Ollama in the dev environment). Anthropic TLS and key rejection verified live with an invalid key (`TPM_AI_LIVE_TLS=1`). No streaming; answers arrive whole (up to 16,000 tokens, 5-minute timeout) |

## Updates

| Feature | Behaviour | Status | Code | Evidence | Known limitations |
|---|---|---|---|---|---|
| Consent and daily check | Asked once on first launch; automatic checks only after "Check automatically", at most every 24 h (a clock that moved backwards still checks); "Check now" in Settings always works; offline failures stay quiet | VERIFIED | `updates.rs`, `commands/update.rs`, `features/updates/` | `updates::*`; `updates.test.tsx`; manual (Xvfb): no request before consent, exactly one manifest request after it | |
| Banner and install | "X is available" with release notes as plain text; Update now warns about anything a restart would lose (uncommitted grid edits, other open windows, unsaved query tabs when tabs are not reopened), saves the workspace, downloads with progress (cancellable), installs and restarts; one install at a time (backend lock held until the installer returns); Download opens the release page when the app cannot install itself | VERIFIED | `UpdateBanner.tsx`, `store.ts`, `commands/update.rs`, `updates.rs` | `updates.test.tsx` (warnings, save before install, cancel, one install per click, Download); `updates::lock_tests`; manual (Xvfb): AppImage 0.1.0 → 0.1.1 replaced in place and restarted as 0.1.1 | Cancel is tested in the UI; cancelling a real download was not run |
| Verification | minisign signature against the embedded public key; signed version must match the announced one; only newer versions are offered (plugin default, `allowDowngrades` never set, checked by `release.yml`) | VERIFIED (signature, signed version) | plugin config, `commands/update.rs` | manual (Xvfb): one flipped byte refused; 0.1.1 file announced as 0.1.2 refused; file unchanged both times | Refusing an older version was not tested separately |
| AppImage self-update | Replaces the AppImage file | VERIFIED | plugin | manual (Xvfb) as above | |
| `.deb` / `.rpm` update | Installed with the system package manager after the system password prompt (`pkexec`) | IMPLEMENTED | plugin | manual (Xvfb): `.deb` build detected (offers Update now via the `linux-x86_64-deb` entry) | The root install itself not yet run |
| Windows (NSIS, MSI) and macOS (.app) updates | Passive installer on Windows; `.app` replaced on macOS | IMPLEMENTED | plugin, `release.yml` | — | Not yet run on real machines |
| Release pipeline | Tag builds sign every updater file, attach `latest.json` (9 targets) and `SHA256SUMS` to a draft; only `-suffix` tags are pre-releases, and they get a numeric MSI version (`0.2.0-rc.1` → `0.2.0.1`) | IMPLEMENTED | `release.yml`, `scripts/updater-manifest.mjs`, `scripts/release-build-config.mjs` | `updater-manifest.test.mjs`, `release-build-config.test.mjs`; collect step simulated for all three OSes with a pre-release version; actionlint | Becomes VERIFIED with the first signed release run |

## Not yet started

| Area | Status | Notes |
|---|---|---|
| SQL Server | NOT_STARTED | Evaluated (`tiberius`, MIT/Apache): viable; see DATABASE_ADAPTERS.md |
| CockroachDB, ClickHouse, Redshift, MongoDB, Snowflake, Oracle, Cassandra | NOT_STARTED | Tier 3; CockroachDB and Redshift may work through the PG adapter but are untested and not claimed |
| Optional MCP server | NOT_STARTED | Disabled by default; local transport only |

## Platforms

| Platform | Status | Evidence |
|---|---|---|
| Linux x86_64 debug build and run | VERIFIED | Built and run under Xvfb on Ubuntu 26.04 |
| Linux release build and .deb package | VERIFIED | `npx tauri build --bundles deb` produced a 28 MiB .deb (most of it the embedded DuckDB engine) with correct metadata; the release binary (embedded frontend) was run under Xvfb. Installing the .deb with dpkg was not tested (no root on the dev machine) |
| Linux AppImage and rpm | IMPLEMENTED | Built by CI and `release.yml` on Ubuntu 24.04; not yet launched |
| Windows x86_64 (.msi, NSIS setup.exe) | IMPLEMENTED | Built by CI on `windows-latest` (clippy clean); not yet installed or launched. Unsigned |
| macOS Apple Silicon (.dmg) | IMPLEMENTED | Built by CI on `macos-latest`; not yet launched. Unsigned and not notarized |
| macOS Intel | NOT_STARTED | No x86_64 build yet |
