// Workspace persistence: open connections and their tabs, including unsaved query
// text, so work survives restarts and crashes. Stored only in the local app database.

import { api } from "../lib/ipc";
import type { Workspace } from "../stores/workspaces";

export const WORKSPACE_KEY = "session.v1";

export interface SavedTab {
  kind: "query" | "table" | "definition" | "dashboard";
  dashboardId?: string;
  title: string;
  sql?: string;
  savedQueryId?: string | null;
  dirty?: boolean;
  schema?: string;
  name?: string;
  objectKind?: string;
}

export interface SavedWorkspace {
  connectionId: string;
  database: string;
  schema: string;
  tabs: SavedTab[];
  activeIndex: number;
}

export interface SavedSession {
  workspaces: SavedWorkspace[];
  activeIndex: number;
}

export function snapshot(workspaces: Workspace[], activeId: string | null): SavedSession {
  return {
    activeIndex: Math.max(0, workspaces.findIndex((w) => w.id === activeId)),
    workspaces: workspaces.map((w) => ({
      connectionId: w.profile.id,
      database: w.session.database,
      schema: w.schema,
      activeIndex: Math.max(0, w.tabs.findIndex((t) => t.id === w.activeTabId)),
      tabs: w.tabs.map((t): SavedTab => {
        if (t.kind === "query") return { kind: "query", title: t.title, sql: t.sql, savedQueryId: t.savedQueryId, dirty: t.dirty };
        if (t.kind === "dashboard") return { kind: "dashboard", title: t.title, dashboardId: t.dashboardId };
        return { kind: t.kind, title: t.title, schema: t.schema, name: t.name, objectKind: t.objectKind };
      }),
    })),
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced save; frequent keystrokes collapse into one write. */
export function scheduleSave(workspaces: Workspace[], activeId: string | null) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void api.setWorkspace(WORKSPACE_KEY, snapshot(workspaces, activeId)).catch(() => undefined);
  }, 800);
}

/** Writes the snapshot now, cancelling a pending debounced save (used before restarting). */
export async function saveNow(workspaces: Workspace[], activeId: string | null) {
  clearTimeout(timer);
  await api.setWorkspace(WORKSPACE_KEY, snapshot(workspaces, activeId));
}

export async function loadSaved(): Promise<SavedSession | null> {
  try {
    return await api.getWorkspace<SavedSession>(WORKSPACE_KEY);
  } catch {
    return null;
  }
}
