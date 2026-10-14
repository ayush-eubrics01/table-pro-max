import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useRestore } from "../stores/restore";
import { StatusBar } from "./WorkspaceView";
import { profile, session } from "../test/fixtures";
import type { Workspace } from "../stores/workspaces";

afterEach(() => {
  cleanup();
  clearMocks();
});
const ws = (over: Partial<typeof session> = {}) =>
  ({ id: "ws-1", profile, session: { ...session, ...over }, schema: "public", tabs: [], activeTabId: null, health: "ok" }) as unknown as Workspace;

describe("StatusBar", () => {
  it("shows where you are and what you can do", () => {
    render(<StatusBar ws={ws({ readOnly: false })} version="0.1.0" />);
    expect(screen.getByText("Writes enabled")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("says read-only and keeps the production tint", () => {
    const { container } = render(<StatusBar ws={ws({ readOnly: true, environment: "production" })} version="0.1.0" />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(container.querySelector("footer")).toHaveAttribute("data-env", "production");
  });

  it("shows the version with no connection open", () => {
    render(<StatusBar ws={undefined} version="0.1.0" />);
    expect(screen.getByText("No connection open")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("says Read-only once when the safety mode is read-only too", () => {
    render(<StatusBar ws={ws({ readOnly: true, safetyMode: "read_only" })} version="0.1.0" />);
    expect(screen.getAllByText("Read-only")).toHaveLength(1);
  });
  it("counts the connection's restore points and opens them", async () => {
    mockIPC((cmd) => (cmd === "list_restore_points" ? [{ id: "a" }, { id: "b" }] : null));
    useRestore.setState({ open: false });
    render(<StatusBar ws={ws({ readOnly: false })} version="0.1.0" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore points · 2" }));
    expect(useRestore.getState().open).toBe(true);
  });

  it("has no restore points entry where none are kept", async () => {
    mockIPC((cmd) => (cmd === "list_restore_points" ? [{ id: "a" }] : null));
    render(<StatusBar ws={ws({ readOnly: true })} version="0.1.0" />);
    cleanup();
    const off = { ...(ws({ readOnly: false }) as unknown as Record<string, unknown>), profile: { ...profile, restorePoints: false } } as unknown as Workspace;
    render(<StatusBar ws={off} version="0.1.0" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Restore points/ })).not.toBeInTheDocument();
  });
});
