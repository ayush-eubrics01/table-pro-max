import { create } from "zustand";
import { api, toError } from "../lib/ipc";
import { uid } from "../lib/text";
import type { ConnectionProfile, DbObject, FilterNode, ObjectKind, RedisInfo, SessionInfo } from "../types/backend";

export interface TableTab {
  kind: "table";
  id: string;
  schema: string;
  name: string;
  objectKind: ObjectKind;
  title: string;
  /** A followed reference opens filtered to one row; kept with the session. */
  filter?: Extract<FilterNode, { type: "group" }>;
}

export interface QueryTab {
  kind: "query";
  id: string;
  title: string;
  sql: string;
  savedQueryId: string | null;
  /** SQL differs from the saved query (or the tab was never saved). */
  dirty: boolean;
}

export interface DefinitionTab {
  kind: "definition";
  id: string;
  schema: string;
  name: string;
  objectKind: ObjectKind;
  title: string;
}

export interface DashboardTab {
  kind: "dashboard";
  id: string;
  dashboardId: string;
  title: string;
}

export type Tab = TableTab | QueryTab | DefinitionTab | DashboardTab;

export interface Workspace {
  id: string;
  /** SQL databases get the schema browser; Redis gets the key browser. */
  kind: "sql" | "redis";
  profile: ConnectionProfile;
  /** Session used for the schema tree, table browsing and grid edits. */
  session: SessionInfo;
  schema: string;
  schemas: string[];
  objects: Record<string, DbObject[]>;
  /** Column names per "schema.table", loaded on demand for autocomplete. */
  columns: Record<string, string[]>;
  tabs: Tab[];
  activeTabId: string | null;
  closed: Tab[];
  /** Result of the periodic ping of the workspace session. */
  health: "ok" | "down";
  /** Writes were allowed on a production connection that opens read-only (this app run only). */
  allowWrites?: boolean;
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeId: string | null;
  open: (profile: ConnectionProfile, session: SessionInfo) => Promise<string>;
  openRedis: (profile: ConnectionProfile, sessionId: string, info: RedisInfo) => string;
  close: (id: string) => Promise<void>;
  activate: (id: string | null) => void;
  update: (id: string, patch: Partial<Workspace>) => void;
  setSchema: (id: string, schema: string) => Promise<void>;
  loadObjects: (id: string, schema: string, force?: boolean) => Promise<DbObject[]>;
  loadColumns: (id: string, schema: string, table: string) => Promise<void>;
  openTab: (wsId: string, tab: Tab) => void;
  openTable: (wsId: string, obj: Pick<DbObject, "schema" | "name" | "kind">, opts?: { filter?: Extract<FilterNode, { type: "group" }> }) => void;
  openQuery: (wsId: string, init?: Partial<QueryTab>) => string;
  updateTab: (wsId: string, tabId: string, patch: Partial<Tab>) => void;
  closeTab: (wsId: string, tabId: string) => void;
  reopenClosed: (wsId: string) => void;
  moveTab: (wsId: string, from: number, to: number) => void;
  activateTab: (wsId: string, tabId: string) => void;
}

function defaultSchema(session: SessionInfo, schemas: string[]): string {
  if (session.dialect === "postgres") return schemas.includes("public") ? "public" : (schemas[0] ?? "public");
  if (session.dialect === "mysql") return session.database || schemas[0] || "";
  if (session.dialect === "mssql") return schemas.includes("dbo") ? "dbo" : (schemas[0] ?? "dbo");
  return "main";
}

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const patchWs = (id: string, f: (w: Workspace) => Workspace) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? f(w) : w)) }));

  return {
    workspaces: [],
    activeId: null,

    open: async (profile, session) => {
      const schemas = await api.listSchemas(session.sessionId).catch(() => [] as string[]);
      const ws: Workspace = {
        id: uid(),
        kind: "sql",
        profile,
        session,
        schema: defaultSchema(session, schemas),
        schemas,
        objects: {},
        columns: {},
        tabs: [],
        activeTabId: null,
        closed: [],
        health: "ok",
      };
      set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id }));
      await get().loadObjects(ws.id, ws.schema).catch(() => undefined);
      return ws.id;
    },

    openRedis: (profile, sessionId, info) => {
      // Redis has no SQL session; a SessionInfo-shaped record keeps the status bar and
      // connection strip uniform. Its dialect is never used.
      const session: SessionInfo = {
        sessionId,
        connectionId: profile.id,
        connectionName: profile.name,
        dialect: "postgres",
        database: String(info.db),
        capabilities: {
          multipleDatabases: false,
          schemas: false,
          cancel: "native",
          transactions: false,
          transactionalDdl: false,
          explain: false,
          explainAnalyze: false,
          materializedViews: false,
          routines: false,
          sequences: false,
        },
        server: { product: "Redis", version: info.version, currentDatabase: String(info.db), currentUser: profile.user },
        readOnly: profile.safetyMode === "read_only",
        writesLocked: false,
        safetyMode: profile.safetyMode,
        environment: profile.environment,
        target: `${profile.host}:${profile.port ?? 6379}/${info.db}`,
      };
      const ws: Workspace = {
        id: uid(),
        kind: "redis",
        profile,
        session,
        schema: "",
        schemas: [],
        objects: {},
        columns: {},
        tabs: [],
        activeTabId: null,
        closed: [],
        health: "ok",
      };
      set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id }));
      return ws.id;
    },

    close: async (id) => {
      const ws = get().workspaces.find((w) => w.id === id);
      set((s) => {
        const rest = s.workspaces.filter((w) => w.id !== id);
        return { workspaces: rest, activeId: s.activeId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeId };
      });
      if (ws?.kind === "redis") await api.redisDisconnect(ws.session.sessionId).catch(() => undefined);
      else if (ws) await api.disconnect(ws.session.sessionId).catch(() => undefined);
    },

    activate: (id) => set({ activeId: id }),
    update: (id, patch) => patchWs(id, (w) => ({ ...w, ...patch })),

    setSchema: async (id, schema) => {
      patchWs(id, (w) => ({ ...w, schema }));
      await get().loadObjects(id, schema);
    },

    loadObjects: async (id, schema, force = false) => {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws) return [];
      if (!force && ws.objects[schema]) return ws.objects[schema];
      try {
        const sessionId = ws.session.sessionId;
        const objects = await api.listObjects(sessionId, schema);
        // A list from a session the workspace has since left (another database) is not kept.
        patchWs(id, (w) => (w.session.sessionId === sessionId ? { ...w, objects: { ...w.objects, [schema]: objects } } : w));
        return objects;
      } catch (e) {
        throw toError(e);
      }
    },

    loadColumns: async (id, schema, table) => {
      const ws = get().workspaces.find((w) => w.id === id);
      const key = `${schema}.${table}`;
      if (!ws || ws.columns[key]) return;
      // Mark as loading so concurrent callers do not repeat the request.
      patchWs(id, (w) => ({ ...w, columns: { ...w.columns, [key]: [] } }));
      try {
        const st = await api.tableStructure(ws.session.sessionId, schema, table);
        patchWs(id, (w) => ({ ...w, columns: { ...w.columns, [key]: st.columns.map((c) => c.name) } }));
      } catch {
        patchWs(id, (w) => {
          const columns = { ...w.columns };
          delete columns[key];
          return { ...w, columns };
        });
      }
    },

    openTab: (wsId, tab) =>
      patchWs(wsId, (w) => {
        // A filtered tab (a followed reference) is always new, and plain opens never land on one.
        const filtered = (t: Tab) => t.kind === "table" && !!t.filter;
        const existing = filtered(tab)
          ? undefined
          : w.tabs.find((t) => {
              if (filtered(t)) return false;
              if (t.kind === "dashboard" && tab.kind === "dashboard") return t.dashboardId === tab.dashboardId;
              return (
                t.kind !== "query" &&
                t.kind !== "dashboard" &&
                t.kind === tab.kind &&
                "schema" in tab &&
                t.schema === tab.schema &&
                t.name === tab.name
              );
            });
        if (existing) return { ...w, activeTabId: existing.id };
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
      }),

    openTable: (wsId, obj, opts) => {
      const isRoutine = obj.kind === "function" || obj.kind === "procedure" || obj.kind === "sequence";
      get().openTab(wsId, {
        kind: isRoutine ? "definition" : "table",
        id: uid(),
        schema: obj.schema,
        name: obj.name,
        objectKind: obj.kind,
        title: obj.name,
        ...(opts?.filter && !isRoutine ? { filter: opts.filter } : {}),
      });
    },

    openQuery: (wsId, init) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      const n = (ws?.tabs.filter((t) => t.kind === "query").length ?? 0) + 1;
      const tab: QueryTab = {
        kind: "query",
        id: uid(),
        title: init?.title ?? `Query ${n}`,
        sql: init?.sql ?? "",
        savedQueryId: init?.savedQueryId ?? null,
        dirty: init?.dirty ?? false,
      };
      patchWs(wsId, (w) => ({ ...w, tabs: [...w.tabs, tab], activeTabId: tab.id }));
      return tab.id;
    },

    updateTab: (wsId, tabId, patch) =>
      patchWs(wsId, (w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as Tab) : t)) })),

    closeTab: (wsId, tabId) =>
      patchWs(wsId, (w) => {
        const idx = w.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return w;
        const tabs = w.tabs.filter((t) => t.id !== tabId);
        const closedTab = w.tabs[idx]!;
        const activeTabId =
          w.activeTabId === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : w.activeTabId;
        return { ...w, tabs, activeTabId, closed: [closedTab, ...w.closed].slice(0, 20) };
      }),

    reopenClosed: (wsId) =>
      patchWs(wsId, (w) => {
        const [tab, ...rest] = w.closed;
        if (!tab) return w;
        const reopened = { ...tab, id: uid() } as Tab;
        return { ...w, tabs: [...w.tabs, reopened], activeTabId: reopened.id, closed: rest };
      }),

    moveTab: (wsId, from, to) =>
      patchWs(wsId, (w) => {
        const tabs = [...w.tabs];
        const [t] = tabs.splice(from, 1);
        if (!t) return w;
        tabs.splice(to, 0, t);
        return { ...w, tabs };
      }),

    activateTab: (wsId, tabId) => patchWs(wsId, (w) => ({ ...w, activeTabId: tabId })),
  };
});

export function useWorkspace(id: string): Workspace | undefined {
  return useWorkspaces((s) => s.workspaces.find((w) => w.id === id));
}
