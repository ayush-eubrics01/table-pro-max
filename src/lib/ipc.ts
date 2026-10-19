// Typed wrappers around Tauri commands. All database work happens in Rust; the
// frontend never sees passwords except while the user is typing them.

import { invoke } from "@tauri-apps/api/core";
import type {
  MongoAggregateRequest,
  MongoCollection,
  MongoDatabase,
  MongoDeleteTarget,
  MongoFindRequest,
  MongoInfo,
  MongoPage,
  MongoVectorRequest,
  Pin,
  Snippet,
  Cell,
  FetchedCell,
  AiAnswer,
  AiPrompt,
  AiProvider,
  AiRequest,
  AiStatus,
  UpdateCheck,
  UpdateStatus,
  AlterOp,
  AppError,
  AppInfo,
  BrowseRequest,
  BrowseResult,
  ChangePreview,
  ApplyResult,
  RestorePoint,
  ReferencingKey,
  RestorePointSummary,
  RestoreUsage,
  ChangeSet,
  ConnectionProfile,
  DbObject,
  Dialect,
  ExplainResult,
  FilterNode,
  FilterPreset,
  ColumnFetch,
  FetchMode,
  HistoryEntry,
  ObjectKind,
  Row,
  RunOptions,
  SavedQuery,
  ScriptAnalysis,
  ScriptResult,
  ServerInfo,
  SessionInfo,
  StatementSpan,
  StoredConnection,
  TableStructure,
  ColumnDef,
  ColumnMapping,
  Driver,
  ExportOptions,
  ImportOptions,
  ImportPreview,
  RunFileResult,
  RedisInfo,
  RedisKey,
  RedisValue,
  ColumnMeta,
  DashboardRecord,
} from "../types/backend";

export class BackendError extends Error {
  readonly kind: AppError["kind"];
  readonly detail?: string;
  readonly code?: string;
  readonly position?: number;

  constructor(e: AppError) {
    super(e.message);
    this.name = "BackendError";
    this.kind = e.kind;
    this.detail = e.detail;
    this.code = e.code;
    this.position = e.position;
  }
}

export function isAppError(v: unknown): v is AppError {
  return typeof v === "object" && v !== null && "kind" in v && "message" in v;
}

export function toError(e: unknown): BackendError {
  if (e instanceof BackendError) return e;
  if (isAppError(e)) return new BackendError(e);
  if (e instanceof Error) return new BackendError({ kind: "internal", message: e.message });
  return new BackendError({ kind: "internal", message: String(e) });
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  openWindow: () => call<void>("open_window"),

  // connections
  listConnections: () => call<StoredConnection[]>("list_connections"),
  parseUrl: (url: string) => call<{ profile: ConnectionProfile; password: string | null }>("parse_url", { url }),
  saveConnection: (profile: ConnectionProfile, password: string | null, sshSecret: string | null = null) =>
    call<ConnectionProfile>("save_connection", { request: { profile, password, sshSecret } }),
  deleteConnection: (id: string) => call<void>("delete_connection", { id }),
  duplicateConnection: (id: string) => call<ConnectionProfile>("duplicate_connection", { id }),
  reorderConnections: (ids: string[]) => call<void>("reorder_connections", { ids }),
  testConnection: (profile: ConnectionProfile, password: string | null, sshSecret: string | null = null) =>
    call<ServerInfo>("test_connection", { request: { profile, password, sshSecret } }),
  connect: (
    connectionId: string,
    opts: {
      password?: string | null;
      sshSecret?: string | null;
      database?: string | null;
      rememberForSession?: boolean;
      readOnly?: boolean;
      /** Open production read-only (true) or writable (false); omitted follows the setting. */
      lockProduction?: boolean;
      /** Id for "connect-progress" events and `cancelConnect`. */
      connectId?: string;
    } = {},
  ) =>
    call<SessionInfo>("connect", {
      request: {
        connectionId,
        password: opts.password ?? null,
        sshSecret: opts.sshSecret ?? null,
        database: opts.database ?? null,
        rememberForSession: opts.rememberForSession ?? false,
        readOnly: opts.readOnly ?? false,
        lockProduction: opts.lockProduction ?? null,
        connectId: opts.connectId ?? null,
      },
    }),
  disconnect: (sessionId: string) => call<void>("disconnect", { sessionId }),
  /** Stops a connection attempt; false when it already finished. */
  cancelConnect: (connectId: string) => call<boolean>("cancel_connect", { connectId }),
  reconnect: (sessionId: string, password?: string | null, sshSecret?: string | null) =>
    call<SessionInfo>("reconnect", { sessionId, password: password ?? null, sshSecret: sshSecret ?? null }),
  exportConnections: (path: string, ids: string[] | null) => call<number>("export_connections", { path, ids }),
  importConnections: (path: string) => call<number>("import_connections", { path }),
  trustSshHost: (host: string, port: number, key: string) => call<void>("trust_ssh_host", { host, port, key }),
  ping: (sessionId: string) => call<void>("ping", { sessionId }),
  setDefaultSchema: (sessionId: string, schema: string) => call<void>("set_default_schema", { sessionId, schema }),
  createDatabaseFile: (driver: Driver, path: string) => call<void>("create_database_file", { driver, path }),

  // metadata
  listDatabases: (sessionId: string) => call<string[]>("list_databases", { sessionId }),
  listSchemas: (sessionId: string) => call<string[]>("list_schemas", { sessionId }),
  listObjects: (sessionId: string, schema: string) => call<DbObject[]>("list_objects", { sessionId, schema }),
  tableStructure: (sessionId: string, schema: string, table: string, refresh = false) =>
    call<TableStructure>("table_structure", { sessionId, schema, table, refresh }),
  referencingKeys: (sessionId: string, schema: string, table: string) => call<ReferencingKey[]>("referencing_keys", { sessionId, schema, table }),
  objectDefinition: (sessionId: string, schema: string, name: string, kind: ObjectKind) =>
    call<string>("object_definition", { sessionId, schema, name, kind }),

  // SQL
  splitSql: (sql: string, dialect: Dialect) => call<StatementSpan[]>("split_sql", { sql, dialect }),
  /** The `:name` (or `$1`) parameters a script asks for, each once, in order. */
  scriptParameters: (sql: string, dialect: Dialect) => call<string[]>("script_parameters", { sql, dialect }),
  statementAtCursor: (sql: string, dialect: Dialect, cursor: number) =>
    call<StatementSpan | null>("statement_at_cursor", { sql, dialect, cursor }),
  analyzeSql: (sessionId: string, sql: string) => call<ScriptAnalysis>("analyze_sql", { sessionId, sql }),
  runQuery: (sessionId: string, sql: string, options: RunOptions) =>
    call<ScriptResult>("run_query", { sessionId, sql, options }),
  cancelQuery: (taskId: string) => call<boolean>("cancel_query", { taskId }),
  fetchRows: (resultId: string, offset: number, limit: number) =>
    call<Row[]>("fetch_rows", { resultId, offset, limit }),
  releaseResults: (resultIds: string[]) => call<void>("release_results", { resultIds }),
  explain: (sessionId: string, sql: string, analyze: boolean, confirmed = false, typedConfirmation?: string) =>
    call<ExplainResult>("explain_query", { sessionId, request: { sql, analyze, confirmed, typedConfirmation: typedConfirmation ?? null } }),

  // browsing & editing
  browseTable: (sessionId: string, request: BrowseRequest) => call<BrowseResult>("browse_table", { sessionId, request }),
  fetchValue: (sessionId: string, schema: string, table: string, key: { column: string; value: string | null }[], column: string) =>
    call<Cell>("fetch_value", { sessionId, schema, table, key, column }),
  resultValue: (resultId: string, row: number, col: number) => call<Cell>("result_value", { resultId, row, col }),
  resultValues: (resultId: string, cells: [number, number][]) => call<Cell[]>("result_values", { resultId, cells }),
  fetchColumn: (sessionId: string, schema: string, table: string, column: string, keys: { column: string; value: string | null }[][]) =>
    call<FetchedCell[]>("fetch_column", { sessionId, schema, table, column, keys }),
  countRows: (sessionId: string, schema: string, table: string, filter: FilterNode | null) =>
    call<number>("count_rows", { sessionId, schema, table, filter }),
  previewChanges: (sessionId: string, changes: ChangeSet) =>
    call<ChangePreview>("preview_changes", { sessionId, changes }),
  applyChanges: (sessionId: string, changes: ChangeSet) =>
    call<ApplyResult>("apply_changes", { sessionId, changes, confirmed: true }),
  previewChangeSets: (sessionId: string, sets: ChangeSet[]) => call<ChangePreview>("preview_change_sets", { sessionId, sets }),
  applyChangeSets: (sessionId: string, sets: ChangeSet[]) => call<ApplyResult>("apply_change_sets", { sessionId, sets, confirmed: true }),
  // Restore points: `rows` are indexes into the point's rows, null for all of them.
  listRestorePoints: (connectionId: string) => call<RestorePointSummary[]>("list_restore_points", { connectionId }),
  getRestorePoint: (id: string) => call<RestorePoint>("get_restore_point", { id }),
  deleteRestorePoint: (id: string) => call<void>("delete_restore_point", { id }),
  deleteRestorePoints: (connectionId: string) => call<number>("delete_restore_points", { connectionId }),
  restorePointsUsage: () => call<RestoreUsage>("restore_points_usage"),
  previewRestore: (sessionId: string, pointId: string, rows: number[] | null) =>
    call<ChangePreview>("preview_restore", { sessionId, pointId, rows }),
  /** `taskId`: for "restore-progress" events and `cancelQuery`. */
  applyRestore: (sessionId: string, pointId: string, rows: number[] | null, taskId?: string) =>
    call<number[]>("apply_restore", { sessionId, pointId, rows, confirmed: true, taskId: taskId ?? null }),
  previewCreateTable: (sessionId: string, request: { schema: string; name: string; columns: ColumnDef[] }) =>
    call<string[]>("preview_create_table", { sessionId, request }),
  previewAlterTable: (sessionId: string, schema: string, table: string, ops: AlterOp[]) =>
    call<string[]>("preview_alter_table", { sessionId, schema, table, ops }),
  /** Runs reviewed DDL. On production, statements that destroy data also need the connection name. */
  applyDdl: (sessionId: string, statements: string[], typedConfirmation?: string) =>
    call<void>("apply_ddl", { sessionId, statements, confirmed: true, typedConfirmation: typedConfirmation ?? null }),

  // import/export
  cancelJob: (jobId: string) => call<boolean>("cancel_job", { jobId }),
  exportResult: (resultId: string, path: string, options: ExportOptions) =>
    call<number>("export_result", { resultId, path, options }),
  exportTable: (sessionId: string, source: BrowseRequest, path: string, options: ExportOptions, jobId: string) =>
    call<number>("export_table", { request: { sessionId, source, path, options, jobId } }),
  listSnippets: () => call<Snippet[]>("list_snippets"),
  saveSnippet: (snippet: Snippet) => call<void>("save_snippet", { snippet }),
  deleteSnippet: (id: string) => call<void>("delete_snippet", { id }),
  /** Pins of a connection in one database (empty where a connection has one database). */
  listPins: (connectionId: string, database: string) => call<Pin[]>("list_pins", { connectionId, database }),
  pinObject: (connectionId: string, database: string, pin: Pin) => call<void>("pin_object", { connectionId, database, pin }),
  unpinObject: (connectionId: string, database: string, pin: Pin) => call<void>("unpin_object", { connectionId, database, pin }),
  /** Rows as JSON or INSERT text for the clipboard (cells as the grid holds them, fully loaded). */
  rowsAsText: (columns: { name: string; typeName: string }[], rows: Cell[][], options: ExportOptions) =>
    call<string>("rows_as_text", { request: { columns, rows, options } }),
  exportRows: (columns: { name: string; typeName: string }[], rows: (string | null)[][], path: string, options: ExportOptions) =>
    call<number>("export_rows", { request: { columns, rows, path, options } }),
  previewImport: (path: string, options: ImportOptions) => call<ImportPreview>("preview_import", { path, options }),
  importFile: (
    sessionId: string,
    importReq: { path: string; options: ImportOptions; schema: string; table: string; mapping: ColumnMapping[]; skip: number },
    createStatements: string[],
    jobId: string,
  ) => call<number>("import_file", { request: { sessionId, import: importReq, createStatements, jobId, confirmed: true } }),
  readSqlFile: (path: string) => call<string>("read_sql_file", { path }),
  writeSqlFile: (path: string, contents: string) => call<void>("write_sql_file", { path, contents }),
  runSqlFile: (sessionId: string, path: string, taskId: string, confirmed: boolean, typedConfirmation?: string) =>
    call<RunFileResult>("run_sql_file", { request: { sessionId, path, taskId, confirmed, typedConfirmation: typedConfirmation ?? null } }),

  runWidget: (sessionId: string, sql: string, params: Record<string, string>, timeoutSecs = 30) =>
    call<{ columns: ColumnMeta[]; rows: Row[]; truncated: boolean }>("run_widget_query", {
      request: { sessionId, sql, params, timeoutSecs },
    }),
  listDashboards: () => call<DashboardRecord[]>("list_dashboards"),
  saveDashboard: (dashboard: DashboardRecord) => call<void>("save_dashboard", { dashboard }),
  deleteDashboard: (id: string) => call<void>("delete_dashboard", { id }),

  // mongodb
  mongoConnect: (
    connectionId: string,
    opts: { password?: string | null; sshSecret?: string | null; rememberForSession?: boolean; lockProduction?: boolean } = {},
  ) =>
    call<{ sessionId: string; info: MongoInfo }>("mongo_connect", {
      request: {
        connectionId,
        password: opts.password ?? null,
        sshSecret: opts.sshSecret ?? null,
        rememberForSession: opts.rememberForSession ?? false,
        lockProduction: opts.lockProduction ?? null,
      },
    }),
  mongoDisconnect: (sessionId: string) => call<void>("mongo_disconnect", { sessionId }),
  mongoDatabases: (sessionId: string) => call<MongoDatabase[]>("mongo_databases", { sessionId }),
  mongoCollections: (sessionId: string, database: string) => call<MongoCollection[]>("mongo_collections", { sessionId, database }),
  mongoFind: (sessionId: string, request: MongoFindRequest) => call<MongoPage>("mongo_find", { sessionId, request }),
  mongoCount: (sessionId: string, database: string, collection: string, filter: string) =>
    call<number>("mongo_count", { sessionId, database, collection, filter }),
  mongoAggregate: (sessionId: string, request: MongoAggregateRequest) => call<MongoPage>("mongo_aggregate", { sessionId, request }),
  mongoVectorSearch: (sessionId: string, request: MongoVectorRequest) => call<MongoPage>("mongo_vector_search", { sessionId, request }),
  mongoDeleteCount: (sessionId: string, database: string, collection: string, target: MongoDeleteTarget) =>
    call<number>("mongo_delete_count", { sessionId, database, collection, target }),
  mongoDelete: (
    sessionId: string,
    request: { database: string; collection: string; target: MongoDeleteTarget; expected: number; confirmed: boolean; typedConfirmation?: string | null },
  ) => call<number>("mongo_delete", { sessionId, request }),

  // redis
  redisConnect: (connectionId: string, opts: { password?: string | null; sshSecret?: string | null; rememberForSession?: boolean } = {}) =>
    call<{ sessionId: string; info: RedisInfo }>("redis_connect", {
      request: {
        connectionId,
        password: opts.password ?? null,
        sshSecret: opts.sshSecret ?? null,
        rememberForSession: opts.rememberForSession ?? false,
      },
    }),
  redisDisconnect: (sessionId: string) => call<void>("redis_disconnect", { sessionId }),
  redisInfo: (sessionId: string) => call<RedisInfo>("redis_info", { sessionId }),
  redisScan: (sessionId: string, cursor: string, pattern: string, count = 500) =>
    call<{ cursor: string; keys: RedisKey[] }>("redis_scan", { sessionId, cursor, pattern, count }),
  redisRead: (sessionId: string, key: string) => call<RedisValue>("redis_read", { sessionId, key }),
  redisSetString: (sessionId: string, key: string, value: string, keepTtl = true) =>
    call<void>("redis_set_string", { sessionId, key, value, keepTtl }),
  redisHashSet: (sessionId: string, key: string, field: string, value: string) =>
    call<void>("redis_hash_set", { sessionId, key, field, value }),
  redisHashDelete: (sessionId: string, key: string, field: string) => call<void>("redis_hash_delete", { sessionId, key, field }),
  redisDelete: (sessionId: string, key: string) => call<boolean>("redis_delete", { sessionId, key }),
  redisExpire: (sessionId: string, key: string, seconds: number | null) => call<void>("redis_expire", { sessionId, key, seconds }),
  redisCommand: (sessionId: string, line: string, confirmed = false) => call<string>("redis_command", { sessionId, line, confirmed }),

  // library
  searchHistory: (connectionId: string | null, search: string, limit = 200) =>
    call<HistoryEntry[]>("search_history", { connectionId, search, limit }),
  deleteHistory: (ids: number[]) => call<void>("delete_history", { ids }),
  clearHistory: (connectionId: string | null) => call<void>("clear_history", { connectionId }),
  pruneHistoryNow: (days: number, maxEntries: number) => call<number>("prune_history", { days, maxEntries }),
  listSavedQueries: () => call<SavedQuery[]>("list_saved_queries"),
  saveQuery: (query: SavedQuery) => call<void>("save_query", { query }),
  deleteSavedQuery: (id: string) => call<void>("delete_saved_query", { id }),
  listFilterPresets: (connectionId: string, schema: string, table: string) =>
    call<FilterPreset[]>("list_filter_presets", { connectionId, schema, table }),
  saveFilterPreset: (preset: FilterPreset) => call<void>("save_filter_preset", { preset }),
  deleteFilterPreset: (id: string) => call<void>("delete_filter_preset", { id }),
  listColumnFetch: (connectionId: string, schema: string, table: string) => call<ColumnFetch[]>("list_column_fetch", { connectionId, schema, table }),
  setColumnFetch: (connectionId: string, schema: string, table: string, column: string, mode: FetchMode | null) =>
    call<void>("set_column_fetch", { connectionId, schema, table, column, mode }),
  // AI assistance (off unless enabled in Settings)
  aiStatus: () => call<AiStatus>("ai_status"),
  aiSetKey: (provider: AiProvider, key: string | null) => call<void>("ai_set_key", { request: { provider, key } }),
  aiPreview: (request: AiRequest) => call<AiPrompt>("ai_preview", { request }),
  aiSend: (prompt: AiPrompt, jobId: string) => call<AiAnswer>("ai_send", { prompt, jobId }),
  aiCancel: (jobId: string) => call<void>("ai_cancel", { jobId }),
  updateStatus: () => call<UpdateStatus>("update_status"),
  updateCheck: (manual: boolean) => call<UpdateCheck>("update_check", { manual }),
  updateInstall: (jobId: string) => call<void>("update_install", { jobId }),
  updateCancel: (jobId: string) => call<void>("update_cancel", { jobId }),
  updateOpenReleasePage: (version: string) => call<void>("update_open_release_page", { version }),
  getSettings: () => call<Record<string, unknown>>("get_settings"),
  setSetting: (key: string, value: unknown) => call<void>("set_setting", { key, value }),
  resetSettings: () => call<void>("reset_settings"),
  getWorkspace: <T>(key: string) => call<T | null>("get_workspace", { key }),
  setWorkspace: (key: string, value: unknown) => call<void>("set_workspace", { key, value }),
};

export type Api = typeof api;
