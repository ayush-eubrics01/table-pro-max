import { useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import { api } from "../lib/ipc";
import { envStyle } from "../lib/env";
import { notifyError, useUi } from "../stores/ui";
import { useWorkspaces } from "../stores/workspaces";
import { WindowControls } from "./WindowControls";

interface Props {
  /** macOS draws its own traffic lights in the top-left corner. */
  mac: boolean;
  onCloseWorkspace: (id: string) => void;
}

/** The window's title bar: connection tabs, search, settings and (off macOS) window buttons. */
export function TitleBar({ mac, onCloseWorkspace }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const activate = (id: string | null) => useWorkspaces.getState().activate(id);
  const tabs = useRef<HTMLDivElement>(null);

  // With many connections the strip scrolls; keep the active tab visible.
  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, workspaces.length]);

  return (
    <header className="titlebar" data-tauri-drag-region data-mac={mac || undefined}>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="app-mark" aria-hidden data-tauri-drag-region>
          <Icon name="table" size={14} />
        </span>
        <span data-tauri-drag-region>Table Pro Max</span>
      </div>
      <nav className="titlebar-tabs" role="tablist" aria-label="Open connections" data-tauri-drag-region>
        <button className="tb-tab" role="tab" aria-selected={activeId === null} onClick={() => activate(null)}>
          <Icon name="grid_view" size={15} />
          <span className="label">Connections</span>
        </button>
        {/* Only the connection tabs scroll, so Connections stays reachable; the wheel scrolls sideways. */}
        <div
          className="titlebar-conn-tabs"
          data-tauri-drag-region
          ref={tabs}
          onWheel={(e) => {
            if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
        {workspaces.map((w) => (
          <div
            key={w.id}
            className="tb-tab"
            role="tab"
            tabIndex={0}
            aria-selected={activeId === w.id}
            style={envStyle(w.session.environment)}
            onClick={() => activate(w.id)}
            onKeyDown={(e) => e.key === "Enter" && activate(w.id)}
            title={w.session.target}
          >
            {w.health === "down" ? <Icon name="link_off" size={13} label="Connection lost" color="var(--danger)" /> : <span className="env-dot" />}
            <span className="label">{w.profile.name}</span>
            <button
              className="tab-close"
              aria-label={`Disconnect ${w.profile.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseWorkspace(w.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        </div>
      </nav>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-actions" data-tauri-drag-region>
        <button className="search-pill" aria-label="Search tables, actions and connections" onClick={() => useUi.getState().setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span>Search tables, actions…</span>
          <span className="kbd">{mac ? "⌘ K" : "Ctrl K"}</span>
        </button>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="New window"
          title="New window (Ctrl+Shift+N)"
          onClick={() => void api.openWindow().catch((err) => notifyError(err, "Could not open a window"))}
        >
          <Icon name="new_window" size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => useUi.getState().setSettingsOpen(true)}>
          <Icon name="settings" size={16} />
        </button>
      </div>
      {!mac && <WindowControls />}
    </header>
  );
}
