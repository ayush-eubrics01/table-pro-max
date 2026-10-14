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
