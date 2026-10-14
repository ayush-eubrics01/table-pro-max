# Design revamp PR 5 (Table views) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the table views to design screens 03, 04, 05, 10 and 11 without changing behaviour:
- **Data:** toolbar, access pill, filter chips, grid cells, floating commit bar, footer and the row inspector.
- **Structure and Definition.**
- **Dialogs:** review changes and destructive confirm.

**Architecture:**
- **Logic stays where it is.** It lives in `TableView.tsx`, `DataGrid.tsx`, `RowDetail.tsx`, `StructureView.tsx`, `DefinitionView.tsx` and `ReviewChangesDialog.tsx`; only markup and CSS change.
- **Three small pieces are new:**
  - `FilterChips` shows the applied filter, read-only.
  - `SqlBlock` shows highlighted SQL with line numbers. It uses the `@lezer/highlight` and `@codemirror/lang-sql` packages the editor already depends on.
  - `cellTone()` decides enum tags and boolean colours.
- **Dialogs** gain an optional subtitle and a danger tone.

**Tech Stack:** React 19 + TypeScript, `@tanstack/react-virtual` grid, `@lezer/highlight` 1.2.5, `@codemirror/lang-sql` 6.10.0, vitest + Testing Library (jsdom) with `@tauri-apps/api/mocks`.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`. See the rows "Table: Data", "Table: Structure / Definition" and "Review changes / destructive confirm" of "Screens (phase 1 mapping)". Design: `FLOW.md` §03, 04, 05, 10, 11, and prototype shots `target/tpm-scratch/design-shots/s1-table.png`, `s3-row.png`, `s3-edit.png`, `s3-review.png`, `s1-structure.png`, `s1-definition.png`.

## Global Constraints
- **No new behaviour (phase 1).** These stay out of scope:
  - FK jump, "filter by this value", Copy JSON / Copy INSERT, Pin;
  - type-to-confirm, a direct "Commit" that skips review, and inspector ↑/↓ buttons;
  - removing a filter by clicking a chip's ×.

  The spec names exactly two small additions for these screens, both read-only:
  - **"Open in editor" on the Definition view** opens the DDL in a new query tab and never runs it.
  - **"Copy SQL" in the review dialog** copies the generated SQL.
- **Existing accessible names and labels stay:**
  - "Review and commit", "Commit changes", "Discard", "N pending change(s)";
  - "Toggle row details", "Reload", "Delete selected rows", "Duplicate row", "Export", "Import";
  - "Rows per page", "Previous page", "Next page";
  - "Edit {column}", "Drop {column}", "Drop index {name}".

  Wording changes the spec allows, each listed in the PR description:
  - **Read-only reason:** it moves from visible text into the Read-only pill's `title`, so the test switches to `getByTitle`.
  - **Review dialog Cancel** becomes "Keep editing".
  - **Structure nullable:** "yes/no" becomes "nullable/required".
- **Tokens only** (`tokens.css`); no `color-mix()`. Production keeps the danger commit button and its environment badge in the review dialog.
- **Code style:** about 160-column lines; no formatter run on whole files; match the surrounding code.
- **Node 24:** `source ~/.nvm/nvm.sh && nvm use 24`.

## Review Focus
1. **Read-only connection or view:** the pill reads "Read-only" with the reason in its title. There's no +Row or Delete, and no commit bar (Task 1 test).
2. **The commit bar never hides the last rows:** the grid gets `bottomInset` while changes are pending, so the last row scrolls clear of the bar (Task 1 and Task 2 tests).
3. **NULL in an enum or boolean column stays an italic NULL,** not a tag or a coloured value. The text "true" in a text column is not coloured (Task 2 test).
4. **Long SQL in Definition and Review** scrolls horizontally. Line numbers match lines, including blank lines and a trailing newline (Task 4 test).
5. **Production review dialog:** keeps the environment badge, the target and the danger commit button (Task 5 test).

---

### Task 1: Data toolbar, access pill, filter chips, commit bar, footer

**Files:**
- Create: `src/features/filters/FilterChips.tsx`, `src/features/filters/FilterChips.test.tsx`
- Modify: `src/features/data-browser/TableView.tsx`, `src/features/data-browser/TableView.test.tsx`
- Modify: `src/features/data-grid/DataGrid.tsx` (new optional prop `bottomInset`)
- Modify: `src/styles/app.css`

**Interfaces:**
- Consumes: `filterToText(node)`, `countConditions(node)`, `GroupNode` from `src/features/filters/filterModel.ts`.
- Produces:
  - `export function FilterChips({ filter, onEdit }: { filter: GroupNode; onEdit: () => void })`, which renders nothing when no condition is enabled;
  - `DataGridProps.bottomInset?: number` (extra scroll space under the last row, in px).

- [ ] **Step 1: Write the failing tests**

`src/features/filters/FilterChips.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterChips } from "./FilterChips";
import type { GroupNode } from "./filterModel";

afterEach(cleanup);

const filter: GroupNode = {
  type: "group",
  logic: "and",
  children: [
    { type: "condition", column: "status", op: "eq", value: "PAID" },
    { type: "condition", column: "note", op: "is_null" },
    { type: "condition", column: "total", op: "gt", value: "10", enabled: false },
  ],
};

describe("FilterChips", () => {
  it("shows each enabled condition as a chip and opens the editor on click", () => {
    const onEdit = vi.fn();
    render(<FilterChips filter={filter} onEdit={onEdit} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent(/status/);
    expect(list).toHaveTextContent(/note/);
    expect(list).not.toHaveTextContent(/total/);
    fireEvent.click(screen.getAllByRole("button", { name: /Edit filter/ })[0]!);
    expect(onEdit).toHaveBeenCalled();
  });

  it("renders nothing without enabled conditions", () => {
    const { container } = render(<FilterChips filter={{ type: "group", logic: "and", children: [] }} onEdit={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

Check the op names (`eq`, `is_null`, `gt`) against `OPS` in `filterModel.ts` before running, and use the real names.

In `TableView.test.tsx`:
- Replace the read-only test's last line with `expect(screen.getByTitle("This connection is read-only")).toHaveTextContent("Read-only");`.
- Add:

```tsx
  it("shows the access pill, and pending changes in a floating bar", async () => {
    renderView();
    expect(await screen.findByText("Writable")).toBeInTheDocument();
    const editor = await openEditor("ada@example.com");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    const bar = await screen.findByRole("region", { name: "Pending changes" });
    expect(bar).toHaveTextContent("1 pending change");
    expect(within(bar).getByRole("button", { name: /Discard/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Review and commit" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/filters/FilterChips.test.tsx src/features/data-browser`
Expected: FAIL. FilterChips fails to resolve. TableView has no "Writable" pill, no "Pending changes" region, and no title on the read-only text.

- [ ] **Step 3: Implement**

`src/features/filters/FilterChips.tsx`:

```tsx
import { Icon } from "../../components/Icon";
import { filterToText, type GroupNode } from "./filterModel";

/** The applied filter as read-only chips; clicking one opens the filter editor. */
export function FilterChips({ filter, onEdit }: { filter: GroupNode; onEdit: () => void }) {
  const active = filter.children.filter((c) => c.enabled !== false);
  if (active.length === 0) return null;
  return (
    <div className="filter-chips">
      <Icon name="filter_list" size={14} />
      <ul aria-label="Active filters">
        {active.map((c, i) => (
          <li key={i}>
            {i > 0 && <span className="logic">{filter.negate ? "" : filter.logic}</span>}
            <button className="chip" aria-label={`Edit filter ${filterToText(c)}`} onClick={onEdit}>
              <span className="mono">{filterToText(c)}</span>
            </button>
          </li>
        ))}
      </ul>
      {filter.negate && <span className="hint">(negated)</span>}
    </div>
  );
}
```

In `TableView.tsx`:

1. **Toolbar right side.** Replace the `readOnlyReason ? <span className="meta" …>` element with nothing (the pill below takes over). After `<span className="grow" />`, remove the pending block (`{nPending > 0 && (…)}`). Before the "Toggle row details" button, insert:

```tsx
            <span className={`access-pill ${readOnlyReason ? "ro" : ""}`} title={readOnlyReason ?? "Edits stay pending until you review and commit them"}>
              <Icon name={readOnlyReason ? "lock" : "edit"} size={13} />
              {readOnlyReason ? "Read-only" : "Writable"}
            </span>
```

2. **Filter chips.** Inside the `view === "data"` fragment, directly before `{filtersOpen && structure && (`, add:

```tsx
          {!filtersOpen && <FilterChips filter={filter} onEdit={() => { setDraftFilter(filter); setFiltersOpen(true); }} />}
```

Import `FilterChips` from `../filters/FilterChips`.

3. **Commit bar.** Inside `<div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>`, give that div `className="grid-area"`, keep its style, and add `position: "relative"`. Then, after the `DataGrid` element and before `grid-footer`, add:

```tsx
              {nPending > 0 && (
                <div className="commit-bar" role="region" aria-label="Pending changes">
                  <span className="dot" />
                  <span role="status">{pluralize(nPending, "pending change")}</span>
                  <button className="btn btn-ghost" onClick={() => setPending(EMPTY_PENDING)}>
                    <Icon name="undo" size={14} /> Discard
                  </button>
                  <button className="btn btn-primary" onClick={openReview}>
                    Review and commit
                  </button>
                </div>
              )}
```

Pass `bottomInset={nPending > 0 ? 56 : 0}` to `DataGrid`.

4. **Footer.** Change the "Count rows" button's class to `btn btn-link`. Nothing else changes in the footer.

In `DataGrid.tsx`, add `bottomInset?: number;` to the props interface with the doc comment `/** Extra scroll space below the last row (px), e.g. under a floating bar. */`. Then add `+ (bottomInset ?? 0)` to `totalHeight` (`HEADER_HEIGHT + rowVirtualizer.getTotalSize()`), which sizes the inner element.

CSS, appended in the "---- toolbar"/grid area of `app.css`:

```css
.access-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--text-sm);
  color: var(--text-muted);
  white-space: nowrap;
}
.access-pill.ro {
  color: var(--text);
  border-color: var(--border-strong);
}
.filter-chips {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
  color: var(--text-faint);
  flex: none;
}
.filter-chips ul {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.filter-chips li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.filter-chips .logic {
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border-input);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: var(--text-xs);
  cursor: pointer;
  max-width: 360px;
}
.chip .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip:hover {
  border-color: var(--border-strong);
}
.grid-area {
  position: relative;
}
.commit-bar {
  position: absolute;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 6px 6px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  box-shadow: var(--shadow-pop);
  white-space: nowrap;
}
.commit-bar .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warning);
}
.btn-link {
  border: 0;
  background: none;
  padding: 0 4px;
  color: var(--accent);
  cursor: pointer;
}
.btn-link:hover {
  text-decoration: underline;
}
```

Then change `.grid-footer` to `height: 32px` and `gap: var(--space-3)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/filters src/features/data-browser && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/filters/FilterChips.tsx src/features/filters/FilterChips.test.tsx src/features/data-browser src/features/data-grid/DataGrid.tsx src/styles/app.css
git commit -m "design: table toolbar with access pill, filter chips and a floating commit bar"
```

---

### Task 2: Grid cells (FK icon, enum tags, booleans) and header

**Files:**
- Modify: `src/lib/cells.ts` (add `cellTone`)
- Create: `src/lib/cells.test.ts` if missing. If it exists, append to it.
- Create: `src/features/data-grid/DataGrid.test.tsx`
- Modify: `src/features/data-grid/DataGrid.tsx` (`GridColumn.foreignKey`, tone classes)
- Modify: `src/features/data-browser/TableView.tsx` (pass `foreignKey`)
- Modify: `src/styles/app.css` (grid block)

**Interfaces:**
- Produces:
  - `export function cellTone(typeName: string, value: Cell | undefined): "enum" | "true" | "false" | null`;
  - `GridColumn.foreignKey?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/cells.test.ts` (create it with the imports below if it does not exist):

```ts
import { describe, expect, it } from "vitest";
import { cellTone } from "./cells";

describe("cellTone", () => {
  it("tags enum values and colours booleans, never NULL or other types", () => {
    expect(cellTone("status_enum", "DRAFT")).toBe("enum");
    expect(cellTone("enum('a','b')", "a")).toBe("enum");
    expect(cellTone("status_enum", null)).toBeNull();
    expect(cellTone("boolean", "true")).toBe("true");
    expect(cellTone("bool", "f")).toBe("false");
    expect(cellTone("boolean", null)).toBeNull();
    expect(cellTone("text", "true")).toBeNull();
    expect(cellTone("integer", "1")).toBeNull();
  });
});
```

`src/features/data-grid/DataGrid.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DataGrid } from "./DataGrid";

afterEach(cleanup);

const columns = [
  { name: "id", typeName: "integer", primaryKey: true },
  { name: "status", typeName: "status_enum" },
  { name: "paid", typeName: "boolean" },
  { name: "owner_id", typeName: "integer", foreignKey: true },
];
const rows = [
  ["1", "DRAFT", "true", "7"],
  ["2", null, "false", null],
];

describe("DataGrid", () => {
  it("marks keys in the header and styles enum and boolean cells", () => {
    render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={rows.length} getRow={(i) => rows[i]} sort={[]} />);
    expect(screen.getByLabelText("Primary key")).toBeInTheDocument();
    expect(screen.getByLabelText("Foreign key")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toHaveClass("tag");
    expect(screen.getByText("true").closest(".grid-cell")).toHaveClass("bool-true");
    expect(screen.getByText("false").closest(".grid-cell")).toHaveClass("bool-false");
    const nulls = screen.getAllByText("NULL");
    expect(nulls.every((n) => !n.classList.contains("tag"))).toBe(true);
  });

  it("adds scroll space under the last row when asked", () => {
    const { container } = render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={2} getRow={(i) => rows[i]} sort={[]} bottomInset={56} />);
    const sized = container.querySelector(".grid > div:not(.grid-header)") as HTMLElement | null;
    expect(sized?.style.height).toMatch(/px$/);
    expect(parseInt(sized!.style.height, 10)).toBeGreaterThanOrEqual(56);
  });
});
```

Before running, read the `DataGrid` props and the scroll markup. If a prop that the test omits is required (`getRow`, `sort` and so on), pass a no-op. If the sized element isn't `.grid > div:not(.grid-header)`, point the selector at it. The DOM shape decides this; the assertion must not change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/cells.test.ts src/features/data-grid`
Expected: FAIL: `cellTone` is not exported, there's no "Foreign key" label, and there are no tag or bool classes. The bottomInset test may already pass if the Task 1 change is in place; that's fine, because Task 1 introduced it.

- [ ] **Step 3: Implement**

`src/lib/cells.ts` (next to `isBooleanType`):

```ts
const ENUM = /enum/i;
const TRUE = /^(t|true|1|yes|on)$/i;
const FALSE = /^(f|false|0|no|off)$/i;

/** How a cell is drawn: enum values as tags, booleans coloured. NULL and binary values are never toned. */
export function cellTone(typeName: string, value: Cell | undefined): "enum" | "true" | "false" | null {
  if (value === null || value === undefined || isBinary(value)) return null;
  if (isBooleanType(typeName)) return TRUE.test(value) ? "true" : FALSE.test(value) ? "false" : null;
  if (ENUM.test(typeName)) return "enum";
  return null;
}
```

`DataGrid.tsx`:
- Add `foreignKey?: boolean;` to `GridColumn`.
- In the header, after the primary-key icon, add `{c.foreignKey && <Icon name="link" size={12} label="Foreign key" />}`. Check that `link` is in `icons.generated.ts`. If not, add it to `ICONS` in `scripts/gen-icons.mjs` and run `node scripts/gen-icons.mjs`.
- In the cell, compute `const tone = cellTone(c.typeName, v);`, add `tone === "true" ? "bool-true" : tone === "false" ? "bool-false" : ""` to `cls`, and render the value as

```tsx
                        <span className={tone === "enum" ? "tag" : undefined}>{v === undefined ? "…" : cellDisplay(v)}</span>
```

`TableView.tsx`: in the `columns=` mapping, add `foreignKey: !!structure.foreignKeys?.some((f) => f.columns.includes(c.name))`.

CSS (grid block):

```css
.grid-hcell .icon {
  color: var(--warning);
}
.grid-hcell .icon[aria-label="Foreign key"] {
  color: var(--syn-number);
}
.grid-cell .tag {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: var(--text-xs);
  line-height: 16px;
  letter-spacing: 0.02em;
}
.grid-cell.bool-true > span {
  color: var(--accent);
}
.grid-cell.bool-false > span {
  color: var(--text-muted);
}
.grid-row.inserted .grid-rownum {
  box-shadow: inset 3px 0 0 var(--accent);
}
```

The Icon's `label` sets `aria-label`; check `Icon.tsx`. If the label lives elsewhere, adjust the `.icon[aria-label=…]` selector to match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib src/features/data-grid src/features/data-browser && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cells.ts src/lib/cells.test.ts src/features/data-grid src/features/data-browser/TableView.tsx src/styles/app.css scripts/gen-icons.mjs src/components/icons.generated.ts
git commit -m "design: grid marks foreign keys, shows enum values as tags and colours booleans"
```

---

### Task 3: Row inspector

**Files:**
- Modify: `src/features/data-browser/RowDetail.tsx`
- Create: `src/features/data-browser/RowDetail.test.tsx`
- Modify: `src/features/data-browser/TableView.tsx` (new props)
- Modify: `src/styles/app.css` (detail panel block)

**Interfaces:**
- `RowDetail` props become `{ columns; row; editable; onEdit; heading: string; subheading: string; isEdited: (col: number) => boolean; onClose: () => void }`.

- [ ] **Step 1: Write the failing test** (`src/features/data-browser/RowDetail.test.tsx`)

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RowDetail } from "./RowDetail";
import { usersStructure } from "../../test/fixtures";

afterEach(cleanup);

const base = {
  columns: usersStructure.columns,
  row: ["3", "ada@example.com", null],
  editable: (c: number) => c !== 0,
  onEdit: () => undefined,
  heading: "Row 3",
  subheading: "users",
  isEdited: (c: number) => c === 1,
  onClose: () => undefined,
};

describe("RowDetail", () => {
  it("names the row, marks nullable and edited fields, and closes", () => {
    const onClose = vi.fn();
    render(<RowDetail {...base} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Row 3" })).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("nullable")).toBeInTheDocument();
    expect(screen.getByText("edited")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close row details" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("locks fields that cannot be edited", () => {
    render(<RowDetail {...base} />);
    expect(screen.queryByLabelText("id")).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByLabelText("email")).toHaveValue("ada@example.com");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/data-browser/RowDetail.test.tsx`
Expected: FAIL (no heading, no "nullable" or "edited" markers, no close button).

- [ ] **Step 3: Implement**

`RowDetail.tsx`. Extend `Props` with `heading`, `subheading`, `isEdited` and `onClose`. Wrap the output:

```tsx
export function RowDetail({ columns, row, editable, onEdit, heading, subheading, isEdited, onClose }: Props) {
  return (
    <aside className="detail-panel" aria-label="Row details">
      <header className="detail-head">
        <div>
          <h2>{row ? heading : "Inspector"}</h2>
          <span className="sub">{row ? subheading : "No row selected"}</span>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Close row details" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {!row ? (
        <p className="detail-empty">Select a row to see its fields.</p>
      ) : (
        <div className="detail-fields">
          {columns.map((c, i) => (
            <Field key={c.name} column={c} value={row[i] ?? null} editable={editable(i)} edited={isEdited(i)} onEdit={(v) => onEdit(i, v)} />
          ))}
        </div>
      )}
    </aside>
  );
}
```

In `Field`, add an `edited: boolean` prop. Replace the `<label>` with:

```tsx
      <label>
        <span className="name">{column.name}</span>
        <span className="type">
          {column.dataType}
          {column.nullable ? " · nullable" : ""}
        </span>
        {edited && <span className="edited">edited</span>}
      </label>
```

The test looks for the text "nullable" alone, so render it as its own element: `{column.nullable && <span className="type">nullable</span>}` beside the type span, instead of concatenating. Give the textarea the class `textarea${edited ? " is-edited" : ""}`. Keep the rest (Set NULL, Format JSON, Copy). Import `Icon`.

`TableView.tsx` passes:

```tsx
                heading={selection.active ? `Row ${offset + selection.active.row + 1}` : "Inspector"}
                subheading={table}
                isEdited={(c) => selection.active !== null && selection.active.row < rows.length && pending.edits[selection.active.row]?.[c] !== undefined}
                onClose={() => setDetailOpen(false)}
```

CSS. Replace the detail panel block (`.detail-panel` through `.detail-field pre`) with:

```css
.detail-panel {
  width: 320px;
  flex: none;
  border-left: 1px solid var(--border-hairline);
  background: var(--surface-panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--border-hairline);
}
.detail-head h2 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}
.detail-head .sub {
  font-family: var(--font-code);
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.detail-empty {
  margin: 0;
  padding: var(--space-4) 14px;
  color: var(--text-muted);
}
.detail-fields {
  overflow: auto;
  flex: 1;
}
.detail-field {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-field label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--text-sm);
}
.detail-field label .name {
  font-weight: 600;
}
.detail-field label .type {
  font-family: var(--font-code);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.detail-field label .edited {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--warning);
}
.detail-field textarea {
  min-height: 32px;
  font-family: var(--font-code);
  font-size: var(--text-sm);
}
.detail-field textarea.is-edited {
  border-color: var(--warning);
  background: var(--edited-bg);
}
.detail-field pre {
  margin: 0;
  padding: 7px 10px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: var(--text-sm);
  user-select: text;
}
.detail-field .btn-ghost {
  height: 24px;
  font-size: var(--text-xs);
}
```

The old `.detail-panel.empty` usage is gone, because the empty state now lives inside the panel.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/data-browser && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/data-browser src/styles/app.css
git commit -m "design: row inspector with header, field types and edited markers"
```

---

### Task 4: SqlBlock, Definition and Structure

**Files:**
- Create: `src/components/SqlBlock.tsx`, `src/components/SqlBlock.test.tsx`
- Create: `src/features/schema-browser/DefinitionView.test.tsx`
- Modify: `src/features/schema-browser/DefinitionView.tsx`, `src/features/schema-browser/StructureView.tsx`
- Modify: `src/features/data-browser/TableView.tsx` (prop `onOpenSql`), `src/app/WorkspaceView.tsx` (pass `onOpenSql`)
- Modify: `src/styles/app.css` (structure block, `.sql-block`)

**Interfaces:**
- Produces:
  - `export function SqlBlock({ sql, dialect, maxHeight }: { sql: string; dialect: Dialect; maxHeight?: string })`;
  - `DefinitionView` prop `onOpenSql?: (sql: string, title: string) => void`;
  - `TableView` prop `onOpenSql?: (sql: string, title: string) => void`.

- [ ] **Step 1: Write the failing tests**

`src/components/SqlBlock.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SqlBlock } from "./SqlBlock";

afterEach(cleanup);

describe("SqlBlock", () => {
  it("numbers every line and highlights keywords and strings", () => {
    const sql = "CREATE TABLE t (\n\n  name text DEFAULT 'x'\n);\n";
    const { container } = render(<SqlBlock sql={sql} dialect="postgres" />);
    const lines = container.querySelectorAll(".sql-line");
    expect(lines).toHaveLength(5);
    expect(Array.from(lines).map((l) => l.querySelector(".ln")?.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(container.querySelector(".syn-keyword")?.textContent).toBe("CREATE");
    expect(container.querySelector(".syn-string")?.textContent).toBe("'x'");
    expect(Array.from(lines).map((l) => l.querySelector(".code")?.textContent).join("\n")).toBe(sql);
  });
});
```

`src/features/schema-browser/DefinitionView.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DefinitionView } from "./DefinitionView";
import { session } from "../../test/fixtures";

const DDL = 'CREATE TABLE "public"."users" (\n  "id" integer NOT NULL\n);';

beforeEach(() => mockIPC((cmd) => (cmd === "object_definition" ? DDL : null)));
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("DefinitionView", () => {
  it("shows the DDL with line numbers and opens it in the editor without running it", async () => {
    const onOpenSql = vi.fn();
    render(<DefinitionView session={session} schema="public" name="users" kind="table" onOpenSql={onOpenSql} />);
    expect(await screen.findByText("3")).toHaveClass("ln");
    fireEvent.click(screen.getByRole("button", { name: /Open in editor/ }));
    expect(onOpenSql).toHaveBeenCalledWith(DDL, "users (definition)");
    expect(screen.getByRole("button", { name: /Copy SQL/ })).toBeInTheDocument();
  });

  it("hides Open in editor when there is nowhere to open it", async () => {
    render(<DefinitionView session={session} schema="public" name="users" kind="table" />);
    await screen.findByText("3");
    expect(screen.queryByRole("button", { name: /Open in editor/ })).not.toBeInTheDocument();
  });
});
```

Check that the command name in `api.objectDefinition` is `object_definition` (`src/lib/ipc.ts`) and use the real one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/SqlBlock.test.tsx src/features/schema-browser`
Expected: FAIL. SqlBlock doesn't resolve, and DefinitionView has no line numbers and no Open in editor button.

- [ ] **Step 3: Implement**

`src/components/SqlBlock.tsx`:

```tsx
import { useMemo } from "react";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import type { Dialect } from "../types/backend";

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], class: "syn-keyword" },
  { tag: [t.string, t.special(t.string)], class: "syn-string" },
  { tag: [t.number, t.bool, t.null], class: "syn-number" },
  { tag: [t.lineComment, t.blockComment, t.comment], class: "syn-comment" },
  { tag: [t.typeName, t.standard(t.name)], class: "syn-type" },
]);

function language(d: Dialect) {
  return (d === "postgres" ? PostgreSQL : d === "sqlite" ? SQLite : MySQL).language;
}

type Segment = { text: string; cls: string };

/** Split highlighted SQL into lines of segments. */
function highlightLines(sql: string, dialect: Dialect): Segment[][] {
  const lines: Segment[][] = [[]];
  const tree = language(dialect).parser.parse(sql);
  highlightCode(
    sql,
    tree,
    highlighter,
    (text, cls) => lines[lines.length - 1]!.push({ text, cls }),
    () => lines.push([]),
  );
  return lines;
}

/** Read-only SQL with line numbers and the editor's syntax colours. */
export function SqlBlock({ sql, dialect, maxHeight }: { sql: string; dialect: Dialect; maxHeight?: string }) {
  const lines = useMemo(() => highlightLines(sql, dialect), [sql, dialect]);
  return (
    <div className="sql-block" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((segs, i) => (
        <div className="sql-line" key={i}>
          <span className="ln" aria-hidden>
            {i + 1}
          </span>
          <span className="code">
            {segs.map((s, j) =>
              s.cls ? (
                <span key={j} className={s.cls}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
```

The test joins lines with `\n`: a trailing newline gives an empty last line, so 4 newlines make 5 lines, and joining recovers the text exactly.

`DefinitionView.tsx`:
- Add the prop `onOpenSql?: (sql: string, title: string) => void`.
- Replace the `sql !== null` fragment with:

```tsx
        <>
          <div className="definition-bar">
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(sql); notify("Definition copied", "success"); }}>
              <Icon name="content_copy" size={14} /> Copy SQL
            </button>
            {onOpenSql && (
              <button className="btn" onClick={() => onOpenSql(sql, `${name} (definition)`)}>
                <Icon name="terminal" size={14} /> Open in editor
              </button>
            )}
            <span className="grow" />
            <span className="hint">Generated from the catalog · read-only</span>
          </div>
          <SqlBlock sql={sql} dialect={session.dialect} />
        </>
```

`TableView.tsx`: add `onOpenSql?: (sql: string, title: string) => void` to `Props` and pass it to `DefinitionView`.

`WorkspaceView.tsx`: pass `onOpenSql={(sql, title) => openQuery(ws.id, { sql, title })}` to `TableView` and to the definition tab's `DefinitionView`. Destructure `openQuery` from `useWorkspaces.getState()` again.

`StructureView.tsx`:
- Wrap each section's heading so the header row holds the title, a count, and (for Columns) the existing "+ Column" / "+ Index" buttons on the right. Move those buttons out of the top `field-row` into the Columns header, and keep the pending-structure-changes controls in the top row.
- Wrap each `<table className="table">` in `<div className="table-card">`.
- Change the nullable cell to `<td className={c.nullable ? "nullable" : "required"}>{c.nullable ? "nullable" : "required"}</td>`.
- In the key cell, after the PK icon, add `{s.foreignKeys.some((f) => f.columns.includes(c.name)) && <Icon name="link" size={12} label="Foreign key" />}`.

Heading example for Columns:

```tsx
        <div className="section-head">
          <h3>
            Columns <span className="count">{s.columns.length}</span>
          </h3>
          {editable && (
            <>
              <button className="btn" onClick={() => setColumnDialog({ mode: "add" })}>
                <Icon name="add" size={14} /> Column
              </button>
              <button className="btn" onClick={() => setIndexDialog(true)}>
                <Icon name="add" size={14} /> Index
              </button>
            </>
          )}
        </div>
```

Use the existing condition that gates these buttons today; read it from the current top `field-row`. Indexes, Foreign keys and Constraints get the same `section-head` with a count and no buttons.

CSS. Replace `.structure` through `.table tr.removed td` and `.code-block` with the following. Keep `.code-block` as is, because other views use it, and add the new rules:

```css
.structure {
  overflow: auto;
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.section-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.section-head h3 {
  flex: 1;
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
}
.section-head .count {
  margin-left: 4px;
  font-family: var(--font-code);
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--text-faint);
}
.table-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  user-select: text;
}
.table th,
.table td {
  text-align: left;
  padding: 9px 14px;
  border-bottom: 1px solid var(--grid-line);
  vertical-align: middle;
}
.table tr:last-child td {
  border-bottom: 0;
}
.table th {
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 500;
  position: sticky;
  top: 0;
}
.table td.mono {
  font-size: var(--text-xs);
}
.table td.nullable {
  color: var(--syn-number);
}
.table td.required {
  color: var(--text-muted);
}
.table td .icon[aria-label^="Primary key"] {
  color: var(--warning);
}
.table tr.pending td {
  background: var(--edited-bg);
}
.table tr.removed td {
  background: var(--deleted-bg);
  text-decoration: line-through;
}
.definition-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.definition-bar .grow {
  flex: 1;
}
.sql-block {
  margin: 0;
  padding: 12px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-sunken);
  font-family: var(--font-code);
  font-size: var(--text-sm);
  line-height: 21px;
  overflow: auto;
  user-select: text;
}
.sql-line {
  display: flex;
  white-space: pre;
}
.sql-line .ln {
  flex: none;
  width: 44px;
  padding-right: 14px;
  text-align: right;
  color: var(--text-faint);
  user-select: none;
}
.sql-line .code {
  padding-right: 16px;
}
.syn-keyword {
  color: var(--syn-keyword);
}
.syn-string {
  color: var(--syn-string);
}
.syn-number {
  color: var(--syn-number);
}
.syn-type {
  color: var(--syn-type);
}
.syn-comment {
  color: var(--syn-comment);
  font-style: italic;
}
```

Check `--syn-number` against `--surface` and `--bg` for 3:1 with the theme checker (it is a coloured status word on table rows). If it fails, use `--accent` for `td.nullable`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components src/features/schema-browser src/features/data-browser src/app && npm run typecheck && npm run lint`
Expected: PASS, and typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/SqlBlock.tsx src/components/SqlBlock.test.tsx src/features/schema-browser src/features/data-browser/TableView.tsx src/app/WorkspaceView.tsx src/styles/app.css
git commit -m "design: Structure as section cards, Definition with line numbers, Copy SQL and Open in editor"
```

---

### Task 5: Review changes and confirm dialogs

**Files:**
- Modify: `src/components/Dialog.tsx` (props `subtitle`, `tone`)
- Modify: `src/features/data-browser/ReviewChangesDialog.tsx` (+ new test file `ReviewChangesDialog.test.tsx`)
- Modify: `src/features/data-browser/TableView.tsx` (pass `statements` from the preview's `statementCount`)
- Modify: `src/components/Overlays.tsx` (confirm uses `tone="danger"` when `danger`)
- Modify: `src/styles/app.css` (dialog block)

**Interfaces:**
- `Dialog` props add `subtitle?: ReactNode; tone?: "danger"`.
- `ReviewChangesDialog` props add `statements?: number`.

- [ ] **Step 1: Write the failing test** (`src/features/data-browser/ReviewChangesDialog.test.tsx`)

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { session } from "../../test/fixtures";

afterEach(cleanup);

const props = {
  session,
  title: "Review changes",
  sql: "UPDATE \"users\" SET \"email\" = 'a' WHERE \"id\" = 1;",
  summary: "1 change to public.users",
  atomic: true,
  statements: 1,
  commitLabel: "Commit changes",
  onCommit: async () => undefined,
  onClose: () => undefined,
};

describe("ReviewChangesDialog", () => {
  it("summarises statements, target and transaction, and keeps production unmistakable", () => {
    render(<ReviewChangesDialog {...props} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`1 statement · ${session.connectionName} · one transaction`)).toBeInTheDocument();
    expect(within(dialog).getByText("Production")).toBeInTheDocument();
    expect(within(dialog).getByText(session.target)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Commit changes" })).toHaveClass("btn-danger");
    expect(dialog.querySelector(".syn-keyword")?.textContent).toBe("UPDATE");
  });

  it("copies the SQL and goes back to editing", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onClose = vi.fn();
    render(<ReviewChangesDialog {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy SQL/ }));
    expect(writeText).toHaveBeenCalledWith(props.sql);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/data-browser/ReviewChangesDialog.test.tsx`
Expected: FAIL. There is no subtitle, no highlighted SQL, no Copy SQL, and no "Keep editing".

- [ ] **Step 3: Implement**

`Dialog.tsx`:
- Add `subtitle?: ReactNode; tone?: "danger";` to `DialogProps`.
- Add `${tone === "danger" ? "dialog-danger" : ""}` to the class list.
- Change the header to:

```tsx
        <div className="dialog-header">
          {tone === "danger" && <Icon name="warning" size={18} className="dialog-tone-icon" />}
          <div className="dialog-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="dialog-subtitle">{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
```

`ReviewChangesDialog.tsx`:
- Add the optional `statements?: number` prop.
- Pass `subtitle={[statements !== undefined ? pluralize(statements, "statement") : null, session.connectionName, atomic ? "one transaction" : "no transaction"].filter(Boolean).join(" · ")}` to `Dialog`, importing `pluralize` from `../../lib/text`.
- Pass `tone={session.environment === "production" ? "danger" : undefined}`.
- Replace the `<pre className="code-block">` with `<SqlBlock sql={sql} dialect={session.dialect} maxHeight="45vh" />`.
- Footer:

```tsx
        <>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(sql)} disabled={busy}>
            <Icon name="content_copy" size={14} /> Copy SQL
          </button>
          <span className="spacer" />
          <span className="hint">{atomic ? "All changes apply or none do." : "This database cannot run these statements in one transaction."}</span>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Keep editing
          </button>
          <button className={`btn ${session.environment === "production" ? "btn-danger" : "btn-primary"}`} onClick={commit} disabled={busy}>
            {busy ? "Committing…" : commitLabel}
          </button>
        </>
```

Keep the env badge and target row in the body, and the summary.

`TableView.tsx`: store `statements: preview.statementCount` in the `review` state (extend its type to `{ sql: string; atomic: boolean; statements: number }`) and pass `statements={review.statements}`.

`Overlays.tsx`: give the confirm `Dialog` the prop `tone={confirm.danger ? "danger" : undefined}`.

CSS (dialog block). Change `.dialog-header` to `align-items: flex-start` and `gap: var(--space-3)`, and add:

```css
.dialog-titles {
  flex: 1;
  min-width: 0;
}
.dialog-subtitle {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.dialog-tone-icon {
  margin-top: 2px;
  color: var(--danger);
}
.dialog-danger {
  border-color: var(--danger);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/data-browser src/components && npm run typecheck`
Expected: PASS. The existing TableView test still clicks "Commit changes" and finds "Production".

- [ ] **Step 5: Commit**

```bash
git add src/components/Dialog.tsx src/components/Overlays.tsx src/features/data-browser src/styles/app.css
git commit -m "design: review dialog with statement summary, highlighted SQL and Copy SQL; danger tone for confirmations"
```

---

### Task 6: Screenshots, docs, verification

- [ ] **Step 1: Docs.**
  - In `docs/FEATURE_MATRIX.md`, find the Definition / DDL row (`grep -n "efinition" docs/FEATURE_MATRIX.md`) and add "Open in editor (new query tab, not run)".
  - Find the commit / review row and mention "Copy SQL".
  - Status stays as it is (IMPLEMENTED or VERIFIED); cite the new tests.
- [ ] **Step 2: Screenshots** (dark and light):
  - table Data with one pending edit and the inspector open;
  - Structure, Definition, and the review dialog.
  - Use the seeded SQLite demo. For the pending edit: double-click a `note` cell, type, press Enter, then open the inspector with the toolbar toggle.
  - Compare with `s3-edit.png`, `s1-structure.png`, `s1-definition.png` and `s3-review.png`.
  - Check Review Focus #2: scroll to the bottom with the bar visible.
- [ ] **Step 3: Full verification.**
  Run: `npm run typecheck && npm run lint && npm test && npm run build`
  Expected: all pass.
- [ ] **Step 4: Commit the docs** with the message `docs: feature matrix notes Open in editor and Copy SQL`.
- [ ] **Step 5: Finish.** Run the whole-branch review with a fresh reviewer, then the fix pass, push, and open the PR (no `full-ci`). List the wording changes from Global Constraints in the PR body. Squash-merge after **CI passed**.
