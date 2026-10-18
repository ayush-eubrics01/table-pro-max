import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { readFileSync } from "node:fs";
import { Sidebar } from "./Sidebar";
import { profile, session } from "../../test/fixtures";
import { useWorkspaces, type Workspace } from "../../stores/workspaces";
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

  it("opens the last select from anywhere in the switcher box, chevron included", () => {
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.db-switch-select:last-of-type\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.db-switch-chevron\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/);
  });

  it("shows which of the two switcher selects has keyboard focus", () => {
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.db-switch-select:focus-visible\s*\{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--focus\)/);
  });
});

describe("Sidebar: pinned objects", () => {
  type PinArg = { kind: string; schema: string; name: string };
  const setup = (pins: PinArg[], saved: { id: string; name: string; sql: string; connectionId: string | null }[] = []) => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    let current = [...pins];
    mockIPC((cmd, args) => {
      const a = args as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (cmd === "list_pins") return current;
      if (cmd === "pin_object") current = [...current, a.pin as PinArg];
      if (cmd === "unpin_object") current = current.filter((p) => JSON.stringify(p) !== JSON.stringify(a.pin));
      if (cmd === "list_saved_queries") return saved.map((s) => ({ ...s, folder: null, favorite: false, createdAt: "", updatedAt: "" }));
      if (cmd === "list_dashboards" || cmd === "list_databases") return [];
      if (cmd === "list_objects") {
        if (a.schema === "locked") throw { kind: "database", message: "permission denied for schema locked" };
        return a.schema === "audit" ? [{ schema: "audit", name: "events", kind: "table" }] : [];
      }
      return null;
    });
    return calls;
  };

  it("shows nothing pinned until something is pinned, then pins from the context menu", async () => {
    const calls = setup([]);
    useWorkspaces.setState({ workspaces: [ws()], activeId: "ws-1" });
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    await screen.findByText("orders");
    expect(screen.queryByRole("button", { name: /^Pinned/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText("orders"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "pin_object")).toBe(true));
    // PostgreSQL connections have several databases: pins belong to the one open.
    expect(calls.find((c) => c.cmd === "pin_object")!.args).toMatchObject({ connectionId: profile.id, database: "app", pin: { kind: "table", schema: "public", name: "orders" } });
    expect(calls.find((c) => c.cmd === "list_pins")!.args).toMatchObject({ connectionId: profile.id, database: "app" });
    const pinned = await screen.findByRole("group", { name: "Pinned" });
    expect(within(pinned).getByText("orders")).toBeInTheDocument();
    fireEvent.contextMenu(within(pinned).getByText("orders"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Pinned" })).not.toBeInTheDocument());
  });

  it("lists pins in their order across schemas and saved queries, opens them, and marks one that is gone", async () => {
    setup(
      [
        { kind: "saved_query", schema: "", name: "q1" },
        { kind: "table", schema: "audit", name: "events" },
        { kind: "view", schema: "public", name: "paid_orders" },
        { kind: "table", schema: "public", name: "dropped" },
        { kind: "table", schema: "locked", name: "secrets" },
      ],
      [{ id: "q1", name: "Monthly revenue", sql: "select 1", connectionId: null }],
    );
    useWorkspaces.setState({ workspaces: [ws()], activeId: "ws-1" });
    render(<Sidebar ws={ws()} onSwitchDatabase={() => undefined} />);
    const pinned = await screen.findByRole("group", { name: "Pinned" });
    await waitFor(() =>
      expect(within(pinned).getAllByRole("treeitem").map((b) => b.getAttribute("aria-label"))).toEqual([
        "Monthly revenue",
        "events, schema audit",
        "paid_orders",
        "dropped, not found",
        "secrets, schema locked, not found",
      ]),
    );
    fireEvent.click(within(pinned).getByText("events"));
    expect(useWorkspaces.getState().workspaces[0]!.tabs.at(-1)).toMatchObject({ kind: "table", schema: "audit", name: "events" });
    fireEvent.click(within(pinned).getByText("Monthly revenue"));
    expect(useWorkspaces.getState().workspaces[0]!.tabs.at(-1)).toMatchObject({ kind: "query", savedQueryId: "q1" });
    fireEvent.change(screen.getByLabelText("Filter objects"), { target: { value: "paid" } });
    expect(within(screen.getByRole("group", { name: "Pinned" })).getAllByRole("treeitem").map((b) => b.getAttribute("aria-label"))).toEqual(["paid_orders"]);
  });
});
