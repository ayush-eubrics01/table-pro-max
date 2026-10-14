// Following a foreign key: which grid cells link to a referenced row, and the filter that finds
// it. A foreign key references a primary or unique key, so the filter matches at most one row.

import type { Cell, ColumnMeta, ForeignKeyInfo, TableStructure } from "../../types/backend";
import { cellParam, isNotLoaded, isPartial } from "../../lib/cells";
import type { GroupNode } from "../filters/filterModel";

export interface FkLink {
  fk: ForeignKeyInfo;
  /** Grid column index for each of `fk.columns`, in order. */
  columns: number[];
}

function add(byCol: FkLink[][], link: FkLink) {
  for (const i of link.columns) byCol[i]!.push(link);
}

export function tableLinks(s: TableStructure): FkLink[][] {
  const byCol: FkLink[][] = s.columns.map(() => []);
  for (const fk of s.foreignKeys) {
    const columns = fk.columns.map((n) => s.columns.findIndex((c) => c.name === n));
    if (columns.every((i) => i >= 0)) add(byCol, { fk, columns });
  }
  return byCol;
}

export function resultLinks(columns: ColumnMeta[], structures: TableStructure[]): FkLink[][] {
  const byCol: FkLink[][] = columns.map(() => []);
  for (const s of structures) {
    const from = (name: string) =>
      columns.flatMap((c, i) => (c.origin && c.origin.schema === s.schema && c.origin.table === s.name && c.origin.column === name ? [i] : []));
    for (const fk of s.foreignKeys) {
      if (fk.columns.length === 1) {
        // Each result column traced to the key column links with its own value.
        for (const i of from(fk.columns[0]!)) add(byCol, { fk, columns: [i] });
        continue;
      }
      // A composite key needs each part exactly once; otherwise the parts can't be paired up.
      const parts = fk.columns.map((n) => from(n));
      if (parts.every((p) => p.length === 1)) add(byCol, { fk, columns: parts.map((p) => p[0]!) });
    }
  }
  return byCol;
}

function linkValues(link: FkLink, row: Cell[]): string[] | null {
  const out: string[] = [];
  for (const i of link.columns) {
    const c = row[i];
    if (c === undefined || c === null || isNotLoaded(c) || isPartial(c)) return null;
    const v = cellParam(c);
    if (v === undefined || v === null) return null;
    out.push(v);
  }
  return out;
}

export function linkFilter(link: FkLink, row: Cell[]): GroupNode | null {
  const values = linkValues(link, row);
  if (!values) return null;
  return {
    type: "group",
    logic: "and",
    children: link.fk.refColumns.map((column, k) => ({ type: "condition", column, op: "eq", value: values[k]!, enabled: true })),
  };
}

export function linkLabel(link: FkLink, row: Cell[]): string | null {
  const values = linkValues(link, row);
  if (!values) return null;
  return `Open ${link.fk.refTable} where ${link.fk.refColumns.map((c, k) => `${c} = ${values[k]}`).join(" and ")}`;
}
