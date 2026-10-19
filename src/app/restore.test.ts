import { describe, expect, it } from "vitest";
import { restoredFilter, snapshot } from "./restore";
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

  it("keeps a query tab's second editor", () => {
    const ws = {
      id: "w",
      kind: "sql",
      profile,
      session,
      schema: "public",
      schemas: ["public"],
      objects: {},
      columns: {},
      tabs: [{ kind: "query", id: "q", title: "Query 1", sql: "select 1", savedQueryId: null, dirty: true, split: true, sql2: "select 2" }],
      activeTabId: "q",
      closed: [],
      health: "ok",
    } as unknown as Workspace;
    expect(snapshot([ws], "w").workspaces[0]!.tabs[0]).toMatchObject({ kind: "query", sql: "select 1", split: true, sql2: "select 2" });
  });

  it("only restores a filter that has the shape of a filter group", () => {
    const ok = { type: "group", logic: "and", children: [] };
    expect(restoredFilter(ok)).toEqual(ok);
    for (const bad of [null, "x", { type: "condition" }, { type: "group", logic: "and" }, { type: "group", children: "no" }]) {
      expect(restoredFilter(bad)).toBeUndefined();
    }
  });
});
