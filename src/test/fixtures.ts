import type { ConnectionProfile, SessionInfo, TableStructure } from "../types/backend";

export const profile: ConnectionProfile = {
  id: "conn-1",
  name: "Local PG",
  driver: "postgres",
  host: "localhost",
  port: 5432,
  user: "app",
  database: "app",
  filePath: null,
  tls: { mode: "prefer", caCertPath: null },
  passwordMode: "keychain",
  environment: "production",
  safetyMode: "confirm_destructive",
  color: null,
  group: null,
  tags: [],
  connectTimeoutSecs: 10,
  queryTimeoutSecs: 0,
  keepaliveSecs: 60,
};

export const session: SessionInfo = {
  sessionId: "sess-1",
  connectionId: "conn-1",
  connectionName: "Local PG",
  dialect: "postgres",
  database: "app",
  capabilities: {
    multipleDatabases: true,
    schemas: true,
    cancel: "native",
    transactions: true,
    transactionalDdl: true,
    explain: true,
    explainAnalyze: true,
    materializedViews: true,
    routines: true,
    sequences: true,
  },
  server: { product: "PostgreSQL", version: "16", currentDatabase: "app", currentUser: "app" },
  readOnly: false,
  safetyMode: "confirm_destructive",
  environment: "production",
  target: "app@localhost:5432/app",
};

export const usersStructure: TableStructure = {
  schema: "public",
  name: "users",
  kind: "table",
  columns: [
    { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: 1, autoIncrement: true, comment: null },
    { name: "email", dataType: "text", nullable: false, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "age", dataType: "integer", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
  ],
  indexes: [],
  foreignKeys: [],
  constraints: [],
  triggers: [],
};
