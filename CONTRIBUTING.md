# Contributing

Thanks for helping. This page is the whole workflow: how to branch, open a pull request, get it
merged, and how releases happen. Read `CLAUDE.md` for the project rules (privacy, security,
testing) before changing behaviour.

## The model in one picture

```
main  ──●───────●────────●──────────●─────────●──►   always releasable, protected
         \     /  \     /  \       /           │
 feat/…   ●──●     ●──●     ●─────●            └─ tag v0.2.0 → draft release → publish
          design/…   perf/…     fix/…
```

- **`main` is the only long-lived branch.** Every commit on it builds, passes CI and could be
  released.
- **All work happens on short branches from `main`** and comes back through a pull request.
  Nobody pushes to `main` directly.
- **Pull requests are squash-merged.** Each one becomes a single commit on `main`, named after
  the PR title.

## Branches

Name the branch after the kind of work, then a few words:

| Prefix | For | Example |
|---|---|---|
| `feat/` | New features | `feat/query-parameters` |
| `fix/` | Bug fixes | `fix/grid-copy-null` |
| `design/` | Visual and UX changes | `design/connection-list` |
| `perf/` | Speed and memory work | `perf/grid-scroll` |
| `docs/` | Documentation only | `docs/adapters` |
| `ci/` | Workflows and build | `ci/cache-cargo` |
| `chore/` | Dependency bumps, cleanup | `chore/bump-tauri` |
| `release/x.y` | Only for a hotfix to an older release (see below) | `release/0.2` |

Several people can work at once because each change lives on its own branch:

- **Keep branches short-lived:** days, not weeks. Split a big feature into PRs that each leave
  `main` working. Unfinished screens stay unreachable in the UI until the last PR connects them.
- **Open a draft PR early** for anything larger, so others can see what is in flight and avoid
  doing it twice.
- **Rebase on `main` before asking for a merge** if `main` moved (`git fetch && git rebase
  origin/main`). Design work tends to touch `src/styles/tokens.css` and `app.css`, so two design
  branches are likely to conflict; whoever merges second rebases.

## Pull requests

1. Branch from an up-to-date `main`: `git switch main && git pull && git switch -c feat/my-change`.
2. Commit as often as you like; the history of your branch is squashed away.
3. Push and open a PR. The PR title becomes the commit on `main`, so write it as
   `type: what changed`, for example `feat: query parameters in the SQL editor` or
   `perf: render only visible grid cells`. Types: `feat`, `fix`, `design`, `perf`, `docs`, `ci`,
   `chore`, `refactor`, `test`.
4. Fill in the template: what changed, how you tested it, and screenshots for UI changes or
   before/after numbers (`cargo run -p tpm-core --example bench --release`) for performance.
5. Wait for **CI passed** to go green, then squash-merge. The branch is deleted automatically.

### What CI runs

| Event | Runs | Typical time |
|---|---|---|
| Pull request | Rust core (with real databases), frontend, dependency audit, desktop app compiled and linted on Linux | about 10 minutes |
| PR labelled `full-ci` | The above on all three platforms, plus Windows, macOS and Linux installers attached to the run | about 50 minutes |
| Push to `main` (every merge) | Everything, desktop app compiled and linted on Linux, Windows and macOS (no installers) | about 15 minutes |
| Release tag (`v*`) | Signed installers for all three platforms in a draft release (`release.yml`) | about 35 minutes |
| Only docs, Markdown or LICENSE changed | Nothing but the "CI passed" check, which passes straight away | seconds |

Only `main` saves build caches; pull requests reuse them, so the first run after a dependency
change is slower.

Add the `full-ci` label when a PR touches anything platform-specific (`src-tauri/`, credential
stores, file paths, installers, the release workflow), or when someone wants to download and try
the PR as an installer. Never put `[skip ci]` in a PR title: the
required check would never report and the PR could not merge.

### Rules on `main`

- Changes arrive only through pull requests, and **CI passed** must be green.
- Squash merge only, linear history, no force pushes, no deleting the branch.
- The maintainer can override in an emergency; that should be rare and explained in the PR.

## Releasing

Releases are cut from `main` with a tag. Details and the signing key are in
[docs/RELEASING.md](docs/RELEASING.md).

1. Open a PR (`chore: release 0.2.0`) that runs `node scripts/bump-version.mjs 0.2.0` (it sets the
   version in every file that declares it) and adds `docs/releases/v0.2.0.md`. Merge it.
2. Tag the merge commit and push the tag:
   `git switch main && git pull && git tag -a v0.2.0 -m "Table Pro Max 0.2.0" && git push origin v0.2.0`.
3. The release workflow builds and signs all three platforms and creates a draft release. Check
   it, then publish. Installed apps that allow update checks offer it from then on.

**Version numbers** follow `MAJOR.MINOR.PATCH`. While below 1.0, raise the middle number for new
features and the last for fixes only.

**Trying a release first:** tag `v0.2.0-rc.1` (after bumping to that version). It builds
everything and is marked as a pre-release, so the in-app updater never offers it.

**Hotfix when `main` already has unreleased work:**

```
v0.2.0 ──► release/0.2 ──● fix ──► tag v0.2.1
              (from the tag)    (the same fix also goes to main through a normal PR)
```

1. `git switch -c release/0.2 v0.2.0` and push it.
2. Open a PR into `release/0.2` with the fix (bump to 0.2.1 and add the release notes in it).
3. Merge, tag `v0.2.1` on `release/0.2`, publish.
4. Make sure the fix also reaches `main`.

If `main` has nothing unreleased, skip all that: fix on `main` and release 0.2.1 from there.

## Local checks before pushing

```sh
cargo fmt --all && cargo clippy --workspace --all-targets
cargo test -p tpm-core
npm run typecheck && npm run lint && npm test
```

Database integration tests need the disposable containers: see the README's Tests section.
