import { describe, expect, it } from "vitest";
import type { Cell, ColumnInfo } from "../../types/backend";
import {
  DEFAULT,
  EMPTY_PENDING,
  buildChangeSet,
  displayRow,
  editCell,
  newInsertedRow,
  pendingCount,
  toggleDelete,
} from "./pending";

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: "text",
  nullable: true,
  default: null,
  primaryKey: null,
  autoIncrement: false,
  comment: null,
  ...extra,
});

const columns = [col("id", { primaryKey: 1, autoIncrement: true, nullable: false }), col("name", { nullable: false }), col("note")];
const rows: Cell[][] = [
  ["1", "ada", null],
  ["2", "grace", "x"],
];

describe("pending changes", () => {
  it("records edits and drops edits that restore the original", () => {
    let p = editCell(EMPTY_PENDING, rows, 0, 1, "Ada");
    expect(pendingCount(p)).toBe(1);
    expect(displayRow(p, rows, 0)).toEqual(["1", "Ada", null]);
    p = editCell(p, rows, 0, 1, "ada");
    expect(pendingCount(p)).toBe(0);
    // NULL -> NULL is not a change either.
    expect(pendingCount(editCell(EMPTY_PENDING, rows, 0, 2, null))).toBe(0);
  });

  it("builds update, delete and insert changes in a safe order", () => {
    let p = editCell(EMPTY_PENDING, rows, 0, 2, "hello");
    p = toggleDelete(p, rows, [1]);
    p = { ...p, inserted: [newInsertedRow(columns, "n1")] };
    p = editCell(p, rows, 2, 1, "linus");
    const set = buildChangeSet(p, rows, columns, "public", "people", true);
    expect(set.changes.map((c) => c.type)).toEqual(["delete", "update", "insert"]);
    expect(set.changes[0]).toEqual({ type: "delete", key: [{ column: "id", value: "2" }] });
    expect(set.changes[1]).toEqual({
      type: "update",
      key: [{ column: "id", value: "1" }],
      edits: [{ column: "note", value: { kind: "value", value: "hello" }, original: null }],
    });
    expect(set.changes[2]).toEqual({
      type: "insert",
      values: [
        { column: "id", value: { kind: "default" } },
        { column: "name", value: { kind: "value", value: "linus" } },
        { column: "note", value: { kind: "value", value: null } },
      ],
    });
  });

  it("deleting an inserted row removes it; toggling delete restores", () => {
    let p = { ...EMPTY_PENDING, inserted: [newInsertedRow(columns, "a")] };
    p = toggleDelete(p, rows, [2]);
    expect(p.inserted).toHaveLength(0);
    p = toggleDelete(p, rows, [0]);
    expect(p.deleted).toEqual([0]);
    p = toggleDelete(p, rows, [0]);
    expect(p.deleted).toEqual([]);
  });

  it("edits on deleted rows are not sent", () => {
    let p = editCell(EMPTY_PENDING, rows, 1, 1, "changed");
    p = toggleDelete(p, rows, [1]);
    const set = buildChangeSet(p, rows, columns, "s", "t", false);
    expect(set.changes).toHaveLength(1);
    expect(set.changes[0]!.type).toBe("delete");
  });

  it("refuses to build a change whose original was never loaded (its conflict check would be skipped)", () => {
    const placeholder: Cell[][] = [["1", "ada", { $notLoaded: true }]];
    const p = { ...EMPTY_PENDING, edits: { 0: { 2: "new" } } };
    expect(() => buildChangeSet(p, placeholder, columns, "public", "people", true)).toThrow(/not loaded/);
  });

  it("refuses to change rows without a primary key", () => {
    const noPk = columns.map((c) => ({ ...c, primaryKey: null }));
    const p = editCell(EMPTY_PENDING, rows, 0, 1, "x");
    expect(() => buildChangeSet(p, rows, noPk, "s", "t", true)).toThrow(/primary key/);
  });

  it("duplicates a row without copying its key", () => {
    const r = newInsertedRow(columns, "d", rows[1]);
    expect(r.values).toEqual([DEFAULT, "grace", "x"]);
  });
});
