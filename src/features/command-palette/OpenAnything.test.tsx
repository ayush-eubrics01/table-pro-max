import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { OpenAnything } from "./OpenAnything";
import { useConnections } from "../../stores/connections";
import { useWorkspaces } from "../../stores/workspaces";
import { useUi } from "../../stores/ui";
import { useRestore } from "../../stores/restore";
import { profile, session } from "../../test/fixtures";

beforeEach(() => {
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  mockIPC((cmd) => (cmd === "list_saved_queries" ? [] : null));
  useWorkspaces.setState({ workspaces: [], activeId: null });
  useConnections.setState({ connections: [{ profile: { ...profile, id: "c-set", name: "set" }, sortOrder: 0, lastUsedAt: null }] } as never);
  useUi.setState({ paletteOpen: true, settingsOpen: false } as never);
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("OpenAnything", () => {
  it("Enter opens the best match, even when it is in a later group", async () => {
    const onConnect = vi.fn();
    render(<OpenAnything onConnect={onConnect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "set" } });
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveTextContent(/^set/));
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]!.id);
    // Enter is consumed: its default action must not press whatever takes focus next (the
    // connecting dialog's Cancel button would cancel the connection it just started).
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "c-set" }));
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("forgives how a name is typed, matches the schema too, and marks the matched letters", async () => {
    const objects = ["order_items", "orders", "customer_orders", "payments"].map((name) => ({ schema: "sales", name, kind: "table" as const }));
    useWorkspaces.setState({
      workspaces: [{ id: "w", kind: "sql", profile, session, schema: "sales", schemas: ["sales"], objects: { sales: objects }, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" }],
      activeId: "w",
    });
    render(<OpenAnything onConnect={() => undefined} />);
    const input = screen.getByRole("combobox");
    const first = async (q: string) => {
      fireEvent.change(input, { target: { value: q } });
      await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true"));
      return screen.getAllByRole("option")[0]!;
    };
    for (const q of ["order items", "odrer_items", "sales items"]) {
      await waitFor(async () => expect(await first(q)).toHaveTextContent(/^order_items/), { timeout: 2000 });
    }
    await waitFor(async () => expect(await first("cust ord")).toHaveTextContent(/^customer_orders/));
    fireEvent.change(input, { target: { value: "order items" } });
    await waitFor(() => expect([...screen.getAllByRole("option")[0]!.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["order", "items"]));
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("Enter right after typing opens the best match for what was typed, not what was listed before", () => {
    const onConnect = vi.fn();
    render(<OpenAnything onConnect={onConnect} />);
    const input = screen.getByRole("combobox");
    // Typed (or pasted) and Enter at once: the list hasn't caught up yet.
    fireEvent.change(input, { target: { value: "set" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "c-set" }));
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("walks the displayed order with the arrow keys", async () => {
    render(<OpenAnything onConnect={() => undefined} />);
    const input = screen.getByRole("combobox");
    const options = await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps actions and connections in view with many cached objects", async () => {
    const objects = Array.from({ length: 80 }, (_, i) => ({ schema: "public", name: `t${i}`, kind: "table" as const }));
    useWorkspaces.setState({
      workspaces: [{ id: "w", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: { public: objects }, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" }],
      activeId: "w",
    } as never);
    render(<OpenAnything onConnect={() => undefined} />);
    expect(await screen.findByRole("option", { name: /^Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^set/ })).toBeInTheDocument();
    // The list is still capped, so a huge schema never floods it.
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(60);
  });

  it("announces each section as a named group of options", async () => {
    render(<OpenAnything onConnect={() => undefined} />);
    const actions = await screen.findByRole("group", { name: "Actions" });
    expect(within(actions).getByRole("option", { name: /^Settings/ })).toBeInTheDocument();
  });

  it("opens the restore points of the active connection", async () => {
    useRestore.setState({ open: false });
    useWorkspaces.setState({
      workspaces: [{ id: "w", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" }],
      activeId: "w",
    } as never);
    render(<OpenAnything onConnect={() => undefined} />);
    fireEvent.click(await screen.findByRole("option", { name: /^Restore points/ }));
    expect(useRestore.getState().open).toBe(true);
  });

  it("offers restore points only where they are kept", async () => {
    useWorkspaces.setState({
      workspaces: [{ id: "w", kind: "sql", profile, session: { ...session, readOnly: true }, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" }],
      activeId: "w",
    } as never);
    render(<OpenAnything onConnect={() => undefined} />);
    expect(await screen.findByRole("option", { name: /^Settings/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Restore points/ })).not.toBeInTheDocument();
  });
});

