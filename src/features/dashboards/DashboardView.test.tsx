import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DashboardView } from "./DashboardView";
import type { Workspace } from "../../stores/workspaces";
import { profile, session } from "../../test/fixtures";

const ws = { id: "ws-1", kind: "sql", profile, session, schema: "public", schemas: ["public"], objects: {}, columns: {}, tabs: [], activeTabId: null, closed: [], health: "ok" } as Workspace;
const tab = { kind: "dashboard" as const, id: "d-tab", dashboardId: "d1", title: "Sales" };

beforeEach(() =>
  mockIPC((cmd) => {
    if (cmd === "list_dashboards") return [{ id: "d1", name: "Sales", definition: { connectionId: profile.id, widgets: [], refreshSecs: 0 } }];
    if (cmd === "connect") return { ...session, sessionId: "dash-sess", readOnly: true };
    return null;
  }),
);
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("DashboardView", () => {
  it("shows the shared Read-only pill, because widgets run on a read-only session", async () => {
    render(<DashboardView ws={ws} tab={tab} active />);
    expect(await screen.findByTitle("Dashboard queries run in a read-only session")).toHaveTextContent("Read-only");
  });
});
