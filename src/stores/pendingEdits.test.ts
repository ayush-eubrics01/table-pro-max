import { beforeEach, describe, expect, it } from "vitest";
import { pendingTableCount, usePendingEdits } from "./pendingEdits";

beforeEach(() => usePendingEdits.setState({ byWorkspace: {} }));

describe("pending edits", () => {
  it("adds up tables across workspaces and forgets workspaces at zero", () => {
    const { set } = usePendingEdits.getState();
    set("a", 2);
    set("b", 1);
    expect(pendingTableCount()).toBe(3);
    set("a", 0);
    expect(pendingTableCount()).toBe(1);
    expect(usePendingEdits.getState().byWorkspace).toEqual({ b: 1 });
  });

  it("does not notify subscribers when nothing changed", () => {
    usePendingEdits.getState().set("a", 1);
    const before = usePendingEdits.getState().byWorkspace;
    usePendingEdits.getState().set("a", 1);
    expect(usePendingEdits.getState().byWorkspace).toBe(before);
  });
});
