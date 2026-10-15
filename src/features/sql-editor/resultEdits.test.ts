import { describe, expect, it } from "vitest";
import type { StatementResult } from "../../types/backend";
import { buildResultChangeSets, cellId, displayCell, readOnlyReason, setEdit } from "./resultEdits";

const st: StatementResult = {
  index: 0,
  sql: "select …",
  start: 0,
  end: 8,
  durationMs: 1,
  truncated: false,
  columns: [
    { name: "id", typeName: "int4", origin: { schema: "public", table: "orders", column: "id" } },
    { name: "status", typeName: "text", origin: { schema: "public", table: "orders", column: "status" } },
    { name: "cid", typeName: "int4", origin: { schema: "public", table: "customers", column: "id" } },
    { name: "email", typeName: "text", origin: { schema: "public", table: "customers", column: "email" } },
    { name: "n", typeName: "int8" },
  ],
  editing: {
    tables: [
      { schema: "public", table: "orders", keyColumns: [0] },
      { schema: "public", table: "customers", keyColumns: [2] },
    ],
    columns: [0, 0, 1, 1, null],
    readOnly: [{ column: 4, reason: "Computed column" }],
  },
};
const r1 = ["1", "paid", "7", "a@x", "3"];
const r2 = ["2", "new", "7", "a@x", "3"]; // same customer as r1
const rNullKey = ["3", "new", null, null, "3"]; // outer join: no customer

describe("result edits", () => {
  it("knows which cells can be edited and why not", () => {
    expect(readOnlyReason(st, r1, 1)).toBeNull();
    expect(readOnlyReason(st, r1, 4)).toBe("Computed column");
    expect(readOnlyReason(st, rNullKey, 3)).toBe("This row has no customers row");
    expect(readOnlyReason(st, undefined, 1)).toBe("Row not loaded");
  });

  it("one edit shows on every cell with the same identity", () => {
    expect(cellId(st, r1, 3)).toBe(cellId(st, r2, 3));
    const e = setEdit({}, st, r1, 3, "b@x");
    expect(displayCell(e, {}, st, r2, 3)).toBe("b@x");
    expect(displayCell(e, {}, st, r2, 1)).toBe("new");
  });

  it("builds one update per table row, keyed and with originals", () => {
    let e = setEdit({}, st, r1, 1, "shipped");
    e = setEdit(e, st, r2, 3, "b@x"); // the same customer as r1
    e = setEdit(e, st, r1, 3, "c@x"); // last edit wins
    const sets = buildResultChangeSets(st, e);
    expect(sets).toEqual([
      {
        schema: "public",
        table: "orders",
        checkConflicts: true,
        changes: [{ type: "update", key: [{ column: "id", value: "1" }], edits: [{ column: "status", value: { kind: "value", value: "shipped" }, original: "paid" }] }],
      },
      {
        schema: "public",
        table: "customers",
        checkConflicts: true,
        changes: [{ type: "update", key: [{ column: "id", value: "7" }], edits: [{ column: "email", value: { kind: "value", value: "c@x" }, original: "a@x" }] }],
      },
    ]);
  });

  it("applied values show after commit until the next run", () => {
    const id = cellId(st, r1, 1)!;
    expect(displayCell({}, { [id]: "shipped" }, st, r1, 1)).toBe("shipped");
  });

  it("after a commit, the next edit of that cell checks against the committed value", () => {
    const applied = { [cellId(st, r1, 1)!]: "shipped" };
    const again = setEdit({}, st, r1, 1, "paid", applied);
    expect(Object.values(again)[0]).toMatchObject({ value: "paid", original: "shipped" });
    expect(setEdit({}, st, r1, 1, "shipped", applied)).toEqual({});
  });

  it("a row whose key was committed is read-only until the query runs again", () => {
    const applied = { [cellId(st, r1, 2)!]: "8" };
    expect(readOnlyReason(st, r1, 3, applied)).toBe("Run the query again to edit this customers row: its key changed");
    expect(readOnlyReason(st, r1, 1, applied)).toBeNull();
    expect(setEdit({}, st, r1, 3, "z@x", applied)).toEqual({});
  });

  it("an edit back to the original value is dropped", () => {
    const e = setEdit(setEdit({}, st, r1, 1, "shipped"), st, r1, 1, "paid");
    expect(Object.keys(e)).toHaveLength(0);
  });

  it("says plainly when a row's key is a binary value", () => {
    const rBinaryKey = [{ $bytes: "00ff", size: 2 }, "paid", "7", "a@x", "3"];
    expect(readOnlyReason(st, rBinaryKey, 1)).toBe("Rows keyed by a binary value can't be edited here");
    // A missing key (an outer join) still reads as before.
    expect(readOnlyReason(st, rNullKey, 3)).toBe("This row has no customers row");
  });

  it("a previewed value is editable (through the editor), not mistaken for binary", () => {
    const rPartial = ["1", { $partial: "p".repeat(80), length: 900 }, "7", "a@x", "3"];
    expect(readOnlyReason(st, rPartial, 1)).toBeNull();
    expect(readOnlyReason(st, ["1", { $bytes: "00", size: 1 }, "7", "a@x", "3"], 1)).toBe("Binary values cannot be edited here");
  });

  it("never records an edit against a preview (its original would be unknown)", () => {
    const rPartial = ["1", { $partial: "p".repeat(80), length: 900 }, "7", "a@x", "3"];
    expect(setEdit({}, st, rPartial, 1, "new")).toEqual({});
    const full = ["1", "p".repeat(900), "7", "a@x", "3"];
    expect(Object.values(setEdit({}, st, full, 1, "new"))[0]).toMatchObject({ value: "new", original: "p".repeat(900) });
  });
});
