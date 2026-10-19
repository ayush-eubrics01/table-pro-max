import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { DataGrid, type GridHandle } from "./DataGrid";
import type { Cell } from "../../types/backend";

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

  it("shows a PostgreSQL enum's values as tags and edits them with a list of its values", () => {
    const cols = [
      { name: "id", typeName: "integer", primaryKey: true },
      { name: "mood", typeName: "mood", enumValues: ["sad", "ok", "happy"] },
    ];
    const data: Cell[][] = [["1", "ok"]];
    const edits: unknown[] = [];
    render(<DataGrid ariaLabel="Rows" columns={cols} rowCount={1} getRow={(i) => data[i]} sort={[]} canEdit={() => true} onEdit={(...a) => edits.push(a)} />);
    expect(screen.getByText("ok")).toHaveClass("tag");
    fireEvent.doubleClick(screen.getByText("ok").closest(".grid-cell")!);
    const list = screen.getByRole("combobox", { name: "Edit mood" });
    expect(list).toHaveValue("ok");
    expect([...(list as HTMLSelectElement).options].map((o) => o.value)).toEqual(["sad", "ok", "happy"]);
    fireEvent.change(list, { target: { value: "happy" } });
    expect(edits).toEqual([[0, 1, "happy"]]);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("doesn't commit an edit when the open editor itself is clicked", () => {
    const cols = [{ name: "mood", typeName: "mood", enumValues: ["sad", "ok"] }];
    const data: Cell[][] = [[null]];
    const edits: unknown[] = [];
    render(<DataGrid ariaLabel="Rows" columns={cols} rowCount={1} getRow={(i) => data[i]} sort={[]} canEdit={() => true} onEdit={(...a) => edits.push(a)} />);
    fireEvent.doubleClick(screen.getByText("NULL").closest(".grid-cell")!);
    const list = screen.getByRole("combobox", { name: "Edit mood" });
    fireEvent.mouseDown(list);
    expect(edits).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Edit mood" })).toBeInTheDocument();
  });

  it("starts an enum edit from a typed key with the current value, and Escape keeps it", () => {
    const cols = [{ name: "mood", typeName: "mood", enumValues: ["sad", "ok"] }];
    const data: Cell[][] = [["sad"]];
    const edits: unknown[] = [];
    render(<DataGrid ariaLabel="Rows" columns={cols} rowCount={1} getRow={(i) => data[i]} sort={[]} canEdit={() => true} onEdit={(...a) => edits.push(a)} />);
    fireEvent.mouseDown(screen.getByText("sad").closest(".grid-cell")!);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "o" });
    const list = screen.getByRole("combobox", { name: "Edit mood" });
    expect(list).toHaveValue("sad");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(edits).toEqual([]);
  });

  it("builds the menu for the cell right-clicked, not the selection before it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const seen: unknown[] = [];
    render(
      <DataGrid
        ariaLabel="Rows"
        columns={columns}
        rowCount={rows.length}
        getRow={(i) => rows[i]}
        sort={[]}
        contextItems={(sel) => (seen.push(sel), [])}
      />,
    );
    fireEvent.mouseDown(screen.getByText("DRAFT").closest(".grid-cell")!);
    fireEvent.contextMenu(screen.getAllByRole("gridcell").find((c) => c.textContent === "2")!);
    expect(seen.at(-1)).toMatchObject({ rows: [1], cols: [0], active: { row: 1, col: 0 } });
    fireEvent.click((await screen.findAllByRole("menuitem", { name: /^Copy/ }))[0]!);
    await waitFor(() => expect(write).toHaveBeenCalledWith("2"));
    // The row number's menu covers the whole row.
    fireEvent.contextMenu(screen.getAllByRole("rowheader")[0]!);
    expect(seen.at(-1)).toMatchObject({ rows: [0], cols: [0, 1, 2, 3] });
  });

  it("adds scroll space under the last row when asked", () => {
    const height = (inset?: number) => {
      const { container, unmount } = render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={2} getRow={(i) => rows[i]} sort={[]} bottomInset={inset} />);
      const sized = container.querySelector(".grid > div:not(.grid-header)") as HTMLElement;
      const h = parseInt(sized.style.height, 10);
      unmount();
      return h;
    };
    expect(height(56) - height()).toBe(56);
  });

  it("shows Not loaded and previews, loads on click, and opens instead of inline editing", () => {
    const cols = [
      { name: "id", typeName: "integer", primaryKey: true },
      { name: "body", typeName: "text", deferred: true },
      { name: "note", typeName: "text" },
    ];
    const data = [["1", { $notLoaded: true }, "x".repeat(300)]] as Cell[][];
    const opened: [number, number, string][] = [];
    const edits: unknown[] = [];
    render(
      <DataGrid
        ariaLabel="Rows"
        columns={cols}
        rowCount={1}
        getRow={(i) => data[i]}
        canEdit={() => true}
        onEdit={(...a) => edits.push(a)}
        onOpenCell={(r, c, how) => (opened.push([r, c, how]), true)}
      />,
    );
    expect(screen.getByLabelText("Loaded on demand")).toBeInTheDocument();
    const nl = screen.getByText("Not loaded").closest(".grid-cell")!;
    expect(nl).toHaveClass("not-loaded");
    fireEvent.click(nl);
    expect(opened).toEqual([[0, 1, "click"]]);
    const long = screen.getByText("300 chars").closest(".grid-cell")!;
    expect(long).toHaveTextContent("x".repeat(80) + "…");
    fireEvent.doubleClick(long);
    expect(opened[1]).toEqual([0, 2, "open"]);
    expect(screen.queryByLabelText("Edit note")).not.toBeInTheDocument();
    expect(edits).toHaveLength(0);
  });

  it("copies full values, fetching placeholders first", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const data = [
      ["1", { $notLoaded: true }, null],
      ["2", "short", null],
    ] as Cell[][];
    const ref = createRef<GridHandle>();
    render(
      <DataGrid
        ref={ref}
        ariaLabel="Rows"
        columns={[{ name: "id", typeName: "integer" }, { name: "body", typeName: "text" }, { name: "n", typeName: "integer" }]}
        rowCount={2}
        getRow={(i) => data[i]}
        loadFull={async (cells) => cells.map(() => "FULL")}
      />,
    );
    fireEvent.mouseDown(screen.getAllByText("1").find((e) => e.closest(".grid-cell"))!.closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getAllByText("NULL")[1]!.closest(".grid-cell")!, { shiftKey: true });
    await act(async () => ref.current!.copySelection(false));
    expect(write).toHaveBeenCalledWith("1\tFULL\t\n2\tshort\t");
  });
  it("shows a reference arrow on linked cells that opens without editing", () => {
    const opened: string[] = [];
    const edits: unknown[] = [];
    render(
      <DataGrid
        ariaLabel="Rows"
        columns={[{ name: "id", typeName: "integer", primaryKey: true }, { name: "customer_id", typeName: "integer", foreignKey: true }]}
        rowCount={1}
        getRow={() => ["1", "42"]}
        canEdit={() => true}
        onEdit={(...a) => edits.push(a)}
        cellLink={(_r, c) => (c === 1 ? { label: "Open customers where id = 42", open: () => opened.push("click") } : null)}
      />,
    );
    const arrow = screen.getByRole("button", { name: "Open customers where id = 42" });
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
    fireEvent.mouseDown(arrow);
    fireEvent.click(arrow);
    fireEvent.doubleClick(arrow);
    expect(opened).toEqual(["click"]);
    expect(screen.queryByLabelText("Edit customer_id")).not.toBeInTheDocument();
    expect(edits).toHaveLength(0);
    // Ctrl/⌘+Enter on the active linked cell.
    fireEvent.mouseDown(screen.getByText("42").closest(".grid-cell")!);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter", ctrlKey: true });
    expect(opened).toEqual(["click", "click"]);
    expect(screen.queryByLabelText("Edit customer_id")).not.toBeInTheDocument();
  });

  it("keeps focus on the grid when the arrow is pressed, and adds no separator without extra menu items", async () => {
    render(
      <DataGrid
        ariaLabel="Rows"
        columns={[{ name: "customer_id", typeName: "integer", foreignKey: true }]}
        rowCount={1}
        getRow={() => ["42"]}
        cellLink={() => ({ label: "Open customers where id = 42", open: () => {} })}
        contextItems={() => []}
      />,
    );
    const pressed = fireEvent.mouseDown(screen.getByRole("button", { name: "Open customers where id = 42" }));
    expect(pressed).toBe(false); // default prevented: the arrow never takes focus
    fireEvent.contextMenu(screen.getByText("42").closest(".grid-cell")!);
    const menu = await screen.findByRole("menu");
    expect(menu.querySelector("hr, [role='separator']")).toBeNull();
  });

  it("keeps a click that lands the moment the grid appears, before React has run its effects", async () => {
    // A click (or a test that found the cell) can reach a grid that has just appeared before
    // React has run its effects. The grid used to clear its selection in such an effect, wiping
    // that click (seen as flaky copy/export/Ctrl+Enter tests under CI load).
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnv = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false; // React schedules effects as in the app, not inside act()
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const draft = () => [...host.querySelectorAll(".grid-cell")].find((c) => c.textContent === "DRAFT");
    try {
      await new Promise<void>((resolve) => {
        const seen = new MutationObserver(() => {
          const cell = draft();
          if (!cell) return;
          seen.disconnect();
          cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1 }));
          resolve();
        });
        seen.observe(host, { childList: true, subtree: true });
        root.render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={rows.length} getRow={(i) => rows[i]} sort={[]} />);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(draft()).toHaveAttribute("aria-selected", "true");
    } finally {
      root.unmount();
      host.remove();
      g.IS_REACT_ACT_ENVIRONMENT = actEnv;
    }
  });

  it("clears the selection and column layout when the columns change", () => {
    const grid = (cols: typeof columns) => <DataGrid ariaLabel="Rows" columns={cols} rowCount={rows.length} getRow={(i) => rows[i]} sort={[]} />;
    const { rerender } = render(grid(columns));
    fireEvent.mouseDown(screen.getByText("DRAFT").closest(".grid-cell")!, { button: 0, buttons: 1 });
    expect(screen.getByText("DRAFT").closest(".grid-cell")).toHaveAttribute("aria-selected", "true");
    rerender(grid(columns)); // same columns: the selection stays
    expect(screen.getByText("DRAFT").closest(".grid-cell")).toHaveAttribute("aria-selected", "true");
    rerender(grid(columns.map((c) => ({ ...c, name: `${c.name}_2` })))); // a new result
    expect(screen.getByText("DRAFT").closest(".grid-cell")).toHaveAttribute("aria-selected", "false");
  });

  it("typing on a cell that opens in an editor (JSON, long text) opens it instead of editing inline", () => {
    const onOpenCell = vi.fn((_r: number, c: number) => c === 1); // column 1 needs the editor
    render(
      <DataGrid ariaLabel="Rows" columns={columns} rowCount={rows.length} getRow={(i) => rows[i]} sort={[]} onEdit={() => {}} canEdit={() => true} onOpenCell={onOpenCell} />,
    );
    fireEvent.mouseDown(screen.getByText("DRAFT").closest(".grid-cell")!, { button: 0, buttons: 1 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "x" });
    expect(onOpenCell).toHaveBeenCalledWith(0, 1, "open");
    expect(screen.queryByLabelText("Edit status")).not.toBeInTheDocument();
    // Other cells still start an inline edit with the typed character.
    fireEvent.mouseDown(screen.getByText("7").closest(".grid-cell")!, { button: 0, buttons: 1 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "9" });
    expect(screen.getByLabelText("Edit owner_id")).toHaveValue("9");
  });
});

