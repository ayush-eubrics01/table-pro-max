import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Sidebar } from "./Sidebar";
import { profile, session } from "../../test/fixtures";
import type { Workspace } from "../../stores/workspaces";
import type { DbObject } from "../../types/backend";

const objects: DbObject[] = [
  { schema: "public", name: "customers", kind: "table", estimatedRows: 1200 },
  { schema: "public", name: "orders", kind: "table", estimatedRows: 10400 },
  { schema: "public", name: "paid_orders", kind: "view" },
];

const ws = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  kind: "sql",
  profile,
  session,
  schema: "public",
  schemas: ["public", "audit"],
  objects: { public: objects },
  columns: {},
  tabs: [],
  activeTabId: null,
  closed: [],
  health: "ok",
  ...patch,
});

beforeEach(() => {
  mockIPC((cmd) => {
    if (cmd === "list_databases") return ["app", "analytics"];
    if (cmd === "list_saved_queries" || cmd === "list_dashboards") return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("Sidebar", () => {
  it("puts the database and schema in one switcher", async () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const sw = screen.getByRole("group", { name: "Database and schema" });
    await waitFor(() => expect(within(sw).getByLabelText("Database")).toHaveValue("app"));
    expect(within(sw).getByLabelText("Schema")).toHaveValue("public");
    expect(within(sw).getByText("/")).toBeInTheDocument();
  });

  it("shows one select and no separator when there is no database list", () => {
    const single = { ...session, dialect: "sqlite" as const, capabilities: { ...session.capabilities, multipleDatabases: false } };
    render(<Sidebar ws={ws({ session: single, schema: "main", schemas: ["main"], objects: { main: [] } })} onSwitchDatabase={() => undefined} />);
    const sw = screen.getByRole("group", { name: "Database and schema" });
    expect(within(sw).getAllByRole("combobox")).toHaveLength(1);
    expect(within(sw).queryByText("/")).not.toBeInTheDocument();
    expect(screen.getByText("This schema is empty")).toBeInTheDocument();
  });

  it("lists objects in collapsible sections with counts", () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const tables = screen.getByRole("button", { name: "Tables (2)" });
    expect(tables).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /^orders/ })).toBeInTheDocument();
    expect(screen.getByText("~10,400")).toBeInTheDocument();
    fireEvent.click(tables);
    expect(tables).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /customers/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Views (1)" })).toBeInTheDocument();
  });

  it("filters objects and says when nothing matches", () => {
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Filter objects"), { target: { value: "paid" } });
    expect(screen.getByRole("button", { name: "Views (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Tables/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter objects"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching objects")).toBeInTheDocument();
  });

  it("keeps schema actions in the footer, and only Refresh when read-only", () => {
    const { unmount } = render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const foot = screen.getByRole("toolbar", { name: "Schema actions" });
    for (const name of ["New table", "Refresh objects", "Import data"]) expect(within(foot).getByRole("button", { name })).toBeInTheDocument();
    unmount();
    render(<Sidebar ws={ws({ session: { ...session, readOnly: true } })} onSwitchDatabase={() => undefined} />);
    const ro = screen.getByRole("toolbar", { name: "Schema actions" });
    expect(within(ro).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Refresh objects"]);
  });

  it("marks the object of the active tab", () => {
    const tab = { kind: "table" as const, id: "t1", schema: "public", name: "orders", objectKind: "table" as const, title: "orders" };
    render(<Sidebar ws={ws({ tabs: [tab], activeTabId: "t1" })} onSwitchDatabase={() => undefined} />);
    expect(screen.getByRole("treeitem", { name: /^orders/ })).toHaveAttribute("aria-current", "true");
  });
});
