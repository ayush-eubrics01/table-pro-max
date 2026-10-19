import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { ChangeSet, TableStructure } from "../../types/backend";
import { session, usersStructure } from "../../test/fixtures";
import { TableView } from "./TableView";
import { Overlays } from "../../components/Overlays";
import { useRestore } from "../../stores/restore";
import { useUi } from "../../stores/ui";

let calls: { cmd: string; args: Record<string, unknown> }[] = [];
let structure: TableStructure = usersStructure;
let applyRestore: { pointId?: string; reason?: string }[] = [];
let rows = [
  ["1", "ada@example.com", "36"],
  ["2", "grace@example.com", null],
];

beforeEach(() => {
  calls = [];
  applyRestore = [];
  useUi.setState({ toasts: [] });
  structure = usersStructure;
  rows = [
    ["1", "ada@example.com", "36"],
    ["2", "grace@example.com", null],
  ];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    switch (cmd) {
      case "table_structure":
        return structure;
      case "browse_table":
        return { columns: [], rows, sql: "SELECT …", durationMs: 1, hasMore: false };
      case "preview_changes":
        return { sql: "UPDATE \"public\".\"users\" SET \"email\" = 'new@example.com' …;", statementCount: 1, atomic: true };
      case "apply_changes":
        return { counts: [1], restore: applyRestore };
      case "list_filter_presets":
        return [];
      default:
        return null;
    }
  });
});

beforeEach(() => {
  // jsdom has no layout APIs that CodeMirror (the value editor) touches.
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
  clearMocks();
});

const renderView = () =>
  render(
    <>
      <TableView session={session} schema="public" table="users" onReconnect={async () => undefined} />
      <Overlays />
    </>,
  );

/** Rows and the table structure load separately; editing starts only once both are in. */
async function openEditor(text: string) {
  const cell = await screen.findByText(text);
  return waitFor(() => {
    fireEvent.doubleClick(cell.closest(".grid-cell")!);
    return screen.getByLabelText("Edit email");
  });
}

describe("TableView", () => {
  it("loads rows with NULL shown distinctly", async () => {
    renderView();
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("NULL").closest(".grid-cell")).toHaveClass("null");
    const browse = calls.find((c) => c.cmd === "browse_table")!;
    expect(browse.args.request).toMatchObject({ schema: "public", table: "users", offset: 0 });
  });

  it("edits a field in the row inspector, with the same pending and commit flow", async () => {
    renderView();
    fireEvent.mouseDown((await screen.findByText("ada@example.com")).closest(".grid-cell")!);
    fireEvent.click(screen.getByRole("button", { name: "Toggle row details" }));
    const email = within(await screen.findByRole("complementary", { name: "Row details" })).getByRole("textbox", { name: "email" });
    fireEvent.change(email, { target: { value: "inspected@example.com" } });
    fireEvent.blur(email);
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.changes as ChangeSet;
    expect(set.changes[0]).toMatchObject({ type: "update", key: [{ column: "id", value: "1" }], edits: [{ column: "email", value: { kind: "value", value: "inspected@example.com" } }] });
  });

  it("keeps edits pending until reviewed, then commits a parameterised change set", async () => {
    renderView();
    const editor = await openEditor("ada@example.com");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "apply_changes")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    const dialog = await screen.findByRole("dialog");
    // Production connections name the target and use the danger style.
    expect(within(dialog).getByText("Production")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit changes" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.changes as ChangeSet;
    expect(set.changes).toEqual([
      {
        type: "update",
        key: [{ column: "id", value: "1" }],
        edits: [{ column: "email", value: { kind: "value", value: "new@example.com" }, original: "ada@example.com" }],
      },
    ]);
    expect(calls.find((c) => c.cmd === "apply_changes")!.args.confirmed).toBe(true);
  });

  it("discard drops pending edits without touching the database", async () => {
    renderView();
    const editor = await openEditor("grace@example.com");
    fireEvent.change(editor, { target: { value: "x" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /Discard/ }));
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "preview_changes" || c.cmd === "apply_changes")).toBe(false);
  });

  it("read-only connections cannot edit", async () => {
    render(<TableView session={{ ...session, readOnly: true }} schema="public" table="users" onReconnect={async () => undefined} />);
    const cell = await screen.findByText("ada@example.com");
    fireEvent.doubleClick(cell.closest(".grid-cell")!);
    expect(screen.queryByLabelText("Edit email")).not.toBeInTheDocument();
    expect(screen.getByTitle("This connection is read-only")).toHaveTextContent("Read-only");
  });

  it("says when a commit kept no restore point, and refreshes the restore points", async () => {
    applyRestore = [{ reason: "changes the primary key" }];
    const before = useRestore.getState().version;
    renderView();
    const editor = await openEditor("ada@example.com");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Review and commit" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message)).toContain("Committed 1 change. No restore point: changes the primary key"));
    expect(useRestore.getState().version).toBeGreaterThan(before);
  });

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

  it("says Insert only for a table without a primary key, and Read-only for a view", async () => {
    structure = { ...usersStructure, columns: usersStructure.columns.map((c) => ({ ...c, primaryKey: null })) };
    const { unmount } = renderView();
    const pill = await screen.findByTitle("No primary key: existing rows cannot be edited");
    expect(pill).toHaveTextContent("Insert only");
    expect(screen.getByRole("button", { name: /Row/ })).toBeInTheDocument();
    unmount();
    structure = { ...usersStructure, kind: "view" };
    renderView();
    expect(await screen.findByTitle("Views are read-only")).toHaveTextContent("Read-only");
    expect(screen.queryByRole("button", { name: "Delete selected rows" })).not.toBeInTheDocument();
  });

  it("centres the commit bar without halving the room it may use", async () => {
    const { readFileSync } = await import("node:fs");
    const rule = readFileSync("src/styles/app.css", "utf8").match(/\n\.commit-bar \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/left:\s*12px/);
    expect(rule).toMatch(/right:\s*12px/);
    expect(rule).toMatch(/width:\s*fit-content/);
    expect(rule).not.toMatch(/translateX|left:\s*50%/);
  });
});

const docsStructure: TableStructure = {
  ...usersStructure,
  name: "docs",
  columns: [
    { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: 1, autoIncrement: false, comment: null },
    { name: "title", dataType: "character varying(50)", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "body", dataType: "text", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "doc", dataType: "jsonb", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
  ],
  foreignKeys: [],
};

describe("large values in opened tables", () => {
  const NL = { $notLoaded: true };
  let page: unknown[][];
  let fetched: Record<string, unknown>;
  beforeEach(() => {
    calls = [];
    page = [
      ["1", "one", NL, NL],
      ["2", "two", NL, NL],
    ];
    fetched = { "1:body": "x".repeat(5000), "2:body": "short", "1:doc": '{"a":1}', "2:doc": null };
    mockIPC((cmd, args) => {
      const a = args as { key: { value: string }[]; column: string; keys: { value: string }[][] };
      calls.push({ cmd, args: a });
      switch (cmd) {
        case "table_structure":
          return docsStructure;
        case "list_column_fetch":
          return [];
        case "browse_table":
          return {
            columns: [
              { name: "id", typeName: "int4" },
              { name: "title", typeName: "varchar" },
              { name: "body", typeName: "text", deferred: true },
              { name: "doc", typeName: "jsonb", deferred: true },
            ],
            rows: page,
            sql: "SELECT …",
            durationMs: 1,
            hasMore: false,
          };
        case "fetch_value":
          if (a.key[0]!.value === "9") throw { kind: "not_found", message: "This row no longer exists" };
          return fetched[`${a.key[0]!.value}:${a.column}`];
        case "fetch_column":
          return a.keys.map((k: { value: string }[]) => ({ found: true, value: fetched[`${k[0]!.value}:${a.column}`] }));
        case "preview_changes":
          return { sql: "UPDATE …", statementCount: 1, atomic: true };
        case "apply_changes":
          return { counts: [1], restore: [] };
        case "rows_as_text":
          return `copied as ${(args as { request: { options: { format: string } } }).request.options.format}`;
        default:
          return null;
      }
    });
  });

  const view = () =>
    render(
      <>
        <TableView session={session} schema="public" table="docs" onReconnect={async () => {}} />
        <Overlays />
      </>,
    );

  it("asks for a lazy page with the stored overrides and shows Not loaded", async () => {
    view();
    expect(await screen.findAllByText("Not loaded")).toHaveLength(4);
    const browse = calls.find((c) => c.cmd === "browse_table")!;
    expect(browse.args.request).toMatchObject({ lazy: true, loadColumns: [], deferColumns: [], limit: 150 });
  });

  it("loads short text inline on click, and opens long text in the editor", async () => {
    view();
    const cells = await screen.findAllByText("Not loaded");
    fireEvent.click(cells[2]!.closest(".grid-cell")!); // row 2 body
    expect(await screen.findByText("short")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "fetch_value")!.args).toMatchObject({ table: "docs", column: "body", key: [{ column: "id", value: "2" }] });
    fireEvent.click(screen.getAllByText("Not loaded")[0]!.closest(".grid-cell")!); // row 1 body (5000 chars)
    expect(await screen.findByRole("dialog", { name: /docs · body · id = 1/ })).toBeInTheDocument();
  });

  it("Set to NULL loads Not loaded values first, so the change keeps its real original", async () => {
    view();
    const cells = await screen.findAllByText("Not loaded");
    fireEvent.mouseDown(cells[2]!.closest(".grid-cell")!, { button: 0, buttons: 1 }); // row 2 body ("short")
    fireEvent.contextMenu(cells[2]!.closest(".grid-cell")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set to NULL" }));
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: /Commit/ }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.changes as ChangeSet;
    const change = set.changes[0] as Extract<ChangeSet["changes"][number], { type: "update" }>;
    expect(change.edits[0]).toMatchObject({ column: "body", value: { kind: "value", value: null }, original: "short" });
  });

  it("a value whose row was deleted meanwhile says how to see the current rows", async () => {
    useUi.setState({ toasts: [] });
    page = [["9", "nine", NL, NL]];
    view();
    const cells = await screen.findAllByText("Not loaded");
    fireEvent.click(cells[0]!.closest(".grid-cell")!);
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message).join()).toMatch(/This row no longer exists.*Refresh/));
  });

  it("Enter on a short Not loaded value loads it and edits it inline in the same gesture", async () => {
    view();
    const cells = await screen.findAllByText("Not loaded");
    fireEvent.mouseDown(cells[2]!.closest(".grid-cell")!, { button: 0, buttons: 1 }); // row 2 body ("short")
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(await screen.findByLabelText("Edit body")).toHaveValue("short");
  });

  it("edits a loaded value in the editor and commits with the full original", async () => {
    view();
    fireEvent.doubleClick((await screen.findAllByText("Not loaded"))[1]!.closest(".grid-cell")!); // row 1 doc (JSON)
    await screen.findByText("Valid JSON");
    // The code editor mounts in an effect after the status text appears: wait for it.
    await waitFor(() => expect(document.querySelector(".value-editor .cm-editor")).not.toBeNull());
    const v = EditorView.findFromDOM(document.querySelector(".value-editor .cm-editor") as HTMLElement)!;
    act(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '{"a":2}' } }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: /Commit/ }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.changes as ChangeSet;
    const change = set.changes[0] as Extract<ChangeSet["changes"][number], { type: "update" }>;
    expect(change.edits[0]).toMatchObject({ column: "doc", value: { kind: "value", value: '{"a":2}' }, original: '{"a":1}' });
  });

  it("Load this column fetches the page in one request, without hiding pending edits", async () => {
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /body/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Load this column" }));
    expect(await screen.findByText("short")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "fetch_column")).toHaveLength(1);
  });

  it("an override is saved and reloads the page", async () => {
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /body/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Always load" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "set_column_fetch")).toBe(true));
    expect(calls.find((c) => c.cmd === "set_column_fetch")!.args).toMatchObject({ connectionId: session.connectionId, column: "body", mode: "load" });
    await waitFor(() => expect(calls.filter((c) => c.cmd === "browse_table")).toHaveLength(2));
  });

  it("copies full values for a mixed selection", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    page = [["2", "two", NL, null]];
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.mouseDown(screen.getByText("two").closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getByText("NULL").closest(".grid-cell")!, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledWith("two\tshort\t"));
  });

  it("says when the row is gone", async () => {
    page = [["9", "nine", NL, NL]];
    view();
    fireEvent.click((await screen.findAllByText("Not loaded"))[0]!.closest(".grid-cell")!);
    expect(await screen.findByText(/This row no longer exists/)).toBeInTheDocument();
    expect(screen.getAllByText("Not loaded")).toHaveLength(2);
  });

  const menuOnRow = async (text: string) => {
    fireEvent.mouseDown(screen.getByText(text).closest(".grid-cell")!);
    fireEvent.contextMenu(screen.getByText(text).closest(".grid-cell")!);
  };

  it("row copies and export fetch deferred values first (never empty placeholders)", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    page = [["2", "two", NL, NL]];
    view();
    await screen.findAllByText("Not loaded");
    // IN list of the selected cells: title through doc, both still Not loaded.
    fireEvent.mouseDown(screen.getByText("two").closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getAllByText("Not loaded")[1]!.closest(".grid-cell")!, { shiftKey: true });
    fireEvent.contextMenu(screen.getByText("two").closest(".grid-cell")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy as SQL IN list" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith("'two', 'short', NULL"));
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy rows as TSV" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith("id\ttitle\tbody\tdoc\n2\ttwo\tshort\t"));
    calls = [];
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export selected rows…" }));
    expect(await screen.findByRole("dialog", { name: /Export/ })).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "fetch_column")).toBe(false); // already loaded by the copies above
  });

  it("copies rows as JSON or INSERT statements, with deferred values loaded first", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    page = [["2", "two", NL, NL]];
    view();
    await screen.findAllByText("Not loaded");
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy rows as JSON" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith("copied as json"));
    const json = calls.find((c) => c.cmd === "rows_as_text")!.args as unknown as { request: { columns: { name: string }[]; rows: unknown[][]; options: Record<string, unknown> } };
    expect(json.request.rows).toEqual([["2", "two", "short", null]]);
    expect(json.request.columns.map((c) => c.name)).toEqual(["id", "title", "body", "doc"]);
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy rows as INSERT" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith("copied as sql"));
    const sql = calls.filter((c) => c.cmd === "rows_as_text").at(-1)!.args as unknown as { request: { options: Record<string, unknown> } };
    expect(sql.request.options).toMatchObject({ format: "sql", sqlSchema: "public", sqlTable: "docs", dialect: "postgres", sqlBatch: 1, header: false });
  });

  it("Export selected rows loads Not loaded values before the dialog opens", async () => {
    page = [["2", "two", NL, NL]];
    view();
    await screen.findAllByText("Not loaded");
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export selected rows…" }));
    expect(await screen.findByRole("dialog", { name: /Export/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "fetch_column").map((c) => c.args.column)).toEqual(["body", "doc"]);
  });

  it("Duplicate row copies deferred values instead of dropping them", async () => {
    page = [["2", "two", NL, NL]];
    view();
    await screen.findAllByText("Not loaded");
    await menuOnRow("two");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate row" }));
    await waitFor(() => expect(screen.getAllByText("short")).toHaveLength(2));
  });

  it("a fetch that finishes after a reload is dropped, not written into the new page", async () => {
    let release: (v: unknown) => void = () => {};
    mockIPC((cmd) => {
      calls.push({ cmd, args: {} });
      if (cmd === "table_structure") return docsStructure;
      if (cmd === "list_column_fetch") return [];
      if (cmd === "browse_table")
        return { columns: [{ name: "id", typeName: "int4" }, { name: "title", typeName: "varchar" }, { name: "body", typeName: "text", deferred: true }, { name: "doc", typeName: "jsonb", deferred: true }], rows: [["1", "one", NL, NL]], sql: "SELECT …", durationMs: 1, hasMore: false };
      if (cmd === "fetch_value") return new Promise((r) => (release = r));
      return null;
    });
    view();
    fireEvent.click((await screen.findAllByText("Not loaded"))[0]!.closest(".grid-cell")!);
    await waitFor(() => expect(calls.some((c) => c.cmd === "fetch_value")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "browse_table")).toHaveLength(2));
    await act(async () => release("STALE VALUE"));
    expect(screen.queryByText("STALE VALUE")).not.toBeInTheDocument();
    expect(screen.getAllByText("Not loaded")).toHaveLength(2);
  });

  it("loads a big page's column in chunks the backend accepts", async () => {
    page = Array.from({ length: 450 }, (_, i) => [String(i + 1), `t${i}`, NL, NL]);
    fetched = {};
    view();
    await screen.findAllByText("t0");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /body/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Load this column" }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "fetch_column")).toHaveLength(3));
    expect(Math.max(...calls.filter((c) => c.cmd === "fetch_column").map((c) => (c.args.keys as unknown[]).length))).toBeLessThanOrEqual(200);
  });

  it("says so when copying fails, instead of leaving the clipboard stale", async () => {
    mockIPC((cmd) => {
      if (cmd === "table_structure") return docsStructure;
      if (cmd === "list_column_fetch") return [];
      if (cmd === "browse_table")
        return { columns: [{ name: "id", typeName: "int4" }, { name: "title", typeName: "varchar" }, { name: "body", typeName: "text", deferred: true }, { name: "doc", typeName: "jsonb", deferred: true }], rows: [["2", "two", NL, NL]], sql: "SELECT …", durationMs: 1, hasMore: false };
      if (cmd === "fetch_column") throw { kind: "network", message: "connection lost" };
      return null;
    });
    view();
    await screen.findAllByText("Not loaded");
    fireEvent.mouseDown(screen.getByText("two").closest(".grid-cell")!);
    fireEvent.mouseDown(screen.getAllByText("Not loaded")[0]!.closest(".grid-cell")!, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument();
  });
});

describe("following references", () => {
  const ordersStructure: TableStructure = {
    ...usersStructure,
    name: "orders",
    columns: [
      { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: 1, autoIncrement: false, comment: null },
      { name: "customer_id", dataType: "integer", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
    ],
    foreignKeys: [{ name: "fk", columns: ["customer_id"], refSchema: "public", refTable: "customers", refColumns: ["id"], onUpdate: "", onDelete: "" }],
  };
  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd === "table_structure") return ordersStructure;
      if (cmd === "browse_table") return { columns: [], rows: [["1", "42"], ["2", null]], sql: "SELECT …", durationMs: 1, hasMore: false };
      if (cmd === "list_column_fetch" || cmd === "list_filter_presets") return [];
      return null;
    });
  });

  it("opens the referenced row in a new tab from the arrow, the keyboard and the menu", async () => {
    const opened: unknown[] = [];
    render(<TableView session={session} schema="public" table="orders" onReconnect={async () => {}} onOpenTable={(...a) => opened.push(a)} />);
    const arrow = await screen.findByRole("button", { name: "Open customers where id = '42'" });
    expect(screen.getAllByRole("button", { name: /^Open customers/ })).toHaveLength(1); // none for the NULL row
    fireEvent.click(arrow);
    const filter = { type: "group", logic: "and", children: [{ type: "condition", column: "id", op: "eq", value: "42", enabled: true }] };
    expect(opened[0]).toEqual(["public", "customers", filter]);
    fireEvent.mouseDown(screen.getByText("42").closest(".grid-cell")!);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter", ctrlKey: true });
    expect(opened).toHaveLength(2);
    fireEvent.contextMenu(screen.getByText("42").closest(".grid-cell")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open referenced row" }));
    expect(opened).toHaveLength(3);
  });

  it("opens the rows that point at a row from the menu", async () => {
    const opened: unknown[] = [];
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "table_structure") return ordersStructure;
      if (cmd === "referencing_keys") {
        asked.push(args);
        return [{ schema: "public", table: "order_lines", name: "fk_l", columns: ["order_id"], refColumns: ["id"] }];
      }
      if (cmd === "browse_table") return { columns: [], rows: [["1", "42"], ["2", null]], sql: "SELECT …", durationMs: 1, hasMore: false };
      if (cmd === "list_column_fetch" || cmd === "list_filter_presets") return [];
      return null;
    });
    render(<TableView session={session} schema="public" table="orders" onReconnect={async () => {}} onOpenTable={(...a) => opened.push(a)} />);
    const cell = (await screen.findByText("42")).closest(".grid-cell")!;
    fireEvent.mouseDown(cell);
    fireEvent.contextMenu(cell);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rows in order_lines that point here" }));
    expect(asked[0]).toMatchObject({ sessionId: session.sessionId, schema: "public", table: "orders" });
    const filter = { type: "group", logic: "and", children: [{ type: "condition", column: "order_id", op: "eq", value: "1", enabled: true }] };
    expect(opened).toEqual([["public", "order_lines", filter]]);
  });

  it("offers no reverse lookup when nothing points at the table, or the lookup fails", async () => {
    mockIPC((cmd) => {
      if (cmd === "table_structure") return ordersStructure;
      if (cmd === "referencing_keys") throw { kind: "database", message: "permission denied" };
      if (cmd === "browse_table") return { columns: [], rows: [["1", "42"]], sql: "SELECT …", durationMs: 1, hasMore: false };
      if (cmd === "list_column_fetch" || cmd === "list_filter_presets") return [];
      return null;
    });
    render(<TableView session={session} schema="public" table="orders" onReconnect={async () => {}} onOpenTable={() => {}} />);
    const cell = (await screen.findByText("42")).closest(".grid-cell")!;
    fireEvent.mouseDown(cell);
    fireEvent.contextMenu(cell);
    await screen.findByRole("menuitem", { name: "Copy as SQL IN list" });
    expect(screen.queryByRole("menuitem", { name: /point here/ })).not.toBeInTheDocument();
  });

  it("follows the value the grid shows, including a pending edit", async () => {
    const opened: unknown[][] = [];
    render(<TableView session={session} schema="public" table="orders" onReconnect={async () => {}} onOpenTable={(...a) => opened.push(a)} />);
    const cell = (await screen.findByText("42")).closest(".grid-cell")!;
    fireEvent.doubleClick(cell);
    const editor = screen.getByLabelText("Edit customer_id");
    fireEvent.change(editor, { target: { value: "77" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Open customers where id = '77'" }));
    expect((opened[0]![2] as { children: { value: string }[] }).children[0]!.value).toBe("77");
  });

  it("does not offer load/defer choices for a foreign-key column (they are always loaded)", async () => {
    render(<TableView session={session} schema="public" table="orders" onReconnect={async () => {}} onOpenTable={() => {}} />);
    await screen.findByText("42");
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: /customer_id/ }));
    await screen.findByRole("menuitem", { name: "Sort ascending" });
    expect(screen.queryByRole("menuitem", { name: "Don't load" })).not.toBeInTheDocument();
  });
});
