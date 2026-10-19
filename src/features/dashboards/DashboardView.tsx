import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { Cell, ColumnMeta, DashboardRecord, SessionInfo, WidgetDef } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { databaseToReopen } from "../../lib/dialect";
import { uid } from "../../lib/text";
import { confirmAction, notify, notifyError, promptText } from "../../stores/ui";
import { useWorkspaces, type DashboardTab, type Workspace } from "../../stores/workspaces";
import { connectWithPrompt } from "../connections/connectFlow";
import { WidgetContent } from "./WidgetContent";
import { WidgetEditor } from "./WidgetEditor";

interface WidgetState {
  status: "idle" | "loading" | "ok" | "error";
  columns?: ColumnMeta[];
  rows?: Cell[][];
  truncated?: boolean;
  error?: string;
  at?: Date;
}

const REFRESH_OPTIONS = [
  { value: 0, label: "Manual refresh" },
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
];

export function DashboardView({ ws, tab, active }: { ws: Workspace; tab: DashboardTab; active: boolean }) {
  const [record, setRecord] = useState<DashboardRecord | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [states, setStates] = useState<Record<string, WidgetState>>({});
  const [editing, setEditing] = useState<WidgetDef | "new" | null>(null);
  const [tableView, setTableView] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const runSeq = useRef(0);
  const updateTab = useWorkspaces((s) => s.updateTab);

  useEffect(() => {
    api
      .listDashboards()
      .then((all) => {
        const found = all.find((d) => d.id === tab.dashboardId);
        if (found) setRecord(found);
        else setError("This dashboard no longer exists.");
      })
      .catch((e) => setError(toError(e).message));
  }, [tab.dashboardId]);

  // Widgets run on a dedicated session opened read-only at the database level.
  useEffect(() => {
    let alive = true;
    connectWithPrompt(ws.profile, databaseToReopen(ws.session), { readOnly: true })
      .then((s) => {
        if (!alive) {
          if (s) void api.disconnect(s.sessionId);
          return;
        }
        sessionRef.current = s;
        setSession(s);
        if (!s) setError("A connection is needed to run this dashboard.");
      })
      .catch((e) => alive && setError(toError(e).message));
    return () => {
      alive = false;
      if (sessionRef.current) void api.disconnect(sessionRef.current.sessionId);
      sessionRef.current = null;
    };
  }, [ws.profile, ws.session.dialect, ws.session.database]);

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (record?.definition.range?.from) p.from = record.definition.range.from;
    if (record?.definition.range?.to) p.to = record.definition.range.to;
    return p;
  }, [record?.definition.range]);

  const refresh = useCallback(
    async (only?: string) => {
      const s = sessionRef.current;
      if (!s || !record) return;
      const seq = ++runSeq.current;
      const widgets = record.definition.widgets.filter((w) => !only || w.id === only);
      setStates((prev) => {
        const next = { ...prev };
        for (const w of widgets) next[w.id] = { ...next[w.id], status: "loading" };
        return next;
      });
      // One read-only session runs widgets one at a time: bounded load on the server,
      // and a failing widget only affects its own card.
      for (const w of widgets) {
        if (seq !== runSeq.current && !only) return;
        try {
          const rs = await api.runWidget(s.sessionId, w.sql, usedParams(w.sql, params), 30);
          setStates((prev) => ({ ...prev, [w.id]: { status: "ok", columns: rs.columns, rows: rs.rows, truncated: rs.truncated, at: new Date() } }));
        } catch (e) {
          setStates((prev) => ({ ...prev, [w.id]: { status: "error", error: toError(e).message, at: new Date() } }));
        }
      }
    },
    [record, params],
  );

  useEffect(() => {
    if (session && record) void refresh();
    // Re-run when the session opens or the definition changes.
  }, [session, record, refresh]);

  useEffect(() => {
    const secs = record?.definition.refreshSecs ?? 0;
    if (!active || !session || secs <= 0) return;
    const t = setInterval(() => void refresh(), secs * 1000);
    return () => clearInterval(t);
  }, [active, session, record?.definition.refreshSecs, refresh]);

  const save = async (next: DashboardRecord) => {
    setRecord(next);
    try {
      await api.saveDashboard(next);
    } catch (e) {
      notifyError(e, "Dashboard was not saved");
    }
  };

  const setDef = (patch: Partial<DashboardRecord["definition"]>) => record && void save({ ...record, definition: { ...record.definition, ...patch } });

  const moveWidget = (id: string, dir: -1 | 1) => {
    if (!record) return;
    const ws2 = [...record.definition.widgets];
    const i = ws2.findIndex((w) => w.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ws2.length) return;
    [ws2[i], ws2[j]] = [ws2[j]!, ws2[i]!];
    setDef({ widgets: ws2 });
  };

  if (error) return <div className="notice notice-error" style={{ margin: 12 }}>{error}</div>;
  if (!record) return <div className="empty"><div className="spinner" /></div>;
  const def = record.definition;

  return (
    <div className="tab-panel">
      <div className="toolbar" role="toolbar" aria-label="Dashboard tools">
        <strong style={{ fontSize: "var(--text-md)" }}>{record.name}</strong>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="Rename dashboard"
          onClick={async () => {
            const name = await promptText({ title: "Rename dashboard", label: "Name", initial: record.name });
            if (name) {
              await save({ ...record, name });
              updateTab(ws.id, tab.id, { title: name });
            }
          }}
        >
          <Icon name="edit" size={13} />
        </button>
        <span className="sep" />
        <label className="meta" htmlFor={`from-${tab.id}`}>
          From
        </label>
        <input id={`from-${tab.id}`} type="date" className="input" value={def.range?.from ?? ""} onChange={(e) => setDef({ range: { from: e.target.value, to: def.range?.to ?? "" } })} />
        <label className="meta" htmlFor={`to-${tab.id}`}>
          to
        </label>
        <input id={`to-${tab.id}`} type="date" className="input" value={def.range?.to ?? ""} onChange={(e) => setDef({ range: { from: def.range?.from ?? "", to: e.target.value } })} />
        <span className="sep" />
        <select className="select" aria-label="Refresh interval" value={def.refreshSecs} onChange={(e) => setDef({ refreshSecs: Number(e.target.value) })}>
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-icon" aria-label="Refresh all widgets" title="Refresh" onClick={() => void refresh()} disabled={!session}>
          <Icon name="refresh" size={14} />
        </button>
        <span className="grow" />
        <span className="access-pill ro" title="Dashboard queries run in a read-only session">
          <Icon name="lock" size={13} /> Read-only
        </span>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          <Icon name="add" size={14} /> Widget
        </button>
      </div>

      <div className="dashboard">
        {def.widgets.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", height: 320 }}>
            <Icon name="bar_chart" size={28} />
            <p>Add a widget: a number, a table, or a chart from a SELECT query.</p>
            <p className="hint">
              Queries run read-only. Use <span className="kbd">{"{{from}}"}</span> and <span className="kbd">{"{{to}}"}</span> for the date range.
            </p>
          </div>
        )}
        {def.widgets.map((w, idx) => {
          const st = states[w.id] ?? { status: "idle" };
          const asTable = tableView[w.id] || w.type === "table";
          return (
            <section key={w.id} className="widget" style={{ gridColumn: `span ${w.span}` }} aria-label={w.title}>
              <header className="widget-head">
                <h3>{w.title}</h3>
                {st.status === "loading" && <div className="spinner" aria-label="Loading" />}
                <span className="grow" />
                {st.at && <span className="hint">{st.at.toLocaleTimeString()}</span>}
                {w.type !== "table" && w.type !== "kpi" && (
                  <button className="btn btn-ghost btn-icon" aria-pressed={!!tableView[w.id]} aria-label="Show as table" title="Show as table" onClick={() => setTableView({ ...tableView, [w.id]: !tableView[w.id] })}>
                    <Icon name="table" size={13} />
                  </button>
                )}
                <button className="btn btn-ghost btn-icon" aria-label="Refresh widget" onClick={() => void refresh(w.id)}>
                  <Icon name="refresh" size={13} />
                </button>
                <button className="btn btn-ghost btn-icon" aria-label="Move earlier" disabled={idx === 0} onClick={() => moveWidget(w.id, -1)}>
                  <Icon name="arrow_upward" size={13} />
                </button>
                <button className="btn btn-ghost btn-icon" aria-label="Move later" disabled={idx === def.widgets.length - 1} onClick={() => moveWidget(w.id, 1)}>
                  <Icon name="arrow_downward" size={13} />
                </button>
                <button className="btn btn-ghost btn-icon" aria-label="Edit widget" onClick={() => setEditing(w)}>
                  <Icon name="edit" size={13} />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete widget"
                  onClick={async () => {
                    if (await confirmAction({ title: `Delete "${w.title}"?`, body: "The widget is removed from this dashboard.", confirmLabel: "Delete widget", danger: true }))
                      setDef({ widgets: def.widgets.filter((x) => x.id !== w.id) });
                  }}
                >
                  <Icon name="delete" size={13} />
                </button>
              </header>
              <div className="widget-body">
                {st.status === "error" && <div className="notice notice-error">{st.error}</div>}
                {st.status === "ok" && st.columns && st.rows && (
                  <WidgetContent type={w.type} asTable={asTable} columns={st.columns} rows={st.rows} />
                )}
                {st.truncated && <p className="hint">Showing the first 5,000 rows.</p>}
              </div>
            </section>
          );
        })}
      </div>

      {editing && (
        <WidgetEditor
          initial={editing === "new" ? undefined : editing}
          session={session}
          params={params}
          onClose={() => setEditing(null)}
          onSave={(w) => {
            const exists = def.widgets.some((x) => x.id === w.id);
            setDef({ widgets: exists ? def.widgets.map((x) => (x.id === w.id ? w : x)) : [...def.widgets, w] });
            setEditing(null);
            notify(`Saved widget "${w.title}"`, "success");
          }}
        />
      )}
    </div>
  );
}

function usedParams(sql: string, params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v && sql.includes(`{{${k}}}`)) out[k] = v;
  return out;
}

/** Creates a dashboard for the connection and opens it in a tab. */
export async function createDashboard(ws: Workspace) {
  const name = await promptText({ title: "New dashboard", label: "Name" });
  if (!name) return;
  const record: DashboardRecord = {
    id: uid(),
    name,
    definition: { version: 1, connectionId: ws.profile.id, refreshSecs: 0, range: null, widgets: [] },
  };
  await api.saveDashboard(record);
  useWorkspaces.getState().openTab(ws.id, { kind: "dashboard", id: uid(), dashboardId: record.id, title: name });
}
