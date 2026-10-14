# Design revamp PR 4 (Workspace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the workspace to design screen 02. That covers the sidebar (database/schema switcher, filter, collapsible sections with counts, footer actions), the 38 px object tabs and the empty state. No behaviour changes.

**Architecture:**
- **`Sidebar.tsx`** keeps its logic and gets new markup: a header with one switcher control, a tree with section rows, and a footer toolbar.
- **Two components move out of `WorkspaceView.tsx`** into their own files so they can be tested alone: the tab strip becomes `ObjectTabs.tsx` and the empty state becomes `WorkspaceEmpty.tsx`. Their logic moves unchanged. This is the layout restructuring the spec allows ("Components may be restructured for layout").
- **CSS** in `src/styles/app.css` uses only existing tokens.

**Tech Stack:** React 19 + TypeScript, zustand stores, vitest + Testing Library (jsdom) with `@tauri-apps/api/mocks`.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, rows "Workspace sidebar" and "Object tabs and empty state" of "Screens (phase 1 mapping)". Design source: `FLOW.md` §02 and prototype screen 02 (`target/tpm-scratch/design-shots/s1-workspace.png`, `s1-table.png`).

## Global Constraints
- **No new behaviour in phase 1.** Pinned objects and an "Enums" section are phase 2. No Ctrl F shortcut exists today, so the filter shows no Ctrl F hint. The empty state shows no "Recent tables" list (nothing records them) and no "Connected in N ms" (nothing measures it).
- **Existing aria-labels stay:**
  - "Database", "Schema", "Filter objects", "Refresh objects", "New table", "Import data";
  - "New query tab", "Close {title}", "Unsaved changes";
  - "Open tabs" (tablist).
- **Colours, sizes and fonts come only from tokens** (`tokens.css`); no `color-mix()`; `--tabs-height` 38 px; `--sidebar-row-height` for tree rows.
- **Keyboard hints match the platform:** `⌘` on macOS and `Ctrl` elsewhere (`isMacPlatform()` from `src/app/WindowControls.tsx`). The palette opens with Ctrl K or Ctrl P, and a new query with Ctrl T (`App.tsx` key handler).
- **Code style:** about 160-column lines and no formatter run on whole files. Match the surrounding code.
- **Node 24:** `source ~/.nvm/nvm.sh && nvm use 24`.

## Review Focus
1. **Read-only connection:** the footer shows Refresh only. New table and Import are hidden, as today (Task 1 test).
2. **SQLite or MySQL (no database list):** the switcher shows a single select and no stray "/" separator (Task 1 test).
3. **Empty schema, or a filter with no match:** shows "This schema is empty" / "No matching objects" and never an empty sidebar (Task 1 test).
4. **Empty state before objects load:** no "undefined tables" or "0 tables" while `ws.objects[ws.schema]` is undefined (Task 3 test).
5. **Long object or tab names** truncate with an ellipsis; counts never wrap or push the sidebar wider (CSS `min-width: 0`; checked in screenshots, Task 4).

---

### Task 1: Sidebar

**Files:**
- Modify: `src/features/database-explorer/Sidebar.tsx`
- Modify: `src/styles/app.css` (sidebar block, "---- sidebar ----")
- Create: `src/features/database-explorer/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `Workspace` from `src/stores/workspaces.ts`; `session`, `profile` from `src/test/fixtures.ts`.
- Produces: no new exports. The section toggle buttons get accessible names `"{label} ({count})"` (for example "Tables (2)"). The footer is `role="toolbar"` with `aria-label="Schema actions"`. The switcher is `role="group"` with `aria-label="Database and schema"`.

- [ ] **Step 1: Write the failing test** (`src/features/database-explorer/Sidebar.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Sidebar } from "./Sidebar";
import { profile, session } from "../../test/fixtures";
import type { Workspace } from "../../stores/workspaces";
import type { DbObject } from "../../types/backend";

const objects: DbObject[] = [
  { schema: "public", name: "customers", kind: "table", estimatedRows: 1200 },
  { schema: "public", name: "orders", kind: "table", estimatedRows: 10400 },
  { schema: "public", name: "paid_orders", kind: "view" },
];

const ws = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  kind: "sql",
  profile,
  session,
  schema: "public",
  schemas: ["public", "audit"],
  objects: { public: objects },
  columns: {},
  tabs: [],
  activeTabId: null,
  closed: [],
  health: "ok",
  ...patch,
});

beforeEach(() => {
  mockIPC((cmd) => {
    if (cmd === "list_databases") return ["app", "analytics"];
    if (cmd === "list_saved_queries" || cmd === "list_dashboards") return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("Sidebar", () => {
  it("puts the database and schema in one switcher", async () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const sw = screen.getByRole("group", { name: "Database and schema" });
    await waitFor(() => expect(within(sw).getByLabelText("Database")).toHaveValue("app"));
    expect(within(sw).getByLabelText("Schema")).toHaveValue("public");
    expect(within(sw).getByText("/")).toBeInTheDocument();
  });

  it("shows one select and no separator when there is no database list", () => {
    const single = { ...session, dialect: "sqlite" as const, capabilities: { ...session.capabilities, multipleDatabases: false } };
    render(<Sidebar ws={ws({ session: single, schema: "main", schemas: ["main"], objects: { main: [] } })} onSwitchDatabase={() => undefined} />);
    const sw = screen.getByRole("group", { name: "Database and schema" });
    expect(within(sw).getAllByRole("combobox")).toHaveLength(1);
    expect(within(sw).queryByText("/")).not.toBeInTheDocument();
    expect(screen.getByText("This schema is empty")).toBeInTheDocument();
  });

  it("lists objects in collapsible sections with counts", () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const tables = screen.getByRole("button", { name: "Tables (2)" });
    expect(tables).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /orders/ })).toBeInTheDocument();
    expect(screen.getByText("~10,400")).toBeInTheDocument();
    fireEvent.click(tables);
    expect(tables).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /customers/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Views (1)" })).toBeInTheDocument();
  });

  it("filters objects and says when nothing matches", () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Filter objects"), { target: { value: "paid" } });
    expect(screen.getByRole("button", { name: "Views (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Tables/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter objects"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching objects")).toBeInTheDocument();
  });

  it("keeps schema actions in the footer, and only Refresh when read-only", () => {
    const { unmount } = render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const foot = screen.getByRole("toolbar", { name: "Schema actions" });
    for (const name of ["New table", "Refresh objects", "Import data"]) expect(within(foot).getByRole("button", { name })).toBeInTheDocument();
    unmount();
    render(<Sidebar ws={ws({ session: { ...session, readOnly: true } })} onSwitchDatabase={() => undefined} />);
    const ro = screen.getByRole("toolbar", { name: "Schema actions" });
    expect(within(ro).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Refresh objects"]);
  });

  it("marks the object of the active tab", () => {
    const tab = { kind: "table" as const, id: "t1", schema: "public", name: "orders", objectKind: "table" as const, title: "orders" };
    render(<Sidebar ws={ws({ tabs: [tab], activeTabId: "t1" })} onSwitchDatabase={() => undefined} />);
    expect(screen.getByRole("treeitem", { name: /orders/ })).toHaveAttribute("aria-current", "true");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/database-explorer/Sidebar.test.tsx`
Expected: FAIL. The "Database and schema" group, the "Tables (2)" name and the "Schema actions" toolbar don't exist yet. The filter test may already pass.

- [ ] **Step 3: Implement**

In `Sidebar.tsx`, replace the `<div className="sidebar-section">…</div>` header with:

```tsx
      <div className="sidebar-head">
        <div className="db-switch" role="group" aria-label="Database and schema">
          <Icon name="database" size={15} />
          {ws.session.capabilities.multipleDatabases && databases.length > 0 && (
            <>
              <select className="db-switch-select db" aria-label="Database" value={ws.session.database} onChange={(e) => onSwitchDatabase(e.target.value)}>
                {databases.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <span className="db-switch-sep" aria-hidden>
                /
              </span>
            </>
          )}
          <select
            className="db-switch-select"
            aria-label={ws.session.dialect === "mysql" ? "Database" : "Schema"}
            value={ws.schema}
            onChange={(e) => setSchema(ws.id, e.target.value).catch((err) => notifyError(err))}
          >
            {(ws.schemas.length ? ws.schemas : [ws.schema]).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <Icon name="unfold_more" size={15} className="db-switch-chevron" />
        </div>
        <div className="sidebar-filter">
          <Icon name="filter_list" size={15} />
          <input className="input" placeholder="Filter objects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter objects" />
        </div>
      </div>
```

The `aria-hidden` on the "/" separator hides it from assistive tech. `getByText("/")` still finds it.

Replace each section toggle (Tables/Views/…, Saved queries) with:

```tsx
              <button className="tree-group" aria-expanded={!isCollapsed} aria-label={`${g.label} (${items.length})`} onClick={() => setCollapsed({ ...collapsed, [g.label]: !isCollapsed })}>
                <Icon name={isCollapsed ? "chevron_right" : "keyboard_arrow_down"} size={14} />
                <span className="label">{g.label}</span>
                <span className="count">{items.length}</span>
              </button>
```

For Saved queries, use `saved.length` and `collapsed.saved` in the same shape. Replace the Dashboards header with a row:

```tsx
          <div className="tree-group-row">
            <button className="tree-group" aria-expanded={!collapsed.dash} aria-label={`Dashboards (${dashboards.length})`} onClick={() => setCollapsed({ ...collapsed, dash: !collapsed.dash })}>
              <Icon name={collapsed.dash ? "chevron_right" : "keyboard_arrow_down"} size={14} />
              <span className="label">Dashboards</span>
              <span className="count">{dashboards.length}</span>
            </button>
            <button className="btn btn-ghost btn-icon tree-group-add" aria-label="New dashboard" title="New dashboard" onClick={() => void createDashboard(ws).catch((e) => notifyError(e))}>
              <Icon name="add" size={13} />
            </button>
          </div>
```

In the object rows, change the row count to `<span className="count">~{formatCount(o.estimatedRows)}</span>` (same text as before, new class). Keep the `KindIcon` sizes at 14.

After `</div>` of `.sidebar-tree` and before `<ContextMenu …>`, add the footer:

```tsx
      <div className="sidebar-foot" role="toolbar" aria-label="Schema actions">
        {!ws.session.readOnly && (
          <button className="btn btn-ghost" onClick={() => setCreating(true)}>
            <Icon name="add" size={15} /> New table
          </button>
        )}
        <span className="grow" />
        <button className="btn btn-ghost btn-icon" aria-label="Refresh objects" title="Refresh schema" onClick={refresh}>
          <Icon name="refresh" size={15} className={loading ? "spin" : undefined} />
        </button>
        {!ws.session.readOnly && (
          <button className="btn btn-ghost btn-icon" aria-label="Import data" title="Import a CSV or JSON file" onClick={() => setImportInto(null)}>
            <Icon name="upload" size={15} />
          </button>
        )}
      </div>
```

In `app.css`, replace the rules `.sidebar` through `.tree-item svg` (keep `.sidebar-resizer`) with:

```css
.sidebar {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface-panel);
  border-right: 1px solid var(--border-hairline);
  position: relative;
}
.sidebar-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 12px 12px 8px;
}
.db-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--text-muted);
  min-width: 0;
}
.db-switch:focus-within {
  border-color: var(--focus);
  box-shadow: 0 0 0 1px var(--focus), 0 0 0 4px var(--focus-ring);
}
.db-switch-select {
  appearance: none;
  min-width: 0;
  flex: 0 1 auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  text-overflow: ellipsis;
  cursor: pointer;
}
.db-switch-select:focus-visible {
  outline: none;
}
.db-switch-select.db {
  font-weight: 600;
  max-width: 55%;
}
.db-switch-sep {
  color: var(--text-faint);
}
.db-switch-chevron {
  margin-left: auto;
  pointer-events: none;
}
.sidebar-filter {
  position: relative;
  display: flex;
}
.sidebar-filter .icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
  pointer-events: none;
}
.sidebar-filter .input {
  flex: 1;
  padding-left: 32px;
}
.sidebar-tree {
  flex: 1;
  overflow: auto;
  padding: 4px 0 8px;
}
.tree-group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: var(--sidebar-row-height);
  padding: 0 12px;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
}
.tree-group:hover {
  color: var(--text);
}
.tree-group .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-group .count,
.tree-item .count {
  margin-left: auto;
  flex: none;
  font-family: var(--font-code);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.tree-group-row {
  display: flex;
  align-items: center;
  padding-right: 6px;
}
.tree-group-row .tree-group {
  flex: 1;
  min-width: 0;
  padding-right: 6px;
}
.tree-group-add {
  width: 22px;
  height: 22px;
}
.tree-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: calc(100% - 12px);
  height: var(--sidebar-row-height);
  margin: 0 6px;
  padding: 0 6px 0 24px;
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.tree-item:hover {
  background: var(--surface-hover);
}
.tree-item[aria-current="true"] {
  background: var(--surface-active);
}
.tree-item[aria-current="true"] .icon {
  color: var(--accent);
}
.tree-item .name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.tree-item .icon {
  flex: none;
  color: var(--text-faint);
}
.sidebar-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-hairline);
}
.sidebar-foot .grow {
  flex: 1;
}
```

`Icon` renders with class `icon` (`src/components/Icon.tsx`). Keep the `.sidebar-section` rule: `HistoryPanel.tsx` and `RedisView.tsx` still use it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/database-explorer`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/database-explorer src/styles/app.css
git commit -m "design: workspace sidebar with one switcher, sections with counts and footer actions"
```

---

### Task 2: Object tabs

**Files:**
- Create: `src/app/ObjectTabs.tsx` (the tab strip, moved from `WorkspaceView.tsx`)
- Create: `src/app/ObjectTabs.test.tsx`
- Modify: `src/app/WorkspaceView.tsx` (use `ObjectTabs`, drop `TabIcon` and `dragIndex`)
- Modify: `src/styles/app.css` ("---- main area / tabs ----" block)

**Interfaces:**
- Consumes: `useWorkspaces` (`activateTab`, `openQuery`, `moveTab`), `Tab`, `Workspace`.
- Produces: `export function ObjectTabs({ ws, dirtyTables, onClose }: { ws: Workspace; dirtyTables: Record<string, boolean>; onClose: (tab: Tab) => void })`.

- [ ] **Step 1: Write the failing test** (`src/app/ObjectTabs.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ObjectTabs } from "./ObjectTabs";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { profile, session } from "../test/fixtures";

const tabs: Tab[] = [
  { kind: "table", id: "t1", schema: "public", name: "orders", objectKind: "table", title: "orders" },
  { kind: "query", id: "q1", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true },
];
const ws: Workspace = { id: "ws-1", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs, activeTabId: "t1", closed: [], health: "ok" };

beforeEach(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
afterEach(cleanup);

describe("ObjectTabs", () => {
  it("shows a tab per open object, the active one selected", () => {
    render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={() => undefined} />);
    expect(screen.getByRole("tablist", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /orders/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /Query 1/ }));
    expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("q1");
  });

  it("marks unsaved queries and tables with pending edits", () => {
    render(<ObjectTabs ws={ws} dirtyTables={{ t1: true }} onClose={() => undefined} />);
    expect(screen.getAllByLabelText("Unsaved changes")).toHaveLength(2);
  });

  it("closes through the callback and opens a new query with +", () => {
    const onClose = vi.fn();
    render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close orders" }));
    expect(onClose).toHaveBeenCalledWith(tabs[0]);
    fireEvent.click(screen.getByRole("button", { name: "New query tab" }));
    expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(3);
  });

  it("is 38 px tall and keeps the focus ring inside the strip", () => {
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.tabbar\s*\{[^}]*height:\s*var\(--tabs-height\)/);
    expect(css).toMatch(/\.tab:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/ObjectTabs.test.tsx`
Expected: FAIL ("Failed to resolve import ./ObjectTabs").

- [ ] **Step 3: Implement**

Create `src/app/ObjectTabs.tsx`. Move the `TabIcon` function, the `dragIndex` state and the whole `<div className="tabbar">…</div>` element from `WorkspaceView.tsx` into it. Keep the code the same, with two changes: `requestClose(t)` becomes `onClose(t)`, and `useWorkspaces.getState()` supplies `activateTab`, `openQuery` and `moveTab`:

```tsx
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "query") return <Icon name="terminal" size={14} />;
  if (tab.kind === "definition") return <Icon name="code_blocks" size={14} />;
  if (tab.kind === "dashboard") return <Icon name="bar_chart" size={14} />;
  return tab.objectKind === "table" ? <Icon name="table" size={14} /> : <Icon name="visibility" size={14} />;
}

/** The object tab strip of a workspace: tables, queries, definitions and dashboards. */
export function ObjectTabs({ ws, dirtyTables, onClose }: { ws: Workspace; dirtyTables: Record<string, boolean>; onClose: (tab: Tab) => void }) {
  const { activateTab, openQuery, moveTab } = useWorkspaces.getState();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      {/* …the existing tab map, with requestClose(t) → onClose(t)… */}
      <button className="tab-add" aria-label="New query tab" title="New query (Ctrl+T)" onClick={() => openQuery(ws.id)}>
        <Icon name="add" size={15} />
      </button>
    </div>
  );
}
```

The comment marks where the existing `ws.tabs.map(...)` block goes, unchanged apart from the rename. In `WorkspaceView.tsx`, replace the tabbar element with `<ObjectTabs ws={ws} dirtyTables={dirtyTables} onClose={(t) => void requestClose(t)} />`. Remove `TabIcon`, `dragIndex`, the now-unused `moveTab` and `activateTab` destructures, and any unused imports.

CSS. Replace `.tabbar` through `.tab-add` with:

```css
.tabbar {
  display: flex;
  align-items: stretch;
  height: var(--tabs-height);
  flex: none;
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg);
  overflow-x: auto;
  scrollbar-width: thin;
}
.tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 8px 0 14px;
  border: 0;
  border-right: 1px solid var(--border-hairline);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  max-width: 240px;
  flex: none;
}
.tab:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.tab:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.tab[aria-selected="true"] {
  background: var(--surface);
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.tab[aria-selected="true"] > .icon:first-child {
  color: var(--accent);
}
.tab.dragging {
  opacity: 0.4;
}
.tab .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab .dirty {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warning);
}
.tab-close {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 0;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}
.tab-close:hover {
  background: var(--surface-active);
  color: var(--text);
}
.tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--tabs-height);
  flex: none;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--text-muted);
}
.tab-add:hover {
  color: var(--text);
  background: var(--surface-hover);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/ObjectTabs.tsx src/app/ObjectTabs.test.tsx src/app/WorkspaceView.tsx src/styles/app.css
git commit -m "design: 38 px object tabs in their own component"
```

---

### Task 3: Workspace empty state

**Files:**
- Create: `src/app/WorkspaceEmpty.tsx`
- Create: `src/app/WorkspaceEmpty.test.tsx`
- Modify: `src/app/WorkspaceView.tsx` (replace the `ws.tabs.length === 0` block)
- Modify: `src/styles/app.css` (new block after `.tab-panel`)

**Interfaces:**
- Consumes: `useWorkspaces().openQuery(wsId)`, `useUi().setPaletteOpen(true)`, `isMacPlatform()` from `./WindowControls`.
- Produces: `export function WorkspaceEmpty({ ws }: { ws: Workspace })`.

- [ ] **Step 1: Write the failing test** (`src/app/WorkspaceEmpty.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceEmpty } from "./WorkspaceEmpty";
import { useWorkspaces, type Workspace } from "../stores/workspaces";
import { useUi } from "../stores/ui";
import { profile, session } from "../test/fixtures";

const base: Workspace = { id: "ws-1", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" };
const loaded: Workspace = {
  ...base,
  objects: { public: [{ schema: "public", name: "a", kind: "table" }, { schema: "public", name: "b", kind: "table" }, { schema: "public", name: "v", kind: "view" }] },
};

beforeEach(() => {
  useWorkspaces.setState({ workspaces: [loaded], activeId: loaded.id });
  useUi.setState({ paletteOpen: false });
});
afterEach(cleanup);

describe("WorkspaceEmpty", () => {
  it("summarises the connection", () => {
    render(<WorkspaceEmpty ws={loaded} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: profile.name })).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL 16 · app · 2 tables")).toBeInTheDocument();
  });

  it("leaves out the table count until objects have loaded", () => {
    render(<WorkspaceEmpty ws={base} />);
    expect(screen.getByText("PostgreSQL 16 · app")).toBeInTheDocument();
    expect(screen.queryByText(/tables/)).not.toBeInTheDocument();
  });

  it("starts a query or opens the palette", () => {
    render(<WorkspaceEmpty ws={loaded} />);
    fireEvent.click(screen.getByRole("button", { name: /New query/ }));
    expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Find anything/ }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/WorkspaceEmpty.test.tsx`
Expected: FAIL ("Failed to resolve import ./WorkspaceEmpty").

- [ ] **Step 3: Implement** (`src/app/WorkspaceEmpty.tsx`)

```tsx
import { Icon } from "../components/Icon";
import { useWorkspaces, type Workspace } from "../stores/workspaces";
import { useUi } from "../stores/ui";
import { isMacPlatform } from "./WindowControls";

/** Shown in a workspace with no open tabs: what is connected, and the two ways to start. */
export function WorkspaceEmpty({ ws }: { ws: Workspace }) {
  const s = ws.session;
  const objects = ws.objects[ws.schema];
  const tables = objects?.filter((o) => o.kind === "table" || o.kind === "foreign_table").length;
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  const summary = [`${s.server.product} ${s.server.version}`, s.database, tables === undefined ? null : `${tables} table${tables === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return (
    <div className="ws-empty">
      <div className="ws-empty-inner">
        <p className="ws-connected">
          <span className="ws-connected-dot" />
          Connected
        </p>
        <h1>{ws.profile.name}</h1>
        <p className="ws-summary">{summary}</p>
        <div className="ws-actions">
          <button className="ws-action" onClick={() => useWorkspaces.getState().openQuery(ws.id)}>
            <Icon name="terminal" size={18} />
            <span>New query</span>
            <span className="kbd">{mod} T</span>
          </button>
          <button className="ws-action" onClick={() => useUi.getState().setPaletteOpen(true)}>
            <Icon name="search" size={18} />
            <span>Find anything</span>
            <span className="kbd">{mod} K</span>
          </button>
        </div>
      </div>
    </div>
  );
}
```

In `WorkspaceView.tsx`, replace the `{ws.tabs.length === 0 && (<div className="empty">…</div>)}` block with `{ws.tabs.length === 0 && <WorkspaceEmpty ws={ws} />}`.

CSS, after `.tab-panel`:

```css
.ws-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  overflow: auto;
}
.ws-empty-inner {
  width: min(540px, 100%);
}
.ws-connected {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.ws-connected-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.ws-empty h1 {
  margin: 8px 0 4px;
  font-size: var(--text-xl);
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-summary {
  margin: 0 0 20px;
  font-family: var(--font-code);
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.ws-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ws-action {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  row-gap: 14px;
  align-items: end;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.ws-action:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}
.ws-action > .icon {
  grid-column: 1 / -1;
  color: var(--accent);
}
.ws-action .kbd {
  font-weight: 400;
}
```

The "Connected" text uses `--text-muted`, not `--accent-text`: `--accent-text` is ink on accent fills, so only the dot is accent-coloured.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app && npm run typecheck && npm run lint`
Expected: PASS, and typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/WorkspaceEmpty.tsx src/app/WorkspaceEmpty.test.tsx src/app/WorkspaceView.tsx src/styles/app.css
git commit -m "design: workspace empty state with connection summary, New query and Find anything"
```

---

### Task 4: Screenshots, docs, verification

**Files:**
- Modify: `docs/FEATURE_MATRIX.md` (Open Anything row: the shortcut is Ctrl+P or Ctrl+K)
- Scratch only (not committed): `target/tpm-scratch/shots/after4-*`

- [ ] **Step 1: Docs.** In the `Open Anything` row of `docs/FEATURE_MATRIX.md`, change "Ctrl+P fuzzy search" to "Ctrl+K (or Ctrl+P) fuzzy search". The title bar and the empty state show Ctrl K.
- [ ] **Step 2: Screenshots.**
  - Run `target/tpm-scratch/shots/capture.sh after4 dark` and `… after4 light`.
  - Capture the empty state as well: seed the demo, close all object tabs with Ctrl+W, then shoot `after4-{theme}-empty`.
  - Compare with `design-shots/s1-workspace.png` and `s1-table.png`.
  - Check the Review Focus #5 truncation: long names ellipsize and counts don't wrap.
- [ ] **Step 3: Full verification.**
  Run: `npm run typecheck && npm run lint && npm test && npm run build`
  Expected: all pass, with test count = previous 120 + the new tests.
- [ ] **Step 4: Commit the docs.**

```bash
git add docs/FEATURE_MATRIX.md
git commit -m "docs: Open Anything opens with Ctrl+K as well"
```

- [ ] **Step 5: Final steps.** Run the whole-branch review (fresh reviewer), then the fix pass, push, and open the PR (no `full-ci`: nothing in `src-tauri/`). Squash-merge after **CI passed**.
