# Roadmap

Milestones follow the engineering plan. Status reflects the code in this repository.

| # | Milestone | Status |
|---|---|---|
| 0 | Repository, requirements, architecture, dependency choices | Done |
| 1 | Desktop foundation: Tauri shell, React/TS, logging, errors, metadata storage and migrations, navigation shell, themes, Linux dev run | Done (Linux run verified under Xvfb) |
| 2 | PostgreSQL vertical slice: profiles, secure credentials, connect, browse schemas/tables, SELECT, paging, errors, integration tests | Done |
| 3 | Editing and query safety: inline edits, pending changes, preview, commit/discard, safety levels, transaction tests | Done |
| 4 | SQL editor productivity: completion, formatting, saved queries, history, tabs, cancel, timeouts | Done except query parameters and snippets |
| 5 | MySQL/MariaDB and SQLite | Done (integration verified; UI verified on MySQL and SQLite) |
| 6 | Advanced data tools: filters, schema editing, quick open, explain, import/export | Done |
| 7 | Metrics board: dashboards, charts, SQL widgets with bounded concurrency | Done |
| 8 | SQL Server, DuckDB, Redis; optional AI; optional MCP | DuckDB, Redis and AI done; SQL Server evaluated; MCP not started |
| 9 | Cross-platform readiness: Linux packages, Windows and macOS CI builds, credential stores, installers | Linux `.deb` built and run; CI workflow written but not yet run |
| 10 | Release hardening: regression, security review, licenses, reproducible builds, checklist | Not started |

## Next up (in order)
1. First Windows/macOS CI runs; AppImage and rpm.
2. Query parameters and snippets.
3. Optional local MCP server (off by default, read-only by default).
4. SQL Server adapter (`tiberius`).
5. TLS test fixture; automated UI end-to-end in CI (tauri-driver on Linux runners).
6. Release checklist (milestone 10).
