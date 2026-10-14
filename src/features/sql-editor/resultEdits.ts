import type { Cell, ChangeSet, ColumnEdit, StatementResult } from "../../types/backend";
import { cellParam, isBinary, isPartial } from "../../lib/cells";

type Param = string | null;
type ColumnValue = { column: string; value: Param };

/** One pending result edit, stored once per source cell (table + primary key + column). */
export interface ResultEdit {
  table: number;
  key: ColumnValue[];
  column: string;
  value: Param;
  original?: Param;
}
export type ResultEdits = Record<string, ResultEdit>;

function keyOf(st: StatementResult, row: Cell[], table: number): ColumnValue[] | null {
  const t = st.editing!.tables[table]!;
  const key: ColumnValue[] = [];
  for (const i of t.keyColumns) {
    const v = cellParam(row[i] ?? null);
    if (v === undefined || v === null) return null;
    key.push({ column: st.columns![i]!.origin!.column, value: v });
  }
  return key;
}

/** Values committed from this result since it ran, by cell id. */
export type Applied = Record<string, Param>;

/** Why this cell cannot be edited, or null when it can. */
export function readOnlyReason(st: StatementResult, row: Cell[] | undefined, col: number, applied: Applied = {}): string | null {
  const ed = st.editing;
  if (!ed) return "This result cannot be edited";
  const table = ed.columns[col];
  if (table === null || table === undefined) {
    return ed.readOnly.find((r) => r.column === col)?.reason ?? ed.readOnly.find((r) => r.column === undefined)?.reason ?? "This column cannot be edited";
  }
  if (!row) return "Row not loaded";
  // A previewed long value is edited in the value editor, which loads it in full first.
  if (isBinary(row[col] ?? null)) return "Binary values cannot be edited here";
  if (!keyOf(st, row, table)) return `This row has no ${ed.tables[table]!.table} row`;
  // The row is keyed by its key as loaded; once a new key is committed, that key no longer finds it.
  if (ed.tables[table]!.keyColumns.some((k) => (cellId(st, row, k) ?? "") in applied)) {
    return `Run the query again to edit this ${ed.tables[table]!.table} row: its key changed`;
  }
  return null;
}

export function cellId(st: StatementResult, row: Cell[], col: number): string | null {
  const table = st.editing?.columns[col];
  if (table === null || table === undefined) return null;
  const key = keyOf(st, row, table);
  if (!key) return null;
  return JSON.stringify([table, key.map((k) => k.value), st.columns![col]!.origin!.column]);
}

export function setEdit(edits: ResultEdits, st: StatementResult, row: Cell[], col: number, value: Param, applied: Applied = {}): ResultEdits {
  const id = cellId(st, row, col);
  if (!id || readOnlyReason(st, row, col, applied)) return edits;
  // A preview is not the value: the editor loads the full value first, so it can be the original.
  if (!(id in applied) && isPartial(row[col] ?? null)) return edits;
  const table = st.editing!.columns[col]!;
  // After a commit the database holds the committed value; that is what the conflict check compares.
  const original = id in applied ? applied[id]! : cellParam(row[col] ?? null);
  const next = { ...edits };
  if (value === original) delete next[id];
  else next[id] = { table, key: keyOf(st, row, table)!, column: st.columns![col]!.origin!.column, value, original };
  return next;
}

export function displayCell(edits: ResultEdits, applied: Applied, st: StatementResult, row: Cell[], col: number): Cell {
  const id = cellId(st, row, col);
  if (id && id in edits) return edits[id]!.value;
  if (id && id in applied) return applied[id]!;
  return row[col] ?? null;
}

export function buildResultChangeSets(st: StatementResult, edits: ResultEdits): ChangeSet[] {
  const sets: ChangeSet[] = [];
  st.editing!.tables.forEach((t, ti) => {
    const byRow = new Map<string, { type: "update"; key: ColumnValue[]; edits: ColumnEdit[] }>();
    for (const e of Object.values(edits).filter((x) => x.table === ti)) {
      const k = JSON.stringify(e.key);
      const change = byRow.get(k) ?? { type: "update" as const, key: e.key, edits: [] };
      change.edits.push({ column: e.column, value: { kind: "value", value: e.value }, ...(e.original !== undefined ? { original: e.original } : {}) });
      byRow.set(k, change);
    }
    if (byRow.size) sets.push({ schema: t.schema, table: t.table, checkConflicts: true, changes: [...byRow.values()] });
  });
  return sets;
}
