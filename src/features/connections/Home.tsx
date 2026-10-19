import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/ipc";
import type { AppInfo, ConnectionProfile, Environment, StoredConnection } from "../../types/backend";
import { useConnections } from "../../stores/connections";
import { useSettings } from "../../stores/settings";
import { ENV_ORDER, driverLabel, driverShort, envLabel, envStyle, isFileDriver } from "../../lib/env";
import { EnvBadge } from "../../components/EnvBadge";
import { ContextMenu, useContextMenu } from "../../components/Menu";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { ConnectionForm } from "./ConnectionForm";
import { isConnectionString } from "../../lib/url";

interface Props {
  appInfo: AppInfo | null;
  onConnect: (profile: ConnectionProfile) => void;
  connecting: string | null;
}

type SortKey = "manual" | "recent" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "manual", label: "Custom" },
  { key: "recent", label: "Recent" },
  { key: "name", label: "Name" },
];


function target(p: ConnectionProfile): string {
  return isFileDriver(p.driver) ? (p.filePath ?? "") : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`;
}

export function Home({ appInfo, onConnect, connecting }: Props) {
  const connections = useConnections((s) => s.connections);
  const productionReadOnly = useSettings((s) => s.settings["safety.productionReadOnly"]);
  const { remove, duplicate } = useConnections.getState();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("manual");
  const [editing, setEditing] = useState<ConnectionProfile | "new" | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const menu = useContextMenu();
  // A pasted URL or ADO.NET string offers a new connection instead of searching.
  const isUrl = isConnectionString(search);

  const groups = useMemo(() => {
    const needle = isUrl ? "" : search.trim().toLowerCase();
    const filtered = connections.filter(
      ({ profile: p }) =>
        !needle || [p.name, p.host, p.database, p.user, p.group ?? "", p.filePath ?? "", ...p.tags].some((v) => v.toLowerCase().includes(needle)),
    );
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "name") return a.profile.name.localeCompare(b.profile.name);
      if (sort === "recent") return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
      return a.sortOrder - b.sortOrder;
    });
    const byEnv = new Map<Environment, StoredConnection[]>();
    for (const c of sorted) byEnv.set(c.profile.environment, [...(byEnv.get(c.profile.environment) ?? []), c]);
    return ENV_ORDER.filter((env) => byEnv.has(env)).map((env) => [env, byEnv.get(env)!] as const);
  }, [connections, search, sort, isUrl]);

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

  const createFromUrl = () => {
    // The URL can hold a password: hand it to the form and clear the search box straight away.
    setPendingUrl(search.trim());
    setSearch("");
    setEditing("new");
  };

  const closeForm = () => {
    setEditing(null);
    setPendingUrl(null);
  };

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <div style={{ flex: 1 }}>
            <h1>Connections</h1>
            <p className="home-sub">
              {connections.length} saved ·{" "}
              {appInfo && !appInfo.credentialStoreAvailable ? "passwords are asked for when connecting" : `passwords in ${appInfo?.credentialStore ?? "your system keychain"}`}
            </p>
          </div>
          <button className="btn" onClick={importProfiles} title="Import connections from a file">
            <Icon name="download" size={15} /> Import
          </button>
          <button className="btn" onClick={() => exportProfiles(null)} disabled={connections.length === 0} title="Export connections (without passwords)">
            <Icon name="upload" size={15} /> Export
          </button>
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="add" size={15} /> New connection
          </button>
        </div>

        <div className="home-toolbar">
          <div style={{ position: "relative", flex: 1, display: "flex" }}>
            <Icon name="search" size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-faint)" }} />
            <input
              className="input"
              style={{ paddingLeft: 32, flex: 1, height: 36 }}
              placeholder="Search by name, host, database — or paste a connection URL"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && isUrl && createFromUrl()}
              aria-label="Search connections"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="segmented" role="group" aria-label="Sort connections">
            {SORTS.map((s) => (
              <button key={s.key} aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {isUrl && (
          <button className="url-row" onClick={createFromUrl}>
            <Icon name="add" size={16} />
            <span>Create connection from this URL…</span>
          </button>
        )}

        {connections.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: 48 }}>
            <p>Add a PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, DuckDB or Redis connection to get started.</p>
            <p className="hint">
              Connections, history and saved queries stay on this computer.{" "}
              {appInfo && !appInfo.credentialStoreAvailable ? "Passwords are asked for each time you connect." : "Passwords go to your system keychain."}
            </p>
            <button className="btn btn-primary" onClick={() => setEditing("new")}>
              New connection
            </button>
          </div>
        )}

        {groups.map(([env, items]) => (
          <section key={env} className="conn-group" aria-label={envLabel(env)}>
            <h2 className="conn-group-head" style={envStyle(env)} aria-label={`${envLabel(env)}, ${items.length} connection${items.length === 1 ? "" : "s"}`}>
              <span className="env-dot" />
              {envLabel(env)}
              <span className="count">{items.length}</span>
            </h2>
            <div className="conn-cards">
              {items.map(({ profile: p, lastUsedAt }) => {
                const facts = [p.group?.trim() || "No group", p.ssh ? "SSH tunnel" : null, p.safetyMode === "read_only" || (productionReadOnly && p.environment === "production" && p.driver !== "redis") ? "Opens read-only" : null].filter(
                  Boolean,
                );
                return (
                  // A plain container: keyboard users reach the Connect and Edit buttons; a click anywhere
                  // else on the card still connects for pointer users.
                  <div
                    key={p.id}
                    className="conn-card"
                    style={envStyle(p.environment)}
                    onClick={(e) => !(e.target as HTMLElement).closest("button") && onConnect(p)}
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
                  >
                    <div className="conn-card-top">
                      <span className="driver-mark" title={driverLabel(p.driver)}>
                        {driverShort(p.driver)}
                      </span>
                      <div className="conn-card-title">
                        <strong>{p.name}</strong>
                        <span>
                          {driverLabel(p.driver)}
                          {lastUsedAt && ` · ${new Date(lastUsedAt).toLocaleDateString()}`}
                        </span>
                      </div>
                      <EnvBadge env={p.environment} />
                    </div>
                    <div className="target">{target(p)}</div>
                    <div className="conn-card-foot">
                      <span className="facts">{facts.join(" · ")}</span>
                      {connecting === p.id && <span className="spinner" aria-label="Connecting" />}
                      <button
                        className="btn btn-ghost btn-icon"
                        aria-label={`Edit ${p.name}`}
                        title="Edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(p);
                        }}
                      >
                        <Icon name="edit" size={15} />
                      </button>
                      <button className="connect-link" aria-label={`Connect to ${p.name}`} onClick={() => onConnect(p)}>
                        Connect <Icon name="chevron_right" size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
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
          initialUrl={editing === "new" ? (pendingUrl ?? undefined) : undefined}
          onClose={closeForm}
          onSaved={(profile, connect) => {
            closeForm();
            if (connect) onConnect(profile);
          }}
        />
      )}
    </div>
  );
}
