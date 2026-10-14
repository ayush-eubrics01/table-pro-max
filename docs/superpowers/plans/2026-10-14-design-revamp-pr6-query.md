# Design revamp PR 6 (Query) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the query view to design screen 06 (editor theme, toolbar, results, history drawer, explain and AI panel) without changing behaviour, and remove the last `color-mix()` from the app.

**Architecture:**
- **Editor theme.** The CodeMirror theme spec moves into an exported constant (`EDITOR_THEME`) so it can be tested. Its colours come only from tokens.
- **Toolbar.** It gets labelled actions, a Run shortcut hint and a target label from a small helper (`queryTarget`).
- **Panels.** `ResultsPanel`, `HistoryPanel`, `ExplainView` and `AiPanel` keep their logic; their markup and CSS change. `HistoryPanel` gains a header with a close button that drives the existing `historyOpen` state.

**Tech Stack:** React 19 + TypeScript, CodeMirror 6 (`@codemirror/view` theme), vitest + Testing Library (jsdom) with `@tauri-apps/api/mocks`.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, row "Query" of "Screens (phase 1 mapping)":
- toolbar: Run, Explain, Format, Save, History, target + environment pill;
- CodeMirror theme from the syntax tokens;
- Results / Messages / Plan tabs;
- history drawer;
- AI panel in the same style.

Design: `FLOW.md` §06, prototype shots `target/tpm-scratch/design-shots/s3-newquery.png` and `s3-run.png`.

## Global Constraints
- **No new behaviour.** Run, Run all, Cancel, Explain, Analyze, Format, Save, file open/save/run, History and Ask AI all keep their handlers and conditions. The AI panel still previews every request and never runs SQL.
- **Accessible names stay:**
  - "Format SQL", "Save query", "Open SQL file", "Save to file", "Run SQL file", "Query history";
  - "Close AI assistant", "Search history", "Clear history";
  - tab names "Messages" and "Result … (n)".
- **No `color-mix()` anywhere in `src/`.** A test enforces it. Colours come from `tokens.css`.
- **Keyboard hints** show `⌘` on macOS and `Ctrl` elsewhere (`isMacPlatform()` from `src/app/WindowControls.tsx`).
- **Code style:** about 160-column lines; no formatter run on whole files.
- **Node 24:** `source ~/.nvm/nvm.sh && nvm use 24`.

## Review Focus
1. **Plan view.** Explain still shows the plan, and "Back to results" still returns to the results (the plan doesn't replace them for good). Task 3 test.
2. **Read-only session.** The toolbar shows a Read-only pill, and Run stays enabled because read-only is enforced by the session. Task 2 checks this by rendering the toolbar markup through `QueryToolbarTarget`.
3. **Target label.**
   - PostgreSQL shows `database.schema`.
   - MySQL and MariaDB show the selected database only.
   - SQLite and DuckDB show the schema (`main`).
   - It never shows an empty or "undefined" piece. Task 2 test.
4. **Messages tab:** an error stays red and is selected after a failing run (Task 3 test).
5. **History drawer:** it scrolls with hundreds of entries, and its close button closes it (Task 4 test, plus a screenshot).

---

### Task 1: Editor theme from tokens, no color-mix anywhere

**Files:**
- Modify: `src/features/sql-editor/SqlEditor.tsx` (export `EDITOR_THEME`, token colours, gutter)
- Modify: `src/styles/tokens.css`. Add `--editor-active-line` and `--search-match`: light and dark values, in both dark blocks.
- Modify: `scripts/theme-check.test.mjs` (widen the no-color-mix test to every file under `src/`)
- Create: `src/features/sql-editor/editorTheme.test.ts`

**Interfaces:**
- Produces: `export const EDITOR_THEME: Record<string, Record<string, string>>` in `SqlEditor.tsx`.

- [ ] **Step 1: Write the failing tests**

In `scripts/theme-check.test.mjs`, replace the body of `it("app.css uses no color-mix() either", …)` with a recursive scan. Keep the test's name, and replace the `app` variable:

```js
  it("app.css uses no color-mix() either", () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const offenders = walk("src")
      .filter((f) => /\.(css|ts|tsx)$/.test(f) && !/\.test\./.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("color-mix("));
    expect(offenders).toEqual([]);
  });
```

Add `readdirSync` to the `node:fs` import and `join` from `node:path`.

`src/features/sql-editor/editorTheme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EDITOR_THEME } from "./SqlEditor";

describe("EDITOR_THEME", () => {
  it("takes every colour from tokens and gives the gutter room", () => {
    const values = Object.values(EDITOR_THEME).flatMap((rule) => Object.values(rule));
    expect(values.some((v) => v.includes("color-mix"))).toBe(false);
    expect(EDITOR_THEME[".cm-activeLine"]!.backgroundColor).toBe("var(--editor-active-line)");
    expect(EDITOR_THEME[".cm-searchMatch"]!.backgroundColor).toBe("var(--search-match)");
    expect(EDITOR_THEME[".cm-gutters"]!.backgroundColor).toBe("var(--surface)");
    expect(EDITOR_THEME[".cm-lineNumbers .cm-gutterElement"]!.minWidth).toBe("32px");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/theme-check.test.mjs src/features/sql-editor/editorTheme.test.ts`
Expected: FAIL. The scan lists `src/features/sql-editor/SqlEditor.tsx`, and `EDITOR_THEME` is not exported.

- [ ] **Step 3: Implement**

`tokens.css`: add to the light block

```css
  --editor-active-line: #f1f4f6;
  --search-match: #fbe7b5;
```

and to both dark blocks

```css
  --editor-active-line: #161a1f;
  --search-match: #4a3a14;
```

Place them next to `--selection`. Read the block first to match its indentation and comment style.

`SqlEditor.tsx`: replace `const theme = EditorView.theme({…})` with

```ts
/** Editor colours, all from tokens.css (exported for tests). */
export const EDITOR_THEME: Record<string, Record<string, string>> = {
  "&": { color: "var(--text)", backgroundColor: "var(--surface)" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-faint)", border: "none", borderRight: "1px solid var(--border-hairline)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 12px 0 14px" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)", color: "var(--text-muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection-strong) !important" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-tooltip": { backgroundColor: "var(--surface-panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--selection)", color: "var(--text)" },
  ".cm-panels": { backgroundColor: "var(--bg-sunken)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "none" },
};

const theme = EditorView.theme(EDITOR_THEME);
```

If the old theme had keys this list lacks (read it first, e.g. an error-mark rule), keep them unchanged in `EDITOR_THEME`.

Add `["--text", ["--editor-active-line"], 4.5]` to `PAIRS` in `scripts/theme-check.mjs`. Code sits on the active line, so text must stay readable there. Then run `npx vitest run scripts/theme-check.test.mjs`. If the pair fails, darken (light theme) or lighten (dark theme) the token until it passes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts src/features/sql-editor && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor src/styles/tokens.css scripts/theme-check.mjs scripts/theme-check.test.mjs
git commit -m "design: editor theme from tokens, no color-mix left in the app"
```

---

### Task 2: Query toolbar and target label

**Files:**
- Create: `src/features/sql-editor/queryTarget.ts`, `src/features/sql-editor/queryTarget.test.ts`
- Modify: `src/features/sql-editor/QueryTab.tsx` (toolbar markup)
- Modify: `src/styles/app.css` (toolbar block)

**Interfaces:**
- Produces:
  - `export function queryTarget(dialect: Dialect, driver: string, database: string, schema: string): string`;
  - `export function QueryToolbarTarget({ target, readOnly, env }: { target: string; readOnly: boolean; env: Environment })` in `QueryTab.tsx`, exported for the test.

- [ ] **Step 1: Write the failing tests**

`src/features/sql-editor/queryTarget.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { queryTarget } from "./queryTarget";
import { QueryToolbarTarget } from "./QueryTab";

afterEach(cleanup);

describe("queryTarget", () => {
  it("names where unqualified names resolve", () => {
    expect(queryTarget("postgres", "postgres", "flexi_dev", "public")).toBe("flexi_dev.public");
    expect(queryTarget("mysql", "mysql", "app", "shop")).toBe("shop");
    expect(queryTarget("mysql", "mariadb", "app", "")).toBe("app");
    expect(queryTarget("sqlite", "sqlite", "/data/shop.db", "main")).toBe("main");
    expect(queryTarget("postgres", "duckdb", "memory", "main")).toBe("main");
    expect(queryTarget("postgres", "postgres", "app", "")).toBe("app");
  });
});

describe("QueryToolbarTarget", () => {
  it("shows the target, the environment, and Read-only when the session is", () => {
    render(createElement(QueryToolbarTarget, { target: "app.public", readOnly: true, env: "production" }));
    expect(screen.getByText("app.public")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
```

Check how a DuckDB session reports its `dialect` and `profile.driver` (`src/types/backend.ts`, `src/lib/env.ts`) and adjust the DuckDB case to the real values. The expectation stays: DuckDB shows the schema.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/sql-editor/queryTarget.test.ts`
Expected: FAIL ("Failed to resolve import ./queryTarget").

- [ ] **Step 3: Implement**

`queryTarget.ts`:

```ts
import type { Dialect } from "../../types/backend";

/** Where unqualified names in a query tab resolve, as shown in the toolbar. */
export function queryTarget(dialect: Dialect, driver: string, database: string, schema: string): string {
  if (driver === "sqlite" || driver === "duckdb") return schema || database;
  if (dialect === "mysql") return schema || database;
  return [database, schema].filter(Boolean).join(".");
}
```

`QueryTab.tsx`:

1. **Exported component.** Add above `QueryTab`:

```tsx
export function QueryToolbarTarget({ target, readOnly, env }: { target: string; readOnly: boolean; env: Environment }) {
  return (
    <>
      {readOnly && (
        <span className="access-pill ro">
          <Icon name="lock" size={13} /> Read-only
        </span>
      )}
      <span className="query-target mono" title="Statements in this tab run here">
        {target}
      </span>
      <EnvBadge env={env} />
    </>
  );
}
```

2. **Toolbar right side.** Replace everything after `<span className="grow" />` with:

```tsx
        <QueryToolbarTarget target={queryTarget(info.dialect, ws.profile.driver, info.database, ws.schema)} readOnly={info.readOnly} env={info.environment} />
```

3. **Run button.** It becomes

```tsx
        <button className="btn btn-primary btn-run" onClick={() => run("current")} disabled={!!running} title="Run current statement or selection (Ctrl+Enter)">
          <Icon name="play_arrow" size={15} /> Run <span className="kbd">{isMacPlatform() ? "⌘" : "Ctrl"} ↵</span>
        </button>
```

4. **Format.** It becomes a labelled ghost button: `<Icon name="format_align_left" size={14} /> Format`. Keep `aria-label="Format SQL"`. Group the file buttons (Open SQL file, Save to file, Run SQL file) after a `<span className="sep" />`. Keep History and Ask AI where they are.

Import `queryTarget`, `isMacPlatform` (`../../app/WindowControls`) and `type Environment`.

CSS (toolbar block):

```css
.btn-run .kbd {
  height: 16px;
  margin-left: 4px;
  background: transparent;
  border-color: currentColor;
  color: inherit;
  opacity: 0.7;
}
.query-target {
  font-size: var(--text-sm);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/sql-editor && npm run typecheck && npm run lint`
Expected: PASS, and typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor src/styles/app.css
git commit -m "design: query toolbar with Run shortcut, labelled Format and the target it runs in"
```

---

### Task 3: Results, messages and plan tabs

**Files:**
- Modify: `src/features/sql-editor/ResultsPanel.tsx`, `src/features/sql-editor/QueryTab.tsx` (plan tab bar)
- Create: `src/features/sql-editor/ResultsPanel.test.tsx`
- Modify: `src/features/explain/ExplainView.tsx` (header line only), `src/styles/app.css` (results and plan blocks)

**Interfaces:** unchanged props.

- [ ] **Step 1: Write the failing test** (`src/features/sql-editor/ResultsPanel.test.tsx`)

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResultsPanel } from "./ResultsPanel";
import type { ScriptResult } from "../../types/backend";

afterEach(cleanup);

const ok = { sql: "select 1", durationMs: 3, columns: [{ name: "x", typeName: "int" }], rows: [["1"]], totalRows: 1, truncated: false, resultId: null, rowsAffected: null, error: null };
const bad = { sql: "selec 1", durationMs: 1, columns: null, rows: null, totalRows: null, truncated: false, resultId: null, rowsAffected: null, error: { kind: "query", message: "syntax error", detail: null, code: null } };

describe("ResultsPanel", () => {
  it("shows how to run when idle, with the platform's key", () => {
    render(<ResultsPanel result={null} running={false} dialect="postgres" />);
    const hint = screen.getByText(/to run the statement at the cursor/);
    expect(hint).toHaveTextContent(navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl");
  });

  it("opens Messages, marked as an error, after a failing run", () => {
    const result = { statements: [ok, bad], cancelled: false, durationMs: 4 } as unknown as ScriptResult;
    render(<ResultsPanel result={result} running={false} dialect="postgres" />);
    const messages = screen.getByRole("tab", { name: "Messages" });
    expect(messages).toHaveAttribute("aria-selected", "true");
    expect(messages).toHaveClass("error");
    expect(screen.getByRole("tab", { name: /Result.*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByText("syntax error")).toBeInTheDocument();
  });
});
```

Before running, read the `StatementResult`, `ScriptResult` and error types in `src/types/backend.ts`. Make the two fixtures valid objects of those types and drop the `as unknown as` cast if they type-check. The assertions don't change.

In the same step, add one test to the end of `src/features/sql-editor/queryTarget.test.ts` (it already renders from `QueryTab`):

```tsx
describe("Plan tabs", () => {
  it("keeps a way back to the results", async () => {
    const { PlanTabs } = await import("./QueryTab");
    let back = false;
    render(createElement(PlanTabs, { onBack: () => (back = true) }));
    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "Back to results" }).click();
    expect(back).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/sql-editor`
Expected: FAIL. The idle hint wording differs, and `PlanTabs` is not exported.

- [ ] **Step 3: Implement**

`ResultsPanel.tsx`, idle state:

```tsx
            <span>
              <span className="kbd">{mod} ↵</span> to run the statement at the cursor or the selection, <span className="kbd">{mod} ⇧ ↵</span> to run everything.
            </span>
```

where `const mod = isMacPlatform() ? "⌘" : "Ctrl";` (import from `../../app/WindowControls`). Behaviour is the same as the old Ctrl+Enter / Ctrl+Shift+Enter text.

`QueryTab.tsx`: extract and export the plan tab bar:

```tsx
export function PlanTabs({ onBack }: { onBack: () => void }) {
  return (
    <div className="results-tabs" role="tablist" aria-label="Plan">
      <button role="tab" aria-selected="true">
        Plan
      </button>
      <button role="tab" aria-selected="false" onClick={onBack}>
        Back to results
      </button>
    </div>
  );
}
```

Use it in place of the inline `<div className="results-tabs">…</div>` in the explain branch: `<PlanTabs onBack={() => setExplain(null)} />`.

CSS. Replace `.results-tabs` through `.messages .entry code` with:

```css
.results-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg);
  overflow-x: auto;
  flex: none;
}
.results-tabs button {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  cursor: pointer;
  color: var(--text-muted);
  white-space: nowrap;
  font-size: var(--text-sm);
}
.results-tabs button:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.results-tabs button[aria-selected="true"] {
  background: var(--surface-active);
  color: var(--text);
}
.results-tabs button.error {
  color: var(--danger);
}
.messages {
  overflow: auto;
  padding: 6px 14px;
  font-size: var(--text-sm);
  user-select: text;
}
.messages .entry {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-hairline);
  display: grid;
  grid-template-columns: 22px 1fr auto;
  gap: var(--space-3);
}
.messages .entry code {
  display: block;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-code);
  font-size: var(--text-xs);
  color: var(--text-muted);
}
```

Plan nodes (`.plan-node` block): give `.plan-node` `border-left: 2px solid var(--border-hairline)` and `.plan-node .bar` `background: var(--accent)`, `height: 3px`, `border-radius: 2px`. Read the block first and change only those properties.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/sql-editor && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/sql-editor src/features/explain src/styles/app.css
git commit -m "design: results, messages and plan tabs in the query view"
```

---

### Task 4: History drawer and AI panel

**Files:**
- Modify: `src/features/query-history/HistoryPanel.tsx` (header with close, entry layout, own classes)
- Create: `src/features/query-history/HistoryPanel.test.tsx`
- Modify: `src/features/sql-editor/QueryTab.tsx` (pass `onClose={() => setHistoryOpen(false)}`)
- Modify: `src/styles/app.css`. Add a history block, restyle the AI panel block, and remove the boxed `pre` that history inherited from `.detail-field`.

**Interfaces:** `HistoryPanel` props add `onClose: () => void`.

- [ ] **Step 1: Write the failing test** (`src/features/query-history/HistoryPanel.test.tsx`)

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HistoryPanel } from "./HistoryPanel";

const entries = [
  { id: 1, connectionId: "c", databaseName: "app", sql: "select 1", startedAt: "2026-10-14T10:00:00Z", durationMs: 4, status: "success", rowCount: 1, error: null },
  { id: 2, connectionId: "c", databaseName: "app", sql: "selec 2", startedAt: "2026-10-14T10:01:00Z", durationMs: 1, status: "error", rowCount: null, error: "syntax error" },
];

beforeEach(() => mockIPC((cmd) => (cmd === "search_history" ? entries : null)));
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("HistoryPanel", () => {
  it("lists past statements with their status, inserts on click and closes", async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<HistoryPanel connectionId="c" refreshKey={0} onInsert={onInsert} onOpen={() => undefined} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    const failed = await screen.findByText("selec 2");
    expect(failed.closest("button")).toHaveAttribute("data-status", "error");
    fireEvent.click(screen.getByText("select 1"));
    expect(onInsert).toHaveBeenCalledWith("select 1");
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

Check the command name behind `api.searchHistory` in `src/lib/ipc.ts` and use the real one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/query-history`
Expected: FAIL (no "History" heading, no `data-status`, no close button).

- [ ] **Step 3: Implement**

`HistoryPanel.tsx`: add `onClose` to `Props`, and render:

```tsx
    <aside className="history-panel" aria-label="Query history">
      <header className="side-head">
        <h2>History</h2>
        <button className="btn btn-ghost btn-icon" aria-label="Clear history" title="Clear history" onClick={clear}>
          <Icon name="delete" size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Close history" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="history-search">
        <input className="input" placeholder="Search history" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search history" />
        <span className="hint">Click to insert, double-click to open in a new tab</span>
      </div>
      <div className="history-list">
        {entries.length === 0 && <div className="empty">No queries yet.</div>}
        {entries.map((e) => (
          <button
            key={e.id}
            className="history-entry"
            data-status={e.status}
            onClick={() => onInsert(e.sql)}
            onDoubleClick={() => onOpen(e.sql)}
            title={e.error ?? undefined}
          >
            <span className="meta">
              <span className="dot" />
              {new Date(e.startedAt).toLocaleString()}
              {e.durationMs !== null ? ` · ${formatDuration(e.durationMs)}` : ""}
            </span>
            <pre>{e.sql}</pre>
          </button>
        ))}
      </div>
    </aside>
```

`QueryTab.tsx`: pass `onClose={() => setHistoryOpen(false)}`.

`AiPanel.tsx`: change the head's class to `side-head` and wrap its title text in `<h2>`. Keep the text and the close button's label. Read the head markup first; the title is the text before `<span className="grow" />`.

CSS. Add:

```css
.side-head {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--border-hairline);
}
.side-head h2 {
  flex: 1;
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}
.history-panel {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border-hairline);
  background: var(--surface-panel);
}
.history-search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-hairline);
}
.history-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.history-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 9px 14px;
  border: 0;
  border-bottom: 1px solid var(--border-hairline);
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.history-entry:hover {
  background: var(--surface-hover);
}
.history-entry .meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.history-entry .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.history-entry[data-status="error"] .dot {
  background: var(--danger);
}
.history-entry[data-status="cancelled"] .dot {
  background: var(--warning);
}
.history-entry pre {
  margin: 0;
  max-height: 60px;
  overflow: hidden;
  font-family: var(--font-code);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.history-entry[data-status="error"] pre {
  color: var(--danger);
}
```

AI panel: change `.ai-panel` to `background: var(--surface-panel)` and `border-left: 1px solid var(--border-hairline)`, and remove `.ai-panel-head` (now `.side-head`). `.ai-tasks .btn[aria-pressed="true"]` becomes `background: var(--surface-active); border-color: var(--accent); box-shadow: none;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/query-history src/features/sql-editor src/features/ai && npm run typecheck && npm run lint`
Expected: PASS, and typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/query-history src/features/sql-editor/QueryTab.tsx src/features/ai/AiPanel.tsx src/styles/app.css
git commit -m "design: history drawer and AI panel share the side-panel style"
```

---

### Task 5: Screenshots, docs, verification

- [ ] **Step 1: Screenshots.**
  - Take dark and light shots of: the query tab idle; after Run with results; with an error (Messages); with History open; and with Explain.
  - Use the seeded SQLite demo, query tab variant (`seed-demo.py … 1`): click Run, then the History toggle, then Explain.
  - Compare with `s3-newquery.png`.
  - Check Review Focus #5 (history scroll) and the editor gutter.
- [ ] **Step 2: Docs.** In `docs/FEATURE_MATRIX.md`, no status changes. If a row names the "Ctrl+Enter" hint text or the history panel wording, update the wording (`grep -n "istory\|Ctrl+Enter" docs/FEATURE_MATRIX.md`).
- [ ] **Step 3: Full verification.**
  Run: `npm run typecheck && npm run lint && npm test && npm run build`
  Expected: all pass.
- [ ] **Step 4: Finish.** Run the whole-branch review with a fresh reviewer, then the fix pass, push, and open the PR (no `full-ci`). Squash-merge after **CI passed**.
