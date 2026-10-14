# Design revamp PR 7b (remaining screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish phase 1. Selects lose their native GTK look everywhere, the Redis key browser gets the workspace sidebar's style, and the dashboard toolbar uses the shared access pill.

**Architecture:** CSS and markup only. Each screen was screenshotted first (`target/tpm-scratch/shots/before7b-*.png`):
- **Already consistent:** export, import, the dashboard dialogs and the widget editor. They use the shared dialog, field and table styles from PRs 1–5.
- **DuckDB:** it opens through the connection form (file engine, restyled in PR 3), so it needs no change.

What remains: native-looking `<select>`s (WebKitGTK draws them as GTK widgets because nothing sets `appearance: none`), the Redis sidebar, and one dashboard label.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, row "Not in the design": "restyled with the same components and tokens". This is the second half of the spec's PR 7 (7a was #16).

## Global Constraints
- **No behaviour changes.** These accessible names stay: "Key pattern", "Scan keys", "New string key", "Keys", "Reload key", "Set expiry", "Delete key".
- **Tokens only;** no `color-mix()`.
- **Code style:** about 160-column lines. Node 24.

## Review Focus
1. **Selects** keep a visible arrow in both themes, at every size used (32 px fields, the 26 px grid footer, segmented-like toolbars). The text never runs under the arrow (Task 1 screenshot).
2. **Focus ring on selects** still shows (the PR 1 focus rule) after `appearance: none` (Task 1 test).
3. **Redis read-only session:** no "New string key" button (Task 2 test).
4. **Long Redis key names** ellipsize in the list and in the header (Task 2 screenshot).
5. **Light theme:** the select arrow colour meets 3:1 against the field background (`--text-muted` on `--bg`, already checked at 4.5).

---

### Task 1: Selects without the native look

**Files:** Modify `src/styles/app.css` (the `.select` rule). Test: add to `scripts/theme-check.test.mjs`.

- [ ] **Step 1: Failing test.** In `scripts/theme-check.test.mjs`, add next to the other app.css checks:

```js
  it("draws selects itself: no native look, a token-coloured arrow, room for it", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const rule = app.match(/\n\.select \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/appearance:\s*none/);
    expect(rule).toMatch(/background-image:[^;]*var\(--text-muted\)/);
    expect(rule).toMatch(/padding-right:\s*30px/);
  });
```

- [ ] **Step 2: Run.** `npx vitest run scripts/theme-check.test.mjs`. Expected: FAIL (no standalone `.select {` rule).
- [ ] **Step 3: Implement.** After the shared `.input, .select, .textarea` rules, add a standalone rule:

```css
.select {
  appearance: none;
  padding-right: 30px;
  background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%), linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
  text-overflow: ellipsis;
}
```

Shorthand `background` declarations elsewhere would reset the arrow: `grep -n "\.select" src/styles/app.css` and change any `background:` on a `.select` selector to `background-color:`.

- [ ] **Step 4: Run.** `npx vitest run scripts`. Expected: PASS.
- [ ] **Step 5: Commit** `design: selects drawn by the app, not the toolkit`.

---

### Task 2: Redis key browser and dashboard toolbar

**Files:** Modify `src/features/redis/RedisView.tsx` (sidebar head), `src/features/dashboards/DashboardView.tsx` (access pill), `src/styles/app.css`. Create `src/features/redis/RedisView.test.tsx`.

- [ ] **Step 1: Failing test** (`RedisView.test.tsx`). Before writing, read `RedisView`'s props and the scan, get and info IPC commands it calls (`src/lib/ipc.ts`). Build a minimal workspace fixture of `kind: "redis"` (see `useWorkspaces.openRedis` for the shape), and mock the scan to return three keys. Then assert:
  - `screen.getByLabelText("Key pattern").closest(".sidebar-filter")` is not null;
  - `await screen.findByText("3 keys")` is in the document;
  - each key's type badge renders (`STR`, `LIST`, `HASH`);
  - with `session.readOnly` (or whatever the view reads as `readOnly`) set to true, the button "New string key" is absent.
- [ ] **Step 2: Run.** `npx vitest run src/features/redis`. Expected: FAIL (no `.sidebar-filter`, text "3 keys loaded").
- [ ] **Step 3: Implement.**
  - **RedisView sidebar head.** Use the PR 4 structure: `<div className="sidebar-head"><div className="sidebar-filter"><Icon name="search" size={15} /><input className="input mono" aria-label="Key pattern" …/></div><div className="redis-keys-meta"><span>{n} keys{more ? " · more available" : ""}</span><span className="grow" />{scan button}{new key button}</div></div>`. Keep both buttons' labels and handlers.
  - **Key rows.** Drop the inline `style` on the key buttons and the badge, and add the class `redis-key` to the row.
  - **DashboardView.** Replace `<span className="meta">Read-only session</span>` with `<span className="access-pill ro" title="Dashboard queries run in a read-only session"><Icon name="lock" size={13} /> Read-only</span>`.
  - **CSS.** Add:
    - `.redis-keys-meta`: flex, centered, `gap: 2px`, `font-size: var(--text-xs)`, `color: var(--text-muted)`, `padding-left: 2px`; `.grow { flex: 1 }`.
    - `.tree-item.redis-key`: `padding-left: 8px`.
    - `.tree-item.redis-key .driver-mark`: `min-width: 40px`, `height: 18px`, `font-size: 10px`.
    - Make the Redis main toolbar match the table toolbar: check that `.redis .toolbar` inherits `.toolbar`.
- [ ] **Step 4: Run.** `npx vitest run src/features/redis src/features/dashboards && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `design: Redis key browser uses the workspace sidebar style; dashboard shows the read-only pill`.

---

### Task 3: Screenshots and verification

- [ ] **Screenshots**, dark and light:
  - the export dialog, the widget editor and the grid footer (selects);
  - the Redis view, with three keys seeded into the disposable `tpm-test-redis` (db 15) and a long key name. Remove the keys afterwards.
  - the dashboard toolbar.
- [ ] **Verify:** `npm run typecheck && npm run lint && npm test && npm run build`.
- [ ] **Finish:** fresh whole-branch review, then the fix pass. Push and open the PR. Squash-merge after **CI passed**.
