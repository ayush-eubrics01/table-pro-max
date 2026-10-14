import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspaceView } from "./WorkspaceView";
import { Overlays } from "../components/Overlays";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { profile, session } from "../test/fixtures";

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
    fireEvent.doubleClick((await screen.findByText("ada@example.com")).closest(".grid-cell")!);
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
