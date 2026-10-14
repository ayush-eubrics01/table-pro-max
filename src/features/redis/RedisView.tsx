import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { RedisKey, RedisValue } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { confirmAction, notify, notifyError, promptText } from "../../stores/ui";
import type { Workspace } from "../../stores/workspaces";
import { prettyJson } from "../../lib/cells";
import { formatCount } from "../../lib/text";

const TYPE_LABEL: Record<string, string> = { string: "STR", hash: "HASH", list: "LIST", set: "SET", zset: "ZSET", stream: "STRM" };

function ttlLabel(ttlMs: number): string {
  if (ttlMs < 0) return "";
  const s = Math.round(ttlMs / 1000);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Key browser + type-aware viewer + console for one Redis connection. */
export function RedisView({ ws }: { ws: Workspace }) {
  const sid = ws.session.sessionId;
  const readOnly = ws.session.readOnly;
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RedisKey[]>([]);
  const [cursor, setCursor] = useState<string>("0");
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState<RedisValue | null>(null);
  const [view, setView] = useState<"key" | "console">("key");
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(
    async (fresh: boolean) => {
      setScanning(true);
      setError(null);
      try {
        // SCAN may return few keys per call; keep going until we have a screenful or reach the end.
        let c = fresh ? "0" : cursor;
        const found: RedisKey[] = [];
        do {
          const page = await api.redisScan(sid, c, pattern, 1000);
          found.push(...page.keys);
          c = page.cursor;
        } while (c !== "0" && found.length < 500);
        setKeys((prev) => (fresh ? found : [...prev, ...found]));
        setCursor(c);
      } catch (e) {
        setError(toError(e).message);
      } finally {
        setScanning(false);
      }
    },
    [sid, pattern, cursor],
  );

  useEffect(() => {
    void scan(true);
    // Initial load only; later scans are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const open = useCallback(
    async (key: string) => {
      setSelected(key);
      setView("key");
      setValue(null);
      try {
        setValue(await api.redisRead(sid, key));
      } catch (e) {
        setError(toError(e).message);
      }
    },
    [sid],
  );

  const removeKey = async (key: string) => {
    const ok = await confirmAction({ title: `Delete ${key}?`, body: "The key and its value are removed from Redis.", confirmLabel: "Delete key", danger: true });
    if (!ok) return;
    try {
      await api.redisDelete(sid, key);
      setKeys((k) => k.filter((x) => x.key !== key));
      setSelected(null);
      setValue(null);
      notify(`Deleted ${key}`, "success");
    } catch (e) {
      notifyError(e);
    }
  };

  const setTtl = async (key: string) => {
    const v = await promptText({ title: `Expiry for ${key}`, label: "Seconds until the key expires (empty to keep forever)", confirmLabel: "Apply" });
    if (v === null) return;
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) return notify("Enter a positive number of seconds", "error");
    try {
      await api.redisExpire(sid, key, n);
      await scan(true);
    } catch (e) {
      notifyError(e);
    }
  };

  const newString = async () => {
    const key = await promptText({ title: "New string key", label: "Key name", confirmLabel: "Create" });
    if (!key) return;
    try {
      await api.redisSetString(sid, key, "", false);
      await scan(true);
      void open(key);
    } catch (e) {
      notifyError(e);
    }
  };

  const current = keys.find((k) => k.key === selected);

  return (
    <div className="redis">
      <aside className="sidebar" aria-label="Redis keys" style={{ minWidth: 0 }}>
        <div className="sidebar-head">
          <div className="sidebar-filter">
            <Icon name="search" size={15} />
            <input
              className="input mono"
              value={pattern}
              aria-label="Key pattern"
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void scan(true)}
            />
          </div>
          <div className="redis-keys-meta">
            <span>
              {formatCount(keys.length)} keys{cursor !== "0" ? " · more available" : ""}
            </span>
            <span className="grow" />
            <button className="btn btn-ghost btn-icon" aria-label="Scan keys" title="Scan (SCAN MATCH)" onClick={() => void scan(true)}>
              <Icon name="refresh" size={15} className={scanning ? "spin" : undefined} />
            </button>
            {!readOnly && (
              <button className="btn btn-ghost btn-icon" aria-label="New string key" title="New string key" onClick={newString}>
                <Icon name="add" size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="sidebar-tree" role="listbox" aria-label="Keys">
          {keys.map((k) => (
            <button key={k.key} role="option" aria-selected={k.key === selected} className="tree-item redis-key" aria-current={k.key === selected} onClick={() => void open(k.key)} title={k.key}>
              <span className="driver-mark">
                {TYPE_LABEL[k.kind] ?? k.kind.toUpperCase().slice(0, 4)}
              </span>
              <span className="name mono">{k.key}</span>
              {k.ttl >= 0 && <span className="meta">{ttlLabel(k.ttl)}</span>}
            </button>
          ))}
          {cursor !== "0" && (
            <div style={{ padding: 8 }}>
              <button className="btn" onClick={() => void scan(false)} disabled={scanning}>
                Load more
              </button>
            </div>
          )}
          {!scanning && keys.length === 0 && <div className="empty">No keys match {pattern}</div>}
        </div>
      </aside>
      <div className="main">
        <div className="toolbar" role="toolbar">
          <div className="segmented" role="group" aria-label="View">
            <button aria-pressed={view === "key"} onClick={() => setView("key")}>
              <Icon name="key" size={12} /> Key
            </button>
            <button aria-pressed={view === "console"} onClick={() => setView("console")}>
              <Icon name="terminal" size={12} /> Console
            </button>
          </div>
          {view === "key" && selected && (
            <>
              <span className="sep" />
              <strong className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {selected}
              </strong>
              {current && current.ttl >= 0 && <span className="meta">expires in {ttlLabel(current.ttl)}</span>}
              <span className="grow" />
              <button className="btn btn-ghost btn-icon" aria-label="Reload key" onClick={() => void open(selected)}>
                <Icon name="refresh" size={14} />
              </button>
              {!readOnly && (
                <>
                  <button className="btn btn-ghost btn-icon" aria-label="Set expiry" title="Set or remove expiry" onClick={() => void setTtl(selected)}>
                    <Icon name="schedule" size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon" aria-label="Delete key" onClick={() => void removeKey(selected)}>
                    <Icon name="delete" size={14} />
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {error && (
          <div className="notice notice-error" style={{ margin: 8 }} role="alert">
            {error}
          </div>
        )}
        {view === "console" ? (
          <RedisConsole sid={sid} ws={ws} />
        ) : selected === null ? (
          <div className="empty">Select a key to see its value.</div>
        ) : value === null ? (
          <div className="empty">
            <div className="spinner" />
          </div>
        ) : (
          <KeyValue sid={sid} keyName={selected} value={value} readOnly={readOnly} onChanged={() => void open(selected)} />
        )}
      </div>
    </div>
  );
}

function KeyValue({ sid, keyName, value, readOnly, onChanged }: { sid: string; keyName: string; value: RedisValue; readOnly: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState(value.kind === "string" ? value.value : "");
  useEffect(() => setDraft(value.kind === "string" ? value.value : ""), [value]);

  const more = (shown: number, total: number) =>
    total > shown ? <p className="hint">Showing {formatCount(shown)} of {formatCount(total)}. Use the console for the rest.</p> : null;

  switch (value.kind) {
    case "none":
      return <div className="empty">This key no longer exists.</div>;
    case "string": {
      const json = prettyJson(value.value);
      const editable = !readOnly && !value.truncated && !value.binary;
      return (
        <div className="structure">
          <div className="hint">
            String, {formatCount(value.length)} bytes{value.binary ? ", binary (shown as hex)" : ""}
            {value.truncated ? ", showing the first 1 MB (read-only)" : ""}
          </div>
          <textarea className="textarea" style={{ minHeight: 240 }} value={draft} readOnly={!editable} onChange={(e) => setDraft(e.target.value)} aria-label="Value" />
          <div className="field-row" style={{ gap: 8 }}>
            {editable && (
              <button
                className="btn btn-primary"
                disabled={draft === value.value}
                onClick={async () => {
                  try {
                    await api.redisSetString(sid, keyName, draft, true);
                    notify("Saved", "success");
                    onChanged();
                  } catch (e) {
                    notifyError(e);
                  }
                }}
              >
                Save value
              </button>
            )}
            {json && (
              <button className="btn" onClick={() => setDraft(json)}>
                Format JSON
              </button>
            )}
          </div>
        </div>
      );
    }
    case "hash":
      return (
        <div className="structure">
          <HashEditor sid={sid} keyName={keyName} fields={value.fields} readOnly={readOnly} onChanged={onChanged} />
          {more(value.fields.length, value.length)}
        </div>
      );
    case "list":
      return (
        <div className="structure">
          <SimpleTable headers={["Index", "Value"]} rows={value.items.map((v, i) => [String(i), v])} />
          {more(value.items.length, value.length)}
        </div>
      );
    case "set":
      return (
        <div className="structure">
          <SimpleTable headers={["Member"]} rows={value.members.map((m) => [m])} />
          {more(value.members.length, value.length)}
        </div>
      );
    case "zset":
      return (
        <div className="structure">
          <SimpleTable headers={["Member", "Score"]} rows={value.items.map(([m, s]) => [m, String(s)])} />
          {more(value.items.length, value.length)}
        </div>
      );
    case "stream":
      return (
        <div className="structure">
          <SimpleTable headers={["Entry ID", "Fields"]} rows={value.entries.map(([id, f]) => [id, f.map(([k, v]) => `${k}=${v}`).join("  ")])} />
          {more(value.entries.length, value.length)}
        </div>
      );
    case "other":
      return <div className="empty">This key has type {value.redisType}. Use the console to inspect it.</div>;
  }
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className="mono">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HashEditor({ sid, keyName, fields, readOnly, onChanged }: { sid: string; keyName: string; fields: [string, string][]; readOnly: boolean; onChanged: () => void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = async (field: string, v: string) => {
    try {
      await api.redisHashSet(sid, keyName, field, v);
      setEdits(({ [field]: _, ...rest }) => rest);
      onChanged();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            {!readOnly && <th style={{ width: 120 }} />}
          </tr>
        </thead>
        <tbody>
          {fields.map(([f, v]) => (
            <tr key={f}>
              <td className="mono">{f}</td>
              <td>
                {readOnly ? (
                  <span className="mono">{v}</span>
                ) : (
                  <input className="input mono" style={{ width: "100%" }} aria-label={`Value of ${f}`} value={edits[f] ?? v} onChange={(e) => setEdits({ ...edits, [f]: e.target.value })} />
                )}
              </td>
              {!readOnly && (
                <td>
                  <button className="btn btn-ghost" disabled={edits[f] === undefined || edits[f] === v} onClick={() => void save(f, edits[f]!)}>
                    Save
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    aria-label={`Delete field ${f}`}
                    onClick={async () => {
                      try {
                        await api.redisHashDelete(sid, keyName, f);
                        onChanged();
                      } catch (e) {
                        notifyError(e);
                      }
                    }}
                  >
                    <Icon name="delete" size={13} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div>
          <button
            className="btn"
            onClick={async () => {
              const f = await promptText({ title: "Add field", label: "Field name", confirmLabel: "Add" });
              if (f) await save(f, "");
            }}
          >
            <Icon name="add" size={14} /> Field
          </button>
        </div>
      )}
    </>
  );
}

interface ConsoleEntry {
  line: string;
  output: string;
  error: boolean;
}

function RedisConsole({ sid, ws }: { sid: string; ws: Workspace }) {
  const [line, setLine] = useState("");
  const [log, setLog] = useState<ConsoleEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [log]);

  const run = async (cmd: string, confirmed = false) => {
    if (!cmd.trim()) return;
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 200));
    setHIndex(-1);
    setLine("");
    try {
      const out = await api.redisCommand(sid, cmd, confirmed);
      setLog((l) => [...l, { line: cmd, output: out, error: false }]);
    } catch (e) {
      const err = toError(e);
      if (err.kind === "confirmation_required") {
        const ok = await confirmAction({
          title: "Run this command?",
          confirmLabel: "Run",
          danger: true,
          body: (
            <>
              <p style={{ margin: 0 }}>
                <strong>{ws.profile.name}</strong> <span className="hint mono">{ws.session.target}</span>
              </p>
              <pre className="code-block">{cmd}</pre>
              <p className="hint" style={{ margin: 0 }}>
                {err.detail}
              </p>
            </>
          ),
        });
        if (ok) return run(cmd, true);
        return;
      }
      setLog((l) => [...l, { line: cmd, output: err.message, error: true }]);
    }
  };

  return (
    <div className="redis-console">
      <div className="redis-console-log" role="log" aria-live="polite">
        {log.length === 0 && <p className="hint">Type a Redis command, for example GET mykey or HGETALL user:1. Blocking commands like BLPOP and SUBSCRIBE are not available here.</p>}
        {log.map((e, i) => (
          <div key={i}>
            <div className="mono" style={{ color: "var(--text-muted)" }}>
              &gt; {e.line}
            </div>
            <pre className={e.error ? "error" : undefined}>{e.output}</pre>
          </div>
        ))}
        <div ref={end} />
      </div>
      <input
        className="input mono"
        aria-label="Redis command"
        placeholder="Command"
        value={line}
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void run(line);
          else if (e.key === "ArrowUp") {
            e.preventDefault();
            const i = Math.min(history.length - 1, hIndex + 1);
            if (history[i] !== undefined) {
              setHIndex(i);
              setLine(history[i]!);
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const i = hIndex - 1;
            setHIndex(Math.max(-1, i));
            setLine(i >= 0 ? history[i]! : "");
          }
        }}
      />
    </div>
  );
}
