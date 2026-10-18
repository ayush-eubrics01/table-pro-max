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
    // One double-click is enough: the grid no longer resets itself after it appears (B21).
    fireEvent.doubleClick(cell);
    expect(await screen.findByLabelText("Edit email")).toBeInTheDocument();
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


describe("production safety", () => {
  it("a statement that destroys data on production runs only after the connection name is typed", async () => {
    const runs: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "connect") return session;
      if (cmd === "statement_at_cursor") return { sql: "drop table users", start: 0, end: 16 };
      if (cmd === "run_query") {
        const options = (args as { options: Record<string, unknown> }).options;
        runs.push(options);
        if (options.typedConfirmation !== "Local PG")
          throw { kind: "confirmation_required", message: "Confirm execution on Local PG", code: "confirm_typed", detail: "DROP permanently removes objects: drop table users" };
        return { taskId: "t", cancelled: false, durationMs: 1, statements: [{ index: 0, sql: "drop table users", start: 0, end: 16, durationMs: 1, truncated: false, rowsAffected: 0 }] };
      }
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    renderWs(ws({ kind: "query", id: "q20", title: "Query 20", sql: "drop table users", savedQueryId: null, dirty: false }));
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    const input = await screen.findByLabelText("Type Local PG to confirm");
    const button = screen.getByRole("button", { name: "Run anyway" });
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "Local PG" } });
    fireEvent.click(button);
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ confirmed: true, typedConfirmation: "Local PG" });
    expect(await screen.findByText("0 rows affected")).toBeInTheDocument();
  });
});

describe("production safety: reviewed DDL", () => {
  it("Drop table in the sidebar asks for the connection name on production", async () => {
    const ddl: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "apply_ddl") {
        const a = args as Record<string, unknown>;
        ddl.push(a);
        if (a.typedConfirmation !== "Local PG")
          throw { kind: "confirmation_required", message: "Review the schema change before applying it", code: "confirm_typed", detail: "DROP permanently removes objects: DROP TABLE users" };
        return null;
      }
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    const w = { ...ws({ kind: "query", id: "q30", title: "Query 30", sql: "", savedQueryId: null, dirty: false }), objects: { public: [{ schema: "public", name: "users", kind: "table" as const }] } };
    renderWs(w);
    fireEvent.contextMenu(await screen.findByText("users"));
    fireEvent.click(await screen.findByText("Drop table…"));
    fireEvent.click(await screen.findByRole("button", { name: "Drop table" }));
    fireEvent.change(await screen.findByLabelText("Type Local PG to confirm"), { target: { value: "Local PG" } });
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    await waitFor(() => expect(ddl).toHaveLength(2));
    expect(ddl[1]).toMatchObject({ confirmed: true, typedConfirmation: "Local PG" });
    expect(await screen.findByText("Dropped users")).toBeInTheDocument();
  });
});

describe("production safety: write access", () => {
  const runAll = () => fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
  const queryWs = (locked: boolean) => ({
    ...ws({ kind: "query", id: "q40", title: "Query 40", sql: "select 1", savedQueryId: null, dirty: false }),
    session: { ...session, readOnly: locked, writesLocked: locked },
  });
  const mock = (connects: Record<string, unknown>[], gate?: Promise<void>) =>
    mockIPC(async (cmd, args) => {
      if (cmd === "connect") {
        const request = (args as { request: Record<string, unknown> }).request;
        connects.push(request);
        if (gate) await gate;
        return { ...session, sessionId: `tab-${connects.length}`, writesLocked: request.lockProduction === true };
      }
      if (cmd === "statement_at_cursor") return { sql: "select 1", start: 0, end: 8 };
      if (cmd === "run_query") return { taskId: "t", cancelled: false, durationMs: 1, statements: [{ index: 0, sql: "select 1", start: 0, end: 8, durationMs: 1, truncated: false, rowsAffected: 0 }] };
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
  const rerenderWith = (rerender: (ui: React.ReactElement) => void, w: Workspace) => {
    useWorkspaces.setState({ workspaces: [w] });
    rerender(
      <>
        <WorkspaceView ws={w} visible />
        <Overlays />
      </>,
    );
  };

  it("a query tab opens its session locked or not like the workspace, and reopens it when that changes", async () => {
    const connects: Record<string, unknown>[] = [];
    mock(connects);
    const { rerender } = renderWs(queryWs(true));
    runAll();
    await waitFor(() => expect(connects).toHaveLength(1));
    expect(connects[0]!.lockProduction).toBe(true);
    rerenderWith(rerender, { ...queryWs(false), allowWrites: true });
    runAll();
    await waitFor(() => expect(connects).toHaveLength(2));
    expect(connects[1]!.lockProduction).toBe(false);
  });

  it("a session still connecting when writes change is replaced, not kept", async () => {
    const connects: Record<string, unknown>[] = [];
    let release = () => undefined as void;
    mock(connects, new Promise<void>((r) => (release = r)));
    const { rerender } = renderWs(queryWs(false));
    runAll();
    await waitFor(() => expect(connects).toHaveLength(1));
    rerenderWith(rerender, queryWs(true));
    release();
    await waitFor(() => expect(connects).toHaveLength(2));
    expect(connects[1]!.lockProduction).toBe(true);
  });
});

describe("production safety: locked", () => {
  it("a write refused on a production connection opened read-only points to Allow writes", async () => {
    const locked = { ...session, readOnly: true, writesLocked: true, safetyMode: "read_only" as const };
    mockIPC((cmd) => {
      if (cmd === "connect") return locked;
      if (cmd === "statement_at_cursor") return { sql: "delete from users", start: 0, end: 17 };
      if (cmd === "run_query") throw { kind: "policy_violation", message: "This connection is read-only. DELETE without a WHERE clause removes every row: delete from users" };
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    renderWs({ ...ws({ kind: "query", id: "q50", title: "Query 50", sql: "delete from users", savedQueryId: null, dirty: false }), session: locked });
    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));
    expect(await screen.findByText(/This connection is read-only.*Choose Allow writes in the status bar to change data\./)).toBeInTheDocument();
  });
});

describe("production safety: SQL files", () => {
  it("Run SQL file asks for the connection name when the file destroys data on production", async () => {
    const runs: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "connect") return session;
      if (cmd === "plugin:dialog|open") return "/tmp/dump.sql";
      if (cmd === "run_sql_file") {
        const request = (args as { request: Record<string, unknown> }).request;
        runs.push(request);
        if (request.typedConfirmation !== "Local PG")
          throw { kind: "confirmation_required", message: "Confirm execution on Local PG", code: "confirm_typed", detail: "DROP permanently removes objects: DROP TABLE IF EXISTS users" };
        return { statementsRun: 3, failures: [], cancelled: false, durationMs: 5 };
      }
      return cmd.startsWith("list_") || cmd.startsWith("search_") ? [] : null;
    });
    renderWs(ws({ kind: "query", id: "q60", title: "Query 60", sql: "", savedQueryId: null, dirty: false }));
    fireEvent.click(screen.getByRole("button", { name: "Run SQL file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run file" }));
    fireEvent.change(await screen.findByLabelText("Type Local PG to confirm"), { target: { value: "Local PG" } });
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ confirmed: true, typedConfirmation: "Local PG" });
    expect(await screen.findByText(/dump.sql: 3 statements/)).toBeInTheDocument();
  });
});
