import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { HistoryEntry } from "../../types/backend";
import { api } from "../../lib/ipc";
import { formatDuration } from "../../lib/text";
import { confirmAction, notifyError } from "../../stores/ui";

interface Props {
  connectionId: string;
  onInsert: (sql: string) => void;
  onOpen: (sql: string) => void;
  refreshKey: number;
  onClose: () => void;
}

export function HistoryPanel({ connectionId, onInsert, onOpen, refreshKey, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.searchHistory(connectionId, search, 300).then(setEntries).catch((e) => notifyError(e));
    }, 150);
    return () => clearTimeout(t);
  }, [connectionId, search, refreshKey]);

  const clear = async () => {
    const ok = await confirmAction({
      title: "Clear history for this connection?",
      body: "Query history is stored only on this computer. This removes it permanently.",
      confirmLabel: "Clear history",
      danger: true,
    });
    if (!ok) return;
    await api.clearHistory(connectionId);
    setEntries([]);
  };

  return (
    <aside className="history-panel" aria-label="Query history">
      <header className="side-head">
        <h2>History</h2>
        <button className="btn btn-ghost btn-icon" aria-label="Clear history" title="Clear history" onClick={clear}>
          <Icon name="delete" size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Close history" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="history-search">
        <input className="input" placeholder="Search history" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search history" />
        <span className="hint">Click to insert, double-click to open in a new tab</span>
      </div>
      <div className="history-list">
        {entries.length === 0 && <div className="empty">No queries yet.</div>}
        {entries.map((e) => (
          <button
            key={e.id}
            className="history-entry"
            data-status={e.status}
            onClick={() => onInsert(e.sql)}
            onDoubleClick={() => onOpen(e.sql)}
            title={e.error ?? undefined}
          >
            <span className="meta">
              <span className="dot" />
              {new Date(e.startedAt).toLocaleString()}
              {e.durationMs !== null ? ` · ${formatDuration(e.durationMs)}` : ""}
            </span>
            <pre>{e.sql}</pre>
          </button>
        ))}
      </div>
    </aside>
  );
}
