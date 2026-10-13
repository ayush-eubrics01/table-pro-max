# Decisions

Short records of choices that shape the code. Newest last.

## D1. Tauri 2 + React + TypeScript; Rust core crate
Tauri gives one Rust backend for Linux, Windows and macOS with small binaries and a
capability-based permission model. All database logic lives in `crates/tpm-core`, which has no
Tauri dependency, so it builds and tests anywhere. (Tauri 3 is in alpha at the time of
writing; we stay on 2.x.)

## D2. Driver libraries instead of SQLx
SQLx is a good fit for applications with known queries. A database client runs arbitrary
SQL whose result types are unknown, needs protocol-level cancellation, and must display
any type. We chose:
* `tokio-postgres`: native `CancelToken`, simple-query protocol with text results,
  `simple_query_raw` streaming, and text-format parameters through a custom `ToSql`.
* `mysql_async`: text protocol with multiple result sets, prepared statements, rustls.
* `rusqlite`: synchronous but complete, with `InterruptHandle` for real cancellation, and the
  same bundled SQLite as the metadata store (two copies of `libsqlite3-sys` cannot coexist,
  which rules out mixing SQLx-sqlite with rusqlite).

## D3. rustls with the ring provider everywhere
There is no OpenSSL dependency, so builds are the same on all platforms. `aws-lc-rs`
(mysql_async's default) is avoided because it needs CMake and a C toolchain on Windows. System
roots come from `rustls-native-certs`, plus an optional user CA file.

## D4. TLS modes are explicit about verification
libpq's `sslmode=require` does not verify certificates. We import it as
"require (no verification)", shown with a warning. The default for new profiles is "prefer",
which verifies when TLS is used. TLS is never silently downgraded from a verifying mode.

## D5. Values cross IPC as text
Cells are `null | string | {$bytes, size}`. This avoids 53-bit integer loss in JavaScript,
supports every server type, and makes the conflict check exact (PostgreSQL compares
`col::text` with the loaded text).

## D6. Custom virtualized grid on @tanstack/react-virtual
We evaluated Glide Data Grid. It is canvas-based and fast, but v6 pins React ≤ 18 and pulls
Linaria and Babel 7 into the runtime dependency tree, and it has had no release for a long
time. A DOM grid on `@tanstack/react-virtual` (MIT, small, maintained) gives ARIA grid
semantics, full control over pending-edit styling, and virtualizes both rows and columns.

## D7. CodeMirror 6 instead of Monaco
CodeMirror 6 is far smaller, has SQL dialects (PostgreSQL, MySQL, MariaDB, SQLite) with
schema-aware completion, and themes through CSS variables. Monaco is heavier and its SQL
support needs extra language services.

## D8. Safety analysis is advisory; enforcement is in the database
`safety.rs` classifies statements with `sqlparser` (with a conservative fallback when parsing
fails) and decides allow, confirm, or block. It is enforced in the backend, not only in the
UI. Read-only connections are also enforced by the server session
(`default_transaction_read_only`, `SET SESSION TRANSACTION READ ONLY`, `SQLITE_OPEN_READ_ONLY` +
`query_only`). Integration tests prove that a write the analyzer considers a read
(`SELECT nextval(...)`) is still refused by PostgreSQL.

## D9. No plaintext or home-grown encrypted password storage
Passwords go to the OS credential store through the `keyring` crate (Keychain, Credential
Manager, Secret Service). If none is reachable, profiles use "ask every time" and the password
is held in memory for the session. We deliberately ship no encrypted-file fallback until there
is a key-management story worth documenting.

## D10. `freezePrototype` disabled
Tauri's `freezePrototype` freezes `Object.prototype`. `sql-formatter`'s parser (nearley) then
fails on startup with "Attempted to assign to readonly property". The webview loads only
bundled local code under a strict CSP (`script-src 'self'`) and no remote content, so we
disable the option rather than drop formatting.

## D11. Product name
"Table Pro Max" is the repository's working name. Before a public release, check it for
trademark conflicts with existing database tools, and rename if needed. The code uses neutral
identifiers (`tpm-core`, `dev.tablepromax.app`) that are easy to change.

## D12. No TablePlus binary analysis
REA reverse-engineering tools and a local TablePlus install are both available. We used
only public documentation and general database-client conventions, and did not analyze the
proprietary binary. Nothing here depends on TablePlus internals.

## D13. AI assistance over plain HTTPS, previewed and never executed
The Rust core calls the Anthropic Messages API (`POST /v1/messages`, `anthropic-version:
2023-06-01`) or an OpenAI-compatible `/chat/completions` endpoint directly with `reqwest`.
There is no official Anthropic SDK for Rust, and keeping the call in the core keeps keys out of
the webview (CSP `connect-src` stays IPC-only). TLS uses the same rustls + ring configuration as
the database drivers; `reqwest` is built with `rustls-no-provider` and a preconfigured client
config, so aws-lc and OpenSSL stay out of the build. The prompt is built by one pure function;
the UI shows its output and the backend sends exactly that, after checking that the endpoint
and model still match the settings. Answers are non-streamed (`max_tokens` 16,000), with
refusal fallback routing (`fallbacks: "default"`) enabled for supported models on Anthropic's
own endpoint. Returned SQL is only inserted into the editor.

## D14. Accepting RUSTSEC-2023-0071 (rsa timing side channel)
`cargo audit` reports the "Marvin" advisory for the `rsa` crate, which russh uses for RSA host
keys and RSA user keys. No fixed release exists. Dropping the feature would break SSH
tunnels to the many servers that still present RSA host keys. The client performs one RSA
private-key operation per login (the authentication signature); the attack needs many timed
private-key operations, so it is not practical here. Host key verification uses only
public-key operations. The advisory is ignored in `.cargo/audit.toml` with this reason; prefer
Ed25519 user keys. Revisit when `rsa` ships a constant-time release.

## D15. In-app updates through tauri-plugin-updater
Users want new versions without visiting GitHub. The app uses the official Tauri updater
plugin (2.13, rustls + ring, no OpenSSL), called only from our Rust commands so the webview
gets no plugin permissions. The manifest is `latest.json` attached to each GitHub release and
read from `releases/latest`, so publishing a draft is what pushes an update, and suffixed tags
(`-rc.N`) stay pre-releases that are never offered. The app asks once before checking
automatically (at most daily); installing always needs a click on "Update now". Updates are
verified with a minisign key held by the maintainer, `requireSignedVersion` binds each
signature to its version, and downgrades are refused. Rejected: our own updater (more code to
get wrong), silent background downloads (conflicts with the privacy promise), package managers
only (most users install from the release page). Consequences: the network rule now names
the update check, and the signing key must be backed up and rotated if it leaks (RELEASING.md).
