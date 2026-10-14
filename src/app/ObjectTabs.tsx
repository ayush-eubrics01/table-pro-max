import { useState } from "react";
import { Icon } from "../components/Icon";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { isMacPlatform } from "./WindowControls";

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "query") return <Icon name="terminal" size={14} />;
  if (tab.kind === "definition") return <Icon name="code_blocks" size={14} />;
  if (tab.kind === "dashboard") return <Icon name="bar_chart" size={14} />;
  return tab.objectKind === "table" ? <Icon name="table" size={14} /> : <Icon name="visibility" size={14} />;
}

/** The object tab strip of a workspace: tables, queries, definitions and dashboards. */
export function ObjectTabs({ ws, dirtyTables, onClose }: { ws: Workspace; dirtyTables: Record<string, boolean>; onClose: (tab: Tab) => void }) {
  const { activateTab, openQuery, moveTab } = useWorkspaces.getState();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  return (
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
          onAuxClick={(e) => e.button === 1 && onClose(t)}
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
              onClose(t);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button className="tab-add" aria-label="New query tab" title={`New query (${isMacPlatform() ? "⌘" : "Ctrl"}+T)`} onClick={() => openQuery(ws.id)}>
        <Icon name="add" size={15} />
      </button>
    </div>
  );
}
