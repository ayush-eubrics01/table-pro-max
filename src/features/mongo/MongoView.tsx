import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { api, toError } from "../../lib/ipc";
import { formatCount, pluralize } from "../../lib/text";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import type { Workspace } from "../../stores/workspaces";
import type { MongoCollection, MongoDatabase, MongoDeleteTarget, MongoPage } from "../../types/backend";
import { ConnectionLine } from "../connections/nameConfirm";
import { cellText, isEveryDocument, parseDoc } from "./mongoText";

type Mode = "find" | "aggregate" | "vector";

interface Target {
  database: string;
  collection: string;
  kind: MongoCollection["kind"];
}

const LIMITS = [50, 100, 500, 1000];

/** Runs `run` on Ctrl+Enter (Cmd+Enter on macOS) in a query field. */
function onRunKey(run: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  };
}

/** Document browser for one MongoDB connection: find, aggregate, vector search, delete. */
export function MongoView({ ws }: { ws: Workspace }) {
  const sid = ws.session.sessionId;
  const readOnly = ws.session.readOnly;
  const [dbs, setDbs] = useState<MongoDatabase[]>([]);
  const [collections, setCollections] = useState<Record<string, MongoCollection[] | "loading">>({});
  const [target, setTarget] = useState<Target | null>(null);
  const [mode, setMode] = useState<Mode>("find");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("");
  const [projection, setProjection] = useState("");
  const [limit, setLimit] = useState(100);
  const [skip, setSkip] = useState(0);
  const [pipeline, setPipeline] = useState('[\n  { "$match": {} }\n]');
  const [vector, setVector] = useState({
    index: "",
    path: "embedding",
    queryVector: "",
    numCandidates: "",
    limit: 10,
    filter: "",
  });
  const [page, setPage] = useState<MongoPage | null>(null);
  /** Where the page on screen came from, and its find filter: what deletes and "Count all" act on. */
  const [shown, setShown] = useState<{ target: Target; filter: string | null } | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"table" | "json">("table");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCollections = useCallback(
    async (name: string) => {
      setCollections((c) => ({ ...c, [name]: "loading" }));
      try {
        // MongoDB's own metadata (system.views, system.profile…) is not browsed or deleted here.
        const list = (await api.mongoCollections(sid, name)).filter((c) => !c.name.startsWith("system."));
        setCollections((c) => ({ ...c, [name]: list }));
      } catch (e) {
        setCollections(({ [name]: _, ...rest }) => rest);
        setError(toError(e).message);
      }
    },
    [sid],
  );

  const toggleDb = (name: string) => {
    if (collections[name] && collections[name] !== "loading") setCollections(({ [name]: _, ...rest }) => rest);
    else void loadCollections(name);
  };

  // A new session (reconnecting, or allowing writes) reloads the tree: the connection's database and
  // the one in use stay open.
  useEffect(() => {
    setCollections({});
    api
      .mongoDatabases(sid)
      .then((list) => {
        setDbs(list);
        const open = new Set([ws.session.database || list[0]?.name, target?.database].filter((d): d is string => !!d));
        for (const d of open) void loadCollections(d);
      })
      .catch((e) => setError(toError(e).message));
    // Once per session; later loads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  /** Each run's number: a result that arrives after a newer run, or a new pick, is dropped. */
  const runSeq = useRef(0);
  const run = useCallback(
    async (t: Target | null, from: number) => {
      if (!t) return;
      const n = ++runSeq.current;
      setSkip(from);
      setRunning(true);
      setError(null);
      setTotal(null);
      try {
        const base = { database: t.database, collection: t.collection };
        const result =
          mode === "find"
            ? await api.mongoFind(sid, {
                ...base,
                filter,
                sort,
                projection,
                skip: from,
                limit,
              })
            : mode === "aggregate"
              ? await api.mongoAggregate(sid, { ...base, pipeline, limit })
              : await api.mongoVectorSearch(sid, {
                  ...base,
                  index: vector.index,
                  path: vector.path,
                  queryVector: vector.queryVector,
                  numCandidates: vector.numCandidates.trim() ? Number(vector.numCandidates) : null,
                  limit: vector.limit,
                  filter: vector.filter,
                });
        if (n !== runSeq.current) return;
        setPage(result);
        setShown({ target: t, filter: mode === "find" ? filter : null });
        setSelected(new Set());
      } catch (e) {
        if (n === runSeq.current) setError(toError(e).message);
      } finally {
        if (n === runSeq.current) setRunning(false);
      }
    },
    [sid, mode, filter, sort, projection, limit, pipeline, vector],
  );

  const pick = (database: string, c: MongoCollection) => {
    const t = { database, collection: c.name, kind: c.kind };
    runSeq.current++;
    setTarget(t);
    setSkip(0);
    setPage(null);
    setShown(null);
    setSelected(new Set());
    setRunning(false);
    if (mode === "find") void run(t, 0);
  };

  const countMatching = async () => {
    if (!shown || shown.filter === null) return;
    try {
      setTotal(await api.mongoCount(sid, shown.target.database, shown.target.collection, shown.filter));
    } catch (e) {
      notifyError(e, "Could not count");
    }
  };

  const remove = async (t: MongoDeleteTarget, what: string) => {
    if (!shown) return;
    const target = shown.target;
    try {
      const count = await api.mongoDeleteCount(sid, target.database, target.collection, t);
      if (count === 0) return notify("No documents match, so nothing was deleted.");
      const production = ws.session.environment === "production";
      const byFilter = t.kind === "filter";
      const ok = await confirmAction({
        title: `Delete ${pluralize(count, "document")}?`,
        confirmLabel: `Delete ${pluralize(count, "document")}`,
        danger: true,
        typeToConfirm: production && byFilter ? ws.session.connectionName : undefined,
        body: (
          <>
            <ConnectionLine session={ws.session} />
            <p style={{ margin: 0 }}>
              {what} from{" "}
              <strong className="mono">
                {target.database}.{target.collection}
              </strong>
              . This can't be undone: MongoDB deletes keep no restore point.
            </p>
            {byFilter && <pre className="code-block">{t.filter.trim() || "{}"}</pre>}
          </>
        ),
      });
      if (!ok) return;
      const deleted = await api.mongoDelete(sid, {
        database: target.database,
        collection: target.collection,
        target: t,
        expected: count,
        confirmed: true,
        typedConfirmation: production && byFilter ? ws.session.connectionName : null,
      });
      notify(`Deleted ${pluralize(deleted, "document")}`, "success");
      await run(target, skip);
    } catch (e) {
      notifyError(e, "Delete failed");
    }
  };

  const docs = useMemo(() => page?.documents.map(parseDoc) ?? [], [page]);
  const canDelete = !readOnly && shown?.target.kind === "collection";
  const shownFilter = shown?.filter ?? null;
  const selectable = canDelete && mode !== "aggregate";

  return (
    <div className="mongo">
      <aside className="sidebar" aria-label="MongoDB databases" style={{ minWidth: 0 }}>
        <div className="sidebar-head">
          <div className="redis-keys-meta">
            <span>{pluralize(dbs.length, "database")}</span>
            <span className="grow" />
            <button
              className="btn btn-ghost btn-icon"
              aria-label="Reload databases"
              title="Reload"
              onClick={() =>
                api
                  .mongoDatabases(sid)
                  .then(setDbs)
                  .catch((e) => setError(toError(e).message))
              }
            >
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </div>
        <div className="sidebar-tree" role="tree" aria-label="Databases and collections">
          {dbs.map((d) => {
            const list = collections[d.name];
            return (
              <div key={d.name} role="treeitem" aria-expanded={!!list}>
                <button className="tree-item" onClick={() => toggleDb(d.name)}>
                  <Icon name={list ? "keyboard_arrow_down" : "chevron_right"} size={13} />
                  <Icon name="database" size={14} />
                  <span className="name">{d.name}</span>
                </button>
                {list === "loading" && (
                  <div className="hint" style={{ paddingLeft: 44 }}>
                    Loading…
                  </div>
                )}
                {Array.isArray(list) && list.length === 0 && (
                  <div className="hint" style={{ paddingLeft: 44 }}>
                    No collections
                  </div>
                )}
                {Array.isArray(list) &&
                  list.map((c) => (
                    <button
                      key={c.name}
                      className="tree-item"
                      style={{ paddingLeft: 44 }}
                      aria-current={target?.database === d.name && target.collection === c.name}
                      onClick={() => pick(d.name, c)}
                      title={c.kind === "collection" ? c.name : `${c.name} (${c.kind})`}
                    >
                      <Icon name={c.kind === "view" ? "visibility" : "table"} size={14} />
                      <span className="name">{c.name}</span>
                      {c.estimatedCount !== null && <span className="meta">~{formatCount(c.estimatedCount)}</span>}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </aside>
      <div className="main">
        <div className="toolbar" role="toolbar">
          <div className="segmented" role="group" aria-label="Query">
            {(["find", "aggregate", "vector"] as const).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => {
                  if (m === mode) return;
                  setMode(m);
                  runSeq.current++;
                  setRunning(false);
                  setPage(null);
                  setShown(null);
                  setTotal(null);
                  setSelected(new Set());
                  setError(null);
                }}
              >
                {m === "find" ? "Find" : m === "aggregate" ? "Aggregate" : "Vector search"}
              </button>
            ))}
          </div>
          {target && (
            <>
              <span className="sep" />
              <strong
                className="mono"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {target.database}.{target.collection}
              </strong>
            </>
          )}
          <span className="grow" />
          <button className="btn btn-primary" disabled={!target || running} onClick={() => void run(target, 0)}>
            <Icon name="play_arrow" size={13} /> Run
          </button>
        </div>
        {target && (
          <div className="mongo-query">
            {mode === "find" && (
              <>
                <label className="field">
                  <span>Filter</span>
                  <input
                    className="input mono"
                    value={filter}
                    placeholder='{ "status": "paid" }'
                    aria-label="Filter"
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={onRunKey(() => void run(target, 0))}
                  />
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Sort</span>
                    <input
                      className="input mono"
                      value={sort}
                      placeholder='{ "createdAt": -1 }'
                      aria-label="Sort"
                      onChange={(e) => setSort(e.target.value)}
                      onKeyDown={onRunKey(() => void run(target, 0))}
                    />
                  </label>
                  <label className="field">
                    <span>Projection</span>
                    <input
                      className="input mono"
                      value={projection}
                      placeholder='{ "name": 1 }'
                      aria-label="Projection"
                      onChange={(e) => setProjection(e.target.value)}
                      onKeyDown={onRunKey(() => void run(target, 0))}
                    />
                  </label>
                  <label className="field" style={{ flex: "0 0 110px" }}>
                    <span>Limit</span>
                    <select className="select" value={limit} aria-label="Limit" onChange={(e) => setLimit(Number(e.target.value))}>
                      {LIMITS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}
            {mode === "aggregate" && (
              <label className="field">
                <span>Pipeline (reading stages only; $out and $merge are refused)</span>
                <textarea
                  className="textarea"
                  rows={6}
                  spellCheck={false}
                  value={pipeline}
                  aria-label="Pipeline"
                  onChange={(e) => setPipeline(e.target.value)}
                  onKeyDown={onRunKey(() => void run(target, 0))}
                />
              </label>
            )}
            {mode === "vector" && (
              <>
                <div className="field-row">
                  <label className="field">
                    <span>Vector index</span>
                    <input
                      className="input mono"
                      value={vector.index}
                      placeholder="vector_index"
                      aria-label="Vector index"
                      onChange={(e) => setVector({ ...vector, index: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Vector field</span>
                    <input className="input mono" value={vector.path} aria-label="Vector field" onChange={(e) => setVector({ ...vector, path: e.target.value })} />
                  </label>
                  <label className="field" style={{ flex: "0 0 100px" }}>
                    <span>Limit</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={1000}
                      value={vector.limit}
                      aria-label="Results"
                      onChange={(e) =>
                        setVector({
                          ...vector,
                          limit: Number(e.target.value) || 1,
                        })
                      }
                    />
                  </label>
                  <label className="field" style={{ flex: "0 0 130px" }}>
                    <span>Candidates</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={vector.numCandidates}
                      placeholder={String(Math.min(vector.limit * 10, 10000))}
                      aria-label="Candidates"
                      onChange={(e) => setVector({ ...vector, numCandidates: e.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Query vector</span>
                  <textarea
                    className="textarea"
                    rows={3}
                    spellCheck={false}
                    value={vector.queryVector}
                    placeholder="[0.12, -0.4, 0.98, …]"
                    aria-label="Query vector"
                    onChange={(e) => setVector({ ...vector, queryVector: e.target.value })}
                    onKeyDown={onRunKey(() => void run(target, 0))}
                  />
                </label>
                <label className="field">
                  <span>Filter (optional; its fields must be indexed as filter fields)</span>
                  <input
                    className="input mono"
                    value={vector.filter}
                    placeholder='{ "lang": "en" }'
                    aria-label="Vector filter"
                    onChange={(e) => setVector({ ...vector, filter: e.target.value })}
                    onKeyDown={onRunKey(() => void run(target, 0))}
                  />
                </label>
              </>
            )}
          </div>
        )}
        {error && (
          <div className="notice notice-error" style={{ margin: 8 }} role="alert">
            {error}
          </div>
        )}
        {!target ? (
          <div className="empty">Pick a collection to see its documents.</div>
        ) : running && !page ? (
          <div className="empty">
            <div className="spinner" />
          </div>
        ) : !page ? (
          <div className="empty">Choose Run to see documents.</div>
        ) : (
          <>
            <div className="mongo-results-head">
              <span>
                {pluralize(page.documents.length, "document")}
                {page.hasMore ? " · more match" : ""}
                {page.truncated ? " · stopped at 16 MB" : ""}
                {total !== null ? ` · ${formatCount(total)} match in all` : ""}
              </span>
              {mode === "find" && (
                <>
                  <button className="btn btn-ghost" onClick={() => void countMatching()}>
                    Count all
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    aria-label="Previous page"
                    disabled={skip === 0 || running}
                    onClick={() => {
                      void run(shown?.target ?? target, Math.max(0, skip - limit));
                    }}
                  >
                    <Icon name="chevron_left" size={14} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    aria-label="Next page"
                    disabled={!page.hasMore || running}
                    onClick={() => {
                      void run(shown?.target ?? target, skip + limit);
                    }}
                  >
                    <Icon name="chevron_right" size={14} />
                  </button>
                </>
              )}
              <span className="grow" />
              {selectable && selected.size > 0 && (
                <button
                  className="btn btn-danger"
                  onClick={() =>
                    void remove(
                      { kind: "ids", ids: [...selected] },
                      selected.size === 1 ? "The selected document will be deleted" : `The ${selected.size} selected documents will be deleted`,
                    )
                  }
                >
                  <Icon name="delete" size={13} /> {selected.size === 1 ? "Delete the selected document" : `Delete ${selected.size} selected documents`}
                </button>
              )}
              {canDelete && mode === "find" && shownFilter !== null && page.documents.length > 0 && (
                <button
                  className="btn"
                  onClick={() =>
                    void remove(
                      { kind: "filter", filter: shownFilter },
                      isEveryDocument(shownFilter) ? "Every document in the collection will be deleted" : "Every document matching this filter will be deleted",
                    )
                  }
                >
                  Delete matching…
                </button>
              )}
              <div className="segmented" role="group" aria-label="Show as">
                <button aria-pressed={view === "table"} onClick={() => setView("table")}>
                  Table
                </button>
                <button aria-pressed={view === "json"} onClick={() => setView("json")}>
                  JSON
                </button>
              </div>
            </div>
            {page.documents.length === 0 ? (
              <div className="empty">No documents match.</div>
            ) : view === "table" ? (
              <div className="mongo-docs">
                <table className="table">
                  <thead>
                    <tr>
                      {selectable && <th style={{ width: 28 }} />}
                      {page.fields.map((f) => (
                        <th key={f} className="mono">
                          {f}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d, i) => {
                      const id = page.ids[i];
                      return (
                        <tr key={i}>
                          {selectable && <td>{id && <SelectBox id={id} selected={selected} onChange={setSelected} label={`Select document ${cellText(d._id)}`} />}</td>}
                          {page.fields.map((f) => (
                            <td key={f} className="mono">
                              {cellText(d[f])}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mongo-docs">
                {page.documents.map((text, i) => {
                  const id = page.ids[i];
                  return (
                    <div key={i} className="mongo-doc">
                      {selectable && id && <SelectBox id={id} selected={selected} onChange={setSelected} label={`Select document ${i + 1}`} />}
                      <pre className="code-block">{text}</pre>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SelectBox({ id, selected, onChange, label }: { id: string; selected: Set<string>; onChange: (s: Set<string>) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={selected.has(id)}
      onChange={(e) => {
        const next = new Set(selected);
        if (e.target.checked) next.add(id);
        else next.delete(id);
        onChange(next);
      }}
    />
  );
}
