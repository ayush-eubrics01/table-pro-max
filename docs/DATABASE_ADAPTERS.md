# Database adapters

Every driver implements `tpm_core::adapters::Session` (`crates/tpm-core/src/adapters/mod.rs`):

| Method | Purpose |
|---|---|
| `dialect`, `capabilities`, `canceller` | Static facts and the out-of-band cancel handle |
| `server_info`, `ping` | Version, current database and user; health check |
| `list_databases`, `list_schemas`, `list_objects`, `table_structure`, `object_definition` | Introspection |
| `execute(sql, max_rows)` | One user-authored statement; may return several result sets |
| `query(sql, params, max_rows)` | Application-generated, parameterised query returning text rows |
| `apply(statements, atomic)` | Generated writes, optionally in one transaction, with per-statement expected row counts |
| `close` | Graceful disconnect |

`Capabilities` is sent to the UI, which hides actions a driver cannot perform.

## Capability matrix

| | PostgreSQL | MySQL | MariaDB | SQLite | DuckDB |
|---|---|---|---|---|---|
| Multiple databases per server (switch by reconnect) | yes | no (schemas = databases) | no | no (attached DBs as schemas) | no |
| Schemas | yes | yes (databases) | yes | `main` + attached | yes |
| Cancellation | protocol cancel | `KILL QUERY` | `KILL QUERY` | `sqlite3_interrupt` | `duckdb_interrupt` |
| Transactions for grid edits | yes | yes (InnoDB) | yes | yes | yes |
| Transactional DDL | yes | no | no | yes | yes |
| EXPLAIN | JSON (VERBOSE) | `FORMAT=JSON` | `FORMAT=JSON` | `EXPLAIN QUERY PLAN` | not yet |
| EXPLAIN ANALYZE | JSON + BUFFERS | tree (8.0.18+) | not offered | no | not yet |
| Materialized views | yes | no | no | no | no |
| Routines listed | functions, procedures | yes | yes | no | no |
| Sequences | yes | no | yes | no | yes |
| Read-only enforcement | `default_transaction_read_only=on` | `SET SESSION TRANSACTION READ ONLY` | same | `SQLITE_OPEN_READ_ONLY` + `query_only` | `access_mode=READ_ONLY` or per-statement `BEGIN TRANSACTION READ ONLY` |

## PostgreSQL (`adapters/postgres.rs`)
* Requires PostgreSQL 10+ (identity columns, `pg_sequences`). Functions are listed with
  `prokind` (11+), and older servers fall back silently.
* User SQL: `simple_query_raw`. Values arrive in text form; `bytea` shows as `\x…`.
  Column type names are not available on this path.
* Generated SQL: extended protocol. Parameters use `TextParam` (text format, any type).
  Browse queries cast columns to `::text` except `bytea`, which is decoded as binary.
* Conflict check compares `col::text IS NOT DISTINCT FROM $n` with the loaded text.
* Errors: SQLSTATE class mapping (23 constraint, 28 auth, 08 network, 57014 cancelled,
  25006 read-only). Detail, hint and context are kept, and the position is mapped into the
  editor.

## MySQL / MariaDB (`adapters/mysql.rs`)
* MySQL 5.7+/8.x and MariaDB 10.3+ expected. The product is detected from `VERSION()`.
* User SQL: `query_iter` (text protocol), so multiple result sets work. Binary columns
  (charset 63 on string/blob types) become binary cells.
* Generated SQL: prepared statements. Binary-protocol values are formatted to text
  (DATE vs DATETIME, TIME with day overflow, microseconds).
* TLS "prefer" tries TLS first and falls back to plaintext only when the server reports no
  TLS support.
* Cancellation opens a short-lived second connection with the same options.
* Note: `SLEEP()` returns `1` when killed instead of raising an error. Results are kept and
  the run is marked cancelled.

## SQLite (`adapters/sqlite.rs`)
* Opening never creates a file; "Create new…" uses `create_database_file`, which refuses to
  overwrite. The file must pass a `sqlite_master` read to count as a database.
* All calls run on the blocking thread pool behind a `std::sync::Mutex`.
* Introspection uses pragma table-valued functions (`pragma_table_xinfo`,
  `pragma_index_list`, `pragma_foreign_key_list`). A rowid-alias `INTEGER PRIMARY KEY` is
  reported as auto-increment.
* `PRAGMA` statements are classified by a dedicated allowlist (sqlparser cannot parse
  pragma arguments that are identifiers).

## DuckDB (`adapters/duckdb.rs`, cargo feature `duckdb`, on by default)
* Embedded via the `duckdb` crate with the bundled engine (MIT). A clean build compiles DuckDB's
  C++ sources (about five minutes on 12 cores); build with `--no-default-features --features os-keyring`
  to leave it out.
* DuckDB allows one database instance per file per process, so sessions on the same file share
  an instance (`try_clone`) through a process-wide registry.
* Generated SQL uses the PostgreSQL dialect (quoting, `$n` parameters, casts, `IS NOT DISTINCT FROM`).
* Row-returning user statements are wrapped as `SELECT COLUMNS(*)::VARCHAR FROM (…)` so DuckDB
  renders every type itself; column types come from `DESCRIBE`, which binds without executing.
  A statement that cannot be wrapped runs as is, and the wrapper never runs a statement twice.
* Read-only sessions run each statement inside `BEGIN TRANSACTION READ ONLY`.

## Column origins (editable query results)

A query result cell can be edited only when the database says which table column it came
from. No SQL is parsed. A column with no origin (an expression, aggregate, literal or function)
stays read-only. The rule that decides editability is in `result_edit.rs`.

| Engine | Mechanism | Cost |
|---|---|---|
| MySQL / MariaDB | The text-protocol column definitions carry `schema`, `org_table` and `org_name`. An empty `org_table` means no origin. | none |
| PostgreSQL | `Session::describe_origins` calls `Client::prepare(sql)` (describe only, never executes) and reads each column's `table_oid` and `column_id`. OIDs resolve to names with one catalog query per new table, cached per session. Skipped on read-only sessions; a failed prepare means no origins. | one round-trip per row-returning statement |
| SQLite | rusqlite feature `column_metadata` (`SQLITE_ENABLE_COLUMN_METADATA`): `column_database_name`, `column_table_name`, `column_origin_name`. Views report their base table. | none |
| DuckDB | Not available. Query results are read-only; opened tables can still be edited. | none |

Origins name the base table, not the alias or the branch of a `UNION`: in `users a JOIN users b`
both sides report `users`, and SQLite reports a compound SELECT's origins from one branch and a
view's columns as its base table's. So `result_sql.rs` also parses the statement, and only ever
takes editability away: a table named more than once (or not at all), a CTE used twice,
`UNION`/`INTERSECT`/`EXCEPT`, a statement that does not parse, and (on SQLite and MySQL) a view
anywhere in the query make the affected result read-only.

Committing edits refuses to run while the tab has an open transaction (its BEGIN/COMMIT would end
the user's). PostgreSQL and SQLite check this exactly, MariaDB through `@@in_transaction`; MySQL
checks `@@autocommit`, and the engine also tracks the `BEGIN`/`COMMIT`/`ROLLBACK` the user runs.

## SQL Server (evaluated, not implemented)
* `tiberius` (MIT/Apache-2.0) is a maintained async TDS client with rustls support and
  `QueryStream` result streaming. Gaps to handle: no built-in cancel API (would need an
  `ATTENTION` packet or a `KILL` from a second connection), and Windows integrated auth
  (`winauth`/Kerberos) is only partially supported.
* Plan: a `Dialect::Mssql` (bracket quoting, `@P1` parameters, `OFFSET … FETCH`), introspection
  through `sys.*` catalog views, and read-only via `ApplicationIntent=ReadOnly` plus a
  `db_datareader` role recommendation.

## Adding a driver
1. Implement `Session` in `adapters/<name>.rs` and add a `Driver` variant and dialect mapping.
2. Report capabilities honestly. Return `ErrorKind::Unsupported` for anything not implemented.
3. Map driver errors to `ErrorKind` and keep server codes and positions.
4. Add the driver to `scripts/test-db.sh` and run the shared `exercise` integration scenario.
5. Update this file and FEATURE_MATRIX.md, and mark it VERIFIED only after the scenario passes.
