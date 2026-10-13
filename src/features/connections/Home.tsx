import { useMemo, useState } from "react";
import { Plus, Search, Download, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/ipc";
import type { AppInfo, ConnectionProfile, StoredConnection } from "../../types/backend";
import { useConnections } from "../../stores/connections";
import { driverShort, driverLabel, envColorVar } from "../../lib/env";
import { EnvBadge } from "../../components/EnvBadge";
import { ContextMenu, useContextMenu } from "../../components/Menu";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { ConnectionForm } from "./ConnectionForm";

interface Props {
  appInfo: AppInfo | null;
  onConnect: (profile: ConnectionProfile) => void;
  connecting: string | null;
}

type SortKey = "manual" | "name" | "recent";

export function Home({ appInfo, onConnect, connecting }: Props) {
  const connections = useConnections((s) => s.connections);
  const { remove, duplicate } = useConnections.getState();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("manual");
  const [editing, setEditing] = useState<ConnectionProfile | "new" | null>(null);
  const menu = useContextMenu();

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = connections.filter(({ profile: p }) =>
      !needle || [p.name, p.host, p.database, p.user, p.group ?? "", p.filePath ?? "", ...p.tags].some((v) => v.toLowerCase().includes(needle)),
    );
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "name") return a.profile.name.localeCompare(b.profile.name);
      if (sort === "recent") return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
      return a.sortOrder - b.sortOrder;
    });
    const map = new Map<string, StoredConnection[]>();
    for (const c of sorted) {
      const g = c.profile.group?.trim() || "";
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [connections, search, sort]);

  const exportProfiles = async (ids: string[] | null) => {
    const path = await saveDialog({ defaultPath: "connections.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      const n = await api.exportConnections(path, ids);
      notify(`Exported ${n} connection${n === 1 ? "" : "s"} (passwords are not included)`, "success");
    } catch (e) {
      notifyError(e, "Export failed");
    }
  };

  const importProfiles = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const n = await api.importConnections(path);
      await useConnections.getState().load();
      notify(`Imported ${n} connection${n === 1 ? "" : "s"}. You will be asked for passwords when connecting.`, "success");
    } catch (e) {
      notifyError(e, "Import failed");
    }
  };

  const onDelete = async (p: ConnectionProfile) => {
    const ok = await confirmAction({
      title: `Delete ${p.name}?`,
      body: "The saved profile and its stored password are removed from this computer. The database itself is not touched.",
      confirmLabel: "Delete connection",
      danger: true,
    });
    if (ok) await remove(p.id).catch((e) => notifyError(e));
  };

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <h1>Connections</h1>
          <button className="btn btn-ghost" onClick={importProfiles} title="Import connections from a file">
            <Upload size={14} /> Import
          </button>
          <button className="btn btn-ghost" onClick={() => exportProfiles(null)} disabled={connections.length === 0} title="Export connections (without passwords)">
            <Download size={14} /> Export
          </button>
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            <Plus size={14} /> New connection
          </button>
        </div>
        <div className="field-row" style={{ alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1, display: "flex" }}>
            <Search size={14} style={{ position: "absolute", left: 8, top: 7, color: "var(--text-faint)" }} />
            <input
              className="input"
              style={{ paddingLeft: 28, flex: 1 }}
              placeholder="Search by name, host, database or tag"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search connections"
            />
          </div>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort connections">
            <option value="manual">Custom order</option>
            <option value="name">Name</option>
            <option value="recent">Recently used</option>
          </select>
        </div>

        {connections.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: 48 }}>
            <p>Add a PostgreSQL, MySQL, MariaDB, SQLite or DuckDB connection to get started.</p>
            <p className="hint">Connections, history and saved queries stay on this computer. Passwords go to your system keychain.</p>
            <button className="btn btn-primary" onClick={() => setEditing("new")}>
              New connection
            </button>
          </div>
        )}

        {groups.map(([group, items]) => (
          <section key={group || "_"} className="conn-group" aria-label={group || "Ungrouped"}>
            {(group || groups.length > 1) && <h3>{group || "Ungrouped"}</h3>}
            <div className="conn-list">
              {items.map(({ profile: p, lastUsedAt }) => (
                <div
                  key={p.id}
                  className="conn-row"
                  role="button"
                  tabIndex={0}
                  style={{ ["--env-color" as string]: envColorVar(p.environment) }}
                  onClick={() => onConnect(p)}
                  onKeyDown={(e) => e.key === "Enter" && onConnect(p)}
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: "Connect", onSelect: () => onConnect(p) },
                      { label: "Edit…", onSelect: () => setEditing(p) },
                      { label: "Duplicate", onSelect: () => void duplicate(p.id).catch((err) => notifyError(err)) },
                      { label: "Export…", onSelect: () => void exportProfiles([p.id]) },
                      "separator",
                      { label: "Delete…", danger: true, onSelect: () => void onDelete(p) },
                    ])
                  }
                  aria-label={`Connect to ${p.name}`}
                >
                  <span className="stripe" />
                  <div style={{ padding: "8px 0", minWidth: 0 }}>
                    <div className="title">{p.name}</div>
                    <div className="sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.driver === "sqlite" || p.driver === "duckdb" ? p.filePath : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`}
                    </div>
                  </div>
                  <div className="field-row" style={{ alignItems: "center", gap: 8 }}>
                    {connecting === p.id && <div className="spinner" aria-label="Connecting" />}
                    {lastUsedAt && <span className="hint">{new Date(lastUsedAt).toLocaleDateString()}</span>}
                    <EnvBadge env={p.environment} />
                  </div>
                  <span className="driver-mark" title={driverLabel(p.driver)}>
                    {driverShort(p.driver)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
        {appInfo && (
          <p className="hint">
            Data folder: <span className="mono">{appInfo.dataDir}</span>. Passwords: {appInfo.credentialStore}.
          </p>
        )}
      </div>
      <ContextMenu state={menu.menu} onClose={menu.close} />
      {editing && (
        <ConnectionForm
          appInfo={appInfo}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(profile, connect) => {
            setEditing(null);
            if (connect) onConnect(profile);
          }}
        />
      )}
    </div>
  );
}
