# Design revamp PR 7a (Settings, palette, updates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the command palette (screen 07) and Settings (screen 08, with a left menu that includes Updates and AI assistant), and bring the update consent dialog and banner into the same style. No behaviour changes.

**Architecture:**
- **Palette.** Results are grouped by kind with a pure `groupResults()` function; keyboard order follows the displayed order. A footer shows the keys.
- **Settings.** It becomes a two-column dialog: a section menu and the content for one section at a time. Every existing setting is shown with a reusable `SettingRow` (label and description on the left, control on the right) and the existing store calls. `UpdateSettings` and `AiSettings` move into their own sections.
- **Updates UI.** The consent dialog and banner get CSS and markup touch-ups only.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, rows "Command palette" (grouped results, keyboard hints footer) and "Settings":
- left menu: General, Editor, Data grid, Safety, History, **Updates**, **AI assistant**, Shortcuts, About;
- existing settings only, each in the section that fits.

Delivery note: the spec's PR 7 is split for reviewability. This plan is 7a. PR 7b covers import/export, dashboards, Redis and DuckDB.

## Global Constraints
- **No new settings and no new palette items.** Every setting keeps its key, range and validation (`NumberField` min/max), and every palette item keeps its action.
- **Labels the update tests depend on stay exactly:**
  - "Check for updates automatically?";
  - "Check automatically", "Don't check";
  - "Update now", "Update anyway", "Download", "Later", "What's new", "Cancel", "Check now".
- **Tokens only;** no `color-mix()`.
- **Code style:** about 160-column lines; no formatter run on whole files. Node 24.

## Review Focus
1. **Palette keyboard.** ↓/↑/Enter walk the displayed (grouped) order, and Enter on the first row runs the first displayed item (Task 1 test).
2. **Number settings.** They still clamp on blur, and switching sections doesn't drop an unsaved draft without saving it: blur commits before the section changes (Task 2 test).
3. **"Reset to defaults"** still asks first and resets everything (Task 2 test).
4. **The About section** still states the network rule (databases, the AI service if allowed, GitHub for updates) and the data and log folders (Task 2 test).
5. **Long values** (data folder path, AI endpoint) wrap or ellipsize inside the content column and never widen the dialog (screenshot, Task 4).

---

### Task 1: Palette grouped results and footer

**Files:**
- Create: `src/features/command-palette/groups.ts`, `src/features/command-palette/groups.test.ts`
- Modify: `src/features/command-palette/OpenAnything.tsx`, `src/styles/app.css` (palette block)

**Interfaces:**
- Produces: `export const GROUPS = [["action", "Actions"], ["object", "Tables and views"], ["schema", "Schemas"], ["saved", "Saved queries"], ["connection", "Connections"]] as const;` and `export function groupResults<T extends { kind: string }>(items: T[]): { kind: string; title: string; items: T[] }[]`. It keeps rank order within each group, drops empty groups, and uses GROUPS order.

- [ ] **Step 1: Write the failing test** (`groups.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { groupResults } from "./groups";

describe("groupResults", () => {
  it("groups by kind in a fixed order, keeping rank order inside each group", () => {
    const items = [
      { kind: "connection", label: "c1" },
      { kind: "object", label: "o1" },
      { kind: "action", label: "a1" },
      { kind: "object", label: "o2" },
    ];
    const groups = groupResults(items);
    expect(groups.map((g) => g.title)).toEqual(["Actions", "Tables and views", "Connections"]);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(["o1", "o2"]);
    expect(groups.flatMap((g) => g.items).map((i) => i.label)).toEqual(["a1", "o1", "o2", "c1"]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run src/features/command-palette/groups.test.ts`. Expected: FAIL (cannot resolve `./groups`).

- [ ] **Step 3: Implement.**

`groups.ts`:

```ts
export const GROUPS = [
  ["action", "Actions"],
  ["object", "Tables and views"],
  ["schema", "Schemas"],
  ["saved", "Saved queries"],
  ["connection", "Connections"],
] as const;

/** Palette sections in a fixed order; items keep their rank order inside a section. */
export function groupResults<T extends { kind: string }>(items: T[]): { kind: string; title: string; items: T[] }[] {
  return GROUPS.map(([kind, title]) => ({ kind, title, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}
```

`OpenAnything.tsx`:
- After `results`, compute `const groups = useMemo(() => groupResults(results), [results]); const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);`.
- Use `flat` everywhere the code used `results` for the index and `choose`: ArrowDown bound `flat.length - 1`, Enter `choose(flat[index])`.
- Render one `<li role="presentation" className="palette-group">{g.title}</li>` before each group's options. Option ids stay `palette-${n}`, where `n` is the item's position in `flat`.
- Above the input, add a `.palette-search` row with `<Icon name="search" size={16} />` and an `<span className="kbd">Esc</span>`. Change the placeholder to "Jump to a table, run an action, switch connection…".
- After the list, add a footer: `<div className="palette-foot"><span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span><span><span className="kbd">↵</span> open</span><span><span className="kbd">Esc</span> close</span></div>`.
- Keep `aria-label="Open anything"` and the combobox wiring.

CSS. Replace the palette block's `.palette` through `.palette li .where` rules with rules for:
- `.palette` (width `min(640px, 92vw)`, `padding: 0`);
- `.palette-search` (flex row, 52px tall, a bottom hairline; the input has no border, a transparent background and `flex: 1`);
- `.palette ul` (max-height 50vh, `overflow: auto`, `padding: 6px`, `margin: 0`, `list-style: none`);
- `.palette-group` (uppercase xs text, `--text-faint`, `padding: 10px 10px 4px`, `letter-spacing: 0.04em`);
- `.palette li[role="option"]` (flex, 36px tall, `gap: 10px`, `padding: 0 10px`, `border-radius: var(--radius-md)`, `cursor: pointer`);
- `.palette li[aria-selected="true"]` (`background: var(--surface-active)`);
- `.palette li .where` (`--text-muted`, xs);
- `.palette-foot` (flex, `gap: 14px`, `padding: 8px 14px`, a top hairline, xs `--text-muted`).

- [ ] **Step 4: Run.** `npx vitest run src/features/command-palette && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `design: command palette grouped by kind with keyboard hints`.

---

### Task 2: Settings with a section menu

**Files:**
- Modify: `src/features/settings/SettingsDialog.tsx`
- Modify: `src/features/updates/UpdateSettings.tsx`, `src/features/ai/AiSettings.tsx` (wrapper markup only: no `fieldset`/`legend`, because the section title replaces it)
- Create: `src/features/settings/SettingsDialog.test.tsx`
- Modify: `src/styles/app.css` (settings block)

**Interfaces:**
- Produces: `SECTIONS: { id: SectionId; label: string; icon: IconName }[]` (nine entries, in the spec's order) and `SettingRow({ label, description, children })`, both in `SettingsDialog.tsx`.

- [ ] **Step 1: Write the failing test** (`SettingsDialog.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SettingsDialog } from "./SettingsDialog";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { Overlays } from "../../components/Overlays";

const appInfo = { version: "0.1.0", dataDir: "/data/tpm", logDir: "/logs/tpm", credentialStore: "Secret Service", credentialStoreAvailable: true, platform: "linux" };
let saved: Record<string, unknown> = {};

beforeEach(() => {
  saved = {};
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  mockIPC((cmd, args) => {
    if (cmd === "set_setting") saved[(args as { key: string }).key] = (args as { value: unknown }).value;
    if (cmd === "update_status") return { currentVersion: "0.1.0", lastCheck: null, auto: "unset" };
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("SettingsDialog", () => {
  it("has the nine sections from the design, one shown at a time", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["General", "Editor", "Data grid", "Safety", "History", "Updates", "AI assistant", "Shortcuts", "About"]);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "Updates" }));
    expect(screen.getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
  });

  it("saves the theme from the segmented control and clamps numbers on blur", async () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(useSettings.getState().settings.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    const size = screen.getByLabelText("Editor font size");
    fireEvent.change(size, { target: { value: "99" } });
    fireEvent.blur(size);
    expect(useSettings.getState().settings["editor.fontSize"]).toBe(28);
  });

  it("states where data lives and what leaves the computer", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("/data/tpm")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent to any server other than the databases you connect to/)).toBeInTheDocument();
  });

  it("asks before resetting everything", async () => {
    const reset = vi.spyOn(useSettings.getState(), "reset");
    render(
      <>
        <SettingsDialog appInfo={appInfo} onClose={() => undefined} />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(await screen.findByText("Reset all settings?")).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
  });
});
```

Before running, read `src/stores/settings.ts`:
- Use the real IPC command name for saving a setting (instead of `set_setting`), or drop the `saved` capture if the store saves differently. The assertions only read the store.
- Check how `set` updates the store; the theme assertion relies on an optimistic update. If the store waits for IPC, make the assertions `await waitFor(...)`.
- Check the update-status command name in `src/lib/ipc.ts` too.

- [ ] **Step 2: Run it.** `npx vitest run src/features/settings`. Expected: FAIL (no navigation or sections).

- [ ] **Step 3: Implement.**

`SettingsDialog.tsx`: keep `NumberField`, and give its input an `aria-label={label}` so it is found by its label when rendered in a row. Then add:

```tsx
type SectionId = "general" | "editor" | "grid" | "safety" | "history" | "updates" | "ai" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "editor", label: "Editor", icon: "code" },
  { id: "grid", label: "Data grid", icon: "table" },
  { id: "safety", label: "Safety", icon: "lock" },
  { id: "history", label: "History", icon: "history" },
  { id: "updates", label: "Updates", icon: "system_update_alt" },
  { id: "ai", label: "AI assistant", icon: "star_shine" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard_return" },
  { id: "about", label: "About", icon: "info" },
];

function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {description && <div className="setting-desc">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
```

Replace `Toggle`'s checkbox with a switch that keeps an accessible name: `<input type="checkbox" className="switch" role="switch" aria-label={label} checked={value} onChange={…} />`. Render it inside `SettingRow`.

Section content:
- **General.**
  - Theme: segmented `Dark` / `Light` / `System`, each a `button` with `aria-pressed` that calls `set("theme", …)`.
  - "Reopen connections and tabs on startup" (`workspace.restore`), with the description "Restores open tabs, filters and unsaved queries."
  - Log detail: a segmented control with the four existing options and their labels (Errors only, Warnings, Normal, Debug), plus the existing hint as its description.
- **Editor:** font size (NumberField), and the "Wrap long lines in the editor" switch.
- **Data grid:** rows per page, row limit for query results (hint as description), and the "Check that rows were not changed…" switch (current label).
- **Safety:** the default query timeout (hint as description).
- **History:** the "Record query history" switch, keep days, maximum entries, and the two existing buttons (Apply history limits now, Delete all history) with their handlers unchanged.
- **Updates:** `<UpdateSettings />`.
- **AI assistant:** `<AiSettings />`.
- **Shortcuts.** A read-only `<dl className="shortcut-list">` of the shortcuts the app has today. List these:
  - Open anything Ctrl+K or Ctrl+P;
  - New window Ctrl+Shift+N;
  - Settings Ctrl+,;
  - New query Ctrl+T;
  - Close tab Ctrl+W;
  - Run Ctrl+Enter;
  - Run all Ctrl+Shift+Enter;
  - Format Ctrl+Shift+F;
  - Save query Ctrl+S;
  - Explain Ctrl+E.

  Use ⌘ on macOS via `isMacPlatform()`. Check each one against `App.tsx` and `SqlEditor.tsx`'s keymap before listing it; list only what exists.
- **About:** the existing notice content, as rows: Version, Data folder (`mono`), Logs (`mono`), Passwords, and the network sentence unchanged.

Layout: `Dialog` with `title="Settings"`, `wide` and `className="settings-dialog"`, keeping the current footer (Reset to defaults, the hint "Changes save automatically", Done). The body is `<div className="settings-layout"><nav aria-label="Settings sections">…buttons with aria-current…</nav><section className="settings-content"><h3>{label}</h3>…</section></div>`.

`UpdateSettings.tsx` and `AiSettings.tsx`:
- Replace the outer `<fieldset className="fieldset"><legend>…</legend>` with a fragment.
- Turn their main checkbox into a `SettingRow` with a switch, keeping the exact label text as the switch's `aria-label` and visible label.
- Export `SettingRow` from `SettingsDialog.tsx` for this, or move it to `src/features/settings/SettingRow.tsx` to avoid a circular import. Prefer the separate file.

CSS. Add a settings block:
- `.settings-dialog` (width `min(880px, 94vw)`, height `min(620px, 88vh)`);
- `.settings-dialog .dialog-body` (`padding: 0`, `display: flex`, `min-height: 0`, `flex: 1`);
- `.settings-layout` (`display: grid`, `grid-template-columns: 200px 1fr`, `flex: 1`, `min-height: 0`);
- `.settings-layout nav` (`padding: 8px`, a right hairline border, `background: var(--surface-panel)`, a flex column with `gap: 2px`);
- nav buttons (34px tall, flex, `gap: 10px`, `padding: 0 10px`, `border-radius: var(--radius-md)`, `--text-muted`; `[aria-current="true"]` gets `background: var(--surface-active)` and `color: var(--text)`);
- `.settings-content` (`overflow: auto`, `padding: 18px 24px`, `min-width: 0`; its `h3` has `margin: 0 0 8px`, `font-size: var(--text-md)`);
- `.setting-row` (flex, `align-items: center`, `justify-content: space-between`, `gap: 24px`, `padding: 14px 0`, a bottom hairline);
- `.setting-text` (`min-width: 0`), `.setting-label` (`font-weight: 500`), `.setting-desc` (`--text-muted`, sm, `margin-top: 2px`, `overflow-wrap: anywhere`);
- `.setting-control` (`flex: none`, `max-width: 50%`);
- `.shortcut-list` (two-column grid, rows with a bottom hairline).

- [ ] **Step 4: Run.** `npx vitest run src/features/settings src/features/updates src/features/ai && npm run typecheck && npm run lint`. Expected: PASS, and the existing updates tests still pass.

- [ ] **Step 5: Commit** `design: Settings with a section menu, including Updates and AI assistant`.

---

### Task 3: Update consent dialog and banner

**Files:**
- Modify: `src/features/updates/FirstRunUpdatePrompt.tsx` (Dialog `subtitle`), `src/features/updates/UpdateBanner.tsx` (icon and layout classes), `src/styles/app.css` (update banner block)
- Test: append to `src/features/updates/updates.test.tsx`

- [ ] **Step 1: Write the failing test.** Append inside the file's top-level `describe`, reusing that file's helpers:

```tsx
  it("explains in the consent dialog what a check sends", async () => {
    renderConsent();
    expect(await screen.findByText("Once a day, from GitHub. Only the app version is sent; nothing about your databases.")).toBeInTheDocument();
  });
```

Read the file first. If there's no `renderConsent` helper, render `FirstRunUpdatePrompt` the way the existing consent test ("Check automatically") does. Keep the assertion.

- [ ] **Step 2: Run it.** `npx vitest run src/features/updates`. Expected: FAIL (no subtitle).

- [ ] **Step 3: Implement.**
  - `FirstRunUpdatePrompt.tsx`: pass `subtitle="Once a day, from GitHub. Only the app version is sent; nothing about your databases."` to `Dialog`.

    Check this sentence against `commands/update.rs` and `docs/SECURITY_MODEL.md` first. If the request sends anything else (for example a User-Agent with the OS), adjust the sentence to the truth, and keep the test in step.
  - `UpdateBanner.tsx`: add `<Icon name="system_update_alt" size={16} className="update-banner-icon" />` at the start of the row.
  - CSS: the banner gets `background: var(--surface-panel)`, `border-bottom: 1px solid var(--border-hairline)`, a 40px row with `gap: 10px`, and `.update-banner-icon { color: var(--accent); }`.

- [ ] **Step 4: Run.** `npx vitest run src/features/updates`. Expected: PASS.

- [ ] **Step 5: Commit** `design: update consent dialog says what a check sends; banner restyled`.

---

### Task 4: Screenshots and verification

- [ ] **Screenshots.** Take dark and light shots of: the palette on home (empty query); the palette with a query in a workspace; and Settings in General, Updates, AI assistant and About. Compare with `s2-palette.png` and `s2-settings.png`. Check Review Focus #5 (a long data folder path).
- [ ] **Verify.** Run `npm run typecheck && npm run lint && npm test && npm run build`.
- [ ] **Finish.** Run the fresh whole-branch review, then the fix pass. Push and open the PR (no `full-ci`). Squash-merge after **CI passed**.
