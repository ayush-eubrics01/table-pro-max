import type { Dialect, Driver, SessionInfo } from "../types/backend";

/** sql-formatter's name for the database's SQL. */
export function formatterLanguage(dialect: Dialect, driver: Driver): "postgresql" | "sqlite" | "mariadb" | "mysql" | "transactsql" {
  if (dialect === "postgres") return "postgresql";
  if (dialect === "sqlite") return "sqlite";
  if (dialect === "mssql") return "transactsql";
  return driver === "mariadb" ? "mariadb" : "mysql";
}

/** A name quoted for the database, for SQL the app writes into the editor. */
export function quoteName(dialect: Dialect, name: string): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Where a connection serves several databases (PostgreSQL, SQL Server), each session is opened
 *  on one: reopening it means asking for that database again. */
export function databaseToReopen(session: SessionInfo): string | null {
  return session.capabilities.multipleDatabases ? session.database : null;
}
