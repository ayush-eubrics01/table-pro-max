import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useWorkspaces, type QueryTab } from "./workspaces";
import { profile, session } from "../test/fixtures";
import { snapshot } from "../app/restore";

beforeEach(() => {
  useWorkspaces.setState({ workspaces: [], activeId: null });
  mockIPC((cmd) => {
    if (cmd === "list_schemas") return ["public", "audit"];
    if (cmd === "list_objects") return [{ schema: "public", name: "users", kind: "table" }];
    return null;
  });
});
afterEach(() => clearMocks());

describe("workspace store", () => {
  it("opens a workspace with the default schema and its objects", async () => {
    const id = await useWorkspaces.getState().open(profile, session);
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.schema).toBe("public");
    expect(ws.objects.public).toHaveLength(1);
    expect(useWorkspaces.getState().activeId).toBe(id);
  });

  it("keeps each query tab's text isolated", async () => {
    const id = await useWorkspaces.getState().open(profile, session);
    const s = useWorkspaces.getState();
    const a = s.openQuery(id, { sql: "select 1" });
    const b = s.openQuery(id, { sql: "select 2" });
    s.updateTab(id, a, { sql: "select 42" });
    const tabs = useWorkspaces.getState().workspaces[0]!.tabs as QueryTab[];
    expect(tabs.find((t) => t.id === a)!.sql).toBe("select 42");
    expect(tabs.find((t) => t.id === b)!.sql).toBe("select 2");
  });

  it("does not duplicate table tabs and can reopen closed tabs", async () => {
    const id = await useWorkspaces.getState().open(profile, session);
    const s = useWorkspaces.getState();
    s.openTable(id, { schema: "public", name: "users", kind: "table" });
    s.openTable(id, { schema: "public", name: "users", kind: "table" });
    let ws = useWorkspaces.getState().workspaces[0]!;
    expect(ws.tabs).toHaveLength(1);
    s.closeTab(id, ws.tabs[0]!.id);
    expect(useWorkspaces.getState().workspaces[0]!.tabs).toHaveLength(0);
    s.reopenClosed(id);
    ws = useWorkspaces.getState().workspaces[0]!;
    expect(ws.tabs).toHaveLength(1);
    expect(ws.activeTabId).toBe(ws.tabs[0]!.id);
  });

  it("reorders tabs", async () => {
    const id = await useWorkspaces.getState().open(profile, session);
    const s = useWorkspaces.getState();
    s.openQuery(id, { title: "A" });
    s.openQuery(id, { title: "B" });
    s.openQuery(id, { title: "C" });
    s.moveTab(id, 0, 2);
    expect(useWorkspaces.getState().workspaces[0]!.tabs.map((t) => t.title)).toEqual(["B", "C", "A"]);
  });

  it("snapshots the workspace for restoration, including unsaved query text", async () => {
    const id = await useWorkspaces.getState().open(profile, session);
    const s = useWorkspaces.getState();
    s.openTable(id, { schema: "public", name: "users", kind: "table" });
    const q = s.openQuery(id, { sql: "select draft" });
    s.updateTab(id, q, { dirty: true });
    const snap = snapshot(useWorkspaces.getState().workspaces, id);
    expect(snap.workspaces[0]).toMatchObject({
      connectionId: "conn-1",
      schema: "public",
      activeIndex: 1,
      tabs: [
        { kind: "table", schema: "public", name: "users" },
        { kind: "query", sql: "select draft", dirty: true },
      ],
    });
    expect(JSON.stringify(snap)).not.toContain("password");
  });
});
