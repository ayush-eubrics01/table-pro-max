# Table Pro Max

A free, privacy-first desktop database client for **PostgreSQL, MySQL, MariaDB, SQL Server,
SQLite, DuckDB and Redis**. It is built with Rust and Tauri for Linux, Windows and macOS.

- **Free, with no catches.** No account, no license key, no premium tier, no limits on tabs,
  filters or connections.
- **Private.** The app talks only to your databases, plus the AI service you configure if you
  turn the optional assistant on (every request is shown to you before it is sent), and GitHub
  for update checks if you allow them. No telemetry. Connections, history and
  saved queries stay on your machine, and passwords go to your system keychain.
- **Safe editing.** Grid edits stay pending until you review the generated SQL and commit them
  in one transaction. Destructive statements ask first. Production connections are
  unmistakable, and read-only mode is enforced by the database session itself.

What exists today, and how it was verified, is listed in
[docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md). What comes next is on the
[roadmap](docs/ROADMAP.md).

## Install
Download an installer from [Releases](../../releases): `.deb`, `.rpm` or `.AppImage` for
Linux, `.msi` or `-setup.exe` for Windows, `.dmg` for macOS on Apple Silicon. Check the file
against `SHA256SUMS` from the same release.

The builds are not code-signed yet, so the OS warns on first launch:
- **Windows:** SmartScreen says "Windows protected your PC". Choose *More info*, then *Run anyway*.
- **macOS:** Gatekeeper may say the app "is damaged" or "cannot be verified". After copying it to
  Applications, run `xattr -dr com.apple.quarantine "/Applications/Table Pro Max.app"`.
- **Linux AppImage:** `chmod +x` the file, then run it.

### Updates
On first launch the app asks whether it may check GitHub for new versions once a day. When one
is published, a banner shows what's new; **Update now** downloads it, checks it against the
project's signing key, installs it and restarts. Nothing is downloaded or installed without
that click. On `.deb` and `.rpm` installs your system asks for your password, as it does for
other software updates. You can change the choice, or check by hand, in Settings › Updates.

## Run from source

### Requirements
- Rust (stable, 1.85+)
- Node.js 20.19+ (24 recommended)
- Platform webview toolchain:
  - **Linux (Debian/Ubuntu):**
    `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11)
  - **macOS:** Xcode Command Line Tools
  - See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for other distributions.
- For saved passwords on Linux: a Secret Service provider (GNOME Keyring, KWallet's Secret
  Service bridge, or KeePassXC). Without one, the app asks for passwords when connecting.

### Develop
```sh
npm install
npm run tauri dev
```

### Build
```sh
npm run tauri build        # bundles land in target/release/bundle/
```
Code signing and notarization (Windows, macOS) need your own certificates. Unsigned builds work
locally but show OS warnings.

## Contributing
Branches, pull requests, CI and releases are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Tests
```sh
cargo test -p tpm-core                       # Rust unit tests (no database needed)
scripts/test-db.sh up                        # disposable PostgreSQL, MySQL, MariaDB in Docker
eval "$(scripts/test-db.sh env)"
cargo test -p tpm-core --test integration    # real-database integration tests
scripts/test-db.sh down
npm run typecheck && npm run lint && npm test
```
Integration tests only touch the `tpm_test` database inside the `tpm-test-*` containers.
Never point the `TPM_TEST_*` variables at a real database.

## Keyboard
| Action | Shortcut |
|---|---|
| Open anything | Ctrl/⌘ + P |
| New query tab / reopen closed tab | Ctrl/⌘ + T / Ctrl/⌘ + Shift + T |
| Close tab | Ctrl/⌘ + W |
| Run statement or selection / run all | Ctrl/⌘ + Enter / Ctrl/⌘ + Shift + Enter |
| Explain | Ctrl/⌘ + E |
| Format SQL | Ctrl/⌘ + Shift + F |
| Save query | Ctrl/⌘ + S |
| Settings | Ctrl/⌘ + , |
| Grid: edit cell / commit edit / cancel | Enter or type / Enter / Esc |
| Grid: copy (with headers) | Ctrl/⌘ + C (Ctrl/⌘ + Shift + C) |

## Project layout
- `crates/tpm-core`: database adapters, execution engine, safety analysis, SQL builders, local
  storage, credentials (no UI dependency)
- `src-tauri`: Tauri commands and app state
- `src`: React + TypeScript interface
- `docs`: requirements, architecture, security model, feature matrix, testing, roadmap,
  licenses, decisions

## License
MIT. Third-party licenses are listed in [docs/DEPENDENCY_LICENSES.md](docs/DEPENDENCY_LICENSES.md).
This project is independent and not affiliated with TablePlus or any database vendor.
