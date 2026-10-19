// Following a foreign key: which grid cells link to a referenced row, and the filter that finds
// it. A foreign key references a primary or unique key, so the filter matches at most one row.

import type { Cell, ColumnMeta, ForeignKeyInfo, ReferencingKey, TableStructure } from "../../types/backend";
import { cellParam, isNotLoaded, isPartial } from "../../lib/cells";
import { filterToText, type GroupNode } from "../filters/filterModel";

export interface FkLink {
  fk: ForeignKeyInfo;
  /** Grid column index for each of `fk.columns`, in order. */
  columns: number[];
}

function add(byCol: FkLink[][], link: FkLink) {
  // A key whose referenced columns are unknown can't build a filter: no link.
  const fk = link.fk;
  if (fk.refColumns.length !== fk.columns.length || fk.refColumns.some((c) => !c)) return;
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

function linkValues(link: Pick<FkLink, "columns">, row: Cell[]): string[] | null {
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

/**
 * The link a cell follows: the first of its column's foreign keys that the row's values can use.
 * The row is only built for columns that have links (this runs for every visible cell).
 */
export function firstLink(links: FkLink[][], col: number, row: () => Cell[] | undefined): { link: FkLink; filter: GroupNode; label: string } | null {
  const candidates = links[col];
  if (!candidates || candidates.length === 0) return null;
  const cells = row();
  if (!cells) return null;
  for (const link of candidates) {
    const filter = linkFilter(link, cells);
    const label = linkLabel(link, cells);
    if (filter && label) return { link, filter, label };
  }
  return null;
}

export function linkLabel(link: FkLink, row: Cell[]): string | null {
  const filter = linkFilter(link, row);
  if (!filter) return null;
  // Worded like the filter chips the opened tab shows (the same formatter).
  return `Open ${link.fk.refTable} where ${filter.children.map(filterToText).join(" and ")}`;
}

export interface ReferencingItem {
  label: string;
  schema: string;
  table: string;
  /** Finds the rows of `schema.table` whose key holds this row's values. */
  filter: GroupNode;
}

/**
 * "Rows that point here": for each foreign key in another table that references this one, the
 * filter that finds the rows holding this row's values. A key needs every referenced value; a
 * NULL, unloaded or preview value can't be pointed at.
 */
export function referencingItems(keys: ReferencingKey[], s: TableStructure, row: Cell[]): ReferencingItem[] {
  const repeated = (k: ReferencingKey) => keys.filter((o) => o.schema === k.schema && o.table === k.table).length > 1;
  return keys.flatMap((k) => {
    const columns = k.refColumns.map((n) => s.columns.findIndex((c) => c.name === n));
    if (columns.length !== k.columns.length || columns.some((i) => i < 0)) return [];
    const values = linkValues({ columns }, row);
    if (!values) return [];
    const name = k.schema === s.schema ? k.table : `${k.schema}.${k.table}`;
    return [
      {
        label: `Rows in ${name} that point here${repeated(k) ? ` (${k.columns.join(", ")})` : ""}`,
        schema: k.schema,
        table: k.table,
        filter: {
          type: "group",
          logic: "and",
          children: k.columns.map((column, i) => ({ type: "condition", column, op: "eq", value: values[i]!, enabled: true })),
        },
      },
    ];
  });
}
