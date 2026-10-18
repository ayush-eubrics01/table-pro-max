import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useRestore } from "../stores/restore";
import { StatusBar } from "./WorkspaceView";
import { profile, session } from "../test/fixtures";
import { useWorkspaces, type Workspace } from "../stores/workspaces";
import { Overlays } from "../components/Overlays";

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

describe("StatusBar: production opened read-only", () => {
  const locked = () => {
    const w = { ...(ws({ readOnly: true, writesLocked: true, safetyMode: "read_only", environment: "production" }) as unknown as Record<string, unknown>), kind: "sql" } as unknown as Workspace;
    useWorkspaces.setState({ workspaces: [w], activeId: w.id });
    return w;
  };

  it("allows writes for this session after the connection name is typed", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "connect") return { ...session, sessionId: "sess-2", readOnly: false, writesLocked: false };
      return cmd.startsWith("list_") ? [] : null;
    });
    const w = locked();
    render(
      <>
        <StatusBar ws={w} version="0.1.0" />
        <Overlays />
      </>,
    );
    expect(screen.getByText("Read-only (production)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow writes" }));
    await screen.findByRole("dialog");
    const confirm = screen.getAllByRole("button", { name: "Allow writes" }).at(-1)!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`Type ${session.connectionName} to confirm`), { target: { value: session.connectionName } });
    fireEvent.click(confirm);
    await waitFor(() => expect(useWorkspaces.getState().workspaces[0]!.session.sessionId).toBe("sess-2"));
    const connect = calls.find((c) => c.cmd === "connect")!;
    expect((connect.args.request as Record<string, unknown>).allowWrites).toBe(true);
    expect(useWorkspaces.getState().workspaces[0]!.allowWrites).toBe(true);
    expect(calls.some((c) => c.cmd === "disconnect" && c.args.sessionId === session.sessionId)).toBe(true);
  });

  it("goes back to read-only without asking", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "connect") return { ...session, sessionId: "sess-3", readOnly: true, writesLocked: true };
      return cmd.startsWith("list_") ? [] : null;
    });
    const w = { ...(ws({ readOnly: false, environment: "production" }) as unknown as Record<string, unknown>), kind: "sql", allowWrites: true } as unknown as Workspace;
    useWorkspaces.setState({ workspaces: [w], activeId: w.id });
    render(<StatusBar ws={w} version="0.1.0" />);
    fireEvent.click(screen.getByRole("button", { name: "Back to read-only" }));
    await waitFor(() => expect(useWorkspaces.getState().workspaces[0]!.session.sessionId).toBe("sess-3"));
    expect((calls.find((c) => c.cmd === "connect")!.args.request as Record<string, unknown>).allowWrites).toBe(false);
    expect(useWorkspaces.getState().workspaces[0]!.allowWrites).toBe(false);
  });
});
