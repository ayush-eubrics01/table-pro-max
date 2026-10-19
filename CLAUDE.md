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
- End to end: `npx tauri build --debug --no-bundle`, then `npm run e2e` under a display (needs
  `tauri-driver` and `WebKitWebDriver`; env vars in `e2e/harness.mjs`). CI runs it on Linux.
- App: `npm run tauri dev` (needs WebKitGTK dev packages on Linux; see README).
- Lint Rust: `cargo clippy --workspace --all-targets` and `cargo fmt --all`.

## Workflow
- Branch from `main` (`feat/`, `fix/`, `design/`, `perf/`, `docs/`, `ci/`, `chore/`), open a PR,
  squash-merge after **CI passed**. Never push to `main`. Details in `CONTRIBUTING.md`.
- PR titles become the commit on `main`: `type: what changed`. Never use `[skip ci]`.
- Versions are set only with `node scripts/bump-version.mjs X.Y.Z`.

## Planning files (`.scratchpad/`, git-ignored, never committed)
- `.scratchpad/roadmap.md`: the current roadmap, the work in progress, in order. Work top to
  bottom. A bug found in something on the roadmap is fixed as part of the roadmap.
- `.scratchpad/tasks.md`: everything else to pick from, with stable IDs. Feedback from any source
  (the maintainer, users, reviews, CI) goes under **Feedback** with its source, the date and a
  simple example of what is needed.
- When every roadmap item is done: release the next minor version (`0.x.0`), delete
  `roadmap.md`, write the next roadmap with the items the maintainer picks from `tasks.md`, and
  update `tasks.md` (picked items move out, done items go under Done).
- Tick items as they finish, naming the PR. Keep both files current; they are the plan of record.

## Releasing a version (when asked to "release X.Y.Z")
Full detail: `CONTRIBUTING.md` (Releasing) and `docs/RELEASING.md` (checklist, signing key).
1. Branch `chore/release-X.Y.Z` from `main`, run `node scripts/bump-version.mjs X.Y.Z`, write
   `docs/releases/vX.Y.Z.md` (what changed, what is unverified, anything users must do), open a
   PR titled `chore: release X.Y.Z`, squash-merge after **CI passed**.
2. On the merge commit: `git tag -a vX.Y.Z -m "Table Pro Max X.Y.Z" && git push origin vX.Y.Z`.
   The tagged commit's message must not contain `[skip ci]`.
3. `release.yml` builds and signs Linux, Windows and macOS and creates a **draft** release. Check
   it has every installer, a `.sig` per updater file, `latest.json` and `SHA256SUMS`.
4. The maintainer publishes the draft (ask; never publish without approval). Publishing a plain
   version offers it to every app that allows update checks.
- Test build first: bump to and tag `vX.Y.Z-rc.N`. It is a pre-release and never offered as an
  update.
- Urgent fix while `main` has unreleased work: `git switch -c release/X.Y vX.Y.0`, fix and bump
  to `X.Y.(Z+1)` in a PR into `release/X.Y`, tag there, and land the same fix on `main`.
- Versions: `MAJOR.MINOR.PATCH`; below 1.0, raise the middle number for features, the last for
  fixes.

## Rules that matter here
- Never add feature gates, license checks, telemetry or network calls other than to user
  databases, the user-configured AI endpoint (`ai.rs`; off by default, every request
  previewed, never auto-executes SQL) and the update check (`commands/update.rs`; asks before
  checking automatically, installs only signed updates after a click).
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
