import { describe, expect, it } from "vitest";
import { snapshot } from "./restore";
import { profile, session } from "../test/fixtures";
import type { Workspace } from "../stores/workspaces";

describe("session snapshot", () => {
  it("keeps a table tab's filter so a followed reference reopens filtered", () => {
    const filter = { type: "group" as const, logic: "and" as const, children: [{ type: "condition" as const, column: "id", op: "eq" as const, value: "42", enabled: true }] };
    const ws = {
      id: "w",
      kind: "sql",
      profile,
      session,
      schema: "public",
      schemas: ["public"],
      objects: {},
      columns: {},
      tabs: [{ kind: "table", id: "t", schema: "public", name: "customers", objectKind: "table", title: "customers", filter }],
      activeTabId: "t",
      closed: [],
      health: "ok",
    } as unknown as Workspace;
    expect(snapshot([ws], "w").workspaces[0]!.tabs[0]).toMatchObject({ kind: "table", name: "customers", filter });
  });
});
