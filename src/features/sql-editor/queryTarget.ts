import type { Dialect } from "../../types/backend";

/** Where unqualified names in a query tab resolve, as shown in the toolbar. */
export function queryTarget(dialect: Dialect, driver: string, database: string, schema: string): string {
  if (driver === "sqlite" || driver === "duckdb") return schema || database;
  if (dialect === "mysql") return schema || database;
  return [database, schema].filter(Boolean).join(".");
}
