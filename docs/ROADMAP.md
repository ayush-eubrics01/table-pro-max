# Roadmap

Milestones follow the engineering plan. Status reflects the code in this repository.

| # | Milestone | Status |
|---|---|---|
| 0 | Repository, requirements, architecture, dependency choices | Done |
| 1 | Desktop foundation: Tauri shell, React/TS, logging, errors, metadata storage and migrations, navigation shell, themes, Linux dev run | Done (Linux run verified under Xvfb) |
| 2 | PostgreSQL vertical slice: profiles, secure credentials, connect, browse schemas/tables, SELECT, paging, errors, integration tests | Done |
| 3 | Editing and query safety: inline edits, pending changes, preview, commit/discard, safety levels, transaction tests | Done |
| 4 | SQL editor productivity: completion, formatting, saved queries, history, tabs, cancel, timeouts | Done |
| 5 | MySQL/MariaDB and SQLite | Done (integration verified; UI verified on MySQL and SQLite) |
| 6 | Advanced data tools: filters, schema editing, quick open, explain, import/export | Done |
| 7 | Metrics board: dashboards, charts, SQL widgets with bounded concurrency | Done |
| 8 | SQL Server, DuckDB, Redis; optional AI; optional MCP | DuckDB, Redis and AI done; SQL Server evaluated; MCP not started |
| 9 | Cross-platform readiness: Linux packages, Windows and macOS CI builds, credential stores, installers | Linux, Windows and macOS installers built in CI; tag-triggered draft releases (`release.yml`); Linux `.deb` run. Windows/macOS installers not yet launched; no code signing |
| 10 | Release hardening: regression, security review, licenses, reproducible builds, checklist | Release checklist written (`docs/RELEASING.md`); the rest not started |

## Next up (in order)
1. Launch the Windows and macOS installers on real machines; code signing when certificates exist.
2. Optional local MCP server (off by default, read-only by default).
3. SQL Server adapter (`tiberius`).
4. TLS test fixture; automated UI end-to-end in CI (tauri-driver on Linux runners).
5. macOS Intel build; auto-update (signed update manifests only).
