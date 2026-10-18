import { api } from "../../lib/ipc";
import type { Cell, Dialect } from "../../types/backend";

/**
 * Copies rows as JSON or as INSERT statements (one per row). The text comes from the export code,
 * so values are quoted and escaped exactly as in a JSON or SQL export. Every value must be loaded.
 */
export async function copyRowsAs(
  format: "json" | "sql",
  columns: { name: string; typeName: string }[],
  rows: Cell[][],
  target: { dialect: Dialect; table: string },
): Promise<void> {
  const text = await api.rowsAsText(columns, rows, {
    format,
    delimiter: ",",
    header: false,
    nullText: "",
    sqlTable: target.table,
    dialect: target.dialect,
    sqlBatch: 1,
  });
  await navigator.clipboard.writeText(text);
}
