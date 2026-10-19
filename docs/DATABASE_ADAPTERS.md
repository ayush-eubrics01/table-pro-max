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

| | PostgreSQL | MySQL | MariaDB | SQLite | DuckDB | SQL Server |
|---|---|---|---|---|---|---|
| Multiple databases per server (switch by reconnect) | yes | no (schemas = databases) | no | no (attached DBs as schemas) | no | yes |
| Schemas | yes | yes (databases) | yes | `main` + attached | yes | yes (`dbo` first) |
| Cancellation | protocol cancel | `KILL QUERY` | `KILL QUERY` | `sqlite3_interrupt` | `duckdb_interrupt` | TDS attention (reconnects when the driver can't settle it) |
| Transactions for grid edits | yes | yes (InnoDB) | yes | yes | yes | yes |
| Transactional DDL | yes | no | no | yes | yes | yes |
| EXPLAIN | JSON (VERBOSE) | `FORMAT=JSON` | `FORMAT=JSON` | `EXPLAIN QUERY PLAN` | not yet | not yet |
| EXPLAIN ANALYZE | JSON + BUFFERS | tree (8.0.18+) | not offered | no | not yet | not yet |
| Materialized views | yes | no | no | no | no | no |
| Routines listed | functions, procedures | yes | yes | no | no | functions, procedures |
| Sequences | yes | no | yes | no | yes | yes |
| Read-only enforcement | `default_transaction_read_only=on` | `SET SESSION TRANSACTION READ ONLY` | same | `SQLITE_OPEN_READ_ONLY` + `query_only` | `access_mode=READ_ONLY` or per-statement `BEGIN TRANSACTION READ ONLY` | every batch in a transaction that is rolled back |

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

## Large values on demand

Opened tables leave potentially large columns out of the page query entirely: no `length()`,
no preview, no `CASE`. The database never reads them for that page; on PostgreSQL those values
stay in TOAST storage. Columns are chosen by type from the introspected structure, never by
looking at data, and primary-key and foreign-key columns are always loaded (they identify rows and are followed from the grid). Tables without a primary key load
every column.

| Engine | Deferred by default | Loaded |
|---|---|---|
| PostgreSQL / DuckDB | `text`, `character varying` / `varchar` with no length, `json`, `jsonb`, `xml`, `bytea`, arrays, `tsvector` (DuckDB: `VARCHAR`, `JSON`, `BLOB`, lists, structs, maps) | `varchar(n)`, `char(n)`, numbers, booleans, dates and times, `uuid`, enums |
| MySQL / MariaDB | `text`, `mediumtext`, `longtext`, `json`, `blob`, `mediumblob`, `longblob` | `char`, `varchar(n)`, `tinytext`, `tinyblob`, numbers, dates, `enum`, `set` |
| SQLite | declared `TEXT`, `BLOB`, `JSON`, `CLOB`, or no declared type | `INTEGER`, `REAL`, `NUMERIC`, `varchar(n)` and other types |

A user can mark any column **Always load** or **Don't load**; the choice is stored locally per
connection, table and column (column names only). A value is fetched with
`SELECT <pk…>, <column> FROM t WHERE (pk = $1 …) OR (…)`, keys as bind parameters. Query
results are the user's own SQL and are never rewritten: the database sends full values, the app
keeps them in its result store, and text longer than `grid.largeValueChars` reaches the UI as a
preview that opens from memory.

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

## SQL Server (`adapters/mssql.rs`)
* Built on `tiberius` 0.13 (TDS 7.3, rustls). Tested against SQL Server 2022; the catalog queries
  use nothing newer than SQL Server 2016. Azure SQL is untested: its gateway redirect is followed
  and the product name comes from `SERVERPROPERTY('EngineEdition')`. Sign-in with SQL Server
  logins only: Windows (Kerberos, NTLM) and Microsoft Entra sign-in are not supported yet. Named
  instances need their TCP port (no SQL Browser lookup).
* Connections: `sqlserver://` / `mssql://` URLs and ADO.NET strings (`Server=tcp:host,port;…`).
  TLS: the sign-in is always encrypted. Disable = sign-in only (certificate not checked);
  Prefer = Require = everything encrypted and the certificate verified; "skip verification" for
  self-signed servers. tiberius builds AWS-LC through tokio-rustls's defaults, but the app installs
  ring as rustls's process provider, which tiberius uses.
* Scripts run as batches separated by `GO` lines, as in SSMS, so `DECLARE`d variables, `IF … BEGIN
  … END` blocks and procedure bodies work. Ctrl+Enter runs the top-level `;`-statement at the
  cursor within its batch, keeping blocks and procedure bodies whole. The safety analyzer reads a
  batch with sqlparser's T-SQL dialect; when it can't parse it, each statement is judged by every
  destructive keyword it contains.
* Values: rendered by the adapter as SSMS shows them (`datetime` to the millisecond, `datetime2`,
  `time` and `datetimeoffset` with their declared digits, `money` with four decimals, `bit` as
  1/0, GUIDs upper-case, binary as bytes). Each rendering converts back to the same value when
  bound as a parameter, which conflict checks and query parameters rely on (integration test).
  `money` arrives from the driver as a float, exact below about 900 billion; the app's own reads
  (pages, restore points, rows by key) cast it to `decimal(19,4)`, which is exact.
* Parameters: `sp_executesql` with `@P1…`, always as `nvarchar`. Statements without values run
  as plain batches (a transaction opened inside `sp_executesql` is refused). A batch with
  parameters runs inside `sp_executesql`, so #temp tables it creates end with it.
* Row cap: a plain `SELECT` runs under `SET ROWCOUNT cap+1`, so the server stops; in any other
  batch, rows past the cap are read and dropped, so the statements after it still run. A user's
  own `SET ROWCOUNT` is refused (it would cap the app's reads, and the app's would clear it): use
  `TOP`. Cancels and timeouts send the attention signal. tiberius 0.13.0 does not wait for the
  server's acknowledgement when it comes in a separate message (prisma/tiberius#459, fix in #460),
  so after a cancel the connection is opened again on the database it was using: #temp tables,
  variables, SET options and an open transaction are lost; the cancel message says so and names
  the database, and the engine drops restore points made in that transaction. In practice every
  cancel and timeout reconnects until tiberius is fixed. A cancel reaches the connection only
  while that run's statement holds it (engine `cancel_task`), so one aimed at a finished statement
  or at a run still waiting never interrupts the app's own follow-up queries; only the user's
  batches listen for one. The app's own reads (catalog, pages, restore planning and captures) run
  through `sp_executesql` with `SET LOCK_TIMEOUT 5000` scoped to the call, so none waits more than
  5 s behind another session (uncommitted DDL included) and the user's own LOCK_TIMEOUT is left
  alone; the restore size estimate also reads with `NOLOCK`. A capture that times out on a lock
  runs the statement without a restore point and says why. With XACT_ABORT a failed batch that
  contains COMMIT keeps its pending restore points (the restore's conflict check stands guard).
* A batch that fails part-way reports the error only: result sets before it are not shown, though
  statements before it ran (and, outside a transaction, were committed). `GO n` (repeat a batch)
  is not supported.
* Read-only: each batch runs as `BEGIN TRANSACTION; … ; ROLLBACK`, on top of the analyzer, which
  refuses everything but reads (procedure calls and dynamic SQL included). Batches that could end
  that transaction or reach past it are refused: `COMMIT`, `ROLLBACK`, `IMPLICIT_TRANSACTIONS`,
  `ANSI_DEFAULTS`, `OPENQUERY`, `OPENROWSET`, `OPENDATASOURCE`. Words are split on any character
  that isn't a letter, digit or `_@#$`, so a non-breaking space (pasted SQL) can't hide one. Effects outside the
  database's transaction log (a sequence's `NEXT VALUE FOR`, mail) are not undone; for full
  protection use a login with read-only rights (`db_datareader`). `ApplicationIntent=ReadOnly`
  is sent too, which routes to a readable secondary where there is one.
* Introspection from `sys.*`: columns with declared types, identity, computed columns (the
  expression stands in for the default), defaults, MS_Description comments; indexes (filtered,
  INCLUDE), unique and check constraints, foreign keys, triggers. Table DDL is generated (SQL
  Server has no SHOW CREATE TABLE); views and routines come from `OBJECT_DEFINITION`. Query
  result columns are described with `sys.dm_exec_describe_first_result_set` in browse mode, so
  results from one table can be edited.
* Restore points: rows are read under `UPDLOCK, HOLDLOCK` (TRUNCATE/DROP lock the table with
  `TABLOCKX`); restores re-insert identity values under `SET IDENTITY_INSERT`, and a dropped table
  comes back with its identity seed and step. Tables with binary columns get none, as on MySQL.
  The engine asks `@@TRANCOUNT` (and `DB_NAME()`) after each batch to follow the user's
  transactions; one that ended counts as committed unless the batch failed or only rolled back.
  An error in a statement never ends the user's transaction on the app's side.
* Not yet: query plans (`SHOWPLAN_XML`), Windows/Entra sign-in, named-instance lookup,
  `DROP DEFAULT` from the structure editor (defaults are named constraints: drop them by name).
* Tests: `scripts/test-db.sh` starts `tpm-test-mssql` (SQL Server 2022 Developer edition, free for
  development and testing; starting it accepts Microsoft's licence for that use).

## MongoDB (`mongo.rs`)
MongoDB is not SQL, so like Redis (`redis_kv.rs`) it does not implement `Session`: the engine keeps
`MongoSession`s in a map of their own and the UI has a `mongo` workspace (`features/mongo/`).
* Built on the official `mongodb` crate 3.9 (Apache-2.0) with rustls; the app installs ring as
  the rustls provider, as for SQL Server. Tested against MongoDB 7 and `mongodb-atlas-local` 8.
* Connections: `mongodb://` with one host, or `mongodb+srv://` (hosts from DNS, as Atlas needs).
  `authSource`, `tls`/`ssl`, `tlsAllowInvalidCertificates`/`tlsInsecure`, `tlsCAFile` and
  `directConnection` are read from URLs (option names in any case). An SSH tunnel connects
  directly to its one host; SRV and verified TLS through a tunnel are refused before the tunnel
  opens. Sign-in is user and password (SCRAM); the auth database is the one given, else `admin`
  for SRV (Atlas), else the connection's database.
* Reads: find (filter, sort, projection as relaxed Extended JSON), count, aggregate (reading
  stages only), and vector search, whose `$vectorSearch` stage the core builds from a form. Each
  read sends `maxTimeMS`. Documents come back as relaxed Extended JSON text.
* Deletes: by `_id` or by filter, counted first and run only while the count is unchanged; read-only
  and locked production sessions refuse them, and `system.*` collections and the `admin`,
  `config` and `local` databases are never deleted from. Ids must be exact values: a regular
  expression, an array or a `$` operator is refused, since inside `$in` it could match many
  documents without the typed confirmation a filter needs on production.
* Names (database, collection, index, field path) are passed to the driver as API parameters,
  never put into query text, so there is nothing to quote.
* Not supported: inserting or editing documents, index management, schema validation, change
  streams, GridFS, replica-set host lists, restore points.
* Tests: `scripts/test-db.sh` starts `tpm-test-mongo` (`mongo:7`) and `tpm-test-mongo-atlas`
  (`mongodb/mongodb-atlas-local`, for vector search).

## Adding a driver
1. Implement `Session` in `adapters/<name>.rs` and add a `Driver` variant and dialect mapping.
2. Report capabilities honestly. Return `ErrorKind::Unsupported` for anything not implemented.
3. Map driver errors to `ErrorKind` and keep server codes and positions.
4. Add the driver to `scripts/test-db.sh` and run the shared `exercise` integration scenario.
5. Update this file and FEATURE_MATRIX.md, and mark it VERIFIED only after the scenario passes.
