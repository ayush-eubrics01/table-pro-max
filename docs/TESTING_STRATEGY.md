# Testing strategy

## Layers

| Layer | Command | What it covers |
|---|---|---|
| Rust unit tests | `cargo test -p tpm-core --lib` | Redaction, URL parsing, quoting, splitting, safety analysis, filter/browse/change/DDL generation, storage migrations and CRUD, credential memory store |
| Rust integration | `scripts/test-db.sh up` then `eval "$(scripts/test-db.sh env)"` and `cargo test -p tpm-core --test integration` | One shared scenario per driver against real servers (below) |
| Frontend unit + component | `npm test` | Pending-change model, filter model, fuzzy ranking, workspace store (tab isolation, reopen, reorder, restore snapshot), TableView edit → review → commit and discard with mocked IPC, read-only grids, FilterBuilder (type-aware operators, nesting, 40+ conditions), ConnectionForm (URL import, secrets kept out of profiles, keychain fallback, TLS warning) |
| Rust HTTP (AI) | `cargo test -p tpm-core --test ai_http` (add `TPM_AI_LIVE_TLS=1` for one live TLS check against api.anthropic.com with an invalid key) | AI client against a fake OpenAI-compatible server on 127.0.0.1: request body equals the preview, bearer auth, 404 mapping, cancel within 200 ms, connection refused |
| Updates | `cargo test -p tpm-core updates::`, `cargo test -p table-pro-max --lib update` (needs the WebKitGTK toolchain), `npx vitest run src/features/updates scripts` | Consent and daily-interval rules (including a clock that moved backwards), plugin error mapping, install-kind detection, consent dialog, banner (notes as text, pending-edit warning, one install per click, Download fallback), manifest generation for every platform and for pre-release versions |
| Static checks | `cargo clippy --workspace --all-targets`, `cargo fmt --check`, `npm run typecheck`, `npm run lint` | |
| Manual end-to-end (Linux) | see "Driving the real app" | The real Tauri app against a disposable database |

## Integration scenario (`crates/tpm-core/tests/integration.rs`)
For PostgreSQL 16, MySQL 8.4, MariaDB 11.4 and SQLite, the same `exercise` function:
1. Connects through the engine with the parsed URL.
2. Proves a destructive script needs confirmation, then creates fixtures.
3. Checks schema discovery: schemas, objects, columns, PK, auto-increment, nullability,
   indexes, foreign keys, and DDL.
4. Runs multi-statement SQL: text values, quoting, NULL, binary, second result set.
5. Checks error handling: syntax error position mapped into the script (PG); stop on error;
   constraint violation kind.
6. Browses with filters (OR group, contains with `;` and quotes), sort, pagination, a probe
   row and count. An injection attempt through a filter value returns no rows.
7. Commits grid edits: update + insert in one transaction. A stale original value gives a
   conflict and full rollback. A constraint failure in a batch rolls back an earlier delete.
8. Runs a 1M-row query: capped at 100k, paged fetch, server query stopped early, session
   still usable, results released.
9. Cancellation in under 5 s; timeout; the session stays usable.
10. Runs EXPLAIN (PG JSON validated).
11. Read-only mode: policy blocks DELETE; the server refuses `nextval` (PG); a raw session
    with no policy layer cannot INSERT.
12. Connection loss: backend terminated from a second session, error reported, reconnect,
    query OK.

A driver whose URL variable is unset prints `BLOCKED: …` and is skipped. It is never
reported as passing. Tests use only the `tpm_test` database in disposable containers
(`tpm-test-*`, tmpfs storage, ports 55432/53306/53307/51433). **Never point these variables at a
real database.**

SQL Server has a flow of its own (`sql_server`, `TPM_TEST_MSSQL_URL`), because its batches,
types and paging differ: discovery, batches with variables and `GO`, error positions, browse
and filters, grid edits with conflicts and rollback, both row-cap paths, cancel and timeout,
user transactions, read-only (a raw session keeps no write), connection loss, query parameters,
column origins, every common type rendered and bound back equal, restore points with identity
values and a dropped table, and the shared export/import round trip. Its container,
`tpm-test-mssql`, runs SQL Server 2022 Developer edition (free for development and testing;
starting it accepts Microsoft's licence for that use).

## Driving the real app (Linux, manual)
WebKitGTK has no packaged WebDriver on the development machine, so the desktop app is checked
under Xvfb with a small XTest helper:
1. `Xvfb :99 -screen 0 1440x900x24 -fbdir <dir>` and `npm run dev`.
2. Launch `target/debug/table-pro-max` with `DISPLAY=:99`, `XDG_DATA_HOME`/`XDG_CONFIG_HOME`
   pointing at a scratch dir, and `DBUS_SESSION_BUS_ADDRESS` pointing at a nonexistent socket
   with `XDG_RUNTIME_DIR` unset. This keeps the run away from the developer's real keyring and
   app data.
3. Drive it with XTest (mouse and keyboard). Screenshots come from the Xvfb framebuffer (XWD).
4. Check the database state with `psql` inside the container.

The flows verified this way: URL import, test connection, save and connect (ask-every-time
fallback), schema switch, open table, inline edit, delete toggle, review dialog, FK failure
with full rollback, successful commit checked in the DB, query tab run, destructive-statement
confirmation (DB unchanged), EXPLAIN plan view, table export to CSV through the native save
dialog, CSV import into a new table, workspace restore after restart, production styling,
MySQL edit/commit, SQLite browse with binary cells, and filters.

## In-app update end to end (Linux, manual)
1. Generate a throwaway key: `npx tauri signer generate --ci -p <pw> -w <dir>/test.key`. Never use
   the real key.
2. Build two AppImages with it, passing a config override per version:
   `{"version":"0.1.0","bundle":{"createUpdaterArtifacts":true,"targets":["appimage","deb"]},
   "plugins":{"updater":{"pubkey":"<test.key.pub>","endpoints":["http://127.0.0.1:8765/latest.json"],
   "dangerousInsecureTransportProtocol":true}}}` and run
   `TAURI_SIGNING_PRIVATE_KEY="$(cat test.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<pw> npx tauri build --config <file>`.
   The insecure flag exists only in these throwaway builds; `release.yml` refuses it.
3. Serve a `latest.json` for 0.1.1 and the 0.1.1 AppImage with `python3 -m http.server 8765 --bind 127.0.0.1`.
4. Run the 0.1.0 AppImage isolated (as in "Driving the real app", plus `APPIMAGE_EXTRACT_AND_RUN=1`
   and `TPM_UPDATE_ENDPOINT=http://127.0.0.1:8765/latest.json`). Check that the consent dialog
   comes before any request, then follow the banner through Update now; the AppImage hash must
   become the 0.1.1 hash and Settings › Updates must show 0.1.1 after the restart.
5. Repeat with one byte of the served file changed, then with the manifest announcing a
   different version: both must be refused and the file must stay unchanged.
6. Delete the throwaway key and the test bundles (`target/release/bundle`).

## Benchmark (`crates/tpm-core/examples/bench.rs`)
Repeatable large-result and large-import check against the disposable databases:
```sh
scripts/test-db.sh up && eval "$(scripts/test-db.sh env)"
cargo run --release -p tpm-core --example bench [import_rows]
```
Results on the development machine (12-core x86_64, Docker on localhost, release build,
200,000-row / 9 MB CSV, 2026-10-13):

| Database | 1M-row SELECT capped at 100k | Page fetch (1k rows) | Import 200k rows | Export table to CSV |
|---|---|---|---|---|
| PostgreSQL 16 | 0.15 s | 0.2 ms | 1.22 s (164k rows/s) | 0.94 s (212k rows/s) |
| MySQL 8.4 | 0.08 s | 0.1 ms | 0.87 s (229k rows/s) | 1.07 s (187k rows/s) |
| MariaDB 11.4 | 0.09 s | 0.1 ms | 0.53 s (380k rows/s) | 0.79 s (254k rows/s) |
| SQLite 3.53 | 0.04 s | 0.1 ms | 0.32 s (630k rows/s) | 0.17 s (1.18M rows/s) |

The capped SELECT stops the server-side query at the cap (cancel or interrupt) instead of
draining a million rows. Imports run in one transaction with parameterised multi-row INSERTs.
Network latency to a remote server will dominate these numbers in real use.

## Planned
* Automated UI end-to-end: either `tauri-driver` + WebKitWebDriver in CI (Linux runners can
  install `webkit2gtk-driver`) or Playwright against the Vite build with a command bridge.
* QueryTab component tests (CodeMirror in jsdom).
* TLS integration fixture (self-signed CA) for all network drivers.
* Grid scrolling frame-time measurement in the webview.
* Windows and macOS: CI already builds the installers; still to do are launch tests and
  credential-store tests on those runners.
