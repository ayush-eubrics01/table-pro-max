import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, FunctionSquare, Hash, Layers, RefreshCw, Table2, Plus, FileCode2, Upload, BarChart3 } from "lucide-react";
import { createDashboard } from "../dashboards/DashboardView";
import { uid } from "../../lib/text";
import type { DashboardRecord, DbObject, ObjectKind, SavedQuery } from "../../types/backend";
import { api } from "../../lib/ipc";
import { useWorkspaces, type Workspace } from "../../stores/workspaces";
import { notify, notifyError } from "../../stores/ui";
import { ContextMenu, useContextMenu } from "../../components/Menu";
import { CreateTableDialog } from "../schema-browser/CreateTableDialog";
import { ReviewChangesDialog } from "../data-browser/ReviewChangesDialog";
import { ImportDialog } from "../import-export/ImportDialog";
import { formatCount } from "../../lib/text";

const GROUPS: { kinds: ObjectKind[]; label: string }[] = [
  { kinds: ["table", "foreign_table"], label: "Tables" },
  { kinds: ["view"], label: "Views" },
  { kinds: ["materialized_view"], label: "Materialized views" },
  { kinds: ["function"], label: "Functions" },
  { kinds: ["procedure"], label: "Procedures" },
  { kinds: ["sequence"], label: "Sequences" },
];

function KindIcon({ kind }: { kind: ObjectKind }) {
  switch (kind) {
    case "view":
      return <Eye size={13} />;
    case "materialized_view":
      return <Layers size={13} />;
    case "function":
    case "procedure":
      return <FunctionSquare size={13} />;
    case "sequence":
      return <Hash size={13} />;
    default:
      return <Table2 size={13} />;
  }
}

export function Sidebar({ ws, onSwitchDatabase }: { ws: Workspace; onSwitchDatabase: (db: string) => void }) {
  const { setSchema, loadObjects, openTable, openQuery } = useWorkspaces.getState();
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [databases, setDatabases] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [dashboards, setDashboards] = useState<DashboardRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState<{ obj: DbObject; sql: string } | null>(null);
  const [importInto, setImportInto] = useState<string | null | undefined>(undefined);
  const menu = useContextMenu();
  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);

  useEffect(() => {
    if (ws.session.capabilities.multipleDatabases) api.listDatabases(ws.session.sessionId).then(setDatabases).catch(() => undefined);
    api
      .listSavedQueries()
      .then((q) => setSaved(q.filter((x) => x.connectionId === null || x.connectionId === ws.profile.id)))
      .catch(() => undefined);
    api
      .listDashboards()
      .then((d) => setDashboards(d.filter((x) => x.definition.connectionId === ws.profile.id)))
      .catch(() => undefined);
  }, [ws.session.sessionId, ws.session.capabilities.multipleDatabases, ws.profile.id, ws.tabs.length]);

  const objects = ws.objects[ws.schema];
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => (objects ?? []).filter((o) => !needle || o.name.toLowerCase().includes(needle)), [objects, needle]);

  const refresh = async () => {
    setLoading(true);
    try {
      await loadObjects(ws.id, ws.schema, true);
      useWorkspaces.getState().update(ws.id, { schemas: await api.listSchemas(ws.session.sessionId) });
    } catch (e) {
      notifyError(e, "Could not load objects");
    } finally {
      setLoading(false);
    }
  };

  const q = (name: string) => (ws.session.dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`);
  const qualified = (o: DbObject) => (ws.session.dialect === "sqlite" && o.schema === "main" ? q(o.name) : `${q(o.schema)}.${q(o.name)}`);

  const objectMenu = (e: React.MouseEvent, o: DbObject) => {
    const relation = o.kind === "table" || o.kind === "view" || o.kind === "materialized_view" || o.kind === "foreign_table";
    menu.open(e, [
      { label: relation ? "Open" : "Show definition", onSelect: () => openTable(ws.id, o) },
      ...(relation
        ? [{ label: "Query in new tab", onSelect: () => openQuery(ws.id, { sql: `SELECT * FROM ${qualified(o)} LIMIT 100;`, title: o.name }) }]
        : []),
      "separator",
      { label: "Copy name", onSelect: () => void navigator.clipboard.writeText(o.name) },
      { label: "Copy qualified name", onSelect: () => void navigator.clipboard.writeText(qualified(o)) },
      {
        label: "Copy definition SQL",
        onSelect: async () => {
          try {
            await navigator.clipboard.writeText(await api.objectDefinition(ws.session.sessionId, o.schema, o.name, o.kind));
            notify("Definition copied", "success");
          } catch (err) {
            notifyError(err);
          }
        },
      },
      ...(o.kind === "table" && !ws.session.readOnly
        ? [
            "separator" as const,
            { label: "Import data…", onSelect: () => setImportInto(o.name) },
            {
              label: "Drop table…",
              danger: true,
              onSelect: () => setDropping({ obj: o, sql: `DROP TABLE ${qualified(o)}` }),
            },
          ]
        : []),
    ]);
  };

  return (
    <aside className="sidebar" aria-label="Database objects">
      <div className="sidebar-section">
        {ws.session.capabilities.multipleDatabases && databases.length > 0 && (
          <select className="select" aria-label="Database" value={ws.session.database} onChange={(e) => onSwitchDatabase(e.target.value)}>
            {databases.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        )}
        <div className="field-row" style={{ gap: 4 }}>
          <select
            className="select"
            style={{ flex: 1 }}
            aria-label={ws.session.dialect === "mysql" ? "Database" : "Schema"}
            value={ws.schema}
            onChange={(e) => setSchema(ws.id, e.target.value).catch((err) => notifyError(err))}
          >
            {(ws.schemas.length ? ws.schemas : [ws.schema]).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-icon" aria-label="Refresh objects" title="Refresh" onClick={refresh}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
          </button>
          {!ws.session.readOnly && (
            <>
              <button className="btn btn-ghost btn-icon" aria-label="New table" title="New table" onClick={() => setCreating(true)}>
                <Plus size={14} />
              </button>
              <button className="btn btn-ghost btn-icon" aria-label="Import data" title="Import a CSV or JSON file" onClick={() => setImportInto(null)}>
                <Upload size={14} />
              </button>
            </>
          )}
        </div>
        <input className="input" placeholder="Filter objects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter objects" />
      </div>
      <div className="sidebar-tree" role="tree">
        {!objects && <div className="empty"><div className="spinner" /></div>}
        {GROUPS.map((g) => {
          const items = visible.filter((o) => g.kinds.includes(o.kind));
          if (items.length === 0) return null;
          const isCollapsed = collapsed[g.label];
          return (
            <div key={g.label} role="group">
              <button className="tree-group" aria-expanded={!isCollapsed} onClick={() => setCollapsed({ ...collapsed, [g.label]: !isCollapsed })}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {g.label} <span className="meta">{items.length}</span>
              </button>
              {!isCollapsed &&
                items.map((o) => (
                  <button
                    key={`${o.kind}:${o.name}`}
                    role="treeitem"
                    className="tree-item"
                    aria-current={activeTab && "name" in activeTab && activeTab.name === o.name && activeTab.schema === o.schema}
                    onClick={() => openTable(ws.id, o)}
                    onContextMenu={(e) => objectMenu(e, o)}
                    title={o.comment ?? o.name}
                  >
                    <KindIcon kind={o.kind} />
                    <span className="name">{o.name}</span>
                    {o.estimatedRows !== undefined && o.estimatedRows >= 0 && <span className="meta">~{formatCount(o.estimatedRows)}</span>}
                  </button>
                ))}
            </div>
          );
        })}
        {objects && visible.length === 0 && <div className="empty">{needle ? "No matching objects" : "This schema is empty"}</div>}
        <div role="group">
          <div className="tree-group" style={{ cursor: "default" }}>
            <button className="tree-group" style={{ padding: 0, width: "auto" }} aria-expanded={!collapsed.dash} onClick={() => setCollapsed({ ...collapsed, dash: !collapsed.dash })}>
              {collapsed.dash ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              Dashboards <span className="meta">{dashboards.length}</span>
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-icon" style={{ height: 18, width: 18 }} aria-label="New dashboard" title="New dashboard" onClick={() => void createDashboard(ws).catch((e) => notifyError(e))}>
              <Plus size={12} />
            </button>
          </div>
          {!collapsed.dash &&
            dashboards.map((d) => (
              <button
                key={d.id}
                className="tree-item"
                role="treeitem"
                onClick={() => useWorkspaces.getState().openTab(ws.id, { kind: "dashboard", id: uid(), dashboardId: d.id, title: d.name })}
                onContextMenu={(e) =>
                  menu.open(e, [
                    {
                      label: "Delete dashboard",
                      danger: true,
                      onSelect: async () => {
                        await api.deleteDashboard(d.id);
                        setDashboards((x) => x.filter((y) => y.id !== d.id));
                      },
                    },
                  ])
                }
              >
                <BarChart3 size={13} />
                <span className="name">{d.name}</span>
              </button>
            ))}
        </div>
        {saved.length > 0 && (
          <div role="group">
            <button className="tree-group" aria-expanded={!collapsed.saved} onClick={() => setCollapsed({ ...collapsed, saved: !collapsed.saved })}>
              {collapsed.saved ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              Saved queries <span className="meta">{saved.length}</span>
            </button>
            {!collapsed.saved &&
              saved.map((s) => (
                <button
                  key={s.id}
                  className="tree-item"
                  role="treeitem"
                  onClick={() => openQuery(ws.id, { sql: s.sql, title: s.name, savedQueryId: s.id })}
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: "Open", onSelect: () => openQuery(ws.id, { sql: s.sql, title: s.name, savedQueryId: s.id }) },
                      {
                        label: "Delete saved query",
                        danger: true,
                        onSelect: async () => {
                          await api.deleteSavedQuery(s.id);
                          setSaved((x) => x.filter((y) => y.id !== s.id));
                        },
                      },
                    ])
                  }
                >
                  <FileCode2 size={13} />
                  <span className="name">{s.name}</span>
                </button>
              ))}
          </div>
        )}
      </div>
      <ContextMenu state={menu.menu} onClose={menu.close} />
      {creating && (
        <CreateTableDialog
          session={ws.session}
          schema={ws.schema}
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            await loadObjects(ws.id, ws.schema, true);
            openTable(ws.id, { schema: ws.schema, name, kind: "table" });
          }}
        />
      )}
      {importInto !== undefined && (
        <ImportDialog
          session={ws.session}
          schema={ws.schema}
          tables={objects ?? []}
          initialTable={importInto ?? undefined}
          onClose={() => setImportInto(undefined)}
          onDone={async (name) => {
            setImportInto(undefined);
            await loadObjects(ws.id, ws.schema, true);
            openTable(ws.id, { schema: ws.schema, name, kind: "table" });
          }}
        />
      )}
      {dropping && (
        <ReviewChangesDialog
          session={ws.session}
          title={`Drop ${dropping.obj.name}?`}
          sql={`${dropping.sql};`}
          atomic={ws.session.capabilities.transactionalDdl}
          summary="The table and all of its rows will be permanently deleted."
          commitLabel="Drop table"
          onClose={() => setDropping(null)}
          onCommit={async () => {
            await api.applyDdl(ws.session.sessionId, [dropping.sql]);
            setDropping(null);
            await loadObjects(ws.id, ws.schema, true);
            notify(`Dropped ${dropping.obj.name}`, "success");
          }}
        />
      )}
    </aside>
  );
}
