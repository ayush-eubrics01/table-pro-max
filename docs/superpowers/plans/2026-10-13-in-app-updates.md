# In-app Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People running Table Pro Max learn about new GitHub releases inside the app and can install them with one click. Every installed file is verified against the project's signing key.

**Architecture:**
- **Core rules (`tpm-core`).** A small pure-Rust module decides when an automatic check may run, and validates versions. It has no Tauri dependency, so CI tests it.
- **Desktop shell.** Thin Tauri commands drive the official `tauri-plugin-updater`: check, download with progress, verify, install, restart. The webview gets no plugin permissions.
- **UI.** React adds a one-time consent dialog, an update banner and a Settings section.
- **Release pipeline.** `release.yml` signs the updater bundles and publishes a `latest.json` manifest that the app reads from `releases/latest`.

**Tech Stack:**
- Rust: Tauri 2.12, `tauri-plugin-updater` 2.13.3 (rustls/ring), `tauri-plugin-opener` 2.7.1.
- Frontend: React 19 with zustand, vitest with `@tauri-apps/api/mocks`.
- Release tooling: a Node 24 script and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-13-in-app-updates-design.md`. Read it before starting any task.

## Global Constraints

**Network and consent**
- **Network rule.** The app's only new network request is the update check: a GET of `https://github.com/ayush-eubrics01/table-pro-max/releases/latest/download/latest.json`, then the update download. It runs only when `updates.auto == "on"` or the user clicks "Check now".
- **Consent setting.** `updates.auto` is `"ask"` (default), `"on"` or `"off"`. `updates.lastCheck` is a number in milliseconds; `0` means never.
- **Automatic checks** run at most once every 24 h (`CHECK_INTERVAL_MS = 86_400_000`).
- **Installing needs a click.** Never download or install without "Update now".

**Verification and security**
- **Every update is verified.** `requireSignedVersion: true`. No downgrades, so `allowDowngrades` is never set.
- **HTTPS only in shipped builds.** `dangerousInsecureTransportProtocol` must never appear in `src-tauri/tauri.conf.json`. Only throwaway local test builds set it through `--config`.
- **TLS.** rustls with the ring provider; no OpenSSL and no native-tls. `cargo tree -i openssl-sys` must match nothing.
- **No webview permissions.** No new capability entries in `src-tauri/capabilities/default.json`. The webview never calls updater or opener plugin commands directly.
- **Secrets.** The private signing key and its password never appear in a command line, log, chat or file in the repo. Only the maintainer handles them (Task 1).

**Release files**
- **Release asset names** (lowercase, from the collect step): `table-pro-max_${v}_amd64.AppImage`, `table-pro-max_${v}_amd64.deb`, `table-pro-max-${v}-1.x86_64.rpm`, `table-pro-max_${v}_x64-setup.exe`, `table-pro-max_${v}_x64_en-US.msi`, `table-pro-max_${v}_aarch64.dmg` and `table-pro-max_${v}_aarch64.app.tar.gz`. Each updater file has a matching `.sig`.
- **Manifest keys:** `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`, `windows-x86_64-nsis`, `windows-x86_64-msi` and `darwin-aarch64-app`. Fallbacks: `linux-x86_64` → appimage, `windows-x86_64` → nsis, `darwin-aarch64` → app.

**Code conventions**
- **Errors** go through `tpm_core::error::AppError` (redacted at construction). Logs record outcomes only, never notes, URLs with queries or home paths.
- **UI text** uses sentence case and plain verbs. Release notes are rendered as text, never as HTML.
- **Process.** Use Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`). For local Tauri builds and `cargo clippy/test -p table-pro-max`, first run `source $S/sysroot/env.sh`, where `S=/tmp/claude-1000/-home-ayush-projects-table-pro-max/684aa898-fb95-49de-a916-d995c0c2b63b/scratchpad`.
- **Commits.** Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These five inputs and failure modes are implied by the spec, but no headline test covers them. Each one has a test in the task named in brackets.
1. **The clock moved backwards:** `updates.lastCheck` is in the future. The check must still run, or the app would never check again [Task 2].
2. **"Update now" clicked twice, or "Check now" during a download:** there must be exactly one install. The backend refuses a second concurrent install [Task 3]; the UI ignores re-entry [Task 5].
3. **Offline or GitHub down at startup with automatic checks on:** no error toast or banner, and `lastCheck` isn't updated, so the next start retries [Task 3 (lastCheck only on success), Task 5 (quiet UI)].
4. **Release notes containing HTML or markdown:** they are shown as literal text [Task 5].
5. **Pre-release tags (`v0.2.0-rc.1`)** must build, collect and produce a manifest without breaking. The release must still be marked pre-release, so it's never offered [Task 6 (manifest), Task 7 (collect globs and pre-release rule)].

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `crates/tpm-core/src/updates.rs` | create | Consent and interval rules, settings parsing, install kinds, version validation, release-page URL. Pure and unit-tested. |
| `crates/tpm-core/src/lib.rs` | modify | `pub mod updates;` |
| `src-tauri/src/commands/update.rs` | create | Tauri commands: status, check, install with progress, cancel, open release page. Maps plugin errors to `AppError`. |
| `src-tauri/src/commands/mod.rs` | modify | `pub mod update;` |
| `src-tauri/src/state.rs` | modify | `pending_update`, `update_jobs` |
| `src-tauri/src/lib.rs` | modify | Register the plugins and commands. |
| `src-tauri/Cargo.toml` | modify | The updater and opener plugins. |
| `src-tauri/tauri.conf.json` | modify | `plugins.updater` (endpoint, public key, signed-version check, passive Windows install). |
| `src/types/backend.ts`, `src/lib/ipc.ts` | modify | Types and typed command wrappers. |
| `src/stores/settings.ts` | modify | `updates.auto`, `updates.lastCheck` |
| `src/stores/pendingEdits.ts` | create | App-wide count of tables with uncommitted grid edits. |
| `src/app/WorkspaceView.tsx` | modify | Report its dirty tables to `usePendingEdits`. |
| `src/app/restore.ts` | modify | `saveNow()` to flush the workspace before a restart. |
| `src/features/updates/store.ts` | create | `useUpdates` zustand store: status, check, install, cancel, banner state. |
| `src/features/updates/FirstRunUpdatePrompt.tsx` | create | The one-time consent dialog. |
| `src/features/updates/UpdateBanner.tsx` | create | The banner under the connection strip. |
| `src/features/updates/UpdateSettings.tsx` | create | Settings › Updates. |
| `src/features/updates/updates.test.tsx` | create | UI and store tests. |
| `src/app/App.tsx`, `src/features/settings/SettingsDialog.tsx`, `src/styles/app.css` | modify | Wiring, privacy note, styles. |
| `scripts/updater-manifest.mjs` (+ `.test.mjs`) | create | Builds `latest.json` from the collected release files. |
| `vite.config.ts` | modify | Vitest also runs `scripts/**/*.test.mjs`. |
| `.github/workflows/release.yml` | modify | Secrets check, signed updater bundles, collect by glob, manifest, pre-release rule. |
| Docs | modify | `CLAUDE.md`, `README.md`, `docs/SECURITY_MODEL.md`, `docs/DECISIONS.md`, `docs/FEATURE_MATRIX.md`, `docs/DEPENDENCY_LICENSES.md`, `docs/RELEASING.md`, `docs/TESTING_STRATEGY.md`, `docs/releases/v0.1.0.md` |

---

### Task 1: Signing key and updater configuration (the maintainer runs the key commands)

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: `plugins.updater` in `tauri.conf.json`. Every later task that starts the app needs it, because the plugin fails at startup without a `pubkey`.
- Produces: GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, used in Task 7.

- [ ] **Step 1: Ask the maintainer to generate the key.** They run this in the Claude Code prompt and pick a password when asked:

```
! source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && cd /home/ayush/projects/table-pro-max && npx tauri signer generate -w ~/.tauri/table-pro-max.key
```

Expected: it writes `~/.tauri/table-pro-max.key` and `~/.tauri/table-pro-max.key.pub`. Never read or print the private key file.

- [ ] **Step 2: Ask the maintainer to store the secrets.** They run:

```
! gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/table-pro-max.key
! gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

The second command prompts for the password. Then they save the key file and its password in their password manager.

- [ ] **Step 3: Check that the secrets exist, by name only.**

Run: `gh secret list`
Expected: both `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are listed.

- [ ] **Step 4: Add the updater config with the public key.**

```bash
cd /home/ayush/projects/table-pro-max && node -e '
const fs = require("fs");
const p = "src-tauri/tauri.conf.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.plugins = { updater: {
  endpoints: ["https://github.com/ayush-eubrics01/table-pro-max/releases/latest/download/latest.json"],
  pubkey: fs.readFileSync(process.env.HOME + "/.tauri/table-pro-max.key.pub", "utf8").trim(),
  requireSignedVersion: true,
  windows: { installMode: "passive" },
} };
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");'
```

- [ ] **Step 5: Verify the config.**

Run: `jq -e '.plugins.updater | (.pubkey | length > 40) and .requireSignedVersion == true and (has("dangerousInsecureTransportProtocol") | not)' src-tauri/tauri.conf.json`
Expected: `true`

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/tauri.conf.json
git commit -m "Updater config: endpoint, public signing key, signed-version check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Update rules in the core (`tpm-core/src/updates.rs`)

**Files:**
- Create: `crates/tpm-core/src/updates.rs`
- Modify: `crates/tpm-core/src/lib.rs` (add `pub mod updates;` after `pub mod transfer;`)

**Interfaces:**
- Produces (used by Task 3):
  - `pub const REPO: &str`, `AUTO_KEY`, `LAST_CHECK_KEY` and `CHECK_INTERVAL_MS: i64`.
  - `pub enum AutoMode { Ask, On, Off }`, which serializes as `"ask"`, `"on"` or `"off"`.
  - `pub struct UpdateSettings { pub auto: AutoMode, pub last_check_ms: i64 }` with `UpdateSettings::from_settings(&serde_json::Map<String, Value>) -> Self`.
  - `pub enum AutoCheck { Disabled, NotDue, Due }` and `pub fn auto_check_due(&UpdateSettings, now_ms: i64) -> AutoCheck`.
  - `pub enum InstallKind { Appimage, Deb, Rpm, Nsis, Msi, App, Unknown }`, which serializes in lowercase, with `fn can_install(self) -> bool`.
  - `pub fn is_valid_version(&str) -> bool` and `pub fn release_page_url(version: &str) -> Result<String>`.

- [ ] **Step 1: Write the failing tests.** Create `crates/tpm-core/src/updates.rs` with only the test module below, plus `pub mod updates;` in `lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY: i64 = CHECK_INTERVAL_MS;

    fn s(auto: AutoMode, last: i64) -> UpdateSettings {
        UpdateSettings { auto, last_check_ms: last }
    }

    #[test]
    fn reads_settings_with_safe_defaults() {
        let mut m = Map::new();
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::Ask, 0));
        m.insert(AUTO_KEY.into(), json!("on"));
        m.insert(LAST_CHECK_KEY.into(), json!(5));
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::On, 5));
        m.insert(AUTO_KEY.into(), json!("off"));
        assert_eq!(UpdateSettings::from_settings(&m).auto, AutoMode::Off);
        // Anything unexpected falls back to asking, never to checking.
        m.insert(AUTO_KEY.into(), json!("yes"));
        m.insert(LAST_CHECK_KEY.into(), json!("x"));
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::Ask, 0));
    }

    #[test]
    fn only_on_allows_automatic_checks() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::Ask, 0), now), AutoCheck::Disabled);
        assert_eq!(auto_check_due(&s(AutoMode::Off, 0), now), AutoCheck::Disabled);
        assert_eq!(auto_check_due(&s(AutoMode::On, 0), now), AutoCheck::Due);
    }

    #[test]
    fn at_most_once_a_day() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::On, now - DAY + 1), now), AutoCheck::NotDue);
        assert_eq!(auto_check_due(&s(AutoMode::On, now - DAY), now), AutoCheck::Due);
    }

    #[test]
    fn clock_moved_backwards_still_checks() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::On, now + 1_000), now), AutoCheck::Due);
    }

    #[test]
    fn versions_and_release_page() {
        for ok in ["0.1.0", "10.20.30", "0.2.0-rc.1", "1.0.0-beta-2"] {
            assert!(is_valid_version(ok), "{ok}");
        }
        for bad in ["", "1.0", "1.0.0.0", "v1.0.0", "1.0.0-", "1.0.0-rc/../x", "1.a.0", "1.0.0 ", "1.0.0-<b>", "01234567890.0.0"] {
            assert!(!is_valid_version(bad), "{bad}");
        }
        assert_eq!(
            release_page_url("0.2.0").unwrap(),
            "https://github.com/ayush-eubrics01/table-pro-max/releases/tag/v0.2.0"
        );
        assert!(release_page_url("../x").is_err());
    }

    #[test]
    fn install_kinds_and_wire_names() {
        assert!(InstallKind::Deb.can_install());
        assert!(InstallKind::App.can_install());
        assert!(!InstallKind::Unknown.can_install());
        assert_eq!(serde_json::to_value(InstallKind::Appimage).unwrap(), json!("appimage"));
        assert_eq!(serde_json::to_value(AutoMode::On).unwrap(), json!("on"));
    }
}
```

- [ ] **Step 2: Run the tests and check they fail.**

Run: `cargo test -p tpm-core updates::`
Expected: compile errors such as "cannot find type `UpdateSettings`".

- [ ] **Step 3: Implement.** Put this above the test module:

```rust
//! Update-check rules. The network side lives in the desktop shell (`commands/update.rs`);
//! this module decides whether an automatic check may run and validates what the UI sends.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, Result};

/// GitHub repository that publishes releases and the update manifest.
pub const REPO: &str = "ayush-eubrics01/table-pro-max";
/// `"ask"` (default), `"on"` or `"off"`.
pub const AUTO_KEY: &str = "updates.auto";
/// Milliseconds since the Unix epoch of the last completed check; 0 means never.
pub const LAST_CHECK_KEY: &str = "updates.lastCheck";
/// Automatic checks run at most this often.
pub const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoMode {
    Ask,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateSettings {
    pub auto: AutoMode,
    pub last_check_ms: i64,
}

impl UpdateSettings {
    pub fn from_settings(settings: &Map<String, Value>) -> Self {
        let auto = match settings.get(AUTO_KEY).and_then(Value::as_str) {
            Some("on") => AutoMode::On,
            Some("off") => AutoMode::Off,
            _ => AutoMode::Ask,
        };
        let last_check_ms = settings.get(LAST_CHECK_KEY).and_then(Value::as_i64).unwrap_or(0);
        Self { auto, last_check_ms }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoCheck {
    /// The user has not agreed to automatic checks.
    Disabled,
    /// Checked less than a day ago.
    NotDue,
    Due,
}

pub fn auto_check_due(settings: &UpdateSettings, now_ms: i64) -> AutoCheck {
    if settings.auto != AutoMode::On {
        return AutoCheck::Disabled;
    }
    let last = settings.last_check_ms;
    // A last check in the future means the clock moved backwards; check rather than wait.
    if last <= 0 || last > now_ms || now_ms - last >= CHECK_INTERVAL_MS { AutoCheck::Due } else { AutoCheck::NotDue }
}

/// How the running app was installed, which decides how an update is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    Appimage,
    Deb,
    Rpm,
    Nsis,
    Msi,
    App,
    /// Built from source or run outside a bundle: updates can only be downloaded.
    Unknown,
}

impl InstallKind {
    pub fn can_install(self) -> bool {
        self != InstallKind::Unknown
    }
}

/// `MAJOR.MINOR.PATCH` with an optional `-prerelease` made of `[0-9A-Za-z.-]`.
pub fn is_valid_version(v: &str) -> bool {
    if v.len() > 80 {
        return false;
    }
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| {
        !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    });
    core_ok && pre_ok
}

/// The GitHub page of a release, for "Download" when the app cannot install the update itself.
pub fn release_page_url(version: &str) -> Result<String> {
    if !is_valid_version(version) {
        return Err(AppError::invalid_config("Not a valid version number"));
    }
    Ok(format!("https://github.com/{REPO}/releases/tag/v{version}"))
}
```

- [ ] **Step 4: Run the tests and check they pass.**

Run: `cargo test -p tpm-core updates:: && cargo clippy -p tpm-core --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: 6 tests pass; no clippy warnings; formatting clean. If not formatted, run `cargo fmt --all` and re-check.

- [ ] **Step 5: Commit.**

```bash
git add crates/tpm-core/src/updates.rs crates/tpm-core/src/lib.rs
git commit -m "Core: update-check rules (consent, daily interval, versions)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Backend commands and plugin wiring

**Files:**
- Create: `src-tauri/src/commands/update.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `Cargo.lock`

**Interfaces:**
- Consumes: everything Task 2 produces, plus `plugins.updater` from Task 1.
- Produces these Tauri commands, used by Task 4 (argument names as the webview sends them):
  - `update_status() -> UpdateStatus { currentVersion: String, auto: AutoMode, lastCheck: i64, installKind: InstallKind, canInstall: bool }`
  - `update_check({ manual: bool }) -> UpdateCheck { available: Option<AvailableUpdate { version, date: Option<String>, notes: Option<String> }>, skipped: bool }`
  - `update_install({ jobId: String }) -> ()`. It emits the event `update-progress` with the payload `{ jobId, downloaded: u64, total: Option<u64> }`. On success it restarts the app, so it never returns.
  - `update_cancel({ jobId: String })`
  - `update_open_release_page({ version: String })`
- Error codes: `updates_off` (an automatic check while not `"on"`), `update_network`, `update_unverified`, `update_install_failed`, `update_busy`.

- [ ] **Step 1: Add the dependencies.** In `src-tauri/Cargo.toml` under `[dependencies]`, after `tauri-plugin-dialog`:

```toml
tauri-plugin-updater = { version = "2.13.3", default-features = false, features = ["rustls-tls", "zip"] }
tauri-plugin-opener = "2.7.1"
```

- [ ] **Step 2: Add the state fields.** In `src-tauri/src/state.rs`, add to `AppState` after `ai_jobs`:

```rust
    /// The update found by the last check, waiting for "Update now".
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Cancellation tokens of running update downloads (at most one).
    pub update_jobs: Mutex<HashMap<String, Arc<tokio_util::sync::CancellationToken>>>,
```

In `src-tauri/src/lib.rs`, add to the `AppState { … }` literal after `ai_jobs: Default::default(),`:

```rust
                pending_update: Default::default(),
                update_jobs: Default::default(),
```

- [ ] **Step 3: Write the failing tests for error mapping.** Create `src-tauri/src/commands/update.rs` with only the tests below, and add `pub mod update;` to `commands/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error as E;

    #[test]
    fn maps_plugin_errors_to_clear_app_errors() {
        let e = update_error(E::Network("dns".into()));
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::Network, Some("update_network")));

        let e = update_error(E::SignedVersionMismatch { signed: "0.1.1".into(), announced: "0.1.2".into() });
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::PolicyViolation, Some("update_unverified")));
        assert!(e.message.contains("nothing was installed"));

        let e = update_error(E::MissingSignedVersion);
        assert_eq!(e.code.as_deref(), Some("update_unverified"));

        let e = update_error(E::AuthenticationFailed);
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::Authentication, Some("update_install_failed")));

        let e = update_error(E::PackageInstallFailed);
        assert_eq!(e.code.as_deref(), Some("update_install_failed"));
    }

    #[test]
    fn install_kind_from_bundle_type() {
        use tauri::utils::config::BundleType;
        assert_eq!(kind_of(Some(BundleType::AppImage)), InstallKind::Appimage);
        assert_eq!(kind_of(Some(BundleType::Deb)), InstallKind::Deb);
        assert_eq!(kind_of(Some(BundleType::Rpm)), InstallKind::Rpm);
        assert_eq!(kind_of(Some(BundleType::Nsis)), InstallKind::Nsis);
        assert_eq!(kind_of(Some(BundleType::Msi)), InstallKind::Msi);
        assert_eq!(kind_of(Some(BundleType::Dmg)), InstallKind::App);
        assert_eq!(kind_of(None), InstallKind::Unknown);
    }
}
```

- [ ] **Step 4: Run the tests and check they fail.**

Run: `source $S/sysroot/env.sh && cargo test -p table-pro-max --lib update`
Expected: compile errors: `update_error` and `kind_of` are not found.

- [ ] **Step 5: Implement the module.** Put this above the tests in `src-tauri/src/commands/update.rs`:

```rust
//! In-app updates through the official updater plugin. Automatic checks run only when the
//! user agreed (`updates.auto == "on"`) and at most daily; "Check now" always works. Every
//! download is verified against the public key in tauri.conf.json before it is installed.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;
use tpm_core::error::{AppError, ErrorKind, Result};
use tpm_core::updates::{self, AutoCheck, AutoMode, InstallKind, UpdateSettings};

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub auto: AutoMode,
    pub last_check: i64,
    pub install_kind: InstallKind,
    pub can_install: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: Option<AvailableUpdate>,
    /// An automatic check that was not due yet; nothing was sent.
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    downloaded: u64,
    total: Option<u64>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn kind_of(bundle: Option<tauri::utils::config::BundleType>) -> InstallKind {
    use tauri::utils::config::BundleType as B;
    match bundle {
        Some(B::AppImage) => InstallKind::Appimage,
        Some(B::Deb) => InstallKind::Deb,
        Some(B::Rpm) => InstallKind::Rpm,
        Some(B::Nsis) => InstallKind::Nsis,
        Some(B::Msi) => InstallKind::Msi,
        Some(B::App | B::Dmg) => InstallKind::App,
        None => InstallKind::Unknown,
    }
}

fn install_kind() -> InstallKind {
    kind_of(tauri::utils::platform::bundle_type())
}

fn update_error(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    let detail = e.to_string();
    let err = match e {
        E::Network(_) | E::Reqwest(_) | E::Http(_) => {
            AppError::new(ErrorKind::Network, "Could not reach the update server").with_code("update_network")
        }
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => {
            AppError::new(ErrorKind::PolicyViolation, "The update could not be verified, so nothing was installed")
                .with_code("update_unverified")
        }
        E::InsecureTransportProtocol | E::EmptyEndpoints | E::UrlParse(_) => {
            AppError::new(ErrorKind::InvalidConfig, "The update server address is not valid")
        }
        E::AuthenticationFailed => AppError::new(
            ErrorKind::Authentication,
            "The update was not installed: the password prompt was cancelled or failed",
        )
        .with_code("update_install_failed"),
        E::DebInstallFailed | E::PackageInstallFailed => {
            AppError::new(ErrorKind::Internal, "The system package manager could not install the update")
                .with_code("update_install_failed")
        }
        _ => AppError::new(ErrorKind::Internal, "The update failed"),
    };
    err.with_detail(detail)
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater> {
    let mut builder = app.updater_builder();
    // Tests point the app at a local manifest. The signature check still applies.
    if let Ok(endpoint) = std::env::var("TPM_UPDATE_ENDPOINT") {
        let url: tauri::Url =
            endpoint.parse().map_err(|_| AppError::invalid_config("TPM_UPDATE_ENDPOINT is not a valid URL"))?;
        builder = builder.endpoints(vec![url]).map_err(update_error)?;
    }
    builder.build().map_err(update_error)
}

#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateStatus> {
    let settings = UpdateSettings::from_settings(&state.storage.all_settings()?);
    let kind = install_kind();
    Ok(UpdateStatus {
        current_version: app.package_info().version.to_string(),
        auto: settings.auto,
        last_check: settings.last_check_ms,
        install_kind: kind,
        can_install: kind.can_install(),
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>, manual: bool) -> Result<UpdateCheck> {
    if !manual {
        let settings = UpdateSettings::from_settings(&state.storage.all_settings()?);
        match updates::auto_check_due(&settings, now_ms()) {
            AutoCheck::Disabled => {
                return Err(AppError::new(ErrorKind::PolicyViolation, "Automatic update checks are off")
                    .with_code("updates_off"));
            }
            AutoCheck::NotDue => return Ok(UpdateCheck { available: None, skipped: true }),
            AutoCheck::Due => {}
        }
    }
    let found = match build_updater(&app)?.check().await {
        Ok(found) => found,
        // The manifest has no file for this platform: nothing to offer.
        Err(tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)) => None,
        Err(e) => {
            let err = update_error(e);
            tracing::info!(manual, code = ?err.code, "update check failed");
            return Err(err);
        }
    };
    // Recorded only after a completed check, so an offline start retries next time.
    state.storage.set_setting(updates::LAST_CHECK_KEY, &serde_json::json!(now_ms()))?;
    let available = found.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        date: u.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_string),
        notes: u.body.clone(),
    });
    tracing::info!(manual, available = available.as_ref().map(|a| a.version.as_str()), "update check");
    *state.pending_update.lock().unwrap_or_else(|p| p.into_inner()) = found;
    Ok(UpdateCheck { available, skipped: false })
}

#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>, job_id: String) -> Result<()> {
    let update = state
        .pending_update
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "No update is waiting. Check for updates first."))?;
    let token = Arc::new(CancellationToken::new());
    {
        let mut jobs = state.update_jobs.lock().unwrap_or_else(|p| p.into_inner());
        if !jobs.is_empty() {
            return Err(AppError::new(ErrorKind::Conflict, "An update is already being installed").with_code("update_busy"));
        }
        jobs.insert(job_id.clone(), token.clone());
    }

    let emitter = app.clone();
    let progress_id = job_id.clone();
    let mut downloaded = 0u64;
    let download = update.download(
        move |chunk, total| {
            downloaded += chunk as u64;
            let _ = emitter.emit("update-progress", Progress { job_id: progress_id.clone(), downloaded, total });
        },
        || {},
    );
    let result = tokio::select! {
        r = download => r.map_err(update_error),
        _ = token.cancelled() => Err(AppError::new(ErrorKind::Cancelled, "Update cancelled")),
    };
    state.update_jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(&job_id);
    let bytes = result.inspect_err(|e| tracing::info!(code = ?e.code, "update download failed"))?;

    // The signature was verified by `download`. Installing may run a system installer, so it
    // happens off the async runtime. On Windows the installer closes the app itself.
    let installer = update.clone();
    tauri::async_runtime::spawn_blocking(move || installer.install(bytes))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(update_error)
        .inspect_err(|e| tracing::info!(code = ?e.code, "update install failed"))?;
    tracing::info!(version = %update.version, "update installed; restarting");
    state.engine.close_all().await;
    app.restart()
}

#[tauri::command]
pub fn update_cancel(state: State<'_, AppState>, job_id: String) {
    if let Some(t) = state.update_jobs.lock().unwrap_or_else(|p| p.into_inner()).get(&job_id) {
        t.cancel();
    }
}

#[tauri::command]
pub fn update_open_release_page(app: AppHandle, version: String) -> Result<()> {
    let url = updates::release_page_url(&version)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new(ErrorKind::Internal, "Could not open the browser").with_detail(e.to_string()))
}
```

If `AppError::internal` doesn't exist with that name, use the constructor that `state.rs` uses: `AppError::internal(e.to_string())`. It's already used there, so it exists.

- [ ] **Step 6: Register the plugins and commands.** In `src-tauri/src/lib.rs`, after `.plugin(tauri_plugin_dialog::init())`:

```rust
        // Opener: Rust-side only (release page); no webview permission is granted.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
```

Then add these to `generate_handler![…]` after `commands::ai::ai_cancel,`:

```rust
            commands::update::update_status,
            commands::update::update_check,
            commands::update::update_install,
            commands::update::update_cancel,
            commands::update::update_open_release_page,
```

- [ ] **Step 7: Run the tests, lint and check dependencies.**

Run:
```bash
source $S/sysroot/env.sh
cargo test -p table-pro-max --lib update
cargo clippy -p table-pro-max --all-targets -- -D warnings
cargo fmt --all -- --check
cargo tree -p table-pro-max -i openssl-sys 2>&1 | head -2
cargo tree -p table-pro-max -i native-tls 2>&1 | head -2
$S/tools/bin/cargo-audit audit
```
Expected:
- 2 tests pass, with no clippy warnings and clean formatting.
- Both `cargo tree` commands print "did not match any packages".
- `cargo audit` has no new errors. The ignored RUSTSEC-2023-0071 is allowed.

If a `tauri_plugin_updater::Error` variant named in Step 5 doesn't exist in 2.13.3, the compiler says so. Check `~/.cargo/registry/src/*/tauri-plugin-updater-2.13.3/src/error.rs` and adjust the match.

- [ ] **Step 8: Commit.**

```bash
git add src-tauri Cargo.lock
git commit -m "Backend: update commands on the official updater plugin

Check (automatic only when allowed and due), download with progress and
cancel, verify, install, restart. One install at a time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend plumbing (types, IPC, settings, pending edits, saving the workspace before restart)

**Files:**
- Modify: `src/types/backend.ts`, `src/lib/ipc.ts`, `src/stores/settings.ts`, `src/app/WorkspaceView.tsx`, `src/app/restore.ts`
- Create: `src/stores/pendingEdits.ts`, `src/stores/pendingEdits.test.ts`

**Interfaces:**
- Consumes: the commands from Task 3.
- Produces (used by Task 5):
  - The types `UpdateAuto`, `InstallKind`, `UpdateStatus`, `AvailableUpdate`, `UpdateCheck` and `UpdateProgress`.
  - `api.updateStatus()`, `api.updateCheck(manual)`, `api.updateInstall(jobId)`, `api.updateCancel(jobId)` and `api.updateOpenReleasePage(version)`.
  - `usePendingEdits` and `pendingTableCount(): number`.
  - `saveNow(workspaces, activeId): Promise<void>`.
  - The settings `"updates.auto"` and `"updates.lastCheck"`.

- [ ] **Step 1: Write the failing test.** Create `src/stores/pendingEdits.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { pendingTableCount, usePendingEdits } from "./pendingEdits";

beforeEach(() => usePendingEdits.setState({ byWorkspace: {} }));

describe("pending edits", () => {
  it("adds up tables across workspaces and forgets workspaces at zero", () => {
    const { set } = usePendingEdits.getState();
    set("a", 2);
    set("b", 1);
    expect(pendingTableCount()).toBe(3);
    set("a", 0);
    expect(pendingTableCount()).toBe(1);
    expect(usePendingEdits.getState().byWorkspace).toEqual({ b: 1 });
  });

  it("does not notify subscribers when nothing changed", () => {
    usePendingEdits.getState().set("a", 1);
    const before = usePendingEdits.getState().byWorkspace;
    usePendingEdits.getState().set("a", 1);
    expect(usePendingEdits.getState().byWorkspace).toBe(before);
  });
});
```

- [ ] **Step 2: Run it and check it fails.**

Run: `npx vitest run src/stores/pendingEdits.test.ts`
Expected: FAIL. The module `./pendingEdits` can't be found.

- [ ] **Step 3: Implement the store.** Create `src/stores/pendingEdits.ts`:

```ts
import { create } from "zustand";

/** Tables with uncommitted grid edits, per workspace, so app-wide actions (updating) can warn first. */
interface PendingEditsState {
  byWorkspace: Record<string, number>;
  set: (workspaceId: string, tables: number) => void;
}

export const usePendingEdits = create<PendingEditsState>((set) => ({
  byWorkspace: {},
  set: (workspaceId, tables) =>
    set((s) => {
      if ((s.byWorkspace[workspaceId] ?? 0) === tables) return s;
      const byWorkspace = { ...s.byWorkspace };
      if (tables > 0) byWorkspace[workspaceId] = tables;
      else delete byWorkspace[workspaceId];
      return { byWorkspace };
    }),
}));

export function pendingTableCount(): number {
  return Object.values(usePendingEdits.getState().byWorkspace).reduce((a, b) => a + b, 0);
}
```

- [ ] **Step 4: Report dirty tables from each workspace.** In `src/app/WorkspaceView.tsx`, change the first line to `import { useCallback, useEffect, useState } from "react";` and add `import { usePendingEdits } from "../stores/pendingEdits";`. Then add these right after the `const [sidebarWidth, …]` line:

```ts
  // Tell app-wide actions (updates) how many tables here have uncommitted edits.
  useEffect(() => {
    const open = new Set(ws.tabs.map((t) => t.id));
    usePendingEdits.getState().set(ws.id, Object.entries(dirtyTables).filter(([id, d]) => d && open.has(id)).length);
  }, [dirtyTables, ws.tabs, ws.id]);
  useEffect(() => () => usePendingEdits.getState().set(ws.id, 0), [ws.id]);
```

- [ ] **Step 5: Add `saveNow`.** In `src/app/restore.ts`, after `scheduleSave`:

```ts
/** Writes the snapshot now, cancelling a pending debounced save (used before restarting). */
export async function saveNow(workspaces: Workspace[], activeId: string | null) {
  clearTimeout(timer);
  await api.setWorkspace(WORKSPACE_KEY, snapshot(workspaces, activeId));
}
```

- [ ] **Step 6: Add the types and IPC wrappers.** Append to `src/types/backend.ts`:

```ts
export type UpdateAuto = "ask" | "on" | "off";
export type InstallKind = "appimage" | "deb" | "rpm" | "nsis" | "msi" | "app" | "unknown";

export interface UpdateStatus {
  currentVersion: string;
  auto: UpdateAuto;
  /** Milliseconds since the epoch; 0 means never. */
  lastCheck: number;
  installKind: InstallKind;
  canInstall: boolean;
}

export interface AvailableUpdate {
  version: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateCheck {
  available: AvailableUpdate | null;
  skipped: boolean;
}

export interface UpdateProgress {
  jobId: string;
  downloaded: number;
  total: number | null;
}
```

In `src/lib/ipc.ts`, add `UpdateCheck` and `UpdateStatus` to the type import. Then add these after the `aiCancel` line:

```ts
  updateStatus: () => call<UpdateStatus>("update_status"),
  updateCheck: (manual: boolean) => call<UpdateCheck>("update_check", { manual }),
  updateInstall: (jobId: string) => call<void>("update_install", { jobId }),
  updateCancel: (jobId: string) => call<void>("update_cancel", { jobId }),
  updateOpenReleasePage: (version: string) => call<void>("update_open_release_page", { version }),
```

- [ ] **Step 7: Add the settings.** In `src/stores/settings.ts`, add to `Settings` after `"ai.baseUrl": string;`:

```ts
  /** Automatic update checks: asked once on first launch. */
  "updates.auto": "ask" | "on" | "off";
  /** Written by the backend after each completed check (ms since the epoch). */
  "updates.lastCheck": number;
```

Add to `DEFAULT_SETTINGS` after `"ai.baseUrl": "",`:

```ts
  "updates.auto": "ask",
  "updates.lastCheck": 0,
```

- [ ] **Step 8: Run the frontend checks.**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: everything passes; the 2 new tests pass.

- [ ] **Step 9: Commit.**

```bash
git add src/types/backend.ts src/lib/ipc.ts src/stores/settings.ts src/stores/pendingEdits.ts src/stores/pendingEdits.test.ts src/app/WorkspaceView.tsx src/app/restore.ts
git commit -m "Frontend plumbing for updates: types, IPC, settings, pending-edit count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Update store, consent dialog, banner, Settings section

**Files:**
- Create: `src/features/updates/store.ts`, `FirstRunUpdatePrompt.tsx`, `UpdateBanner.tsx`, `UpdateSettings.tsx` and `updates.test.tsx`, all under `src/features/updates/`
- Modify: `src/app/App.tsx`, `src/features/settings/SettingsDialog.tsx`, `src/styles/app.css`

**Interfaces:**
- Consumes: everything Task 4 produces, `confirmAction` from `src/stores/ui.ts`, `uid` from `src/lib/text.ts`, and `Dialog` from `src/components/Dialog.tsx`.
- Produces:
  - `useUpdates`, a zustand store with `status`, `available`, `phase` (`"idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error"`), `progress`, `error`, `bannerHidden` and `jobId`, and the actions `init()`, `refreshStatus()`, `check(manual)`, `install()`, `cancel()`, `later()` and `openReleasePage()`.
  - The components `FirstRunUpdatePrompt`, `UpdateBanner` and `UpdateSettings`.

- [ ] **Step 1: Write the failing tests.** Create `src/features/updates/updates.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { UpdateStatus } from "../../types/backend";
import { Overlays } from "../../components/Overlays";
import { usePendingEdits } from "../../stores/pendingEdits";
import { FirstRunUpdatePrompt } from "./FirstRunUpdatePrompt";
import { UpdateBanner } from "./UpdateBanner";
import { useUpdates } from "./store";

let calls: { cmd: string; args: Record<string, unknown> }[];
let stored: Record<string, unknown>;
let status: UpdateStatus;
let checkResult: unknown;
let checkFails: unknown;
const INITIAL = useUpdates.getState();

beforeEach(() => {
  calls = [];
  stored = {};
  status = { currentVersion: "0.1.0", auto: "ask", lastCheck: 0, installKind: "appimage", canInstall: true };
  checkResult = { available: { version: "0.2.0", date: null, notes: "<b>Faster</b> grid" }, skipped: false };
  checkFails = null;
  useUpdates.setState(INITIAL, true);
  usePendingEdits.setState({ byWorkspace: {} });
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      switch (cmd) {
        case "update_status":
          return { ...status, auto: (stored["updates.auto"] as UpdateStatus["auto"]) ?? status.auto };
        case "update_check":
          if (checkFails) throw checkFails;
          return checkResult;
        case "set_setting":
          stored[a.key as string] = a.value;
          return null;
        case "update_install":
          return new Promise(() => undefined); // the real app restarts here
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
});

afterEach(() => {
  cleanup();
  clearMocks();
});

const checks = () => calls.filter((c) => c.cmd === "update_check");
const installs = () => calls.filter((c) => c.cmd === "update_install");

describe("first-run consent", () => {
  it("asks before any check and saves yes", async () => {
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(0);
    render(<FirstRunUpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Check automatically" }));
    await waitFor(() => expect(checks()).toHaveLength(1));
    expect(stored["updates.auto"]).toBe("on");
    expect(checks()[0]!.args).toEqual({ manual: false });
    expect(screen.queryByText("Check for updates automatically?")).not.toBeInTheDocument();
  });

  it("saves no and never checks", async () => {
    await useUpdates.getState().init();
    render(<FirstRunUpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Don't check" }));
    await waitFor(() => expect(stored["updates.auto"]).toBe("off"));
    expect(checks()).toHaveLength(0);
  });

  it("does not check automatically when off", async () => {
    status.auto = "off";
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(0);
  });

  it("stays quiet when an automatic check fails (offline)", async () => {
    status.auto = "on";
    checkFails = { kind: "network", message: "Could not reach the update server" };
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(1);
    expect(useUpdates.getState().phase).toBe("idle");
    expect(useUpdates.getState().error).toBeNull();
  });

  it("shows the error for a failed manual check", async () => {
    checkFails = { kind: "network", message: "Could not reach the update server" };
    await useUpdates.getState().check(true);
    expect(useUpdates.getState().phase).toBe("error");
    expect(useUpdates.getState().error).toContain("Could not reach the update server");
  });
});

describe("update banner", () => {
  const found = async () => {
    status.auto = "on";
    await useUpdates.getState().init();
  };

  it("shows release notes as text, never as HTML", async () => {
    await found();
    const { container } = render(<UpdateBanner />);
    expect(screen.getByText("Table Pro Max 0.2.0 is available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(screen.getByText("<b>Faster</b> grid")).toBeInTheDocument();
    expect(container.querySelector(".update-notes b")).toBeNull();
  });

  it("asks first when tables have uncommitted edits", async () => {
    await found();
    usePendingEdits.getState().set("ws-1", 2);
    render(
      <>
        <UpdateBanner />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText(/2 tables have uncommitted changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/uncommitted changes/)).not.toBeInTheDocument());
    expect(installs()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(installs()).toHaveLength(1));
  });

  it("starts only one install when clicked twice", async () => {
    await found();
    render(<UpdateBanner />);
    const button = screen.getByRole("button", { name: "Update now" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(installs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(installs()).toHaveLength(1);
  });

  it("offers Download when this install cannot update itself", async () => {
    status.canInstall = false;
    status.installKind = "unknown";
    await found();
    render(<UpdateBanner />);
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "update_open_release_page" && c.args.version === "0.2.0")).toBe(true));
  });

  it("Later hides the banner", async () => {
    await found();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

Run: `npx vitest run src/features/updates`
Expected: FAIL. The modules `./FirstRunUpdatePrompt`, `./UpdateBanner` and `./store` can't be found.

- [ ] **Step 3: Implement the store.** Create `src/features/updates/store.ts`:

```ts
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { AvailableUpdate, UpdateProgress, UpdateStatus } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { confirmAction } from "../../stores/ui";
import { pendingTableCount } from "../../stores/pendingEdits";
import { useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { saveNow } from "../../app/restore";

export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

interface UpdatesState {
  status: UpdateStatus | null;
  available: AvailableUpdate | null;
  phase: UpdatePhase;
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  bannerHidden: boolean;
  jobId: string | null;
  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  check: (manual: boolean) => Promise<void>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  later: () => void;
  openReleasePage: () => Promise<void>;
}

const busy = (phase: UpdatePhase) => phase === "checking" || phase === "downloading" || phase === "installing";

// Set synchronously when "Update now" is clicked, so a second click is ignored even while the
// unsaved-edits confirmation is open.
let installClaimed = false;

function describe(e: unknown): string {
  const err = toError(e);
  return err.detail ? `${err.message}: ${err.detail}` : err.message;
}

/** In-app updates: nothing is checked automatically unless the user agreed (`updates.auto`). */
export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  available: null,
  phase: "idle",
  progress: null,
  error: null,
  bannerHidden: false,
  jobId: null,

  refreshStatus: async () => {
    try {
      set({ status: await api.updateStatus() });
    } catch {
      // Status is informational; the Settings section shows what it has.
    }
  },

  init: async () => {
    await get().refreshStatus();
    if (get().status?.auto === "on") await get().check(false);
  },

  check: async (manual) => {
    if (busy(get().phase)) return;
    set({ phase: "checking", error: null });
    try {
      const r = await api.updateCheck(manual);
      if (r.skipped) set({ phase: get().available ? "available" : "idle" });
      else if (r.available) set({ available: r.available, phase: "available", bannerHidden: false });
      else set({ available: null, phase: "upToDate" });
    } catch (e) {
      // Automatic checks fail quietly (offline, GitHub down); the next start tries again.
      set({ phase: manual ? "error" : "idle", error: manual ? describe(e) : null });
    }
    await get().refreshStatus();
  },

  install: async () => {
    const { available, phase } = get();
    if (!available || busy(phase) || installClaimed) return;
    installClaimed = true;
    try {
      const pending = pendingTableCount();
      if (pending > 0) {
        const ok = await confirmAction({
          title: `Update to ${available.version} now?`,
          body: `${pending} ${pending === 1 ? "table has" : "tables have"} uncommitted changes. They will be lost when the app restarts.`,
          confirmLabel: "Update anyway",
          danger: true,
        });
        if (!ok) return;
      }
      await runInstall();
    } finally {
      installClaimed = false;
    }
  },

  cancel: async () => {
    const { jobId } = get();
    if (jobId) await api.updateCancel(jobId).catch(() => undefined);
  },

  later: () => set({ bannerHidden: true }),

  openReleasePage: async () => {
    const version = get().available?.version;
    if (version) await api.updateOpenReleasePage(version).catch((e) => set({ error: describe(e) }));
  },
}));

/** Downloads, verifies and installs the pending update; on success the app restarts. */
async function runInstall() {
  const set = useUpdates.setState;
  const jobId = uid();
  set({ phase: "downloading", progress: { downloaded: 0, total: null }, error: null, jobId });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<UpdateProgress>("update-progress", (e) => {
      if (e.payload.jobId !== jobId) return;
      const { downloaded, total } = e.payload;
      set({ progress: { downloaded, total }, phase: total != null && downloaded >= total ? "installing" : "downloading" });
    });
  } catch {
    // Progress is optional.
  }
  try {
    if (useSettings.getState().settings["workspace.restore"]) {
      const ws = useWorkspaces.getState();
      await saveNow(ws.workspaces, ws.activeId).catch(() => undefined);
    }
    await api.updateInstall(jobId);
    // On success the app restarts before this returns.
  } catch (e) {
    set({ phase: "available", error: toError(e).kind === "cancelled" ? null : describe(e) });
  } finally {
    unlisten?.();
    set({ jobId: null, progress: null });
  }
}
```

- [ ] **Step 4: Implement the consent dialog.** Create `src/features/updates/FirstRunUpdatePrompt.tsx`:

```tsx
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useSettings } from "../../stores/settings";
import { useUpdates } from "./store";

/** Asked once. Nothing is checked automatically until the user agrees. */
export function FirstRunUpdatePrompt() {
  const auto = useUpdates((s) => s.status?.auto);
  const [dismissed, setDismissed] = useState(false);
  if (auto !== "ask" || dismissed) return null;

  const answer = async (on: boolean) => {
    setDismissed(true);
    await useSettings.getState().set("updates.auto", on ? "on" : "off");
    await useUpdates.getState().refreshStatus();
    if (on) await useUpdates.getState().check(false);
  };

  return (
    <Dialog
      title="Check for updates automatically?"
      onClose={() => setDismissed(true)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => void answer(false)}>
            Don't check
          </button>
          <button className="btn btn-primary" onClick={() => void answer(true)}>
            Check automatically
          </button>
        </>
      }
    >
      <p>
        Table Pro Max can check GitHub once a day for a new version. GitHub sees your IP address and that you use the app;
        nothing about your databases or queries is sent.
      </p>
      <p className="hint">You can change this, or check by hand, in Settings.</p>
    </Dialog>
  );
}
```

- [ ] **Step 5: Implement the banner.** Create `src/features/updates/UpdateBanner.tsx`:

```tsx
import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useUpdates } from "./store";

/** "Version X is available" under the connection strip. Release notes are shown as plain text. */
export function UpdateBanner() {
  const available = useUpdates((s) => s.available);
  const phase = useUpdates((s) => s.phase);
  const progress = useUpdates((s) => s.progress);
  const error = useUpdates((s) => s.error);
  const hidden = useUpdates((s) => s.bannerHidden);
  const canInstall = useUpdates((s) => s.status?.canInstall ?? false);
  const [showNotes, setShowNotes] = useState(false);
  if (!available || hidden) return null;

  const actions = useUpdates.getState();
  const working = phase === "downloading" || phase === "installing";
  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <div className="update-banner" role="region" aria-label="Update available">
      <div className="update-banner-row">
        <RefreshCw size={14} aria-hidden />
        <span>Table Pro Max {available.version} is available.</span>
        {working && (
          <span className="hint" role="status">
            {phase === "installing" ? "Installing…" : pct == null ? "Downloading…" : `Downloading ${pct} %`}
          </span>
        )}
        <span className="grow" />
        {available.notes && (
          <button className="btn btn-ghost" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)}>
            What's new
          </button>
        )}
        {working ? (
          phase === "downloading" && (
            <button className="btn" onClick={() => void actions.cancel()}>
              Cancel
            </button>
          )
        ) : canInstall ? (
          <button className="btn btn-primary" onClick={() => void actions.install()}>
            Update now
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void actions.openReleasePage()}>
            <Download size={14} /> Download
          </button>
        )}
        {!working && (
          <button className="btn btn-ghost" onClick={actions.later}>
            Later
          </button>
        )}
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
          {canInstall && (
            <>
              {" "}
              <button className="btn btn-ghost" onClick={() => void actions.openReleasePage()}>
                Download instead
              </button>
            </>
          )}
        </div>
      )}
      {showNotes && available.notes && <pre className="update-notes">{available.notes}</pre>}
    </div>
  );
}
```

- [ ] **Step 6: Implement the Settings section.** Create `src/features/updates/UpdateSettings.tsx`:

```tsx
import { useEffect } from "react";
import { useSettings } from "../../stores/settings";
import { useUpdates } from "./store";

/** Settings → Updates. "Check now" always works; automatic checks need the switch. */
export function UpdateSettings() {
  const status = useUpdates((s) => s.status);
  const phase = useUpdates((s) => s.phase);
  const available = useUpdates((s) => s.available);
  const error = useUpdates((s) => s.error);
  const auto = useSettings((s) => s.settings["updates.auto"]);

  useEffect(() => {
    void useUpdates.getState().refreshStatus();
  }, []);

  const toggle = async (on: boolean) => {
    await useSettings.getState().set("updates.auto", on ? "on" : "off");
    await useUpdates.getState().refreshStatus();
  };

  const version = status?.currentVersion ?? "…";
  const last = status?.lastCheck ? new Date(status.lastCheck).toLocaleString() : "never";
  const message =
    phase === "checking"
      ? "Checking…"
      : phase === "error"
        ? error
        : available
          ? `Version ${available.version} is available.`
          : phase === "upToDate"
            ? `You have the latest version (${version}).`
            : `Version ${version}. Last checked: ${last}.`;

  return (
    <fieldset className="fieldset">
      <legend>Updates</legend>
      <label className="checkbox">
        <input type="checkbox" checked={auto === "on"} onChange={(e) => void toggle(e.target.checked)} />
        Check for updates automatically (once a day, from GitHub)
      </label>
      <div className="row">
        <button className="btn" disabled={phase === "checking" || phase === "downloading" || phase === "installing"} onClick={() => void useUpdates.getState().check(true)}>
          Check now
        </button>
        <span className="hint" role="status">
          {message}
        </span>
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 7: Wire it into the app.** In `src/app/App.tsx`:
  - Add the imports:
    ```tsx
    import { FirstRunUpdatePrompt } from "../features/updates/FirstRunUpdatePrompt";
    import { UpdateBanner } from "../features/updates/UpdateBanner";
    import { useUpdates } from "../features/updates/store";
    ```
  - In the startup effect, right after `await useSettings.getState().load();`, add:
    ```tsx
        if (isMainWindow) void useUpdates.getState().init();
    ```
  - Make the first child of the content `<div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>`:
    ```tsx
        {isMainWindow && <UpdateBanner />}
    ```
  - After `<Overlays />`, add:
    ```tsx
      {isMainWindow && <FirstRunUpdatePrompt />}
    ```

  In `src/features/settings/SettingsDialog.tsx`, import `UpdateSettings` from `"../updates/UpdateSettings"` and render `<UpdateSettings />` right after `<AiSettings />`. Then replace the last sentence of the notice with:

  ```tsx
          Nothing is sent to any server other than the databases you connect to and, only if you allow it, the AI service you set up above and GitHub when checking for updates.
  ```

  Append to `src/styles/app.css`:

  ```css
  .update-banner {
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    padding: 6px 12px;
  }
  .update-banner-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .update-banner-row .grow {
    flex: 1;
  }
  .update-notes {
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    margin: 8px 0 0;
    font: inherit;
  }
  ```

- [ ] **Step 8: Run the tests and all frontend checks.**

Run: `npx vitest run src/features/updates && npm run typecheck && npm run lint && npm test && npm run build`
Expected: the 10 update tests pass and every other check passes. If the Cancel button in `Overlays` has a different accessible name, read `src/components/Overlays.tsx` and match it in the test.

- [ ] **Step 9: Commit.**

```bash
git add src/features/updates src/app/App.tsx src/features/settings/SettingsDialog.tsx src/styles/app.css
git commit -m "UI: ask once about update checks, update banner, Settings > Updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Manifest generator (`scripts/updater-manifest.mjs`)

**Files:**
- Create: `scripts/updater-manifest.mjs`, `scripts/updater-manifest.test.mjs`
- Modify: `vite.config.ts` (`test.include`)

**Interfaces:**
- Produces (used by Task 7):
  - The command `node scripts/updater-manifest.mjs --version <v> --repo <owner/name> --notes <file> --dir <dir> --out <file>`.
  - The exports `buildManifest({ version, repo, notes, pubDate, readSignature })`, `PLATFORMS: [key, (v) => fileName][]` and `FALLBACKS`.

- [ ] **Step 1: Make vitest find the tests.** In `vite.config.ts`, change `include: ["src/**/*.test.{ts,tsx}"],` to:

```ts
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
```

- [ ] **Step 2: Write the failing tests.** Create `scripts/updater-manifest.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { FALLBACKS, PLATFORMS, buildManifest } from "./updater-manifest.mjs";

const REPO = "ayush-eubrics01/table-pro-max";
const signatures = (v) => Object.fromEntries(PLATFORMS.map(([, name]) => [`${name(v)}.sig`, `sig-of-${name(v)}\n`]));

function build(version, overrides = {}) {
  const sigs = { ...signatures(version), ...overrides };
  return buildManifest({
    version,
    repo: REPO,
    notes: "Notes with <b>markup</b>\nand lines",
    pubDate: "2026-10-13T00:00:00.000Z",
    readSignature: (file) => {
      if (!(file in sigs)) throw new Error(`Missing signature: ${file}`);
      return sigs[file];
    },
  });
}

describe("updater manifest", () => {
  it("has every install type plus the fallbacks", () => {
    const m = build("0.2.0");
    expect(Object.keys(m.platforms).sort()).toEqual(
      [...PLATFORMS.map(([k]) => k), ...Object.keys(FALLBACKS)].sort(),
    );
    expect(m.platforms["linux-x86_64-deb"]).toEqual({
      url: `https://github.com/${REPO}/releases/download/v0.2.0/table-pro-max_0.2.0_amd64.deb`,
      signature: "sig-of-table-pro-max_0.2.0_amd64.deb",
    });
    expect(m.platforms["linux-x86_64"]).toEqual(m.platforms["linux-x86_64-appimage"]);
    expect(m.platforms["windows-x86_64"]).toEqual(m.platforms["windows-x86_64-nsis"]);
    expect(m.platforms["darwin-aarch64"]).toEqual(m.platforms["darwin-aarch64-app"]);
    expect(m.version).toBe("0.2.0");
    expect(m.pub_date).toBe("2026-10-13T00:00:00.000Z");
  });

  it("points pre-release versions at their own tag", () => {
    const m = build("0.2.0-rc.1");
    expect(m.platforms["darwin-aarch64-app"].url).toBe(
      `https://github.com/${REPO}/releases/download/v0.2.0-rc.1/table-pro-max_0.2.0-rc.1_aarch64.app.tar.gz`,
    );
  });

  it("keeps the notes verbatim", () => {
    expect(build("0.2.0").notes).toBe("Notes with <b>markup</b>\nand lines");
  });

  it("fails when a signature is missing or empty", () => {
    const missing = signatures("0.2.0");
    delete missing["table-pro-max-0.2.0-1.x86_64.rpm.sig"];
    expect(() =>
      buildManifest({ version: "0.2.0", repo: REPO, notes: "", pubDate: "x", readSignature: (f) => {
        if (!(f in missing)) throw new Error(`Missing signature: ${f}`);
        return missing[f];
      } }),
    ).toThrow("Missing signature: table-pro-max-0.2.0-1.x86_64.rpm.sig");
    expect(() => build("0.2.0", { "table-pro-max_0.2.0_x64-setup.exe.sig": "  \n" })).toThrow("Empty signature");
  });

  it("rejects versions and repositories that are not valid", () => {
    expect(() => build("v0.2.0")).toThrow("Not a release version");
    expect(() => build("0.2")).toThrow("Not a release version");
    expect(() => buildManifest({ version: "0.2.0", repo: "a/b/../c", notes: "", pubDate: "x", readSignature: () => "s" })).toThrow(
      "Not a GitHub repository",
    );
  });
});
```

- [ ] **Step 3: Run the tests and check they fail.**

Run: `npx vitest run scripts`
Expected: FAIL. `./updater-manifest.mjs` can't be found.

- [ ] **Step 4: Implement.** Create `scripts/updater-manifest.mjs`:

```js
#!/usr/bin/env node
// Builds latest.json for the Tauri updater from the files collected by release.yml.
// Usage: node scripts/updater-manifest.mjs --version 0.2.0 --repo owner/name \
//          --notes docs/releases/v0.2.0.md --dir release-assets --out release-assets/latest.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One updater file per install type. Names match the collect step in release.yml. */
export const PLATFORMS = [
  ["linux-x86_64-appimage", (v) => `table-pro-max_${v}_amd64.AppImage`],
  ["linux-x86_64-deb", (v) => `table-pro-max_${v}_amd64.deb`],
  ["linux-x86_64-rpm", (v) => `table-pro-max-${v}-1.x86_64.rpm`],
  ["windows-x86_64-nsis", (v) => `table-pro-max_${v}_x64-setup.exe`],
  ["windows-x86_64-msi", (v) => `table-pro-max_${v}_x64_en-US.msi`],
  ["darwin-aarch64-app", (v) => `table-pro-max_${v}_aarch64.app.tar.gz`],
];

/** Used by an app that does not know how it was installed. */
export const FALLBACKS = {
  "linux-x86_64": "linux-x86_64-appimage",
  "windows-x86_64": "windows-x86_64-nsis",
  "darwin-aarch64": "darwin-aarch64-app",
};

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function buildManifest({ version, repo, notes, pubDate, readSignature }) {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!REPO.test(repo) || repo.includes("..")) throw new Error(`Not a GitHub repository: ${repo}`);
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const platforms = {};
  for (const [key, name] of PLATFORMS) {
    const file = name(version);
    const signature = readSignature(`${file}.sig`).trim();
    if (!signature) throw new Error(`Empty signature: ${file}.sig`);
    platforms[key] = { url: `${base}/${encodeURIComponent(file)}`, signature };
  }
  for (const [key, target] of Object.entries(FALLBACKS)) platforms[key] = platforms[target];
  return { version, notes, pub_date: pubDate, platforms };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      repo: { type: "string" },
      notes: { type: "string" },
      dir: { type: "string" },
      out: { type: "string" },
    },
  });
  for (const k of ["version", "repo", "notes", "dir", "out"]) if (!values[k]) throw new Error(`--${k} is required`);
  const manifest = buildManifest({
    version: values.version,
    repo: values.repo,
    notes: readFileSync(values.notes, "utf8"),
    pubDate: new Date().toISOString(),
    readSignature: (file) => {
      try {
        return readFileSync(join(values.dir, file), "utf8");
      } catch {
        throw new Error(`Missing signature: ${file}`);
      }
    },
  });
  writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${values.out} with ${Object.keys(manifest.platforms).length} targets`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 5: Run the tests and check they pass.**

Run: `npx vitest run scripts && npm run lint`
Expected: 5 tests pass, and lint is clean. ESLint only lints `*.ts`/`*.tsx`, so the `.mjs` file isn't linted.

- [ ] **Step 6: Commit.**

```bash
git add scripts/updater-manifest.mjs scripts/updater-manifest.test.mjs vite.config.ts
git commit -m "Release: script that writes the updater manifest (latest.json)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Release workflow (sign updater bundles, collect by glob, publish manifest)

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the secrets from Task 1, the command from Task 6, and the asset names in Global Constraints.
- Produces: draft releases carrying `latest.json`, a `.sig` for every updater file, and `SHA256SUMS`.

- [ ] **Step 1: Check the updater config in the `check` job.** Add a step after "Tag matches the app version":

```yaml
      - name: Updater config is safe to ship
        run: |
          jq -e '.plugins.updater
                 | (.pubkey | length > 40)
                   and .requireSignedVersion == true
                   and (has("dangerousInsecureTransportProtocol") | not)
                   and (has("allowDowngrades") | not)' src-tauri/tauri.conf.json
```

- [ ] **Step 2: Build signed updater bundles.** Replace the build job's step `- name: Build bundles (unsigned)` / `run: npx tauri build` with:

```yaml
      - name: Build bundles (installers unsigned, updates signed)
        shell: bash
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: |
          if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
            echo "::error::The TAURI_SIGNING_PRIVATE_KEY secret is not set. See docs/RELEASING.md."
            exit 1
          fi
          npx tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

- [ ] **Step 3: Collect by glob, with signatures.** Replace the body of `- name: Collect installers` (keep `shell: bash`) with:

```bash
          v="${{ needs.check.outputs.version }}"
          b=target/release/bundle
          out=release-assets  # not dist/: that is the Vite build output
          mkdir "$out"
          shopt -s nullglob
          # take <signed|plain> <published name> <matches...>: exactly one match, copied
          # (with its updater signature when signed) under the published name.
          take() {
            local mode=$1 name=$2; shift 2
            if [ $# -ne 1 ]; then echo "::error::expected one file for $name, found $#: $*"; exit 1; fi
            cp "$1" "$out/$name"
            if [ "$mode" = signed ]; then cp "$1.sig" "$out/$name.sig"; fi
          }
          case "$RUNNER_OS" in
            Linux)
              take signed "table-pro-max_${v}_amd64.deb"          "$b"/deb/*.deb
              take signed "table-pro-max-${v}-1.x86_64.rpm"        "$b"/rpm/*.rpm
              take signed "table-pro-max_${v}_amd64.AppImage"      "$b"/appimage/*.AppImage ;;
            Windows)
              take signed "table-pro-max_${v}_x64_en-US.msi"       "$b"/msi/*.msi
              take signed "table-pro-max_${v}_x64-setup.exe"       "$b"/nsis/*-setup.exe ;;
            macOS)
              take plain  "table-pro-max_${v}_aarch64.dmg"         "$b"/dmg/*.dmg
              take signed "table-pro-max_${v}_aarch64.app.tar.gz"  "$b"/macos/*.app.tar.gz ;;
          esac
          ls -l "$out"
```

- [ ] **Step 4: Build the manifest and set the pre-release rule.** In the `draft` job:
  - Insert these before the `Checksums` step:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Updater manifest
        run: |
          v="${{ needs.check.outputs.version }}"
          node scripts/updater-manifest.mjs --version "$v" --repo "$GITHUB_REPOSITORY" \
            --notes "docs/releases/v$v.md" --dir release-assets --out release-assets/latest.json
```

  - In `Create draft release`, change `case "$v" in 0.*|*-*) pre="--prerelease" ;; esac` to:

```bash
          case "$v" in *-*) pre="--prerelease" ;; esac  # only suffixed tags; plain tags are offered as updates
```

  - Update the header comment of the workflow to mention the signed updater files and `latest.json`.

- [ ] **Step 5: Lint the workflow.**

Run: `timeout 120 docker run --rm --name tpm-test-actionlint -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.7 -color=false; echo exit=$?; docker rmi rhysd/actionlint:1.7.7`
Expected: `exit=0` with no findings.

- [ ] **Step 6: Simulate the collect and manifest steps locally.**

```bash
T=$S/reltest2; rm -rf "$T"; mkdir -p "$T"/target/release/bundle/{deb,rpm,appimage,dmg,macos,msi,nsis} "$T/dist"
cd "$T" && for f in "deb/Table Pro Max_0.2.0-rc.1_amd64.deb" "rpm/Table Pro Max-0.2.0~rc.1-1.x86_64.rpm" "appimage/Table Pro Max_0.2.0-rc.1_amd64.AppImage" "macos/Table Pro Max.app.tar.gz" "msi/Table Pro Max_0.2.0-rc.1_x64_en-US.msi" "nsis/Table Pro Max_0.2.0-rc.1_x64-setup.exe"; do echo data > "target/release/bundle/$f"; echo "sig-$f" > "target/release/bundle/$f.sig"; done; echo dmg > "target/release/bundle/dmg/Table Pro Max_0.2.0-rc.1_aarch64.dmg"
python3 - "$T" <<'EOF'
import yaml, sys, subprocess
wf = yaml.safe_load(open('/home/ayush/projects/table-pro-max/.github/workflows/release.yml'))
step = [s for s in wf['jobs']['build']['steps'] if s.get('name') == 'Collect installers'][0]
script = step['run'].replace('${{ needs.check.outputs.version }}', '0.2.0-rc.1')
for os_name in ['Linux', 'Windows', 'macOS']:
    r = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], cwd=sys.argv[1],
                       env={'RUNNER_OS': os_name, 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
    print(os_name, r.returncode, r.stderr.strip())
    subprocess.run(['bash', '-c', 'mv release-assets/* collected/ 2>/dev/null || (mkdir -p collected && mv release-assets/* collected/); rmdir release-assets'], cwd=sys.argv[1])
EOF
mkdir -p "$T/notes" && echo "Test notes" > "$T/notes/v0.2.0-rc.1.md"
node /home/ayush/projects/table-pro-max/scripts/updater-manifest.mjs --version 0.2.0-rc.1 --repo ayush-eubrics01/table-pro-max --notes "$T/notes/v0.2.0-rc.1.md" --dir "$T/collected" --out "$T/collected/latest.json" && jq '.platforms | keys | length' "$T/collected/latest.json"
cd /home/ayush/projects/table-pro-max
```
Expected:
- `Linux 0`, `Windows 0` and `macOS 0`, with no stderr.
- The manifest script prints "Wrote … with 9 targets", and `jq` prints `9`.

This proves the globs also handle a pre-release name, which is Review Focus item 5.

- [ ] **Step 7: Commit.**

```bash
git add .github/workflows/release.yml
git commit -m "Release: sign updater bundles, attach latest.json, plain tags are updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end update on Linux (local, with a throwaway key)

**Files:**
- No repo files change, except the evidence recorded in Task 9. All work happens in `$S/e2e-update`.

**Interfaces:**
- Consumes: everything from Tasks 1–5. The `TPM_UPDATE_ENDPOINT` override comes from Task 3.

- [ ] **Step 1: Generate a throwaway key.** It must never be the real one.

```bash
E=$S/e2e-update; rm -rf "$E"; mkdir -p "$E"/{serve,run,v010,v011,data}
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
./node_modules/.bin/tauri signer generate --ci -p e2e-pass -w "$E/test.key"
```
Expected: `$E/test.key` and `$E/test.key.pub` exist.

- [ ] **Step 2: Build 0.1.0 and 0.1.1 AppImages with the test key and a local endpoint.**

```bash
source $S/sysroot/env.sh
for v in 0.1.0 0.1.1; do
  node -e 'const fs=require("fs");const [v,E]=process.argv.slice(1);fs.writeFileSync(`${E}/conf-${v}.json`,JSON.stringify({version:v,bundle:{createUpdaterArtifacts:true,targets:["appimage","deb"]},plugins:{updater:{pubkey:fs.readFileSync(`${E}/test.key.pub`,"utf8").trim(),endpoints:["http://127.0.0.1:8765/latest.json"],dangerousInsecureTransportProtocol:true}}}))' "$v" "$E"
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$E/test.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=e2e-pass \
    npx tauri build --config "$E/conf-$v.json" 2>&1 | tail -5
  cp target/release/bundle/appimage/*_"$v"_amd64.AppImage "$E/v${v//./}/app.AppImage"
  cp target/release/bundle/appimage/*_"$v"_amd64.AppImage.sig "$E/v${v//./}/app.AppImage.sig"
  cp target/release/bundle/deb/*_"$v"_amd64.deb "$E/v${v//./}/app.deb"
done
ls -l "$E"/v010 "$E"/v011
```
Expected: each folder has `app.AppImage`, `app.AppImage.sig` and `app.deb`. Then delete the throwaway bundles so they can't be mistaken for release builds: `rm -rf target/release/bundle`.

- [ ] **Step 3: Serve a 0.1.1 manifest.**

```bash
cp "$E/v011/app.AppImage" "$E/serve/app-0.1.1.AppImage"
node -e 'const fs=require("fs");const E=process.argv[1];fs.writeFileSync(E+"/serve/latest.json",JSON.stringify({version:"0.1.1",notes:"E2E test release\n<b>not bold</b>",pub_date:new Date().toISOString(),platforms:{"linux-x86_64-appimage":{url:"http://127.0.0.1:8765/app-0.1.1.AppImage",signature:fs.readFileSync(E+"/v011/app.AppImage.sig","utf8").trim()}}}))' "$E"
python3 -m http.server 8765 --bind 127.0.0.1 -d "$E/serve" > "$E/http.log" 2>&1 &
```
Run this server in the background with `run_in_background`, and stop it at the end of the task.

- [ ] **Step 4: Run 0.1.0, isolated, and follow the whole flow.**

```bash
cp "$E/v010/app.AppImage" "$E/run/TableProMax.AppImage"; chmod +x "$E/run/TableProMax.AppImage"
sha256sum "$E"/v010/app.AppImage "$E"/v011/app.AppImage
env -u XDG_RUNTIME_DIR DISPLAY=:99 HOME="$E/data" XDG_DATA_HOME="$E/data/share" XDG_CONFIG_HOME="$E/data/config" \
  XDG_CACHE_HOME="$E/data/cache" DBUS_SESSION_BUS_ADDRESS="unix:path=$E/no-bus" APPIMAGE_EXTRACT_AND_RUN=1 \
  TPM_UPDATE_ENDPOINT=http://127.0.0.1:8765/latest.json "$E/run/TableProMax.AppImage" > "$E/app.log" 2>&1 &
```
Use `$S/e2e/shot.sh` for screenshots and `$S/e2e/xinput.py` to click (key names are X keysyms such as `Control_L`). Check, with a screenshot of each:
  1. The dialog "Check for updates automatically?" appears. Click **Check automatically**.
  2. The banner says "Table Pro Max 0.1.1 is available." **What's new** shows `<b>not bold</b>` literally.
  3. `$E/http.log` shows exactly one `GET /latest.json` and nothing else.
  4. Click **Update now**. The app restarts, and `sha256sum "$E/run/TableProMax.AppImage"` equals the 0.1.1 hash.
  5. After the restart, Settings › Updates shows "Version 0.1.1". There's no first-run dialog, because the answer was saved.

- [ ] **Step 5: Tampered update is refused.**
  1. Stop the app, then restore 0.1.0 into `$E/run`. Make the next start check again: start the app, then turn the switch off and on in Settings. Or delete `$E/data/share/dev.tablepromax.app/app.db` and answer the dialog again.
  2. Flip one byte of the served file: `printf '\x00' | dd of="$E/serve/app-0.1.1.AppImage" bs=1 seek=4096 conv=notrunc`.
  3. Click Update now.

  Expected: the banner shows "The update could not be verified, so nothing was installed", and the AppImage hash is still the 0.1.0 hash.

- [ ] **Step 6: Version mismatch is refused.**
  1. Restore the untampered file.
  2. Rewrite `latest.json` with `"version":"0.1.2"`, keeping the 0.1.1 file and signature.
  3. Update now.

  Expected: refused with the same "could not be verified" message (`SignedVersionMismatch`), and the hash is unchanged.

- [ ] **Step 7: The install kind is detected for `.deb`.** Extract `$E/v010/app.deb` with `dpkg-deb -x` and run its `usr/bin/table-pro-max` with the same isolation env. Expected: the banner shows **Update now**, not **Download**, so `installKind` is `deb`. Don't run the update: it would call pkexec and `dpkg` as root.

- [ ] **Step 8: Clean up.** Stop the app and the HTTP server. Delete `$E/test.key`, `$E/test.key.pub` and the built AppImages, and run `rm -rf target/release/bundle`. Record the results (pass/fail per step, with the hashes) for Task 9.

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/SECURITY_MODEL.md`, `docs/DECISIONS.md`, `docs/FEATURE_MATRIX.md`, `docs/DEPENDENCY_LICENSES.md`, `docs/RELEASING.md`, `docs/TESTING_STRATEGY.md`, `docs/releases/v0.1.0.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: `CLAUDE.md`.** In "Rules that matter here", change the first bullet to:

```markdown
- Never add feature gates, license checks, telemetry or network calls other than to user
  databases, the user-configured AI endpoint (`ai.rs`; off by default, every request
  previewed, never auto-executes SQL) and the update check (`commands/update.rs`; asks
  before checking automatically, installs only signed updates after a click).
```

- [ ] **Step 2: README.** Make three changes:
  - In the privacy bullet, add: ", and GitHub for update checks if you allow them".
  - Add an "Updates" paragraph under Install: the app asks once whether to check daily, shows a banner when a new version exists, and installs it after you click Update now. On `.deb`/`.rpm` your system asks for your password. Updates are verified with the project's signing key.
  - Update the keyboard/feature text only if it's affected.

- [ ] **Step 3: SECURITY_MODEL.** Add:
  - **A data-sharing row:** update check → GitHub → IP address and user agent (`tauri-plugin-updater/<version>`) → only with consent or "Check now".
  - **Residual risks:**
    - GitHub learns that the IP address runs the app.
    - If the signing key is lost, existing installs can't verify updates, and everyone must reinstall once.
    - If the key leaks, an attacker who can also serve the manifest could push an update until the key is rotated.
    - `.deb`/`.rpm` installs run the system package manager as root after the password prompt; the signature is checked first.
    - Windows and macOS installers aren't code-signed, which is separate from update signing.

- [ ] **Step 4: DECISIONS.** Add D15 "In-app updates through tauri-plugin-updater". It covers:
  - the context: users want updates without visiting GitHub;
  - the decision: the official plugin, called from Rust commands only, with the GitHub `releases/latest` manifest, asking once before checking, an explicit click to install, `requireSignedVersion` and no downgrades;
  - the rejected alternatives: our own updater, background downloads, package-manager-only;
  - the consequences: key custody, and the network rule extension.

- [ ] **Step 5: FEATURE_MATRIX.** Add an "Updates" section with these rows:
  - **Consent and daily check:** VERIFIED (Task 2, 5 tests and Task 8 step 4).
  - **Banner, notes as text, pending-edit warning:** VERIFIED (Task 5 tests and Task 8).
  - **Signature and version checks:** VERIFIED (Task 8 steps 5–6).
  - **AppImage self-update:** VERIFIED (Task 8 step 4).
  - **`.deb`/`.rpm` install through pkexec:** IMPLEMENTED (detection verified, install not run here).
  - **Windows NSIS/MSI and macOS app updates:** IMPLEMENTED (not yet run on real machines).
  - **Release pipeline (signed files, latest.json):** IMPLEMENTED until the first tagged release succeeds; then VERIFIED, with the run id.

- [ ] **Step 6: DEPENDENCY_LICENSES.** Add `tauri-plugin-updater` 2.13.3 and `tauri-plugin-opener` 2.7.1, both MIT OR Apache-2.0.

- [ ] **Step 7: RELEASING.** Add a "Signing key" section:
  - the two secrets and where the key lives (`~/.tauri/table-pro-max.key` and the password manager);
  - **key loss:** generate a new key, put its public key in `tauri.conf.json`, publish a release, and tell users to reinstall manually once;
  - **key leak:** rotate the key the same way and delete the old secret.

  Then update the checklist:
  - the draft must contain `latest.json` and a `.sig` for each updater file;
  - publishing a plain tag pushes the update to everyone who allowed checks;
  - test builds use `-rc.N` tags, which stay pre-releases.

- [ ] **Step 8: TESTING_STRATEGY and ARCHITECTURE.**
  - TESTING_STRATEGY: describe the update tests (unit tests, the manifest script, the UI) and the Task 8 manual procedure.
  - ARCHITECTURE: add `updates.rs` and `commands/update.rs`, plus a short "Updates" data-flow paragraph.

- [ ] **Step 9: Release notes for v0.1.0.** In `docs/releases/v0.1.0.md`, add a bullet "**Updates:** the app can check for new versions (it asks first) and install them in one click; updates are verified with the project's signing key." Also remove "the Windows and macOS installers are built and checked in CI, but nobody has launched them" only if that's no longer true; otherwise keep it.

- [ ] **Step 10: Commit.**

```bash
git add CLAUDE.md README.md docs
git commit -m "Docs: in-app updates (rules, security model, D15, matrix, releasing)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Ship (each outward-facing step needs the maintainer's go-ahead)

- [ ] **Step 1: Full local verification.**

```bash
cargo fmt --all -- --check && cargo clippy -p tpm-core --all-targets -- -D warnings && cargo test -p tpm-core
source $S/sysroot/env.sh && cargo clippy -p table-pro-max --all-targets -- -D warnings && cargo test -p table-pro-max --lib
npm run typecheck && npm run lint && npm test && npm run build
$S/tools/bin/cargo-audit audit && npm audit --omit=dev
```
Expected: all pass.

- [ ] **Step 2: Push the branch and open a PR.** First check with the maintainer that pushing is fine. Then:
  - Run `git push -u origin feat/in-app-updates`.
  - Open the PR with `gh pr create`, with a summary, the testing evidence from Task 8, and the 🤖 footer.

- [ ] **Step 3: Wait for CI.** Then the maintainer merges (or approves the merge).

- [ ] **Step 4: Re-cut v0.1.0 so it ships with the updater.** Get the maintainer's go-ahead before running anything:
  1. Delete the unpublished draft and tag: `gh release delete v0.1.0 --yes && git push origin :refs/tags/v0.1.0 && git tag -d v0.1.0`.
  2. Tag the merge commit: `git tag -a v0.1.0 <merge-sha> -m "Table Pro Max 0.1.0" && git push origin v0.1.0`. The commit message must not contain `[skip ci]`.

- [ ] **Step 5: Check the draft.** It must contain `latest.json`, a `.sig` for the AppImage, deb, rpm, setup.exe, msi and app.tar.gz, plus `SHA256SUMS`, and it must not be marked pre-release. Run `gh release download v0.1.0 -p latest.json -D $S/rel-check` and confirm with `jq` that there are 9 platform keys and every URL contains `/download/v0.1.0/`.

- [ ] **Step 6: The maintainer publishes the draft.** Then, after publishing, check `curl -sIL https://github.com/ayush-eubrics01/table-pro-max/releases/latest/download/latest.json | grep -i '^http'`. Expected: it ends in `200`.

- [ ] **Step 7: Update the feature matrix.** Set the release pipeline row to VERIFIED with the run id. Commit on a docs-only branch and PR, which skips CI.
