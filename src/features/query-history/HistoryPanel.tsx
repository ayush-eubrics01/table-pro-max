import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { HistoryEntry } from "../../types/backend";
import { api } from "../../lib/ipc";
import { formatDuration } from "../../lib/text";
import { confirmAction, notifyError } from "../../stores/ui";

interface Props {
  connectionId: string;
  onInsert: (sql: string) => void;
  onOpen: (sql: string) => void;
  refreshKey: number;
}

export function HistoryPanel({ connectionId, onInsert, onOpen, refreshKey }: Props) {
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
    <div className="detail-panel" aria-label="Query history">
      <div className="sidebar-section">
        <input className="input" placeholder="Search history" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search history" />
        <div className="field-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span className="hint">Double-click to open, click to insert</span>
          <button className="btn btn-ghost btn-icon" aria-label="Clear history" onClick={clear}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {entries.length === 0 && <div className="empty">No queries yet.</div>}
      {entries.map((e) => (
        <button
          key={e.id}
          className="detail-field"
          style={{ border: 0, borderBottom: "1px solid var(--grid-line)", background: "none", textAlign: "left", cursor: "pointer" }}
          onClick={() => onInsert(e.sql)}
          onDoubleClick={() => onOpen(e.sql)}
          title={e.error ?? undefined}
        >
          <span className="hint">
            {new Date(e.startedAt).toLocaleString()} · {e.status}
            {e.durationMs !== null ? ` · ${formatDuration(e.durationMs)}` : ""}
          </span>
          <pre style={{ maxHeight: 80, overflow: "hidden", color: e.status === "error" ? "var(--danger)" : undefined }}>{e.sql}</pre>
        </button>
      ))}
    </div>
  );
}
