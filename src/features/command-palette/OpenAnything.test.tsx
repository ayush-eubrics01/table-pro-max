import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { OpenAnything } from "./OpenAnything";
import { useConnections } from "../../stores/connections";
import { useWorkspaces } from "../../stores/workspaces";
import { useUi } from "../../stores/ui";
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
  });

  it("announces each section as a named group of options", async () => {
    render(<OpenAnything onConnect={() => undefined} />);
    const actions = await screen.findByRole("group", { name: "Actions" });
    expect(within(actions).getByRole("option", { name: /^Settings/ })).toBeInTheDocument();
  });
});
