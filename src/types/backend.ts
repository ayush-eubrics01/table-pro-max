// Types mirroring the Rust IPC contract (crates/tpm-core and src-tauri/src/commands).
// Keep in sync with the serde representations on the Rust side.

export type Driver = "postgres" | "mysql" | "mariadb" | "sqlite" | "duckdb" | "redis";
export type Dialect = "postgres" | "mysql" | "sqlite";
export type Environment = "local" | "development" | "testing" | "staging" | "production";
export type SafetyMode = "normal" | "confirm_destructive" | "confirm_writes" | "read_only";
export type TlsMode = "disable" | "prefer" | "require" | "require_insecure";
export type PasswordMode = "keychain" | "ask" | "none";

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number | null;
  user: string;
  database: string;
  filePath: string | null;
  tls: { mode: TlsMode; caCertPath: string | null };
  passwordMode: PasswordMode;
  environment: Environment;
  safetyMode: SafetyMode;
  color: string | null;
  group: string | null;
  tags: string[];
  connectTimeoutSecs: number;
  queryTimeoutSecs: number;
  keepaliveSecs: number;
  ssh?: SshConfig | null;
}

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  keyPath: string | null;
  secretMode: PasswordMode;
}

export interface StoredConnection {
  profile: ConnectionProfile;
  sortOrder: number;
  lastUsedAt: string | null;
}

export type ErrorKind =
  | "invalid_config"
  | "authentication"
  | "network"
  | "tls"
  | "ssh"
  | "database"
  | "timeout"
  | "cancelled"
  | "constraint"
  | "conflict"
  | "serialization"
  | "file"
  | "credential_store"
  | "unsupported"
  | "policy_violation"
  | "confirmation_required"
  | "not_found"
  | "internal";

export interface AppError {
  kind: ErrorKind;
  message: string;
  detail?: string;
  code?: string;
  position?: number;
}

/** A cell: NULL, text, or a binary preview. */
export type Cell = null | string | { $bytes: string; size: number };
export type Row = Cell[];

export interface ColumnOrigin {
  schema: string;
  table: string;
  column: string;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
  /** Base table column this result column was read from, when the database reports it. */
  origin?: ColumnOrigin;
}

export interface EditableTable {
  schema: string;
  table: string;
  /** Result column index of each primary-key column, in key order. */
  keyColumns: number[];
}

export interface ReadOnlyReason {
  column?: number;
  reason: string;
}

/** Which cells of a query result can be edited (see result_edit.rs). */
export interface ResultEditing {
  tables: EditableTable[];
  /** Per result column: index into `tables`, or null when the column cannot be edited. */
  columns: (number | null)[];
  readOnly: ReadOnlyReason[];
}

export interface ServerInfo {
  product: string;
  version: string;
  currentDatabase: string;
  currentUser: string;
}

export interface Capabilities {
  multipleDatabases: boolean;
  schemas: boolean;
  cancel: "native" | "kill_query" | "interrupt";
  transactions: boolean;
  transactionalDdl: boolean;
  explain: boolean;
  explainAnalyze: boolean;
  materializedViews: boolean;
  routines: boolean;
  sequences: boolean;
}

export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  connectionName: string;
  dialect: Dialect;
  database: string;
  capabilities: Capabilities;
  server: ServerInfo;
  readOnly: boolean;
  safetyMode: SafetyMode;
  environment: Environment;
  target: string;
}

export type ObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "foreign_table"
  | "function"
  | "procedure"
  | "sequence";

export interface DbObject {
  schema: string;
  name: string;
  kind: ObjectKind;
  comment?: string;
  estimatedRows?: number;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  primaryKey: number | null;
  autoIncrement: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface ConstraintInfo {
  name: string;
  kind: string;
  definition: string;
}

export interface TriggerInfo {
  name: string;
  timing: string;
  event: string;
  definition: string;
}

export interface TableStructure {
  schema: string;
  name: string;
  kind: ObjectKind;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
}

export interface StatementSpan {
  sql: string;
  start: number;
  end: number;
}

export type StatementClass = "read" | "transaction" | "session" | "write" | "ddl" | "unknown" | "destructive";

export interface StatementAnalysis {
  sql: string;
  start: number;
  end: number;
  class: StatementClass;
  reasons: string[];
  parsed: boolean;
}

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "confirm"; reasons: string[] }
  | { decision: "block"; reason: string };

export interface ScriptAnalysis {
  statements: StatementAnalysis[];
  decision: PolicyDecision;
}

export interface RunOptions {
  taskId?: string;
  confirmed?: boolean;
  timeoutSecs?: number;
  maxRows?: number;
  baseOffset?: number;
}

export interface StatementResult {
  index: number;
  sql: string;
  start: number;
  end: number;
  durationMs: number;
  resultId?: string;
  columns?: ColumnMeta[];
  rows?: Row[];
  totalRows?: number;
  truncated: boolean;
  rowsAffected?: number;
  error?: AppError;
  editing?: ResultEditing;
}

export interface ScriptResult {
  taskId: string;
  statements: StatementResult[];
  durationMs: number;
  cancelled: boolean;
}

export type Logic = "and" | "or";
export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "not_like"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "between"
  | "not_between"
  | "is_null"
  | "is_not_null"
  | "is_true"
  | "is_false";

export type FilterNode =
  | { type: "group"; logic: Logic; negate?: boolean; children: FilterNode[] }
  | {
      type: "condition";
      column: string;
      op: FilterOp;
      value?: string | null;
      value2?: string | null;
      values?: string[];
      enabled?: boolean;
    }
  | { type: "raw"; sql: string; enabled?: boolean };

export interface SortSpec {
  column: string;
  descending: boolean;
}

export interface BrowseRequest {
  schema: string;
  table: string;
  filter?: FilterNode | null;
  sort: SortSpec[];
  limit: number;
  offset: number;
}

export interface BrowseResult {
  columns: ColumnMeta[];
  rows: Row[];
  sql: string;
  durationMs: number;
  hasMore: boolean;
}

export type EditValue = { kind: "value"; value: string | null } | { kind: "default" };

export interface ColumnEdit {
  column: string;
  value: EditValue;
  /** Loaded value for the conflict check; omit to skip the check for this column. */
  original?: string | null;
}

export type RowChange =
  | { type: "insert"; values: ColumnEdit[] }
  | { type: "update"; key: { column: string; value: string | null }[]; edits: ColumnEdit[] }
  | { type: "delete"; key: { column: string; value: string | null }[] };

export interface ChangeSet {
  schema: string;
  table: string;
  changes: RowChange[];
  checkConflicts: boolean;
}

export interface ChangePreview {
  sql: string;
  statementCount: number;
  atomic: boolean;
}

export interface ExplainResult {
  format: "postgres_json" | "mysql_json" | "mysql_tree" | "sqlite_plan";
  raw: string;
  rows: { columns: ColumnMeta[]; rows: Row[]; truncated: boolean } | null;
  durationMs: number;
}

export interface ColumnDef {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export type AlterOp =
  | { type: "addColumn"; column: ColumnDef }
  | { type: "dropColumn"; name: string }
  | { type: "renameColumn"; from: string; to: string }
  | { type: "setType"; name: string; dataType: string }
  | { type: "setNullable"; name: string; nullable: boolean }
  | { type: "setDefault"; name: string; default: string | null }
  | { type: "renameTable"; to: string }
  | { type: "createIndex"; name: string; columns: string[]; unique: boolean }
  | { type: "dropIndex"; name: string };

export interface HistoryEntry {
  id: number;
  connectionId: string | null;
  databaseName: string | null;
  sql: string;
  startedAt: string;
  durationMs: number | null;
  status: "success" | "error" | "cancelled";
  rowCount: number | null;
  error: string | null;
}

export interface SavedQuery {
  id: string;
  connectionId: string | null;
  name: string;
  folder: string | null;
  sql: string;
  favorite: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface FilterPreset {
  id: string;
  connectionId: string | null;
  schemaName: string | null;
  tableName: string | null;
  name: string;
  filter: FilterNode;
  createdAt?: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logDir: string;
  credentialStore: string;
  credentialStoreAvailable: boolean;
  platform: string;
}

export type ExportFormat = "csv" | "json" | "json_lines" | "sql" | "xlsx";

export interface ExportOptions {
  format: ExportFormat;
  delimiter: string;
  header: boolean;
  nullText: string;
  sqlTable: string | null;
  dialect: Dialect | null;
  sqlBatch: number;
}

export type ImportFormat = "csv" | "json";

export interface ImportOptions {
  format: ImportFormat;
  delimiter: string;
  quote: string;
  header: boolean;
  encoding: "utf8" | "latin1";
  nullValues: string[];
  trim: boolean;
}

export interface InferredColumn {
  name: string;
  kind: "integer" | "decimal" | "boolean" | "date" | "timestamp" | "text";
  nullable: boolean;
}

export interface ImportPreview {
  columns: InferredColumn[];
  rows: (string | null)[][];
  fileBytes: number;
}

export interface ColumnMapping {
  target: string;
  source: number;
}

export interface RunFileResult {
  statementsRun: number;
  failures: StatementResult[];
  cancelled: boolean;
  durationMs: number;
}

export type WidgetType = "kpi" | "table" | "line" | "bar" | "pie";

export interface WidgetDef {
  id: string;
  title: string;
  type: WidgetType;
  sql: string;
  /** Grid columns spanned (1 or 2). */
  span: 1 | 2;
}

export interface DashboardDefinition {
  version: 1;
  connectionId: string;
  refreshSecs: number;
  range: { from: string; to: string } | null;
  widgets: WidgetDef[];
}

export interface DashboardRecord {
  id: string;
  name: string;
  definition: DashboardDefinition;
  createdAt?: string;
  updatedAt?: string;
}

export interface RedisInfo {
  version: string;
  mode: string;
  db: number;
  keys: number;
}

export interface RedisKey {
  key: string;
  kind: string;
  ttl: number;
}

export type RedisValue =
  | { kind: "none" }
  | { kind: "string"; value: string; length: number; truncated: boolean; binary: boolean }
  | { kind: "hash"; fields: [string, string][]; length: number }
  | { kind: "list"; items: string[]; length: number }
  | { kind: "set"; members: string[]; length: number }
  | { kind: "zset"; items: [string, number][]; length: number }
  | { kind: "stream"; entries: [string, [string, string][]][]; length: number }
  | { kind: "other"; redisType: string };

// ---- AI assistance (crates/tpm-core/src/ai.rs) ----
export type AiProvider = "anthropic" | "openai_compatible";
export type AiTask = "explain" | "explain_error" | "improve" | "generate";

export interface AiConfig {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
}

export interface AiStatus {
  config: AiConfig;
  keyStored: boolean;
  keyPersistent: boolean;
}

export interface AiRequest {
  task: AiTask;
  dialect: string;
  sql: string;
  error?: string | null;
  description?: string | null;
  schema?: string | null;
}

/** Exactly what will be sent; shown to the user before sending. */
export interface AiPrompt {
  endpoint: string;
  model: string;
  system: string;
  user: string;
}

export interface AiAnswer {
  text: string;
  sql: string | null;
  model: string;
  truncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type UpdateAuto = "ask" | "on" | "off";
export type InstallKind = "appimage" | "deb" | "rpm" | "nsis" | "msi" | "app" | "unknown";

export interface UpdateStatus {
  currentVersion: string;
  auto: UpdateAuto;
  /** Milliseconds since the epoch; 0 means never. */
  lastCheck: number;
  installKind: InstallKind;
  canInstall: boolean;
  /** App windows open right now; all of them close when an update restarts the app. */
  openWindows: number;
}

export interface AvailableUpdate {
  version: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateCheck {
  available: AvailableUpdate | null;
  skipped: boolean;
}

export interface UpdateProgress {
  jobId: string;
  downloaded: number;
  total: number | null;
}
