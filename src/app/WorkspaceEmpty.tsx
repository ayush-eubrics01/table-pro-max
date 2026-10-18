import { Icon } from "../components/Icon";
import { useWorkspaces, type Workspace } from "../stores/workspaces";
import { useUi } from "../stores/ui";
import { isMacPlatform } from "./WindowControls";

/** Shown in a workspace with no open tabs: what is connected, and the two ways to start. */
export function WorkspaceEmpty({ ws }: { ws: Workspace }) {
  const s = ws.session;
  const objects = ws.objects[ws.schema];
  const tables = objects?.filter((o) => o.kind === "table" || o.kind === "foreign_table").length;
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  // On MySQL the switcher picks the database (shown as the schema).
  const database = s.dialect === "mysql" ? ws.schema : s.database;
  const down = ws.health === "down";
  const summary = [`${s.server.product} ${s.server.version}`, database, tables === undefined ? null : `${tables} table${tables === 1 ? "" : "s"}${s.dialect === "postgres" || s.dialect === "mssql" ? ` in ${ws.schema}` : ""}`].filter(Boolean).join(" · ");
  return (
    <div className="ws-empty">
      <div className="ws-empty-inner">
        <p className="ws-connected" data-down={down || undefined}>
          <span className="ws-connected-dot" />
          {down ? "Connection lost" : "Connected"}
        </p>
        <h1>{ws.profile.name}</h1>
        <p className="ws-summary">{summary}</p>
        <div className="ws-actions">
          <button className="ws-action" onClick={() => useWorkspaces.getState().openQuery(ws.id)}>
            <Icon name="terminal" size={18} />
            <span>New query</span>
            <span className="kbd">{mod} T</span>
          </button>
          <button className="ws-action" onClick={() => useUi.getState().setPaletteOpen(true)}>
            <Icon name="search" size={18} />
            <span>Find anything</span>
            <span className="kbd">{mod} K</span>
          </button>
        </div>
      </div>
    </div>
  );
}
