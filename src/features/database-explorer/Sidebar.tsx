import { useEffect, useMemo, useState } from "react";
import { fuzzyMatch, rank } from "../../lib/fuzzy";
import { withNameConfirm } from "../connections/nameConfirm";
import { Icon } from "../../components/Icon";
import { createDashboard } from "../dashboards/DashboardView";
import { uid } from "../../lib/text";
import type { DashboardRecord, DbObject, ObjectKind, Pin, SavedQuery } from "../../types/backend";
import { api } from "../../lib/ipc";
import { quoteName } from "../../lib/dialect";
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
      return <Icon name="visibility" size={14} />;
    case "materialized_view":
      return <Icon name="layers" size={14} />;
    case "function":
    case "procedure":
      return <Icon name="function" size={14} />;
    case "sequence":
      return <Icon name="tag" size={14} />;
    default:
      return <Icon name="table" size={14} />;
  }
}

export function Sidebar({ ws, onSwitchDatabase }: { ws: Workspace; onSwitchDatabase: (db: string) => void }) {
  const { setSchema, loadObjects, openTable, openQuery } = useWorkspaces.getState();
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [databases, setDatabases] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedQuery[] | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  // Schemas whose object list could not be read: their pins can't be found.
  const [unreadable, setUnreadable] = useState<Set<string>>(new Set());
  // Pins belong to the database open where a connection has several (PostgreSQL).
  const pinDb = ws.session.capabilities.multipleDatabases ? ws.session.database : "";
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
      .catch(() => setSaved(null));
    api
      .listDashboards()
      .then((d) => setDashboards(d.filter((x) => x.definition.connectionId === ws.profile.id)))
      .catch(() => undefined);
  }, [ws.session.sessionId, ws.session.capabilities.multipleDatabases, ws.profile.id, ws.tabs.length]);

  useEffect(() => {
    setUnreadable(new Set());
    api
      .listPins(ws.profile.id, pinDb)
      .then((p) => setPins(p ?? []))
      .catch(() => setPins([]));
  }, [ws.profile.id, pinDb]);

  // Pinned objects of other schemas: load those schemas' lists to know whether they still exist.
  useEffect(() => {
    for (const schema of new Set(pins.filter((p) => p.kind !== "saved_query").map((p) => p.schema))) {
      if (useWorkspaces.getState().workspaces.find((w) => w.id === ws.id)?.objects[schema]) continue;
      void loadObjects(ws.id, schema).catch(() => setUnreadable((u) => new Set(u).add(schema)));
    }
  }, [pins, ws.id, loadObjects]);

  const isPinned = (pin: Pin) => pins.some((p) => p.kind === pin.kind && p.schema === pin.schema && p.name === pin.name);
  const togglePin = async (pin: Pin) => {
    try {
      if (isPinned(pin)) await api.unpinObject(ws.profile.id, pinDb, pin);
      else await api.pinObject(ws.profile.id, pinDb, pin);
      setPins(await api.listPins(ws.profile.id, pinDb));
    } catch (e) {
      notifyError(e, "Could not change the pinned objects");
    }
  };
  const pinItem = (pin: Pin) => ({ label: isPinned(pin) ? "Unpin" : "Pin to top", onSelect: () => void togglePin(pin) });
  const pinOf = (o: DbObject): Pin | null =>
    o.kind === "table" || o.kind === "view" || o.kind === "materialized_view" ? { kind: o.kind, schema: o.schema, name: o.name } : null;

  const objects = ws.objects[ws.schema];
  const needle = filter.trim();
  // Forgiving match (typos, spaces for underscores), best first; the whole list without a filter.
  const visible = useMemo(() => (needle ? rank(objects ?? [], needle, (o) => o.name, Infinity) : (objects ?? [])), [objects, needle]);
  const matches = (text: string) => !needle || fuzzyMatch(needle, [text]) !== null;

  // Pinned rows in pin order. Whether one still exists is known once its list has loaded.
  const pinnedRows = pins.flatMap((pin) => {
    if (pin.kind === "saved_query") {
      const q = saved?.find((x) => x.id === pin.name);
      const label = q?.name ?? pin.name;
      if (!matches(label)) return [];
      return [{ pin, label, missing: saved !== null && !q, open: () => q && openQuery(ws.id, { sql: q.sql, title: q.name, savedQueryId: q.id }) }];
    }
    if (!matches(pin.name)) return [];
    const list = ws.objects[pin.schema];
    const missing = list ? !list.some((o) => o.name === pin.name && o.kind === pin.kind) : unreadable.has(pin.schema);
    const kind: ObjectKind = pin.kind;
    return [{ pin, label: pin.name, missing, open: () => openTable(ws.id, { schema: pin.schema, name: pin.name, kind }) }];
  });

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

  const q = (name: string) => quoteName(ws.session.dialect, name);
  const qualified = (o: DbObject) => (ws.session.dialect === "sqlite" && o.schema === "main" ? q(o.name) : `${q(o.schema)}.${q(o.name)}`);

  const objectMenu = (e: React.MouseEvent, o: DbObject) => {
    const relation = o.kind === "table" || o.kind === "view" || o.kind === "materialized_view" || o.kind === "foreign_table";
    menu.open(e, [
      { label: relation ? "Open" : "Show definition", onSelect: () => openTable(ws.id, o) },
      ...(relation
        ? [{ label: "Query in new tab", onSelect: () => openQuery(ws.id, { sql: `SELECT * FROM ${qualified(o)} LIMIT 100;`, title: o.name }) }]
        : []),
      ...(pinOf(o) ? [pinItem(pinOf(o)!)] : []),
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
      <div className="sidebar-head">
        <div className="db-switch" role="group" aria-label="Database and schema">
          <Icon name="database" size={15} />
          {ws.session.capabilities.multipleDatabases && databases.length > 0 && (
            <>
              <select className="db-switch-select db" aria-label="Database" value={ws.session.database} onChange={(e) => onSwitchDatabase(e.target.value)}>
                {databases.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <span className="db-switch-sep" aria-hidden>
                /
              </span>
            </>
          )}
          <select
            className="db-switch-select"
            aria-label={ws.session.dialect === "mysql" ? "Database" : "Schema"}
            title={ws.schema}
            value={ws.schema}
            onChange={(e) => setSchema(ws.id, e.target.value).catch((err) => notifyError(err))}
          >
            {(ws.schemas.length ? ws.schemas : [ws.schema]).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <Icon name="unfold_more" size={15} className="db-switch-chevron" />
        </div>
        <div className="sidebar-filter">
          <Icon name="filter_list" size={15} />
          <input className="input" placeholder="Filter objects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter objects" />
        </div>
      </div>
      <div className="sidebar-tree" role="tree">
        {pinnedRows.length > 0 && (
          <div role="group" aria-label="Pinned">
            <button className="tree-group" aria-expanded={!collapsed.pinned} aria-label={`Pinned (${pinnedRows.length})`} onClick={() => setCollapsed({ ...collapsed, pinned: !collapsed.pinned })}>
              <Icon name={collapsed.pinned ? "chevron_right" : "keyboard_arrow_down"} size={14} />
              <span className="label">Pinned</span>
              <span className="count">{pinnedRows.length}</span>
            </button>
            {!collapsed.pinned &&
              pinnedRows.map(({ pin, label, open, missing }) => (
                <button
                  key={`${pin.kind}:${pin.schema}:${pin.name}`}
                  role="treeitem"
                  className={`tree-item${missing ? " missing" : ""}`}
                  aria-disabled={missing || undefined}
                  title={missing ? `${label} was not found; it may have been renamed or dropped` : label}
                  aria-label={[label, pin.kind !== "saved_query" && pin.schema !== ws.schema ? `schema ${pin.schema}` : "", missing ? "not found" : ""].filter(Boolean).join(", ")}
                  onClick={() => !missing && open()}
                  onContextMenu={(e) => menu.open(e, [...(missing ? [] : [{ label: "Open", onSelect: open }]), pinItem(pin)])}
                >
                  {pin.kind === "saved_query" ? <Icon name="code_blocks" size={13} /> : <KindIcon kind={pin.kind} />}
                  <span className="name">{label}</span>
                  {pin.kind !== "saved_query" && pin.schema !== ws.schema && <span className="count">{pin.schema}</span>}
                  {missing && <span className="count">Not found</span>}
                </button>
              ))}
          </div>
        )}
        {!objects && <div className="empty"><div className="spinner" /></div>}
        {GROUPS.map((g) => {
          const items = visible.filter((o) => g.kinds.includes(o.kind));
          if (items.length === 0) return null;
          const isCollapsed = collapsed[g.label];
          return (
            <div key={g.label} role="group">
              <button className="tree-group" aria-expanded={!isCollapsed} aria-label={`${g.label} (${items.length})`} onClick={() => setCollapsed({ ...collapsed, [g.label]: !isCollapsed })}>
                <Icon name={isCollapsed ? "chevron_right" : "keyboard_arrow_down"} size={14} />
                <span className="label">{g.label}</span>
                <span className="count">{items.length}</span>
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
                    {o.estimatedRows !== undefined && o.estimatedRows >= 0 && <span className="count">~{formatCount(o.estimatedRows)}</span>}
                  </button>
                ))}
            </div>
          );
        })}
        {objects && visible.length === 0 && <div className="empty">{needle ? "No matching objects" : "This schema is empty"}</div>}
        <div role="group">
          <div className="tree-group-row">
            <button className="tree-group" aria-expanded={!collapsed.dash} aria-label={`Dashboards (${dashboards.length})`} onClick={() => setCollapsed({ ...collapsed, dash: !collapsed.dash })}>
              <Icon name={collapsed.dash ? "chevron_right" : "keyboard_arrow_down"} size={14} />
              <span className="label">Dashboards</span>
              <span className="count">{dashboards.length}</span>
            </button>
            <button className="btn btn-ghost btn-icon tree-group-add" aria-label="New dashboard" title="New dashboard" onClick={() => void createDashboard(ws).catch((e) => notifyError(e))}>
              <Icon name="add" size={13} />
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
                <Icon name="bar_chart" size={13} />
                <span className="name">{d.name}</span>
              </button>
            ))}
        </div>
        {saved && saved.length > 0 && (
          <div role="group">
            <button className="tree-group" aria-expanded={!collapsed.saved} aria-label={`Saved queries (${saved.length})`} onClick={() => setCollapsed({ ...collapsed, saved: !collapsed.saved })}>
              <Icon name={collapsed.saved ? "chevron_right" : "keyboard_arrow_down"} size={14} />
              <span className="label">Saved queries</span>
              <span className="count">{saved.length}</span>
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
                      pinItem({ kind: "saved_query", schema: "", name: s.id }),
                      {
                        label: "Delete saved query",
                        danger: true,
                        onSelect: async () => {
                          await api.deleteSavedQuery(s.id);
                          setSaved((x) => (x ?? []).filter((y) => y.id !== s.id));
                          // Deleting a saved query also unpins it.
                          setPins((x) => x.filter((p) => !(p.kind === "saved_query" && p.name === s.id)));
                        },
                      },
                    ])
                  }
                >
                  <Icon name="code_blocks" size={13} />
                  <span className="name">{s.name}</span>
                </button>
              ))}
          </div>
        )}
      </div>
      <div className="sidebar-foot" role="toolbar" aria-label="Schema actions">
        {!ws.session.readOnly && (
          <button className="btn btn-ghost" onClick={() => setCreating(true)}>
            <Icon name="add" size={15} /> New table
          </button>
        )}
        <span className="grow" />
        <button className="btn btn-ghost btn-icon" aria-label="Refresh objects" title="Refresh schema" onClick={refresh}>
          <Icon name="refresh" size={15} className={loading ? "spin" : undefined} />
        </button>
        {!ws.session.readOnly && (
          <button className="btn btn-ghost btn-icon" aria-label="Import data" title="Import a CSV or JSON file" onClick={() => setImportInto(null)}>
            <Icon name="upload" size={15} />
          </button>
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
            const done = await withNameConfirm(ws.session, (typed) => api.applyDdl(ws.session.sessionId, [dropping.sql], typed).then(() => true));
            if (!done) return;
            setDropping(null);
            await loadObjects(ws.id, ws.schema, true);
            notify(`Dropped ${dropping.obj.name}`, "success");
          }}
        />
      )}
    </aside>
  );
}
