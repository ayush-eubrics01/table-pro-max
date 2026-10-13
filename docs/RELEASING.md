# Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow
builds installers on Linux, Windows and macOS, signs the in-app update files with the project's
key, writes the update manifest `latest.json` and `SHA256SUMS`, and attaches everything to a
**draft** release. A maintainer publishes the draft by hand after checking it.

Publishing a release with a plain version (`v1.2.0`) makes it the "latest" release, and every
installed app that allows update checks will offer it. Versions with a suffix (`v1.2.0-rc.1`)
are marked as pre-releases and are never offered; use them to test a release build.

## Checklist
1. `main` is green in CI (core with integration tests, frontend, desktop builds, audit).
2. The version is the same in `Cargo.toml` (`[workspace.package]`), `package.json` and
   `src-tauri/tauri.conf.json`. The workflow stops if the tag does not match all three.
3. `docs/releases/vX.Y.Z.md` exists. The workflow uses it as the release notes and stops
   without it. Say what changed, what is unverified, and anything users must do.
4. `docs/FEATURE_MATRIX.md` statuses are current. Nothing is called VERIFIED without evidence.
5. `cargo audit` and `npm audit --omit=dev` pass. Any ignored advisory is explained in
   `docs/DECISIONS.md`.
6. Tag and push: `git tag -a vX.Y.Z -m "Table Pro Max X.Y.Z" && git push origin vX.Y.Z`.
   The tagged commit's message must not contain `[skip ci]` (or `[ci skip]`, `[no ci]`):
   GitHub applies it to the tag push too, and the release workflow silently does not start.
7. When the workflow finishes, open the draft release and check:
   - every installer is attached: `.deb`, `.rpm`, `.AppImage`, `.msi`, `-setup.exe`, `.dmg`,
     and `SHA256SUMS`;
   - `latest.json` is attached, and each updater file (`.AppImage`, `.deb`, `.rpm`, `.msi`,
     `-setup.exe`, `.app.tar.gz`) has its `.sig`;
   - at least the Linux package installs and starts; note any platform nobody launched;
   - the notes read correctly.
8. Publish the draft. To abandon a release, delete the draft and the tag
   (`git push origin :refs/tags/vX.Y.Z`), fix the problem, and tag again.

## Signing key
In-app updates are verified with a minisign key pair. The public key is in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private key and its password are
the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
the maintainer keeps the key file (`~/.tauri/table-pro-max.key`) and password in a password
manager. Never paste either into an issue, a log, a chat or a commit.

- **Key lost:** installed apps can no longer verify updates. Generate a new key
  (`npx tauri signer generate -w ~/.tauri/table-pro-max.key`), put the new public key in
  `tauri.conf.json`, update both secrets, publish a release, and tell users to reinstall it
  once by hand.
- **Key leaked:** do the same immediately, and delete the old secrets. Until users install the
  release with the new key, someone holding the old key who can also serve the manifest could
  push an update.

## Not done yet
- Code signing (Windows Authenticode, Apple Developer ID and notarization). Until then, users
  see SmartScreen and Gatekeeper warnings; the README explains how to get past them.
- Reproducible builds.
