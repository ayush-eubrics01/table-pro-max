# Jump to referenced row: design

Date: 2026-10-14. Status: agreed in conversation, awaiting written-spec review.

This is the second of three sub-projects, after large values on demand and before restore history.

## Goal
Wherever a cell holds a foreign key, one click opens the row it points to: the referenced table
opens in a new tab, filtered to exactly that row.

Success means:
- In `orders.customer_id = 42`, clicking the cell's arrow opens `customers` in a new tab, with
  the filter `id = 42` shown as a normal filter chip and one row visible.
- It works in opened tables and in query results whose columns the database traces to a
  foreign-key column.
- Composite foreign keys filter on every column (`a = 1 AND b = 2`).
- No new SQL and no new backend command. It uses the existing filtered `browse`.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| Where | Opened tables and query results. Results need the column's origin, so they work on MySQL, MariaDB and SQLite, and on PostgreSQL for writable connections. |
| Opens in | A new tab every time. The filter is visible and editable as a chip. The current tab (page, selection, pending edits) is untouched. |
| Which keys | Every foreign key. A foreign key must reference a primary or unique key, so the filter matches at most one row. |
| Reverse lookups | Not in scope ("rows that point at this one" is a possible later item). |

## Non-goals
- Reverse references.
- Reusing an existing tab of the referenced table.
- Following references in query results on PostgreSQL read-only connections. They have no
  column origins, because the describe step is skipped there.
- Foreign keys to tables in another database.

## Behaviour
- **When the arrow shows.** On a cell whose column is part of a foreign key. No arrow when:
  - the value is NULL, Not loaded, a preview (`Partial`) or binary;
  - the row is a new unsaved one;
  - for a composite foreign key, any of the key's values is NULL or unusable.
- **How it looks.**
  - A small arrow icon in the cell's right corner. It is visible when the pointer is over the
    cell or the cell is the active (selected) cell, so the grid stays quiet otherwise.
  - The tooltip names the target: "Open customers where id = 42". A composite key shows every
    column, joined with "and".
- **Ways to follow a reference:**
  - clicking the arrow;
  - **Ctrl/⌘+Enter** on the active cell;
  - the cell context menu item **Open referenced row**.
- **A column in more than one foreign key.**
  - The arrow and the shortcut use the first foreign key, in the order the structure lists them.
  - The context menu lists one item per foreign key: "Open referenced row in customers" and
    "Open referenced row in accounts".
- **The new tab:**
  - A table tab for `ref_schema.ref_table`. Its initial filter is an AND group with one enabled
    `eq` condition per referenced column. Each condition's value is the referencing cell's text.
  - The tab's title is the table name, as for any table tab.
  - If the row no longer exists, the tab shows "No rows" with the filter visible.
- **Tabs survive restarts.** The initial filter is stored on the tab model, so a restored
  workspace reopens the tab filtered.

## Implementation outline
- **`src/features/data-browser/fkLinks.ts`** (new, pure functions):
  - `tableLinks(structure: TableStructure): FkLink[][]`: per column index, the foreign keys
    that column belongs to.
  - `resultLinks(columns: ColumnMeta[], structures: TableStructure[]): FkLink[][]`: per result
    column. A column links when its `origin` is a column of a foreign key of the origin table's
    structure. For a composite foreign key, every key column must also appear in the result,
    traced to the same table.
  - `FkLink = { fk: ForeignKeyInfo; columns: number[] /* grid column index for each fk.columns entry */ }`.
  - `linkFilter(link: FkLink, row: Cell[]): GroupNode | null`: the filter for the target table,
    or `null` when any value is unusable.
  - `linkLabel(link: FkLink, row: Cell[]): string`: the tooltip and menu text.
- **`stores/workspaces.ts`:**
  - `openTable(wsId, obj, opts?: { filter?: GroupNode })`.
  - The table tab model gains `filter?: GroupNode`, persisted with the workspace.
- **`TableView`** takes `initialFilter?: GroupNode`. It seeds `filter` and `draftFilter`, so the
  first `browse` uses it and the chip shows it.
- **`DataGrid`:**
  - New optional prop `cellLink?: (row: number, col: number) => { label: string; open: () => void } | null`.
  - It renders the arrow button. The button has `aria-label` set to the label, and its click
    calls `open` without starting an edit.
  - **Ctrl/⌘+Enter** on the active cell calls `open`.
- **`TableView` and `ResultsPanel`** compute links and pass `cellLink`, plus the context-menu
  items. ResultsPanel gets the origin tables' structures through `api.tableStructure`, once per
  result, for the tables in its column origins. The engine caches structures.
- **`WorkspaceView`** passes an `onOpenTable(schema, table, filter)` callback down to
  `TableView` and `QueryTab`/`ResultsPanel`, which calls `openTable` with the filter.

## Safety
- No new SQL path. The filter goes through the existing `browse` and filter compiler: values are
  bind parameters, and columns are checked against the referenced table's structure.
- Read-only connections can follow references, since it's a read.
- No new network calls. Nothing new is written to disk except the tab's filter, which is part
  of the existing local workspace state.

## Testing
- **Unit (`fkLinks.test.ts`):**
  - single and composite foreign keys, and a column in two foreign keys;
  - NULL, Not loaded, `Partial` and binary values give no link;
  - result columns traced through origins;
  - a composite foreign key where one column is missing from the result gives no link;
  - label text.
- **`DataGrid.test.tsx`:**
  - the arrow renders only for linked cells;
  - clicking it calls `open` and doesn't start an inline edit;
  - Ctrl/⌘+Enter on the active cell calls `open`.
- **`TableView.test.tsx`:** following a reference calls `onOpenTable` with the referenced
  schema, table and filter.
- **`WorkspaceView.test.tsx`:** `openTable` with a filter opens a new tab whose first
  `browse_table` request carries that filter, and the chip shows it.
- **`ResultsPanel.test.tsx`:** a result column whose origin is a foreign-key column shows the
  arrow, and following it calls `onOpenTable` with the right target.
- **Manual (Xvfb, test PostgreSQL, isolated data dir):**
  - orders → customers from an opened table and from a `SELECT *` result;
  - a composite foreign key;
  - a deleted target gives "No rows";
  - dark and light screenshots.
- **Docs:** a `FEATURE_MATRIX.md` row "Jump to referenced row".
