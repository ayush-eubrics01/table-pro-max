# Security model

## Assets
Database credentials, connection details, query text, query results, and the user's
databases themselves.

## Boundaries and controls

| Concern | Control | Where | Tested by |
|---|---|---|---|
| Credentials at rest | OS credential store only; profiles never contain passwords; "ask every time" keeps the secret in memory for the session | `credentials.rs`, `src-tauri/src/state.rs` | `config::profile_serialization_never_contains_password`, `storage::connections_crud_without_passwords` |
| Secrets in logs and errors | Every `AppError` message and detail is redacted at construction; the file logger redacts each line | `redact.rs`, `error.rs`, `src-tauri/src/logging.rs` | `redact::*`, `error::messages_are_redacted_on_construction` |
| URL parsing | Percent-decoding, IPv6 hosts, query-string passwords split out; parse errors never echo the input | `config.rs` | `config::*` |
| SQL injection via values | All values are bind parameters (PostgreSQL text-format params, MySQL prepared statements, SQLite bound params) | `filter.rs`, `changes.rs`, adapters | `filter::values_never_appear_in_sql`, integration "injection attempt" checks |
| SQL injection via identifiers | Identifiers validated (non-empty, no NUL, ≤ 256 bytes) and quoted per dialect; columns must exist in the introspected structure | `dialect.rs`, `filter.rs`, `changes.rs`, `browse.rs` | `dialect::*`, `changes::validation_errors` |
| Type/default injection in DDL | Data types restricted to type-name characters; defaults reject `;`, `--` and `/*`; generated DDL is always previewed | `ddl.rs` | `ddl::rejects_injection_in_types_and_defaults` |
| Destructive statements | `sqlparser` classification; policy enforced in the backend (confirm or block), not only in the UI; target connection shown before high-risk runs | `safety.rs`, `engine.rs` | `safety::*`, integration confirmation test |
| Read-only connections | Enforced by the database session plus a policy layer that blocks statements trying to switch it off | adapters, `safety.rs` | integration: `nextval` refused by the server; raw session INSERT refused |
| Grid edits overwriting others' changes | Optimistic concurrency: each UPDATE must match the loaded values and affect exactly one row, otherwise the transaction rolls back | `changes.rs`, adapters `apply` | integration "stale original value" |
| SSH host identity | Host keys verified against `~/.ssh/known_hosts` (read only) and the app's own known-hosts file; unknown hosts are refused until the user confirms the SHA-256 fingerprint; a changed key is always refused with a MITM warning; SSH secrets use the same keychain/ask model as DB passwords (separate account) | `ssh.rs`, `connectFlow.tsx` | `ssh::known_hosts_trust_round_trip`, integration `ssh_tunnel` |
| TLS downgrade | Verification is on in every mode except the explicit "require (no verification)", which is labelled with a warning | `adapters/tls.rs`, `config.rs` | `config::libpq_require_does_not_claim_verification` |
| Webview privileges | Capabilities: `core:default` and dialog open/save/message only. No fs, shell or http plugins. CSP `default-src 'self'`; `connect-src` limited to IPC | `src-tauri/capabilities/default.json`, `tauri.conf.json` | review (see residual risks) |
| File access | Done only by app commands with explicit paths from native dialogs; SQLite open never creates files implicitly; create refuses to overwrite | `adapters/sqlite.rs`, commands | `sqlite_open_rules` integration test |
| Large or malformed input | Page size ≤ 10,000; result rows capped; binary previews capped at 4 KB; CA files ≤ 4 MB; workspace state ≤ 16 MB; filter nesting ≤ 64 | various | unit tests |
| Cross-tab leakage | Each query tab has its own session and result IDs; results are released when tabs rerun or close, and evicted when sessions close | `engine.rs`, `QueryTab.tsx` | integration `release_results` check |
| Telemetry | None. No analytics, crash upload or update pings | — | review |
| AI data sharing | Off by default; enabling it requires a confirmation that says what is sent. Each request is previewed and only that exact text is sent (the backend rejects a preview made under different settings). Only user-chosen SQL, error text, description and optionally table/column names; never row data. Plain http only to loopback; https verified with system roots (rustls + ring). Keys in the OS credential store, sent only as a header, never logged; prompts never logged. Answers are rendered as text, and SQL is inserted into the editor, never executed | `ai.rs`, `commands/ai.rs`, `AiPanel.tsx` | `ai::*`, `ai_http` |

## Residual risks
* **The safety analyzer is not a proof.** Functions with side effects, procedures, and vendor
  syntax the parser does not understand can modify data. Treat "confirm" modes as a seatbelt.
  Use a database role with least privilege for real protection.
* **PostgreSQL read-only mode** uses `default_transaction_read_only`. A superuser could still
  change roles or settings through paths the policy layer does not recognize. For a guaranteed
  read-only connection, use a role that only has `SELECT`.
* **MySQL read-only** uses `SET SESSION TRANSACTION READ ONLY`, which does not cover temporary
  tables or some administrative statements.
* **In-memory secrets**: passwords held for "ask every time" stay in process memory until the
  app exits and are not zeroized.
* **AI providers receive what you send.** With AI turned on, the previewed SQL, error text and
  names go to the configured provider under its own data policy. SQL literals and error details
  can contain data values; the preview and the editable error box are the control. Use a local
  model server for sensitive work.
* **RSA SSH user keys** use the `rsa` crate, which has an open timing advisory
  (RUSTSEC-2023-0071, DECISIONS D14). Prefer Ed25519 keys.
* **`freezePrototype` is disabled** (see DECISIONS D10). The webview runs only bundled code
  under a strict CSP.
* **Keyring on Linux** depends on a running Secret Service (GNOME Keyring, KWallet with the
  Secret Service bridge, or KeePassXC). Without one, passwords cannot be saved.
* **Cancellation is racy by nature**: a cancel can arrive after a statement finished. PostgreSQL
  ignores cancels for idle sessions, so a late cancel never affects a later statement.
* **SSH tunnels** listen on `127.0.0.1` only, on a random port, for the life of the session. Other local processes running as any user could connect to that port while it is open; the database still requires its own authentication.

## Reporting
Security issues should be reported privately to the maintainers before public disclosure.
