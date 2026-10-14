import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { usePendingEdits } from "../stores/pendingEdits";
import { Sidebar } from "../features/database-explorer/Sidebar";
import { ObjectTabs } from "./ObjectTabs";
import { WorkspaceEmpty } from "./WorkspaceEmpty";
import { TableView } from "../features/data-browser/TableView";
import { QueryTab } from "../features/sql-editor/QueryTab";
import { DefinitionView } from "../features/schema-browser/DefinitionView";
import { DashboardView } from "../features/dashboards/DashboardView";
import { RedisView } from "../features/redis/RedisView";
import { api } from "../lib/ipc";
import { envColorVar, envLabel, envStyle, safetyLabel } from "../lib/env";
import { confirmAction, notifyError } from "../stores/ui";
import { connectWithPrompt, reconnectWithPrompt } from "../features/connections/connectFlow";

export function WorkspaceView({ ws, visible }: { ws: Workspace; visible: boolean }) {
  const { closeTab, openQuery, update } = useWorkspaces.getState();
  const openSql = (sql: string, title: string) => openQuery(ws.id, { sql, title });
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
        body: tab.kind === "query" ? "This query has not been saved." : "Pending row changes will be discarded.",
        confirmLabel: "Close without saving",
        danger: true,
      });
      if (!ok) return;
    }
    closeTab(ws.id, tab.id);
  };

  const reconnect = useCallback(async () => {
    const info = await reconnectWithPrompt(ws.session.sessionId, ws.profile);
    if (info) update(ws.id, { session: info });
  }, [ws.id, ws.session.sessionId, ws.profile, update]);

  const switchDatabase = async (db: string) => {
    try {
      const session = await connectWithPrompt(ws.profile, db);
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
      className="workspace"
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
              />
            )}
            {t.kind === "query" && <QueryTab ws={ws} tab={t} active={visible && ws.activeTabId === t.id} />}
            {t.kind === "definition" && <DefinitionView session={s} schema={t.schema} name={t.name} kind={t.objectKind} onOpenSql={openSql} />}
            {t.kind === "dashboard" && <DashboardView ws={ws} tab={t} active={visible && ws.activeTabId === t.id} />}
          </div>
        ))}
      </div>
    </div>
  );
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
      {s.readOnly ? (
        <span className="write-mode">
          <Icon name="lock" size={12} /> Read-only
        </span>
      ) : (
        <span className="write-mode">Writes enabled</span>
      )}
      <span title="Query safety mode">{safetyLabel(s.safetyMode)}</span>
      <span className="mono">{ws.schema}</span>
      {version && <span className="version">v{version}</span>}
    </footer>
  );
}
