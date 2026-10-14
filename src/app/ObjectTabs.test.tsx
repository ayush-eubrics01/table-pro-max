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
    expect(css).toMatch(/\.tab:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  });
});
