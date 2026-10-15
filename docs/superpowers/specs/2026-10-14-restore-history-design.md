# Restore history: design

Date: 2026-10-14. Status: agreed in conversation, awaiting written-spec review.

This is the third of three sub-projects, after large values on demand and the foreign-key jump.

## Goal
Before the app changes or destroys rows, it keeps a copy of exactly those rows. You can later
see what a statement changed and put it back: all of it, or chosen rows. Copies are kept on this
machine for 7 days.

Success means:
- After `UPDATE orders SET status = 'cancelled' WHERE customer_id = 42`, a restore point lists
  the matched rows before and after. **Restore all** puts the old values back, after a review and
  a commit.
- DELETE, TRUNCATE, DROP TABLE and ALTER TABLE … DROP COLUMN can be undone the same way.
- Grid commits in the table view get restore points too.
- A restore never overwrites a row someone changed since: the conflict check stops it, and
  nothing is written.
- When a restore point can't be kept, you're told why before the statement runs, and you choose
  to run anyway or cancel.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| What is captured | UPDATE and DELETE (with or without WHERE), TRUNCATE, DROP TABLE and ALTER TABLE … DROP COLUMN from query tabs, plus grid commits (updates and deletes) in the table view. |
| How | In one transaction: read the affected rows (`SELECT … WHERE <the statement's WHERE> FOR UPDATE` where supported), run the statement, read the rows again by primary key for the "after" values, commit. |
| Storage | The local app database, **unencrypted**. Nothing leaves the machine. |
| Who has it | On by default for **every** connection, production included. A per-connection switch turns it off. |
| Limits | At most 100,000 rows or 50 MB per restore point, 1 GB for all restore points together (oldest removed first), and 7 days. All three are settings. |
| Restore | **Restore all** or **Restore selected** rows. The restore SQL is reviewed and committed in one transaction, with a conflict check. |
| Can't capture | A confirmation names the reason; **Run anyway** runs without a restore point. |

## Non-goals
- Restoring INSERTs, or rows inserted by grid commits (deleting what was added).
- Statements the app can't analyse into one table plus a WHERE (see the capture plan).
- Capturing changes made outside the app, or by triggers and cascades the statement causes in
  other tables.
- Encryption at rest.
- Sharing or exporting restore points.

## Capture plan (`crates/tpm-core/src/restore_plan.rs`)
Each statement is parsed with sqlparser, in the session's dialect, into one of these:

| Statement | Plan | Captured |
|---|---|---|
| `UPDATE t [AS a] SET … [WHERE w]` | `Update { table, alias, where_sql, set_columns }` | before rows matching `w`; after rows by primary key |
| `DELETE FROM t [AS a] [WHERE w]` | `Delete { table, alias, where_sql }` | before rows matching `w` |
| `TRUNCATE [TABLE] t` | `Truncate { table }` | all rows |
| `DROP TABLE t` (a single table) | `DropTable { table }` | definition (`object_definition`) and all rows |
| `ALTER TABLE t DROP [COLUMN] c` (a single column, nothing else) | `DropColumn { table, column }` | key columns plus `c` for all rows; the column's type and nullability from the structure |
| anything else that writes | `Unsupported { reason }` | nothing |

- The WHERE is re-emitted from the parsed expression (sqlparser's `Display`), so the capture
  `SELECT` filters exactly as the statement does. The table keeps its alias.
- **Unsupported, with these reasons:**
  - "joins other tables": `UPDATE … FROM`, `DELETE … USING`, MySQL multi-table;
  - "uses ORDER BY or LIMIT";
  - "uses a WITH clause";
  - "changes the primary key": the SET list includes a key column;
  - "the table has no primary key": UPDATE and DROP COLUMN only, since a DELETE can still be
    re-inserted;
  - "the statement could not be analysed";
  - "the table could not be read".
- **Only writes are planned.** Statements of class `Read`, `Session` and `Transaction` are never
  planned. INSERT, CREATE and the other DDL get no plan and no confirmation.
- **Before a script runs**, the engine plans every statement. For each capturable one it counts
  the matching rows: `SELECT count(*) FROM t WHERE w`, or the whole table for TRUNCATE, DROP
  TABLE and DROP COLUMN. A statement is over the limit when its count is above the row limit.
  The byte limit can't be known without reading the rows, so it is checked during capture
  instead: a capture that goes over it is dropped, the statement runs without a restore point,
  and its message says so.
- **Confirmation.** If any statement is `Unsupported` or over the limit, and the user hasn't
  confirmed, the run returns `confirmation_required`, listing each statement and its reason, the
  same way as the existing destructive-statement confirmation. **Run anyway** reruns with
  `confirmed`, and those statements run without a restore point.
- **No restore point at all when:**
  - the connection is read-only;
  - restore points are off for the connection;
  - the driver is Redis.

## Capture at run time (engine)
For a statement with a capture plan, on the tab's session, through the session lock:

1. **Outside a user transaction:** `BEGIN`.
   **Inside one** (the engine's open-transaction tracking): no BEGIN, and the restore point is
   marked **pending**.
2. **Before rows:** `SELECT <columns> FROM t [AS a] WHERE w [FOR UPDATE]`.
   - `FOR UPDATE` on PostgreSQL and MySQL/MariaDB. Not on SQLite, which writes under a database
     lock anyway, or DuckDB.
   - At most limit + 1 rows are fetched. Over the limit: this statement runs without a restore
     point, and its message says "No restore point: more than 100,000 rows".
   - Columns are read like the table view (the PostgreSQL text cast), so values round-trip as
     bind parameters.
3. **Run the statement**, as today.
4. **After rows** (UPDATE only): `SELECT … WHERE <pk> IN (captured keys)`.
5. **Outside a user transaction:** `COMMIT`. If anything fails: `ROLLBACK`, the statement's
   error is shown as usual, and no restore point is kept.
6. **Save the restore point** through `RestoreStore::save`. The engine holds an
   `Option<Arc<dyn RestoreStore>>`, which the Tauri layer sets to the app storage.

**Pending restore points:**
- When the user's `COMMIT` succeeds in the same session, pending points become **kept**.
- On `ROLLBACK`, `reconnect`, `close_session` or a broken session, pending points are deleted.
  `ROLLBACK TO SAVEPOINT` leaves them pending, which is conservative.

**DDL:** DROP TABLE and DROP COLUMN capture all rows (and, for DROP TABLE, the definition)
before running. On SQLite, DuckDB and PostgreSQL, DDL is transactional, so the BEGIN/COMMIT
wraps it. On MySQL/MariaDB, DDL commits implicitly: the capture runs first, the statement
second, and the restore point is saved only if the statement succeeds.

**Grid commits:** `apply_change_sets` captures before rows by the change set's keys, for updated
and deleted rows, inside its existing transaction. It reads after rows for the updates, and saves
one restore point per table, with the kind "Grid edit". Inserted rows are not captured.

## Storage (`storage.rs`, migration 3)
```sql
CREATE TABLE restore_points (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'kept', 'restored')),
    restored_at TEXT,
    kind TEXT NOT NULL,             -- update | delete | truncate | drop_table | drop_column | grid_edit
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    statement TEXT NOT NULL,
    data TEXT NOT NULL,             -- JSON: columns, key columns, before rows, after rows, ddl, column type
    row_count INTEGER NOT NULL,
    bytes INTEGER NOT NULL
);
CREATE INDEX restore_points_conn ON restore_points (connection_id, created_at);
```
- **Retention** runs at app start and after each save:
  - delete points older than `restore.keepDays` (default 7);
  - then, while the total `bytes` exceeds `restore.maxTotalMb` (default 1024), delete the oldest.
- Deleting a connection deletes its restore points.
- The per-connection switch is `ConnectionProfile.restore_points: bool`, with a serde default of
  true. Profiles still hold no secrets.

## Restoring (`crates/tpm-core/src/restore.rs`)
`build_restore(point, selected_rows: Option<Vec<usize>>) -> RestorePlan` produces DDL statements
(if any) plus `ChangeSet`s, which run through the existing machinery:

| Kind | Restore |
|---|---|
| update / grid_edit (updates) | `RowChange::Update` per row: SET each changed column to its before value. `original` = its after value, so the conflict check stops if the row changed since. |
| delete / truncate / grid_edit (deletes) | `RowChange::Insert` with the before values. An existing key fails the commit with the database's unique-violation error, and nothing is written. |
| drop_table | the saved `CREATE TABLE` definition first (if the table doesn't exist), then inserts. |
| drop_column | `ALTER TABLE t ADD COLUMN c <saved type>` (nullable), then a `RowChange::Update` per row setting `c` by primary key. |

- **New engine calls:**
  - `preview_restore(session, point_id, rows)`: SQL text, statement count, atomic;
  - `apply_restore(session, point_id, rows, confirmed)`: one transaction where the engine
    allows. On MySQL/MariaDB, DDL followed by data isn't atomic, and the review dialog says so.
- **After a successful restore,** the point becomes `restored`, with `restored_at`. Since the
  restore is itself an update or insert, it creates a new restore point (kind "Restore of …").
- **Read-only connections** can't restore. The backend refuses, like every other write.

## UI
- **Status bar:** "Restore points · N" for the active connection. It opens the panel. Hidden
  when the feature is off for the connection.
- **Command palette:** "Restore points".
- **Results:** a statement that got a restore point says so in Messages ("Restore point saved"),
  with **Open**.
- **Restore points panel**, a right-hand drawer for the active connection:
  - **List** (newest first): time, table, kind, rows, size, and the start of the statement.
    Tags: Pending, Restored.
  - **Detail:**
    - the full statement (highlighted, as in the review dialog);
    - a grid with a checkbox per row, showing before → after with changed cells highlighted.
      Deleted rows are marked. Large values show as previews, as in query results.
    - **Restore all**, **Restore selected**, and **Delete restore point**.
  - Restoring opens the existing **Review changes** dialog (SQL, connection, environment, atomic
    or not) and commits only on **Commit**.
- **Confirmation before running** ("can't keep a restore point"):
  - the existing confirmation dialog, listing each affected statement and its reason;
  - buttons **Run anyway** and **Cancel**.
- **Connection form:** a "Keep restore points" switch, on by default.
- **Settings › Safety:**
  - "Keep restore points for (days)", default 7;
  - "Max rows per restore point", default 100,000;
  - "Max size per restore point (MB)", default 50;
  - "Total space for restore points (MB)", default 1,024.

## Safety and privacy
- Restore points are copies of database rows, stored unencrypted in the local app database in
  the user's profile. They never leave the machine. `docs/SECURITY_MODEL.md` says so.
- Capture SQL is built from the parsed statement: the WHERE is the user's own, re-emitted. Key
  lookups bind values as parameters, and identifiers are quoted and checked against the
  structure.
- Restores use the existing reviewed, parameterised change machinery, and the backend refuses
  them on read-only connections.
- No new network calls.

## Testing
- **Unit (`restore_plan`):**
  - UPDATE and DELETE with and without WHERE, with an alias, with quoted names;
  - every unsupported reason;
  - TRUNCATE, DROP TABLE, DROP COLUMN;
  - other ALTERs, INSERT and SELECT not planned.
- **Unit (`restore`):**
  - the undo change sets for each kind;
  - selected rows only;
  - DROP TABLE and DROP COLUMN emit DDL first.
- **Unit (`storage`):** save, list, status changes, retention by age and by total size, deleted
  with the connection.
- **Integration** (PostgreSQL, MySQL, MariaDB, SQLite, DuckDB):
  - UPDATE → restore → the values are back;
  - DELETE → restore → the rows are back;
  - TRUNCATE, DROP TABLE and DROP COLUMN restored;
  - a conflict (the row changed after the UPDATE): nothing written;
  - a pending point deleted on ROLLBACK, and kept on COMMIT;
  - an over-limit statement returns `confirmation_required`, and with `confirmed` it runs without
    a point;
  - a grid commit point restored;
  - a restore's own restore point.
- **Frontend:**
  - the panel list and detail (before → after, row selection);
  - Restore all and Restore selected go through review;
  - the status-bar count;
  - the "can't keep a restore point" confirmation;
  - the connection-form switch;
  - the settings.
- **Manual (Xvfb, test PostgreSQL, isolated data dir):** UPDATE/DELETE/TRUNCATE/DROP and a grid
  commit, each restored; a conflict; dark and light.
- **Docs:**
  - `FEATURE_MATRIX.md` row "Restore points";
  - `SECURITY_MODEL.md`: restore points store row copies locally, unencrypted, and can be turned
    off per connection;
  - `ARCHITECTURE.md`: the capture and restore flow.

## Risks
- **Extra work per change:** each captured statement adds a count, one or two reads and, outside
  a user transaction, a BEGIN/COMMIT. Large updates near the limit cost a read of the affected
  rows.
- **WHERE re-emission:** sqlparser's `Display` must produce SQL the server accepts. A statement
  whose expression doesn't round-trip fails the capture `SELECT`; that statement then runs
  without a restore point, and the message says so.
- **Side effects the capture can't see:** triggers, cascades and generated columns change rows
  that aren't captured. The restore point covers only the target table's rows (a non-goal, stated
  in the panel's help text).
- **Disk use:** bounded by the 1 GB default total and the 7-day retention.
