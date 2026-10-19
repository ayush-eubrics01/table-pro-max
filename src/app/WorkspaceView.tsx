import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { useRestore } from "../stores/restore";
import { RestorePanel } from "../features/restore/RestorePanel";
import { usePendingEdits } from "../stores/pendingEdits";
import { Sidebar } from "../features/database-explorer/Sidebar";
import { ObjectTabs } from "./ObjectTabs";
import { WorkspaceEmpty } from "./WorkspaceEmpty";
import { TableView } from "../features/data-browser/TableView";
import type { GroupNode } from "../features/filters/filterModel";
import { QueryTab } from "../features/sql-editor/QueryTab";
import { DefinitionView } from "../features/schema-browser/DefinitionView";
import { DashboardView } from "../features/dashboards/DashboardView";
import { RedisView } from "../features/redis/RedisView";
import { api } from "../lib/ipc";
import { databaseToReopen } from "../lib/dialect";
import { envColorVar, envLabel, envStyle, safetyLabel } from "../lib/env";
import { confirmAction, notifyError } from "../stores/ui";
import { connectWithPrompt, reconnectWithPrompt } from "../features/connections/connectFlow";
import { ConnectionLine } from "../features/connections/nameConfirm";

export function WorkspaceView({ ws, visible }: { ws: Workspace; visible: boolean }) {
  const { closeTab, openQuery, openTable, update } = useWorkspaces.getState();
  const openSql = (sql: string, title: string) => openQuery(ws.id, { sql, title });
  const openReferenced = (schema: string, table: string, filter: GroupNode) => openTable(ws.id, { schema, name: table, kind: "table" }, { filter });
  const [dirtyTables, setDirtyTables] = useState<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState(264);

  // Tell app-wide actions (updates) how many tables here have uncommitted edits.
  useEffect(() => {
    const open = new Set(ws.tabs.map((t) => t.id));
    usePendingEdits.getState().set(ws.id, Object.entries(dirtyTables).filter(([id, d]) => d && open.has(id)).length);
  }, [dirtyTables, ws.tabs, ws.id]);
  useEffect(() => () => usePendingEdits.getState().set(ws.id, 0), [ws.id]);

  const requestClose = async (tab: Tab) => {
    const dirty = (tab.kind === "query" && tab.dirty && tab.sql.trim().length > 0 && !tab.savedQueryId) || dirtyTables[tab.id];
    if (dirty) {
      const ok = await confirmAction({
        title: `Close ${tab.title}?`,
        body: dirtyTables[tab.id] ? "Pending row changes will be discarded." : "This query has not been saved.",
        confirmLabel: "Close without saving",
        danger: true,
      });
      if (!ok) return;
    }
    closeTab(ws.id, tab.id);
  };

  // Ctrl/⌘+W closes the active tab of the visible workspace, asking first like the tab's × does.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "w" || e.shiftKey || e.altKey) return;
      const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
      if (!tab) return;
      e.preventDefault();
      void requestCloseRef.current(tab);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, ws.tabs, ws.activeTabId]);

  const reconnect = useCallback(async () => {
    const info = await reconnectWithPrompt(ws.session.sessionId, ws.profile);
    if (info) update(ws.id, { session: info });
  }, [ws.id, ws.session.sessionId, ws.profile, update]);

  const switchDatabase = async (db: string) => {
    try {
      const session = await connectWithPrompt(ws.profile, db, { lockProduction: ws.session.writesLocked });
      if (!session) return;
      await api.disconnect(ws.session.sessionId).catch(() => undefined);
      const schemas = await api.listSchemas(session.sessionId);
      const schema = schemas.includes("public") ? "public" : (schemas[0] ?? "public");
      update(ws.id, { session, schemas, schema, objects: {}, columns: {}, tabs: ws.tabs.filter((t) => t.kind === "query" || t.kind === "dashboard") });
      await useWorkspaces.getState().loadObjects(ws.id, schema);
    } catch (e) {
      notifyError(e, "Could not switch database");
    }
  };

  const onSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = sidebarWidth;
    const move = (ev: MouseEvent) => setSidebarWidth(Math.min(560, Math.max(180, start + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const s = ws.session;
  const restoreOpen = useRestore((r) => r.open) && keepsRestorePoints(ws);
  if (ws.kind === "redis") {
    return (
      <div
        className="workspace"
        data-env={s.environment}
        style={{ ["--env-color" as string]: envColorVar(s.environment), display: visible ? "flex" : "none" }}
      >
        <RedisView ws={ws} />
      </div>
    );
  }
  return (
    <div
      className={restoreOpen && visible ? "workspace with-panel" : "workspace"}
      data-env={s.environment}
      hidden={!visible}
      style={{ ["--env-color" as string]: envColorVar(s.environment), ["--sidebar-width" as string]: `${sidebarWidth}px`, display: visible ? undefined : "none" }}
    >
      <div style={{ position: "relative", minHeight: 0, display: "flex" }}>
        <Sidebar ws={ws} onSwitchDatabase={switchDatabase} />
        <div className="sidebar-resizer" role="separator" aria-orientation="vertical" onMouseDown={onSidebarResize} />
      </div>
      <div className="main">
        <ObjectTabs ws={ws} dirtyTables={dirtyTables} onClose={(t) => void requestClose(t)} />
        {ws.tabs.length === 0 && <WorkspaceEmpty ws={ws} />}
        {ws.tabs.map((t) => (
          <div key={t.id} className="tab-panel" style={{ display: ws.activeTabId === t.id ? "flex" : "none" }} role="tabpanel">
            {t.kind === "table" && (
              <TableView
                session={s}
                onOpenSql={openSql}
                schema={t.schema}
                table={t.name}
                onReconnect={reconnect}
                onDirtyChange={(d) => setDirtyTables((x) => (x[t.id] === d ? x : { ...x, [t.id]: d }))}
                initialFilter={t.filter}
                onOpenTable={openReferenced}
              />
            )}
            {t.kind === "query" && (
              <QueryTab
                ws={ws}
                tab={t}
                onOpenTable={openReferenced}
                active={visible && ws.activeTabId === t.id}
                onDirtyChange={(d) => setDirtyTables((x) => (x[t.id] === d ? x : { ...x, [t.id]: d }))}
              />
            )}
            {t.kind === "definition" && <DefinitionView session={s} schema={t.schema} name={t.name} kind={t.objectKind} onOpenSql={openSql} />}
            {t.kind === "dashboard" && <DashboardView ws={ws} tab={t} active={visible && ws.activeTabId === t.id} />}
          </div>
        ))}
      </div>
      {restoreOpen && visible && <RestorePanel session={s} onClose={() => useRestore.getState().setOpen(false)} />}
    </div>
  );
}

/** Whether restore points are kept for this workspace's connection. */
function keepsRestorePoints(ws: Workspace): boolean {
  return ws.kind !== "redis" && !ws.session.readOnly && ws.profile.restorePoints !== false;
}

/** "Restore points · N" in the status bar; opens the panel. */
function RestoreCount({ ws }: { ws: Workspace }) {
  const version = useRestore((r) => r.version);
  const [count, setCount] = useState<number | null>(null);
  const connectionId = ws.profile.id;
  useEffect(() => {
    let live = true;
    api
      .listRestorePoints(connectionId)
      .then((p) => live && setCount(p.length))
      .catch(() => live && setCount(null));
    return () => {
      live = false;
    };
  }, [connectionId, version]);
  if (count === null) return null;
  return (
    <button className="btn btn-ghost statusbar-btn" title="Copies of changed rows, kept on this computer" onClick={() => useRestore.getState().setOpen(true)}>
      <Icon name="history" size={12} /> {`Restore points · ${count}`}
    </button>
  );
}

/**
 * Allows writes on a production connection that opened read-only, or takes them back: the
 * workspace reconnects the other way (query tabs follow on their next run). Allowing asks for the
 * connection name; it lasts until the workspace closes.
 */
export async function changeWriteAccess(ws: Workspace, allow: boolean) {
  const s = ws.session;
  if (allow) {
    const ok = await confirmAction({
      title: `Allow writes on ${s.connectionName}?`,
      body: (
        <>
          <ConnectionLine session={s} />
          <p style={{ margin: 0 }}>
            Statements and edits can change this production database until you go back to read-only or close the connection. Query tabs reconnect on their next run, and a transaction open in
            one is rolled back.
          </p>
        </>
      ),
      confirmLabel: "Allow writes",
      danger: true,
      typeToConfirm: s.connectionName,
    });
    if (!ok) return;
  } else {
    const pending = usePendingEdits.getState().byWorkspace[ws.id] ?? 0;
    const ok =
      pending === 0 ||
      (await confirmAction({
        title: "Go back to read-only?",
        body: `${pending === 1 ? "1 table has" : `${pending} tables have`} edits you have not committed. They can't be committed while the connection is read-only.`,
        confirmLabel: "Go back to read-only",
      }));
    if (!ok) return;
  }
  try {
    const session = await connectWithPrompt(ws.profile, databaseToReopen(s), { lockProduction: !allow });
    if (!session) return;
    await api.disconnect(s.sessionId).catch(() => undefined);
    useWorkspaces.getState().update(ws.id, { session, allowWrites: allow, health: "ok" });
  } catch (e) {
    notifyError(e, allow ? "Could not allow writes" : "Could not go back to read-only");
  }
}

export function StatusBar({ ws, version }: { ws: Workspace | undefined; version?: string }) {
  if (!ws)
    return (
      <footer className="statusbar">
        <span>No connection open</span>
        <span className="grow" />
        {version && <span className="version">v{version}</span>}
      </footer>
    );
  const s = ws.session;
  const reconnect = async () => {
    try {
      const info = await reconnectWithPrompt(s.sessionId, ws.profile);
      if (info) useWorkspaces.getState().update(ws.id, { session: info, health: "ok" });
    } catch (e) {
      notifyError(e, "Reconnect failed");
    }
  };
  return (
    <footer className="statusbar" data-env={s.environment}>
      {ws.health === "down" && (
        <>
          <strong style={{ color: "var(--danger)" }}>Connection lost</strong>
          <button className="btn btn-ghost" style={{ height: 18 }} onClick={reconnect}>
            Reconnect
          </button>
        </>
      )}
      <span className="env-label" style={envStyle(s.environment)}>
        <span className="env-dot" />
        {envLabel(s.environment)}
      </span>
      <span>{s.connectionName}</span>
      <span className="mono">{s.target}</span>
      <span>
        {s.server.product} {s.server.version}
      </span>
      <span className="grow" />
      {s.writesLocked ? (
        <span className="write-mode">
          <Icon name="lock" size={12} /> Read-only (production)
          <button className="btn btn-ghost" style={{ height: 18 }} onClick={() => void changeWriteAccess(ws, true)}>
            Allow writes
          </button>
        </span>
      ) : s.readOnly ? (
        <span className="write-mode">
          <Icon name="lock" size={12} /> Read-only
        </span>
      ) : (
        <span className="write-mode">
          Writes enabled
          {ws.allowWrites && (
            <button className="btn btn-ghost" style={{ height: 18 }} onClick={() => void changeWriteAccess(ws, false)}>
              Back to read-only
            </button>
          )}
        </span>
      )}
      {/* A read-only session already says so; don't repeat it as the safety mode. */}
      {!(s.readOnly && s.safetyMode === "read_only") && <span title="Query safety mode">{safetyLabel(s.safetyMode)}</span>}
      <span className="mono">{ws.schema}</span>
      {keepsRestorePoints(ws) && <RestoreCount ws={ws} />}
      {version && <span className="version">v{version}</span>}
    </footer>
  );
}
