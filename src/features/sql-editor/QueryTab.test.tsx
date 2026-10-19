import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { EditorView } from "@codemirror/view";
import { QueryTab } from "./QueryTab";
import { Overlays } from "../../components/Overlays";
import { useWorkspaces, type QueryTab as QueryTabModel, type Workspace } from "../../stores/workspaces";
import { profile, session } from "../../test/fixtures";

const ws = (tab: QueryTabModel): Workspace => ({
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

const stored = () => useWorkspaces.getState().workspaces[0]!.tabs[0] as QueryTabModel;
const editors = (c: HTMLElement) => [...c.querySelectorAll(".cm-editor")].map((e) => EditorView.findFromDOM(e as HTMLElement)!);

/** Renders the tab the way WorkspaceView does: from the store, so edits flow back into it. */
function Live() {
  const w = useWorkspaces((s) => s.workspaces[0]!);
  return <QueryTab ws={w} tab={w.tabs[0] as QueryTabModel} active />;
}

let ran: string[] = [];
let savedList: unknown[] = [];
let savedQueries: Record<string, unknown>[] = [];

function renderTab(tab: QueryTabModel) {
  useWorkspaces.setState({ workspaces: [ws(tab)], activeId: "ws-1" });
  return render(
    <>
      <Live />
      <Overlays />
    </>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  ran = [];
  savedList = [];
  savedQueries = [];
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    if (cmd === "list_saved_queries") return savedList;
    if (cmd === "save_query") savedQueries.push(a.query as Record<string, unknown>);
    if (cmd === "connect") return { ...session, sessionId: "tab-sess" };
    if (cmd === "statement_at_cursor") {
      const sql = a.sql as string;
      return { sql, start: 0, end: new TextEncoder().encode(sql).length };
    }
    if (cmd === "run_query") {
      ran.push(a.sql as string);
      return { statements: [], durationMs: 1 };
    }
    if (cmd.startsWith("list_") || cmd === "script_parameters") return [];
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

const base: QueryTabModel = { kind: "query", id: "q1", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true };

describe("QueryTab: split editor", () => {
  it("opens a second editor whose text is kept with the tab", async () => {
    const { container } = renderTab(base);
    expect(editors(container)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Split editor" }));
    expect(editors(container)).toHaveLength(2);
    expect(stored().split).toBe(true);
    const right = editors(container)[1]!;
    right.dispatch({ changes: { from: 0, insert: "select 2" } });
    await waitFor(() => expect(stored().sql2).toBe("select 2"));
    expect(stored().sql).toBe("select 1");
  });

  it("runs the editor that has the focus", async () => {
    const { container } = renderTab({ ...base, split: true, sql2: "select 2" });
    const [left, right] = editors(container);
    fireEvent.focusIn(right!.contentDOM);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(ran).toEqual(["select 2"]));
    fireEvent.focusIn(left!.contentDOM);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(ran).toEqual(["select 2", "select 1"]));
  });

  it("closing the split hides the second editor but keeps its text", async () => {
    const { container } = renderTab({ ...base, split: true, sql2: "select 2" });
    fireEvent.click(screen.getByRole("button", { name: "Split editor" }));
    expect(editors(container)).toHaveLength(1);
    expect(stored()).toMatchObject({ split: false, sql2: "select 2" });
    fireEvent.click(screen.getByRole("button", { name: "Split editor" }));
    expect(editors(container)[1]!.state.doc.toString()).toBe("select 2");
  });

  it("toggles with Mod+\\ from the editor", () => {
    const { container } = renderTab(base);
    fireEvent.keyDown(editors(container)[0]!.contentDOM, { key: "\\", ctrlKey: true });
    expect(editors(container)).toHaveLength(2);
  });
});

describe("QueryTab: saving", () => {
  it("keeps a saved query's folder, favourite and connection when saving it again", async () => {
    savedList = [{ id: "q1", connectionId: null, name: "monthly revenue", folder: "Reports", sql: "select 0", favorite: true }];
    renderTab({ ...base, title: "monthly revenue", savedQueryId: "q1" });
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(savedQueries).toHaveLength(1));
    expect(savedQueries[0]).toEqual({ id: "q1", connectionId: null, name: "monthly revenue", folder: "Reports", sql: "select 1", favorite: true });
  });
});
