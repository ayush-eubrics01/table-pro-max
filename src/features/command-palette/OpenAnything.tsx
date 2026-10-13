import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { ConnectionProfile, DbObject, SavedQuery } from "../../types/backend";
import { api } from "../../lib/ipc";
import { useConnections } from "../../stores/connections";
import { useWorkspaces } from "../../stores/workspaces";
import { useUi } from "../../stores/ui";
import { rank } from "./fuzzy";

type Item =
  | { kind: "object"; label: string; where: string; wsId: string; obj: DbObject }
  | { kind: "schema"; label: string; where: string; wsId: string; schema: string }
  | { kind: "connection"; label: string; where: string; profile: ConnectionProfile }
  | { kind: "saved"; label: string; where: string; wsId: string; query: SavedQuery }
  | { kind: "action"; label: string; where: string; run: () => void };

export function OpenAnything({ onConnect }: { onConnect: (p: ConnectionProfile) => void }) {
  const setOpen = useUi((s) => s.setPaletteOpen);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const connections = useConnections((s) => s.connections);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    api.listSavedQueries().then(setSaved).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 60);
    return () => clearTimeout(t);
  }, [query]);

  // Search only cached metadata: never query the database per keystroke.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const active = workspaces.find((w) => w.id === activeId);
    const ordered = active ? [active, ...workspaces.filter((w) => w !== active)] : workspaces;
    for (const ws of ordered) {
      for (const [schema, objs] of Object.entries(ws.objects)) {
        for (const obj of objs) out.push({ kind: "object", label: obj.name, where: `${ws.profile.name} · ${schema}`, wsId: ws.id, obj });
      }
      for (const schema of ws.schemas) out.push({ kind: "schema", label: schema, where: `${ws.profile.name} · schema`, wsId: ws.id, schema });
      for (const q of saved.filter((s) => !s.connectionId || s.connectionId === ws.profile.id))
        out.push({ kind: "saved", label: q.name, where: `${ws.profile.name} · saved query`, wsId: ws.id, query: q });
    }
    for (const c of connections) out.push({ kind: "connection", label: c.profile.name, where: "connection", profile: c.profile });
    if (active) {
      out.push({ kind: "action", label: "New query", where: "action", run: () => useWorkspaces.getState().openQuery(active.id) });
      out.push({ kind: "action", label: "Reopen closed tab", where: "action", run: () => useWorkspaces.getState().reopenClosed(active.id) });
    }
    out.push({ kind: "action", label: "Settings", where: "action", run: () => useUi.getState().setSettingsOpen(true) });
    return out;
  }, [workspaces, activeId, connections, saved]);

  const results = useMemo(() => rank(items, debounced, (i) => i.label), [items, debounced]);
  useEffect(() => setIndex(0), [debounced]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    const ws = useWorkspaces.getState();
    switch (item.kind) {
      case "object":
        ws.activate(item.wsId);
        if (ws.workspaces.find((w) => w.id === item.wsId)?.schema !== item.obj.schema) void ws.setSchema(item.wsId, item.obj.schema);
        ws.openTable(item.wsId, item.obj);
        break;
      case "schema":
        ws.activate(item.wsId);
        void ws.setSchema(item.wsId, item.schema);
        break;
      case "saved":
        ws.activate(item.wsId);
        ws.openQuery(item.wsId, { sql: item.query.sql, title: item.query.name, savedQueryId: item.query.id });
        break;
      case "connection":
        onConnect(item.profile);
        break;
      case "action":
        item.run();
        break;
    }
  };

  const icon = (i: Item) => {
    if (i.kind === "object") return i.obj.kind === "view" || i.obj.kind === "materialized_view" ? <Icon name="visibility" size={14} /> : i.obj.kind === "function" || i.obj.kind === "procedure" ? <Icon name="function" size={14} /> : <Icon name="table" size={14} />;
    if (i.kind === "connection" || i.kind === "schema") return <Icon name="database" size={14} />;
    if (i.kind === "saved") return <Icon name="code_blocks" size={14} />;
    return <Icon name="terminal" size={14} />;
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Open anything">
        <input
          autoFocus
          placeholder="Open a table, view, schema, saved query or connection"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={`palette-${index}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") choose(results[index]);
          }}
        />
        <ul id="palette-results" role="listbox" ref={listRef}>
          {results.map((r, i) => (
            <li key={i} id={`palette-${i}`} role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => choose(r)}>
              {icon(r)}
              <span>{r.label}</span>
              <span className="where">{r.where}</span>
            </li>
          ))}
          {results.length === 0 && <li className="hint">Nothing matches. Objects appear here after their schema has been opened.</li>}
        </ul>
      </div>
    </div>
  );
}
