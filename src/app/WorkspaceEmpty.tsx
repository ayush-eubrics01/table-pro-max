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
  const summary = [`${s.server.product} ${s.server.version}`, s.database, tables === undefined ? null : `${tables} table${tables === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return (
    <div className="ws-empty">
      <div className="ws-empty-inner">
        <p className="ws-connected">
          <span className="ws-connected-dot" />
          Connected
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
