import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { UpdateStatus } from "../../types/backend";
import { Overlays } from "../../components/Overlays";
import { usePendingEdits } from "../../stores/pendingEdits";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { profile, session } from "../../test/fixtures";
import { FirstRunUpdatePrompt } from "./FirstRunUpdatePrompt";
import { UpdateBanner } from "./UpdateBanner";
import { useUpdates } from "./store";

let calls: { cmd: string; args: Record<string, unknown> }[];
let stored: Record<string, unknown>;
let status: UpdateStatus;
let checkResult: unknown;
let checkFails: unknown;
const INITIAL = useUpdates.getState();

beforeEach(() => {
  calls = [];
  stored = {};
  status = { currentVersion: "0.1.0", auto: "ask", lastCheck: 0, installKind: "appimage", canInstall: true, openWindows: 1 };
  checkResult = { available: { version: "0.2.0", date: null, notes: "<b>Faster</b> grid" }, skipped: false };
  checkFails = null;
  useUpdates.setState(INITIAL, true);
  usePendingEdits.setState({ byWorkspace: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useWorkspaces.setState({ workspaces: [] });
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      switch (cmd) {
        case "update_status":
          return { ...status, auto: (stored["updates.auto"] as UpdateStatus["auto"]) ?? status.auto };
        case "update_check":
          if (checkFails) throw checkFails;
          return checkResult;
        case "set_setting":
          stored[a.key as string] = a.value;
          return null;
        case "update_install":
          return new Promise(() => undefined); // the real app restarts here
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
});

afterEach(() => {
  cleanup();
  clearMocks();
});

const checks = () => calls.filter((c) => c.cmd === "update_check");
const installs = () => calls.filter((c) => c.cmd === "update_install");

describe("first-run consent", () => {
  it("asks before any check and saves yes", async () => {
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(0);
    render(<FirstRunUpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Check automatically" }));
    await waitFor(() => expect(checks()).toHaveLength(1));
    expect(stored["updates.auto"]).toBe("on");
    expect(checks()[0]!.args).toEqual({ manual: false });
    expect(screen.queryByText("Check for updates automatically?")).not.toBeInTheDocument();
  });

  it("says in the consent dialog what a check reveals and that it can be changed later", async () => {
    await useUpdates.getState().init();
    render(<FirstRunUpdatePrompt />);
    expect(screen.getByText("Asked once. You can change this, or check by hand, in Settings › Updates.")).toBeInTheDocument();
    expect(screen.getByText(/GitHub sees your IP address and that you use the app/)).toBeInTheDocument();
  });

  it("saves no and never checks", async () => {
    await useUpdates.getState().init();
    render(<FirstRunUpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Don't check" }));
    await waitFor(() => expect(stored["updates.auto"]).toBe("off"));
    expect(checks()).toHaveLength(0);
  });

  it("does not check automatically when off", async () => {
    status.auto = "off";
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(0);
  });

  it("stays quiet when an automatic check fails (offline)", async () => {
    status.auto = "on";
    checkFails = { kind: "network", message: "Could not reach the update server" };
    await useUpdates.getState().init();
    expect(checks()).toHaveLength(1);
    expect(useUpdates.getState().phase).toBe("idle");
    expect(useUpdates.getState().error).toBeNull();
  });

  it("shows the error for a failed manual check", async () => {
    checkFails = { kind: "network", message: "Could not reach the update server" };
    await useUpdates.getState().check(true);
    expect(useUpdates.getState().phase).toBe("error");
    expect(useUpdates.getState().error).toContain("Could not reach the update server");
  });
});

describe("update banner", () => {
  const found = async () => {
    status.auto = "on";
    await useUpdates.getState().init();
  };

  it("shows release notes as text, never as HTML", async () => {
    await found();
    const { container } = render(<UpdateBanner />);
    expect(screen.getByText("Table Pro Max 0.2.0 is available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(screen.getByText("<b>Faster</b> grid")).toBeInTheDocument();
    expect(container.querySelector(".update-notes b")).toBeNull();
  });

  it("asks first when tables have uncommitted edits", async () => {
    await found();
    usePendingEdits.getState().set("ws-1", 2);
    render(
      <>
        <UpdateBanner />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText(/2 tables have uncommitted changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/uncommitted changes/)).not.toBeInTheDocument());
    expect(installs()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(installs()).toHaveLength(1));
  });

  it("starts only one install when clicked twice", async () => {
    await found();
    render(<UpdateBanner />);
    const button = screen.getByRole("button", { name: "Update now" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(installs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(installs()).toHaveLength(1);
  });

  it("Cancel stops the running download", async () => {
    await found();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(installs()).toHaveLength(1));
    const jobId = installs()[0]!.args.jobId;
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "update_cancel" && c.args.jobId === jobId)).toBe(true));
  });

  it("offers Download when this install cannot update itself", async () => {
    status.canInstall = false;
    status.installKind = "unknown";
    await found();
    render(<UpdateBanner />);
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "update_open_release_page" && c.args.version === "0.2.0")).toBe(true));
  });

  it("Later hides the banner", async () => {
    await found();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(/is available/)).not.toBeInTheDocument();
  });
});

describe("unsaved work outside the grid", () => {
  const found = async () => {
    status.auto = "on";
    await useUpdates.getState().init();
  };
  const dirtyQuery = () =>
    useWorkspaces.setState({
      workspaces: [
        {
          id: "ws-1",
          profile,
          session,
          schema: "public",
          activeTabId: "t1",
          tabs: [{ kind: "query", id: "t1", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true }],
        },
      ],
    } as never);

  it("warns that other windows will close", async () => {
    status.openWindows = 3;
    await found();
    render(
      <>
        <UpdateBanner />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText(/2 other windows will close/)).toBeInTheDocument();
    expect(installs()).toHaveLength(0);
  });

  it("warns about unsaved query tabs when tabs are not reopened", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, "workspace.restore": false } });
    dirtyQuery();
    await found();
    render(
      <>
        <UpdateBanner />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText(/1 unsaved query tab/)).toBeInTheDocument();
    expect(installs()).toHaveLength(0);
  });

  it("does not warn about query tabs that will be reopened, and saves them first", async () => {
    dirtyQuery();
    await found();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(installs()).toHaveLength(1));
    const order = calls.map((c) => c.cmd).filter((c) => c === "set_workspace" || c === "update_install");
    expect(order).toEqual(["set_workspace", "update_install"]);
  });
});

