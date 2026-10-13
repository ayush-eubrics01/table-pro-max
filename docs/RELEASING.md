# Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow
builds unsigned installers on Linux, Windows and macOS, writes `SHA256SUMS`, and attaches
everything to a **draft** release. A maintainer publishes the draft by hand after checking it.
Versions `0.x` and versions with a suffix (`1.2.0-rc.1`) are marked as pre-releases.

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
   - at least the Linux package installs and starts; note any platform nobody launched;
   - the notes read correctly.
8. Publish the draft. To abandon a release, delete the draft and the tag
   (`git push origin :refs/tags/vX.Y.Z`), fix the problem, and tag again.

## Not done yet
- Code signing (Windows Authenticode, Apple Developer ID and notarization). Until then, users
  see SmartScreen and Gatekeeper warnings; the README explains how to get past them.
- Auto-update. If it is added, updates must be signed and the app must only contact the update
  endpoint when the user enables it.
- Reproducible builds.
