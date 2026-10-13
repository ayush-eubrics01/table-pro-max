# In-app updates: design

Date: 2026-10-13. Status: approved in conversation, awaiting written-spec review.

## Goal
When a maintainer publishes a new release on GitHub, people running Table Pro Max learn about it
inside the app and can install it with one click, without visiting GitHub.

Success means:
- After a release is published, an app that allows automatic checks shows the new version within
  a day of its next start. Any app shows it after "Check now".
- "Update now" downloads the update, checks its signature, installs it and restarts into the new
  version, on every format that can install updates in place.
- Only files signed with the project's key are ever installed. An older signed release is
  refused even if a tampered manifest offers it.
- Nothing goes to the network until the user agrees, except when they click "Check now".

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| When to check | Ask once on first launch. If yes, check at startup at most once every 24 hours. "Check now" in Settings always works. |
| How to install | Show a banner. Install only after the user clicks "Update now". Never download in the background. |
| Channel | Every published release is an update. Tags with a suffix (`v0.2.0-rc.1`) stay pre-releases and are never offered. |
| Signing key | The maintainer generates it and stores it in GitHub secrets with three commands. The private key and password never pass through an AI session. |
| Mechanism | Official `tauri-plugin-updater` 2.13.3, called from our Rust commands only. The webview gets no updater permissions. |

## Non-goals
- Background or silent downloads, forced updates, or minimum-version enforcement.
- Beta channels, staged rollouts, or delta updates.
- Package-manager distribution (apt repository, winget, Homebrew). These can come later.
- Code signing for Windows and macOS. That is separate from update signing, and stays on the roadmap.
- macOS Intel builds.

## How it works

```
Maintainer publishes release vX.Y.Z on GitHub
  │  release.yml signed every updater-capable bundle and attached latest.json
  ▼
App start ── updates.auto == "on" and last check older than 24 h? ── no ──▶ nothing sent
  │ yes                                     (or the user clicked "Check now")
  ▼
GET https://github.com/ayush-eubrics01/table-pro-max/releases/latest/download/latest.json
  │ manifest version newer than the running one?
  ▼
Banner: "Table Pro Max X.Y.Z is available"  [What's new] [Update now] [Later]
  │ Update now (asks first if any table tab has uncommitted grid edits)
  ▼
Download the file for this install type → verify the minisign signature with the embedded public
key, and the signed version against the announced one → install → restart into X.Y.Z
```

`releases/latest` only resolves to published, non-pre-release releases. Drafts are invisible to
users, so clicking **Publish** on the draft is what pushes the update.

### Install types
The plugin reads the bundle type that Tauri embeds in the binary and picks the matching manifest
entry, `{os}-{arch}-{bundle_type}`, falling back to `{os}-{arch}`.

| Installed from | Manifest key | How the plugin installs it |
|---|---|---|
| AppImage | `linux-x86_64-appimage` | Replaces the AppImage file in place. |
| `.deb` | `linux-x86_64-deb` | `dpkg -i` through `pkexec`, so the system asks for the user's password. If there's no polkit agent, it tries a zenity password prompt with `sudo`. |
| `.rpm` | `linux-x86_64-rpm` | `rpm -U` the same way. |
| Windows `setup.exe` | `windows-x86_64-nsis` | Runs the NSIS installer in passive mode, which shows progress and asks nothing. |
| Windows `.msi` | `windows-x86_64-msi` | `msiexec` in passive mode. |
| macOS `.dmg` / `.app` | `darwin-aarch64-app` | Replaces the `.app` bundle from the signed `.app.tar.gz`. |
| Unknown, e.g. a binary built from source | none | Can't install. The banner offers **Download**, which opens the release page. |

If installing fails, for example because the password prompt was cancelled or the app folder
isn't writable, the banner shows the error and offers **Download** as the fallback.

## Components

### Backend: `src-tauri/src/commands/update.rs` (new)
State: `AppState.update: Mutex<Option<tauri_plugin_updater::Update>>` holds the update found by
the last check. `AppState.update_jobs` holds a cancellation token per running download.

Commands, all returning `Result<_, AppError>`:
- **`update_status() -> UpdateStatus`**
  - `{ currentVersion, auto: "ask" | "on" | "off", lastCheck: i64 (ms, 0 = never), installKind: "appimage" | "deb" | "rpm" | "nsis" | "msi" | "app" | "unknown", canInstall: bool }`.
- **`update_check(manual: bool) -> UpdateCheck`**
  - Returns `{ available: Option<{ version, date, notes }>, skipped: bool }`.
  - When `manual` is false, it refuses with `InvalidConfig` ("automatic update checks are off") unless `updates.auto == "on"`.
  - When `manual` is false and the last check was less than 24 h ago, it returns `skipped: true` without a network call.
  - Every completed check, manual or automatic, records `updates.lastCheck`.
  - The decision is a pure function, `auto_check_due(auto, last_check, now) -> Decision`, so it can be unit-tested.
- **`update_install(job_id)`**
  - Downloads the update with progress events (`update-progress`: `{ jobId, downloaded, total }`), verifies it, installs it, then calls `app.restart()`. The NSIS and MSI installers close the app on Windows themselves.
  - It fails if no update is pending.
  - The download runs under `tokio::select!` with the job's cancellation token.
- **`update_cancel(job_id)`**
  - Cancels a download in progress. Once installing has begun, it can no longer be cancelled.
- **`update_open_release_page(version)`**
  - Accepts only a semver string, and opens `https://github.com/ayush-eubrics01/table-pro-max/releases/tag/v{version}`.
  - It uses the Rust API of `tauri-plugin-opener` and grants no opener permission to the webview.

Plugin setup in `lib.rs`: `tauri_plugin_updater::Builder::new().build()`. If the environment
variable `TPM_UPDATE_ENDPOINT` is set, the backend uses it as the only endpoint. Tests use this
to point at a local server. It doesn't weaken anything: the signature check against the embedded
key still applies, and release builds keep HTTPS mandatory.

Logging records only the outcome: checked, up to date or version found, installed, failed with
an error kind. Logs never contain URLs with query strings, file paths in the user's home folder,
or the notes.

### Configuration
In `tauri.conf.json`:
```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/ayush-eubrics01/table-pro-max/releases/latest/download/latest.json"],
    "pubkey": "<contents of table-pro-max.key.pub>",
    "requireSignedVersion": true,
    "windows": { "installMode": "passive" }
  }
}
```
- `bundle.createUpdaterArtifacts` stays off in the checked-in config. The release workflow turns
  it on with `--config`, so pull-request and CI builds need no secrets.
- `dangerousInsecureTransportProtocol` is never set in the checked-in config. The local
  end-to-end test sets it through `--config` on throwaway builds only. `release.yml` asserts it is
  absent.

### Settings
Two new keys go in the existing settings store, which the backend reads like `ai.enabled`:
- **`updates.auto`:** `"ask"`, `"on"` or `"off"`. The default is `"ask"`, and resetting settings returns it to `"ask"`.
- **`updates.lastCheck`:** a number in milliseconds, `0` for never. Only the backend writes it.

### Frontend
- **`src/features/updates/useUpdates.ts`:** a zustand store with the status, the available update, the banner state (hidden, shown, downloading with %, installing, error) and the actions.
  - On app start, after settings load, it calls `update_check(false)`, but only if `updates.auto == "on"`.
- **`FirstRunUpdatePrompt.tsx`:** shown once at startup when `updates.auto == "ask"`.
  > **Check for updates automatically?**
  > Table Pro Max can check GitHub once a day for a new version. GitHub sees your IP address and
  > that you use the app; nothing about your databases or queries is sent.
  > [Check automatically] [Don't check]

  Either answer is saved. Closing the dialog leaves `"ask"`, so it's asked again next launch.
- **`UpdateBanner.tsx`:** sits under the tab bar in the main window only.
  - Buttons: [What's new] [Update now] (or [Download] when `canInstall` is false) [Later].
  - The notes are rendered as plain text, never as HTML.
  - *Later* hides the banner until the next launch.
  - Progress shows "Downloading 42 %" with a Cancel button, then "Installing…" and "Restarting…".
- **Pending edits guard:** `TableView` registers whether it has uncommitted grid edits in a small
  shared store, `usePendingEdits`. "Update now" asks "N tables have uncommitted changes. They will
  be lost. Update anyway?" before it starts. The workspace snapshot, including unsaved query
  text, is saved right before installing, and restored after the restart.
- **Settings › Updates:**
  - the current version;
  - a "Check for updates automatically" switch, which sets `on`/`off`;
  - a [Check now] button, with the result shown inline (up to date, version available, or the error);
  - "Last checked: …".

### Dependencies
- `tauri-plugin-updater = { version = "2.13.3", default-features = false, features = ["rustls-tls", "zip"] }`
  - It uses rustls with ring, matching the rest of the app, so there's still no OpenSSL.
  - The `system-proxy` feature is dropped. The rest of the app doesn't read system proxies either, so behaviour stays consistent.
- `tauri-plugin-opener = "2"`: Rust API only, with no capability added.
- No JavaScript plugin packages: the frontend talks to our own commands.
- Licenses: MIT/Apache-2.0. Both get added to `docs/DEPENDENCY_LICENSES.md`, and `cargo audit` must stay clean.

## Release pipeline (`release.yml`)
1. **Secrets check.** The job fails with a clear message if `TAURI_SIGNING_PRIVATE_KEY` is missing. The password secret may be empty only if the key has no password.
2. **Build.** `npx tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'` runs with both secrets in the environment, on every OS.
3. **Collect.** The existing installers are collected as before. The workflow also collects the updater files and their `.sig` files, renamed to the same lowercase pattern:
   - Linux: `.AppImage`, `.deb`, `.rpm`, each with a `.sig`. The installers themselves are the update files.
   - Windows: `-setup.exe` and `.msi`, each with a `.sig`.
   - macOS: `table-pro-max_X.Y.Z_aarch64.app.tar.gz` with its `.sig`.
4. **Manifest.** `scripts/updater-manifest.mjs` builds `latest.json` from the collected files.
   - **Inputs:** version, tag, repo and notes file.
   - **Contents:** `version`, `notes` (from `docs/releases/vX.Y.Z.md`), `pub_date`, and under `platforms` one `{ url, signature }` per key from the install-types table, plus the fallback keys `linux-x86_64` (AppImage), `windows-x86_64` (NSIS) and `darwin-aarch64` (app).
   - **URLs** point to `releases/download/vX.Y.Z/<file>`.
   - **It fails** if any expected file or signature is missing.
5. **Draft.** `latest.json` and `SHA256SUMS` are attached to the draft, together with the files. The pre-release flag is set only for versions containing `-`.

`docs/RELEASING.md` gains a section on:
- the signing secrets;
- backing up the key;
- what losing the key means: existing installs can't verify new updates, so everyone must reinstall once from a release signed with a new key;
- what leaking the key means: rotate the key, ship a release with the new public key, and remove the leaked secret.

## Privacy and security
- **Only one new network request.** It's a GET for a public file on github.com, made only after the user agreed, or when they click "Check now". The download goes to the GitHub release asset host. The user agent is the plugin's (`tauri-plugin-updater/2.13.3`); no app version or identifiers are added.
- **Signatures and versions are always checked.** The plugin verifies the minisign signature with the embedded public key and refuses a version mismatch (`requireSignedVersion`). It also refuses anything not newer than the running version.
- **Root access only after a prompt.** `.deb` and `.rpm` installs need root, which the user grants through the system password prompt. The plugin only runs this after the signature check.
- **Docs to update:**
  - `CLAUDE.md`: the network rule is extended to "the update check (`commands/update.rs`; asks first; signed updates only)".
  - README privacy line and install section.
  - `SECURITY_MODEL.md`: a data-sharing row and residual risks (GitHub sees IP addresses; key loss or leak; root install for deb/rpm).
  - `DECISIONS.md`: D15.

## Error handling
| Situation | Behaviour |
|---|---|
| Automatic check fails (offline, GitHub down, malformed manifest) | Logged at info level. Nothing is shown. The next attempt happens on the next start, at most every 24 h. |
| "Check now" fails | Error shown inline in Settings, using the `AppError` message. |
| Signature invalid, signed version mismatch, or not newer | Install refused. The banner says the update could not be verified and nothing was changed, and offers **Download**. |
| Download cancelled | The banner returns to "available". Nothing is installed. |
| Install fails (password prompt cancelled, permission denied) | Error in the banner, with **Download** as the fallback. The current version keeps running. |
| No matching platform in the manifest | Treated as "up to date". Logged. |

## Testing
**Automated tests:**
- **Rust unit tests:**
  - `auto_check_due`: every `auto` value, never checked, under and over 24 h, and clock skew where the last check is in the future;
  - semver validation for `update_open_release_page`;
  - the mapping from install kind to `canInstall`.
- **Manifest script (vitest):** builds every platform key and the fallbacks; fails on a missing `.sig`; URLs use the tag; the notes are read verbatim; and the version must match the tag. Vitest's `include` is extended to `scripts/**/*.test.mjs`.
- **Frontend (vitest):**
  - the first-run prompt shows only for `"ask"` and saves the answer;
  - no automatic check unless `"on"`;
  - banner state transitions;
  - "Update now" asks first when there are pending edits;
  - Download is shown when `canInstall` is false.

**Manual end-to-end test (Linux, Xvfb, scratch data folders, no access to the keyring):**
1. Generate a throwaway key. It's never the real one.
2. Build AppImage 0.1.0 and 0.1.1 with it, using the throwaway public key, the local endpoint and the insecure-transport flag through `--config`.
3. Serve the 0.1.1 manifest and file from `127.0.0.1`.
4. Run 0.1.0 and walk through: first-run prompt → automatic check → banner → Update now → the app restarts and reports 0.1.1.
5. Repeat with one byte of the update changed: refused, still on 0.1.0.
6. Repeat with a manifest that announces 0.1.2 for the 0.1.1 file: refused because of the version mismatch.
7. Also build a `.deb` 0.1.0 and check that the banner shows install, not download. The actual `dpkg` install isn't run here: it needs root on the dev machine.

**Not testable here:** installing on Windows and macOS, and the pkexec path for `.deb`/`.rpm`. These get exercised first with real releases, and the feature matrix records them as IMPLEMENTED, not VERIFIED.

## Rollout
1. Implement on `feat/in-app-updates`; CI must pass.
2. The maintainer runs the three key commands; the public key is committed to `tauri.conf.json`.
3. Merge. Delete the unpublished `v0.1.0` draft and tag, and re-tag so 0.1.0 ships with the updater.
4. Check the draft has `latest.json`, every `.sig` file and the manifest contents. The maintainer publishes.
5. After publishing, check that an installed 0.1.0 runs "Check now" and reports "up to date". The first real update is exercised by 0.1.1.
