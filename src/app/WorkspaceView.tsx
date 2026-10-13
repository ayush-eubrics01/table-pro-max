import { useCallback, useState } from "react";
import { Code2, Eye, FileCode2, Plus, Table2, X, Lock, BarChart3 } from "lucide-react";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { Sidebar } from "../features/database-explorer/Sidebar";
import { TableView } from "../features/data-browser/TableView";
import { QueryTab } from "../features/sql-editor/QueryTab";
import { DefinitionView } from "../features/schema-browser/DefinitionView";
import { DashboardView } from "../features/dashboards/DashboardView";
import { RedisView } from "../features/redis/RedisView";
import { api } from "../lib/ipc";
import { envColorVar, envLabel, safetyLabel } from "../lib/env";
import { confirmAction, notifyError } from "../stores/ui";
import { connectWithPrompt, reconnectWithPrompt } from "../features/connections/connectFlow";

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "query") return <Code2 size={13} />;
  if (tab.kind === "definition") return <FileCode2 size={13} />;
  if (tab.kind === "dashboard") return <BarChart3 size={13} />;
  return tab.objectKind === "table" ? <Table2 size={13} /> : <Eye size={13} />;
}

export function WorkspaceView({ ws, visible }: { ws: Workspace; visible: boolean }) {
  const { activateTab, closeTab, openQuery, moveTab, update } = useWorkspaces.getState();
  const [dirtyTables, setDirtyTables] = useState<Record<string, boolean>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(264);

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
        <div className="tabbar" role="tablist" aria-label="Open tabs">
          {ws.tabs.map((t, i) => (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={ws.activeTabId === t.id}
              className={`tab ${dragIndex === i ? "dragging" : ""}`}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null && dragIndex !== i) moveTab(ws.id, dragIndex, i);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              onClick={() => activateTab(ws.id, t.id)}
              onKeyDown={(e) => e.key === "Enter" && activateTab(ws.id, t.id)}
              onAuxClick={(e) => e.button === 1 && void requestClose(t)}
              title={"schema" in t ? `${t.schema}.${t.name}` : t.title}
            >
              <TabIcon tab={t} />
              <span className="label">{t.title}</span>
              {((t.kind === "query" && t.dirty && !t.savedQueryId && t.sql.trim()) || dirtyTables[t.id]) && <span className="dirty" aria-label="Unsaved changes" />}
              <button
                className="tab-close"
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestClose(t);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="tab-add" aria-label="New query tab" title="New query (Ctrl+T)" onClick={() => openQuery(ws.id)}>
            <Plus size={14} />
          </button>
        </div>
        {ws.tabs.length === 0 && (
          <div className="empty">
            <p>Open a table from the sidebar, or start a query.</p>
            <button className="btn btn-primary" onClick={() => openQuery(ws.id)}>
              New query
            </button>
            <p className="hint">
              <span className="kbd">Ctrl+P</span> opens anything · <span className="kbd">Ctrl+T</span> new query
            </p>
          </div>
        )}
        {ws.tabs.map((t) => (
          <div key={t.id} className="tab-panel" style={{ display: ws.activeTabId === t.id ? "flex" : "none" }} role="tabpanel">
            {t.kind === "table" && (
              <TableView
                session={s}
                schema={t.schema}
                table={t.name}
                onReconnect={reconnect}
                onDirtyChange={(d) => setDirtyTables((x) => (x[t.id] === d ? x : { ...x, [t.id]: d }))}
              />
            )}
            {t.kind === "query" && <QueryTab ws={ws} tab={t} active={visible && ws.activeTabId === t.id} />}
            {t.kind === "definition" && <DefinitionView session={s} schema={t.schema} name={t.name} kind={t.objectKind} />}
            {t.kind === "dashboard" && <DashboardView ws={ws} tab={t} active={visible && ws.activeTabId === t.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusBar({ ws }: { ws: Workspace | undefined }) {
  if (!ws) return <footer className="statusbar">No connection open</footer>;
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
      <span className="env-dot" style={{ ["--env-color" as string]: envColorVar(s.environment) }} />
      <strong>{envLabel(s.environment)}</strong>
      <span>{s.connectionName}</span>
      <span className="mono">{s.target}</span>
      <span>
        {s.server.product} {s.server.version}
      </span>
      <span className="grow" />
      {s.readOnly && (
        <span>
          <Lock size={11} /> read-only
        </span>
      )}
      <span title="Query safety mode">{safetyLabel(s.safetyMode)}</span>
      <span>{ws.schema}</span>
    </footer>
  );
}
