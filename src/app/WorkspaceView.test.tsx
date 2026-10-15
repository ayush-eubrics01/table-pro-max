import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspaceView } from "./WorkspaceView";
import { Overlays } from "../components/Overlays";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { useRestore } from "../stores/restore";
import { profile, session, usersStructure } from "../test/fixtures";

const ws = (tab: Tab): Workspace => ({
  id: "ws-1",
  kind: "sql",
  profile,
  session,
  schema: "public",
  schemas: ["public"],
  objects: { public: [] },
  columns: {},
  tabs: [tab],
  activeTabId: tab.id,
  closed: [],
  health: "ok",
});
const tabsLeft = () => useWorkspaces.getState().workspaces[0]!.tabs.length;

function renderWs(w: Workspace) {
  useWorkspaces.setState({ workspaces: [w], activeId: w.id });
  return render(
    <>
      <WorkspaceView ws={w} visible />
      <Overlays />
    </>,
  );
}

beforeEach(() => {
  // jsdom has no layout APIs that CodeMirror and the grid touch.
  Element.prototype.scrollIntoView = () => undefined;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  mockIPC((cmd) => (cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null));
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("Ctrl+W", () => {
  it("asks before closing a query tab with unsaved text", async () => {
    renderWs(ws({ kind: "query", id: "q1", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true }));
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(await screen.findByText("Close Query 1?")).toBeInTheDocument();
    expect(tabsLeft()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close without saving" }));
    await waitFor(() => expect(tabsLeft()).toBe(0));
  });

  it("closes a tab with nothing to lose straight away", async () => {
    renderWs(ws({ kind: "query", id: "q2", title: "Query 2", sql: "", savedQueryId: null, dirty: false }));
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(tabsLeft()).toBe(0));
  });
});

describe("pending query result edits", () => {
  const result = {
    taskId: "t",
    cancelled: false,
    durationMs: 1,
    statements: [
      {
        index: 0,
        sql: "select id, email from users",
        start: 0,
        end: 27,
        durationMs: 1,
        truncated: false,
        resultId: "r1",
        totalRows: 1,
        columns: [
          { name: "id", typeName: "int4", origin: { schema: "public", table: "users", column: "id" } },
          { name: "email", typeName: "text", origin: { schema: "public", table: "users", column: "email" } },
        ],
        rows: [["1", "ada@example.com"]],
        editing: { tables: [{ schema: "public", table: "users", keyColumns: [0] }], columns: [0, 0], readOnly: [] },
      },
    ],
  };
  let runs = 0;
  beforeEach(() => {
    runs = 0;
    mockIPC((cmd) => {
      if (cmd === "connect") return session;
      if (cmd === "statement_at_cursor") return { sql: "select id, email from users", start: 0, end: 27 };
      if (cmd === "explain_query") return { format: "sqlite_plan", raw: "", rows: { columns: [], rows: [], truncated: false }, durationMs: 1 };
      if (cmd === "run_query") {
        runs++;
        return structuredClone(result);
      }
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
  });

  async function runAndEdit() {
    renderWs(ws({ kind: "query", id: "q3", title: "Query 3", sql: "select id, email from users", savedQueryId: "saved", dirty: false }));
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    const cell = (await screen.findByText("ada@example.com")).closest(".grid-cell")!;
    // Under a loaded full-suite run the first double-click can land before the results are
    // editable; retry until the inline editor opens (a person would just double-click again).
    await waitFor(() => {
      if (!screen.queryByLabelText("Edit email")) fireEvent.doubleClick(cell);
      expect(screen.getByLabelText("Edit email")).toBeInTheDocument();
    });
    const editor = screen.getByLabelText("Edit email");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
  }

  it("asks before closing the tab", async () => {
    await runAndEdit();
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(await screen.findByText("Pending row changes will be discarded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Pending row changes will be discarded.")).not.toBeInTheDocument());
    expect(tabsLeft()).toBe(1);
  });

  it("keeps pending edits while a plan is shown", async () => {
    await runAndEdit();
    fireEvent.click(screen.getByRole("button", { name: /^Explain/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to results" }));
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
  });

  it("asks before running again, and keeps the edits when cancelled", async () => {
    await runAndEdit();
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    expect(await screen.findByText("Discard pending result edits?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Discard pending result edits?")).not.toBeInTheDocument());
    expect(runs).toBe(1);
    expect(screen.getByText("1 pending change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Run and discard" }));
    await waitFor(() => expect(runs).toBe(2));
    await waitFor(() => expect(screen.queryByText("1 pending change")).not.toBeInTheDocument());
  });
});

describe("followed references", () => {
  it("a filtered table tab loads with its filter and shows it as a chip", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "table_structure") return usersStructure;
      if (cmd === "browse_table") return { columns: [], rows: [["42", "a@example.com", null]], sql: "SELECT …", durationMs: 1, hasMore: false };
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    const filter = { type: "group" as const, logic: "and" as const, children: [{ type: "condition" as const, column: "id", op: "eq" as const, value: "42", enabled: true }] };
    renderWs(ws({ kind: "table", id: "t1", schema: "public", name: "users", objectKind: "table", title: "users", filter }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "browse_table")).toBe(true));
    expect((calls.find((c) => c.cmd === "browse_table")!.args.request as { filter: unknown }).filter).toEqual(filter);
    expect(await screen.findByRole("button", { name: "Edit filter id = '42'" })).toBeInTheDocument();
  });
});

describe("restore points", () => {
  let withPoint = true;
  it("a run that keeps a restore point refreshes the panel, which opens beside the tabs", async () => {
    withPoint = true;
    const runArgs: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "connect") return session;
      if (cmd === "statement_at_cursor") return { sql: "delete from users where id = 1", start: 0, end: 30 };
      if (cmd === "run_query") {
        runArgs.push(args as Record<string, unknown>);
        return {
          taskId: "t",
          cancelled: false,
          durationMs: 1,
          statements: [{ index: 0, sql: "delete from users where id = 1", start: 0, end: 30, durationMs: 1, truncated: false, rowsAffected: 1, ...(withPoint ? { restore: { pointId: "p1" } } : {}) }],
        };
      }
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    useRestore.setState({ open: false, version: 0 });
    renderWs(ws({ kind: "query", id: "q9", title: "Query 9", sql: "delete from users where id = 1", savedQueryId: null, dirty: false }));
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    expect(await screen.findByText("Restore point saved")).toBeInTheDocument();
    expect(useRestore.getState().version).toBeGreaterThan(0);
    expect(runArgs[0]!.options).toMatchObject({ restoreMaxRows: 100_000, restoreMaxMb: 50 });
    expect(screen.queryByRole("complementary", { name: "Restore points" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open restore points" }));
    expect(await screen.findByRole("complementary", { name: "Restore points" })).toBeInTheDocument();
  });

  it("any run refreshes restore points (a COMMIT or ROLLBACK may settle pending ones)", async () => {
    withPoint = false;
    mockIPC((cmd) => {
      if (cmd === "connect") return session;
      if (cmd === "statement_at_cursor") return { sql: "commit", start: 0, end: 6 };
      if (cmd === "run_query")
        return { taskId: "t", cancelled: false, durationMs: 1, statements: [{ index: 0, sql: "commit", start: 0, end: 6, durationMs: 1, truncated: false, rowsAffected: 0 }] };
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    useRestore.setState({ open: false, version: 0 });
    renderWs(ws({ kind: "query", id: "q10", title: "Query 10", sql: "commit", savedQueryId: null, dirty: false }));
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    await waitFor(() => expect(useRestore.getState().version).toBeGreaterThan(0));
  });
});

