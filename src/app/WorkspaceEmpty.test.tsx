import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceEmpty } from "./WorkspaceEmpty";
import { useWorkspaces, type Workspace } from "../stores/workspaces";
import { useUi } from "../stores/ui";
import { profile, session } from "../test/fixtures";

const base: Workspace = { id: "ws-1", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" };
const loaded: Workspace = {
  ...base,
  objects: { public: [{ schema: "public", name: "a", kind: "table" }, { schema: "public", name: "b", kind: "table" }, { schema: "public", name: "v", kind: "view" }] },
};

beforeEach(() => {
  useWorkspaces.setState({ workspaces: [loaded], activeId: loaded.id });
  useUi.setState({ paletteOpen: false });
});
afterEach(cleanup);

describe("WorkspaceEmpty", () => {
  it("summarises the connection", () => {
    render(<WorkspaceEmpty ws={loaded} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: profile.name })).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL 16 · app · 2 tables")).toBeInTheDocument();
  });

  it("leaves out the table count until objects have loaded", () => {
    render(<WorkspaceEmpty ws={base} />);
    expect(screen.getByText("PostgreSQL 16 · app")).toBeInTheDocument();
    expect(screen.queryByText(/tables/)).not.toBeInTheDocument();
  });

  it("starts a query or opens the palette", () => {
    render(<WorkspaceEmpty ws={loaded} />);
    fireEvent.click(screen.getByRole("button", { name: /New query/ }));
    expect(useWorkspaces.getState().workspaces[0]!.tabs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Find anything/ }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });
});
