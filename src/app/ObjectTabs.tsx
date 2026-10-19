import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useWorkspaces, type Tab, type Workspace } from "../stores/workspaces";
import { shortcut } from "../lib/shortcut";

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
  // After a key moves or closes a tab, focus follows to the tab now selected.
  const listRef = useRef<HTMLDivElement>(null);
  const focusSelected = useRef(false);
  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [ws.activeTabId, ws.tabs]);

  // The tab that takes the strip's one Tab stop: the selected one, else the first.
  const stopId = ws.tabs.some((t) => t.id === ws.activeTabId) ? ws.activeTabId : ws.tabs[0]?.id;

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const t = ws.tabs[i]!;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateTab(ws.id, t.id);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "Delete") {
      e.preventDefault();
      focusSelected.current = true;
      onClose(t);
      return;
    }
    const n = ws.tabs.length;
    const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    focusSelected.current = true;
    activateTab(ws.id, ws.tabs[next]!.id);
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs" ref={listRef}>
      {ws.tabs.map((t, i) => (
        // The close button sits beside the tab, not inside it, so its keys never activate the tab.
        <div
          key={t.id}
          className={`tab ${dragIndex === i ? "dragging" : ""}`}
          data-selected={ws.activeTabId === t.id || undefined}
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIndex !== null && dragIndex !== i) moveTab(ws.id, dragIndex, i);
            setDragIndex(null);
          }}
          onDragEnd={() => setDragIndex(null)}
          onAuxClick={(e) => e.button === 1 && onClose(t)}
          title={"schema" in t ? `${t.schema}.${t.name}` : t.title}
        >
          <div
            className="tab-main"
            role="tab"
            // One Tab stop for the strip; arrow keys move between tabs.
            tabIndex={stopId === t.id ? 0 : -1}
            aria-selected={ws.activeTabId === t.id}
            aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete"
            onClick={() => activateTab(ws.id, t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <TabIcon tab={t} />
            <span className="label">{t.title}</span>
            {((t.kind === "query" && t.dirty && !t.savedQueryId && t.sql.trim()) || dirtyTables[t.id]) && <span className="dirty" aria-label="Unsaved changes" />}
          </div>
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
      <button className="tab-add" aria-label="New query tab" title={`New query (${shortcut("Mod+T")})`} onClick={() => openQuery(ws.id)}>
        <Icon name="add" size={15} />
      </button>
    </div>
  );
}
