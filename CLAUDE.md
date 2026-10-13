# Table Pro Max: notes for Claude Code sessions

Free, privacy-first, cross-platform database client. Tauri 2 shell, React/TypeScript UI,
Rust core. Read `docs/ARCHITECTURE.md` and `docs/FEATURE_MATRIX.md` before changing behaviour.

## Layout
- `crates/tpm-core/`: all database logic (adapters, engine, safety, SQL builders, storage,
  credentials). No Tauri dependency; must stay buildable and testable without a webview.
- `src-tauri/`: thin Tauri command layer (`commands/*.rs`), app state, redacting logger,
  capabilities.
- `src/`: React app. `features/*` per area, `stores/*` (zustand), `lib/ipc.ts` (typed
  commands), `types/backend.ts` (mirror of the Rust serde types; keep in sync).
- `docs/`: requirements, architecture, feature matrix, security model, adapters, testing,
  roadmap, licenses, decisions.

## Commands
- Node: use Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`). The default Node 16 is too old.
- Core tests: `cargo test -p tpm-core` (plain `cargo test` at the root also only runs the core;
  see `default-members`).
- DB integration: `scripts/test-db.sh up && eval "$(scripts/test-db.sh env)" && cargo test -p tpm-core --test integration`;
  `scripts/test-db.sh down` afterwards. Only ever use these disposable containers.
- Frontend: `npm run typecheck && npm run lint && npm test && npm run build`.
- App: `npm run tauri dev` (needs WebKitGTK dev packages on Linux; see README).
- Lint Rust: `cargo clippy --workspace --all-targets` and `cargo fmt --all`.

## Rules that matter here
- Never add feature gates, license checks, telemetry or network calls other than to user
  databases and the user-configured AI endpoint (`ai.rs`; off by default, every request
  previewed, never auto-executes SQL).
- Never store or log passwords. Profiles hold no secrets. Errors go through `AppError`
  (redacted at construction). Use `add_context`, not `with_detail`, to annotate existing
  errors.
- Values are always bind parameters. Identifiers go through `Dialect::quote_ident` and must
  be checked against the introspected `TableStructure`.
- The safety analyzer is advisory. Read-only must also be enforced by the DB session. Keep
  confirmation checks in the backend (`engine.rs`), not only in the UI.
- Statement offsets from the backend are UTF-8 bytes; convert with `src/lib/text.ts`.
- One session per query tab; never run two operations concurrently on one session.
- Update `docs/FEATURE_MATRIX.md` when a feature's status changes. VERIFIED needs a test or a
  reproducible manual check.
- When testing the desktop app locally, isolate it from the developer's keyring and data:
  set `XDG_DATA_HOME`/`XDG_CONFIG_HOME` to a scratch dir, point `DBUS_SESSION_BUS_ADDRESS` at a
  nonexistent socket, and unset `XDG_RUNTIME_DIR`.
- Do not touch Docker containers other than `tpm-test-*`.
