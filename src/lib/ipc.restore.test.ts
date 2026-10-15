import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { api } from "./ipc";

afterEach(() => clearMocks());

describe("restore point commands", () => {
  it("call the backend with the expected arguments", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "list_restore_points") return [];
      if (cmd === "preview_restore") return { sql: "", statementCount: 0, atomic: true };
      return null;
    });
    await api.listRestorePoints("c1");
    await api.getRestorePoint("p1");
    await api.previewRestore("s1", "p1", [0, 2]);
    await api.applyRestore("s1", "p1", null);
    await api.deleteRestorePoint("p1");
    expect(calls.map((c) => c[0])).toEqual([
      "list_restore_points",
      "get_restore_point",
      "preview_restore",
      "apply_restore",
      "delete_restore_point",
    ]);
    expect(calls[0]![1]).toMatchObject({ connectionId: "c1" });
    expect(calls[2]![1]).toMatchObject({ sessionId: "s1", pointId: "p1", rows: [0, 2] });
    expect(calls[3]![1]).toMatchObject({ sessionId: "s1", pointId: "p1", rows: null, confirmed: true });
    expect(calls[4]![1]).toMatchObject({ id: "p1" });
  });
});
