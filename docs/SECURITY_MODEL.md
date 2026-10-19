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
| Accidental writes on production | Production connections open read-only unless the setting is off; the backend applies it at connect (a missing or wrong flag from the UI means read-only), and writes are allowed per workspace only after the connection name is typed. Statements that destroy data on production need the name typed too, checked in the engine | `engine.rs` (`open_session`, `check_confirmation`), `safety.rs`, `commands/connections.rs` | integration `production_safety`; unit `production_asks_for_the_name_before_destroying_data` |
| Grid edits overwriting others' changes | Optimistic concurrency: each UPDATE must match the loaded values and affect exactly one row, otherwise the transaction rolls back | `changes.rs`, adapters `apply` | integration "stale original value" |
| Restore points (copies of rows) | Before a change, the affected rows are copied into the local app database (`restore_points`, not encrypted, never sent anywhere); kept 7 days and within size limits, removed with their connection, and can be turned off per connection; none on read-only connections. The capture `SELECT` re-uses the user's own WHERE in the statement's transaction; restores are generated with bind parameters and run only after the review dialog, with the same conflict check as grid edits, and are refused on read-only connections | `restore_plan.rs`, `restore.rs`, `storage.rs`, `engine.rs` | `restore_plan::*`, `restore::*`, `storage::restore_points_*`, integration `restore_points` |
| SSH host identity | Host keys verified against `~/.ssh/known_hosts` (read only) and the app's own known-hosts file; unknown hosts are refused until the user confirms the SHA-256 fingerprint; a changed key is always refused with a MITM warning; SSH secrets use the same keychain/ask model as DB passwords (separate account) | `ssh.rs`, `connectFlow.tsx` | `ssh::known_hosts_trust_round_trip`, integration `ssh_tunnel` |
| TLS downgrade | Verification is on in every mode except the explicit "require (no verification)", which is labelled with a warning | `adapters/tls.rs`, `config.rs` | `config::libpq_require_does_not_claim_verification` |
| Webview privileges | Capabilities: `core:default`; dialog open, save, message, ask and confirm; and, for the custom title bar, window set-title, minimise, toggle-maximise, is-maximised, close and start-dragging (`allow-is-maximized` and `allow-internal-toggle-maximize` are already in `core:default` and are listed to document what the title bar needs). No fs, shell or http plugins; the updater and opener plugins are used from Rust only and grant the webview nothing. CSP `default-src 'self'`; `connect-src` limited to IPC | `src-tauri/capabilities/default.json`, `tauri.conf.json` | review (see residual risks) |
| File access | Done only by app commands with explicit paths from native dialogs; SQLite open never creates files implicitly; create refuses to overwrite | `adapters/sqlite.rs`, commands | `sqlite_open_rules` integration test |
| Large or malformed input | Page size ≤ 10,000; result rows capped; binary previews capped at 4 KB; CA files ≤ 4 MB; workspace state ≤ 16 MB; filter nesting ≤ 64 | various | unit tests |
| Cross-tab leakage | Each query tab has its own session and result IDs; results are released when tabs rerun or close, and evicted when sessions close | `engine.rs`, `QueryTab.tsx` | integration `release_results` check |
| Telemetry | None. No analytics or crash upload. The only non-database request without AI is the update check, which needs consent (below) | — | review |
| AI data sharing | Off by default; enabling it requires a confirmation that says what is sent. Each request is previewed and only that exact text is sent (the backend rejects a preview made under different settings). Only user-chosen SQL, error text, description and optionally table/column names; never row data. Plain http only to loopback; https verified with system roots (rustls + ring). Keys in the OS credential store, sent only as a header, never logged; prompts never logged. Answers are rendered as text, and SQL is inserted into the editor, never executed | `ai.rs`, `commands/ai.rs`, `AiPanel.tsx` | `ai::*`, `ai_http` |
| Update checks | Asked once on first launch; automatic checks only when the user agreed, at most daily; "Check now" always works. One GET of `releases/latest/download/latest.json` on github.com, then the download: GitHub sees the IP address and the plugin's user agent (`tauri-plugin-updater/<version>`), no app data. Every update is verified with the minisign public key built into the app, the signed version must match the announced one (`requireSignedVersion`), and downgrades are refused. Nothing is downloaded or installed without "Update now". Release notes are shown as text | `updates.rs`, `commands/update.rs`, `features/updates/`, `release.yml` | `updates::*`, `commands::update::tests`, `updates.test.tsx`, manual end-to-end (TESTING_STRATEGY) |

## Residual risks
* **The safety analyzer is not a proof.** Functions with side effects, procedures, and vendor
  syntax the parser does not understand can modify data. Treat "confirm" modes as a seatbelt.
  Use a database role with least privilege for real protection.
* **PostgreSQL read-only mode** uses `default_transaction_read_only`. A superuser could still
  change roles or settings through paths the policy layer does not recognize. For a guaranteed
  read-only connection, use a role that only has `SELECT`.
* **MySQL read-only** uses `SET SESSION TRANSACTION READ ONLY`, which does not cover temporary
  tables or some administrative statements.
* **SQL Server read-only** has no session setting to rely on: each batch runs inside a
  transaction that is always rolled back, behind the analyzer, which allows only reads (no
  procedure calls or dynamic SQL); batches with COMMIT, ROLLBACK, IMPLICIT_TRANSACTIONS,
  ANSI_DEFAULTS or a pass-through query (OPENQUERY, OPENROWSET, OPENDATASOURCE) are refused by the
  session, whatever Unicode spacing surrounds them. Effects outside the transaction log are not undone (a
  sequence's `NEXT VALUE FOR`, for instance). For a guaranteed read-only connection, use a login
  whose only rights are `db_datareader`.
* **SQL Server sign-in is always encrypted**, but with TLS set to Disable the server's
  certificate is not checked and the rest of the traffic is plaintext. Prefer and Require
  verify the certificate.
* **MongoDB read-only** is enforced by the app, not the server: MongoDB has no read-only session,
  so a read-only or locked production connection only runs finds, counts, reading pipelines
  (`$out` and `$merge` refused at any depth) and vector searches, and refuses deletes. For a
  guaranteed read-only connection, use a user with only the `read` role. Deletes keep no restore
  point.
* **Restore points hold table data on disk.** They are copies of changed rows in the app
  database, unencrypted, readable by anyone who can read the user's files, for up to 7 days by
  default (Settings › Safety). Turn them off per connection where that is not acceptable.
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

* **Update checks reveal usage.** When checks are allowed, GitHub learns that an IP address runs
  the app. Turn automatic checks off in Settings to avoid it.
* **Update signing key.** If the private key is lost, installed copies cannot verify new
  updates and everyone has to reinstall once from a release signed with a new key. If it leaks,
  someone who can also serve the manifest could push an update until the key is rotated (see
  RELEASING.md).
* **`.deb` and `.rpm` updates run as root.** The updater installs them with the system package
  manager after the system password prompt (`pkexec`), and only after the signature check.
* **Installers are not code-signed** (Windows Authenticode, Apple notarization). This is separate
  from update signing, which is in place.

## Reporting
Security issues should be reported privately to the maintainers before public disclosure.
