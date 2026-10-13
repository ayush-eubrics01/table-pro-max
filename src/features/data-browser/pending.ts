// Pending grid edits. Nothing here touches the database: changes accumulate until the
// user reviews and commits them, which sends a ChangeSet to the backend.

import type { Cell, ChangeSet, ColumnEdit, ColumnInfo, RowChange } from "../../types/backend";
import { cellParam } from "../../lib/cells";

export const DEFAULT = Symbol("default");
export type PendingValue = string | null | typeof DEFAULT;

export interface InsertedRow {
  id: string;
  values: PendingValue[];
}

export interface Pending {
  /** row index (within the loaded page) -> column index -> new value */
  edits: Record<number, Record<number, string | null>>;
  deleted: number[];
  inserted: InsertedRow[];
}

export const EMPTY_PENDING: Pending = { edits: {}, deleted: [], inserted: [] };

export function pendingCount(p: Pending): number {
  const updated = Object.keys(p.edits).filter((r) => !p.deleted.includes(Number(r))).length;
  return updated + p.deleted.length + p.inserted.length;
}

export function hasPending(p: Pending): boolean {
  return pendingCount(p) > 0;
}

/** Applies an edit to a loaded row (`row < loadedCount`) or to an inserted row. */
export function editCell(
  p: Pending,
  rows: Cell[][],
  row: number,
  col: number,
  value: string | null,
): Pending {
  if (row >= rows.length) {
    const i = row - rows.length;
    return {
      ...p,
      inserted: p.inserted.map((r, k) => (k === i ? { ...r, values: r.values.map((v, c) => (c === col ? value : v)) } : r)),
    };
  }
  const original = rows[row]?.[col];
  const rowEdits = { ...(p.edits[row] ?? {}) };
  if (original !== undefined && cellParam(original) === value) delete rowEdits[col];
  else rowEdits[col] = value;
  const edits = { ...p.edits };
  if (Object.keys(rowEdits).length === 0) delete edits[row];
  else edits[row] = rowEdits;
  return { ...p, edits };
}

export function newInsertedRow(columns: ColumnInfo[], id: string, copyFrom?: Cell[]): InsertedRow {
  return {
    id,
    values: columns.map((c, i) => {
      if (copyFrom && !c.autoIncrement && c.primaryKey === null) {
        const v = cellParam(copyFrom[i] ?? null);
        if (v !== undefined) return v;
      }
      if (c.autoIncrement || c.default !== null) return DEFAULT;
      return c.nullable ? null : "";
    }),
  };
}

export function toggleDelete(p: Pending, rows: Cell[][], indices: number[]): Pending {
  const existing = indices.filter((i) => i < rows.length);
  const insertedIdx = new Set(indices.filter((i) => i >= rows.length).map((i) => i - rows.length));
  const allDeleted = existing.length > 0 && existing.every((i) => p.deleted.includes(i));
  const deleted = allDeleted
    ? p.deleted.filter((i) => !existing.includes(i))
    : Array.from(new Set([...p.deleted, ...existing])).sort((a, b) => a - b);
  return { ...p, deleted, inserted: p.inserted.filter((_, k) => !insertedIdx.has(k)) };
}

/** The value shown in the grid for a loaded or inserted row. */
export function displayRow(p: Pending, rows: Cell[][], row: number): Cell[] | undefined {
  if (row < rows.length) {
    const base = rows[row];
    const e = p.edits[row];
    if (!base || !e) return base;
    return base.map((c, i) => (i in e ? (e[i] ?? null) : c));
  }
  const ins = p.inserted[row - rows.length];
  return ins?.values.map((v) => (v === DEFAULT ? "(default)" : v));
}

export class ChangeBuildError extends Error {}

export function buildChangeSet(
  p: Pending,
  rows: Cell[][],
  columns: ColumnInfo[],
  schema: string,
  table: string,
  checkConflicts: boolean,
): ChangeSet {
  const pk = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.primaryKey !== null)
    .sort((a, b) => (a.c.primaryKey ?? 0) - (b.c.primaryKey ?? 0));
  const keyOf = (rowIdx: number) => {
    if (pk.length === 0) throw new ChangeBuildError("This table has no primary key, so existing rows cannot be changed.");
    return pk.map(({ c, i }) => {
      const v = cellParam(rows[rowIdx]?.[i] ?? null);
      if (v === undefined) throw new ChangeBuildError(`Primary key column ${c.name} holds binary data and cannot identify the row.`);
      return { column: c.name, value: v };
    });
  };

  const changes: RowChange[] = [];
  for (const r of p.deleted) changes.push({ type: "delete", key: keyOf(r) });
  for (const [rowStr, cols] of Object.entries(p.edits)) {
    const r = Number(rowStr);
    if (p.deleted.includes(r)) continue;
    const edits: ColumnEdit[] = Object.entries(cols).map(([colStr, value]) => {
      const col = Number(colStr);
      const original = cellParam(rows[r]?.[col] ?? null);
      const edit: ColumnEdit = { column: columns[col]!.name, value: { kind: "value", value } };
      if (original !== undefined) edit.original = original;
      return edit;
    });
    changes.push({ type: "update", key: keyOf(r), edits });
  }
  for (const ins of p.inserted) {
    changes.push({
      type: "insert",
      values: ins.values.map((v, i) =>
        v === DEFAULT
          ? { column: columns[i]!.name, value: { kind: "default" } }
          : { column: columns[i]!.name, value: { kind: "value", value: v } },
      ),
    });
  }
  return { schema, table, changes, checkConflicts };
}
