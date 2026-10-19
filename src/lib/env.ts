import type { Driver, Environment, SafetyMode } from "../types/backend";

export const ENVIRONMENTS: { value: Environment; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "development", label: "Development" },
  { value: "testing", label: "Testing" },
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
];

/** Order of the environment groups on the Connections home: the riskiest first. */
export const ENV_ORDER: Environment[] = ["production", "staging", "testing", "development", "local"];

export function envLabel(env: Environment): string {
  return ENVIRONMENTS.find((e) => e.value === env)?.label ?? env;
}

export function envColorVar(env: Environment): string {
  return `var(--env-${env})`;
}

/** CSS variables that colour an environment dot, stripe or badge (see .env-dot, .env-badge). */
export function envStyle(env: Environment): Record<string, string> {
  return {
    "--env-color": `var(--env-${env})`,
    "--env-bg": `var(--env-${env}-bg)`,
    "--env-text": `var(--env-${env}-text)`,
  };
}

export const SAFETY_MODES: { value: SafetyMode; label: string; help: string }[] = [
  { value: "normal", label: "Run everything", help: "Statements run without extra prompts." },
  {
    value: "confirm_destructive",
    label: "Confirm destructive statements",
    help: "Asks before DROP, TRUNCATE, and UPDATE or DELETE without WHERE.",
  },
  { value: "confirm_writes", label: "Confirm all writes", help: "Asks before any statement that may change data or schema." },
  {
    value: "read_only",
    label: "Read-only",
    help: "The database session is opened read-only and write statements are refused.",
  },
];

export function safetyLabel(mode: SafetyMode): string {
  return SAFETY_MODES.find((m) => m.value === mode)?.label ?? mode;
}

export const DRIVERS: { value: Driver; label: string; short: string }[] = [
  { value: "postgres", label: "PostgreSQL", short: "PG" },
  { value: "mysql", label: "MySQL", short: "MY" },
  { value: "mariadb", label: "MariaDB", short: "MA" },
  { value: "mssql", label: "SQL Server", short: "MS" },
  { value: "mongodb", label: "MongoDB", short: "MO" },
  { value: "sqlite", label: "SQLite", short: "SQ" },
  { value: "duckdb", label: "DuckDB", short: "DU" },
  { value: "redis", label: "Redis", short: "RD" },
];

export function isFileDriver(d: Driver): boolean {
  return d === "sqlite" || d === "duckdb";
}

export function driverLabel(d: Driver): string {
  return DRIVERS.find((x) => x.value === d)?.label ?? d;
}

export function driverShort(d: Driver): string {
  return DRIVERS.find((x) => x.value === d)?.short ?? d;
}
