import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ObjectTabs } from "./ObjectTabs";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { profile, session } from "../test/fixtures";

const tabs: Tab[] = [
  { kind: "table", id: "t1", schema: "public", name: "orders", objectKind: "table", title: "orders" },
  { kind: "query", id: "q1", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true },
];
const ws: Workspace = { id: "ws-1", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs, activeTabId: "t1", closed: [], health: "ok" };

beforeEach(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
afterEach(cleanup);

describe("ObjectTabs", () => {
  it("shows a tab per open object, the active one selected", () => {
    render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={() => undefined} />);
    expect(screen.getByRole("tablist", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /orders/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /Query 1/ }));
    expect(useWorkspaces.getState().workspaces[0]!.activeTabId).toBe("q1");
  });

  it("marks unsaved queries and tables with pending edits", () => {
    render(<ObjectTabs ws={ws} dirtyTables={{ t1: true }} onClose={() => undefined} />);
    expect(screen.getAllByLabelText("Unsaved changes")).toHaveLength(2);
  });

  it("closes through the callback and opens a new query with +", () => {
    const onClose = vi.fn();
    render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close orders" }));
    expect(onClose).toHaveBeenCalledWith(tabs[0]);
    fireEvent.click(screen.getByRole("button", { name: "New query tab" }));
    expect(useWorkspaces.getState().workspaces[0]!.tabs).toHaveLength(3);
  });

  it("is 38 px tall and keeps the focus ring inside the strip", () => {
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.tabbar\s*\{[^}]*height:\s*var\(--tabs-height\)/);
    expect(css).toMatch(/\.tab-main:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  });

  it("keeps close buttons outside the tabs and activates a tab with Space", () => {
    render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "Close orders" }).closest('[role="tab"]')).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: /Query 1/ }), { key: " " });
    expect(useWorkspaces.getState().workspaces[0]!.activeTabId).toBe("q1");
  });

  it("makes the whole tab clickable: padding sits inside the tab element", () => {
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.tab-main\s*\{[^}]*flex:\s*1[^}]*padding:\s*0 8px 0 14px/);
    expect(css).toMatch(/\.tab\s*\{[^}]*padding:\s*0 6px 0 0;/);
  });

  it("reorders tabs by drag and drop, and closes one with a middle click", () => {
    const onClose = vi.fn();
    const { container } = render(<ObjectTabs ws={ws} dirtyTables={{}} onClose={onClose} />);
    const wrappers = container.querySelectorAll(".tab");
    fireEvent.dragStart(wrappers[0]!);
    fireEvent.drop(wrappers[1]!);
    expect(useWorkspaces.getState().workspaces[0]!.tabs.map((t) => t.id)).toEqual(["q1", "t1"]);
    fireEvent(wrappers[1]!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).toHaveBeenCalled();
  });
});
