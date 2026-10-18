import { api } from "../../lib/ipc";
import { formatCount } from "../../lib/text";
import { notify } from "../../stores/ui";
import type { Cell, Dialect } from "../../types/backend";

/** The most rows one copy takes (the backend refuses more); larger sets are exported instead. */
export const MAX_COPY_ROWS = 100_000;

/** False (after saying so) when `n` rows are too many to copy; checked before reading any. */
export function canCopyRows(n: number): boolean {
  if (n <= MAX_COPY_ROWS) return true;
  notify(`${formatCount(n)} rows are too many to copy (at most ${formatCount(MAX_COPY_ROWS)}); export them instead`, "error");
  return false;
}

/**
 * Copies rows as JSON or as INSERT statements (one per row). The text comes from the export code,
 * so values are quoted and escaped exactly as in a JSON or SQL export. Every value must be loaded.
 */
export async function copyRowsAs(
  format: "json" | "sql",
  columns: { name: string; typeName: string }[],
  rows: Cell[][],
  target: { dialect: Dialect; schema: string | null; table: string },
): Promise<void> {
  const text = await api.rowsAsText(columns, rows, {
    format,
    delimiter: ",",
    header: false,
    nullText: "",
    sqlTable: target.table,
    sqlSchema: target.schema,
    dialect: target.dialect,
    sqlBatch: 1,
  });
  await navigator.clipboard.writeText(text);
}
