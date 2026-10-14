import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
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
});
