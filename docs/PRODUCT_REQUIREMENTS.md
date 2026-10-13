# Product requirements

## Product
Table Pro Max is a free, cross-platform desktop client for relational databases. It is for
developers and data people who spend hours browsing tables, editing rows and writing SQL. It
draws on workflows common to native database clients such as TablePlus (fast connection list,
tabbed workspace, grid editing with a commit step, Open Anything), but it is implemented
independently, with its own identity.

## Principles
1. **Everything is free.** No tiers, license checks, accounts, quotas, or tab/filter/window
   limits. Every implemented feature is available to every user.
2. **Privacy first.** The app talks only to the databases the user connects to. There is no
   telemetry, analytics, crash upload or account. Connections, history and saved work stay on
   the machine; passwords go to the OS credential store.
3. **Safe by default.** Grid edits stay pending until reviewed. Destructive statements need
   confirmation by default. Production connections are visually distinct, and read-only mode
   is enforced by the database session.
4. **Honest capabilities.** A feature is claimed only for drivers where it is implemented and
   tested (see FEATURE_MATRIX.md).

## Primary workflows (first usable release)
1. **Connect.** Create a profile by form or by pasting a URL, test it, save it (password to the
   keychain or "ask every time"), connect. Profiles are grouped and labelled by environment.
2. **Explore.** Switch database and schema, filter the object tree, open tables and views,
   inspect structure and DDL, jump anywhere with Ctrl+P.
3. **Browse and edit.** Page through rows, sort, filter with a structured builder, edit cells
   inline or in the row-detail panel, insert, duplicate and delete rows, review the generated
   SQL, and commit atomically or discard.
4. **Query.** Write SQL with dialect highlighting and completion. Run the current statement,
   the selection, or everything. See results per statement with timing. Cancel, set
   timeouts, explain, format, save, and search history.
5. **Change schema.** Create tables and alter columns and indexes through forms, always
   reviewing the SQL first.

## Supported databases (Tier 1)
PostgreSQL, MySQL, MariaDB, SQLite. Tier 2 (SQL Server, DuckDB, Redis) and Tier 3 are on the
roadmap and are not advertised until implemented.

## Non-functional requirements
* The UI stays responsive with large tables: virtualized grid, paged fetch, bounded memory.
* A query in one tab never blocks or affects another tab.
* All long operations are cancellable and time-limited.
* Errors explain what happened and what to do, never include secrets, and keep server
  detail (SQLSTATE, hint, position) available.
* Keyboard-first: every primary action has a shortcut; grid and dialogs are keyboard operable
  with visible focus.
* Accessibility: ARIA grid semantics, labelled controls, reduced-motion support.

## Out of scope for the first release
Cloud sync, team sharing, plugins. (SSH tunnelling, import/export, dashboards and opt-in AI
assistance, once listed here, are now implemented.)
