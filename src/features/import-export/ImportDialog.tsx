import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ColumnMapping, DbObject, ImportOptions, ImportPreview, SessionInfo, TableStructure } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { formatBytes } from "../../lib/cells";
import { formatCount, uid } from "../../lib/text";
import { Dialog } from "../../components/Dialog";
import { EnvBadge } from "../../components/EnvBadge";
import { notify } from "../../stores/ui";
import { useJobProgress } from "./useJobProgress";

const KIND_TYPES: Record<string, Record<string, string>> = {
  postgres: { integer: "bigint", decimal: "numeric", boolean: "boolean", date: "date", timestamp: "timestamp", text: "text" },
  mysql: { integer: "bigint", decimal: "double", boolean: "boolean", date: "date", timestamp: "datetime(6)", text: "text" },
  sqlite: { integer: "INTEGER", decimal: "REAL", boolean: "TEXT", date: "TEXT", timestamp: "TEXT", text: "TEXT" },
};

interface Props {
  session: SessionInfo;
  schema: string;
  tables: DbObject[];
  initialTable?: string;
  onClose: () => void;
  onDone: (table: string) => void;
}

type Target = { mode: "existing"; table: string } | { mode: "new"; table: string };

/** Import a CSV or JSON file: preview, options, target table, column mapping, review, run. */
export function ImportDialog({ session, schema, tables, initialTable, onClose, onDone }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [options, setOptions] = useState<ImportOptions>({
    format: "csv",
    delimiter: ",",
    quote: '"',
    header: true,
    encoding: "utf8",
    nullValues: ["", "NULL"],
    trim: false,
  });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [target, setTarget] = useState<Target>({ mode: initialTable ? "existing" : "new", table: initialTable ?? "" });
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [newTypes, setNewTypes] = useState<string[]>([]);
  const [review, setReview] = useState<string[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJobProgress(jobId);
  const typeMap = KIND_TYPES[session.dialect]!;

  const choose = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson"] }] });
    if (typeof p !== "string") return;
    const isJson = /\.(json|jsonl|ndjson)$/i.test(p);
    setOptions((o) => ({ ...o, format: isJson ? "json" : "csv", delimiter: /\.tsv$/i.test(p) ? "\t" : o.delimiter }));
    setPath(p);
  };

  // Re-read the preview whenever the file or parsing options change.
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setError(null);
    api
      .previewImport(path, options)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setNewTypes(p.columns.map((c) => typeMap[c.kind] ?? "text"));
      })
      .catch((e) => alive && setError(toError(e).message));
    return () => {
      alive = false;
    };
  }, [path, options, typeMap]);

  useEffect(() => {
    if (target.mode !== "existing" || !target.table) {
      setStructure(null);
      return;
    }
    api.tableStructure(session.sessionId, schema, target.table, true).then(setStructure).catch((e) => setError(toError(e).message));
  }, [target, session.sessionId, schema]);

  // Default mapping: match column names case-insensitively.
  useEffect(() => {
    if (!preview) return;
    const names = target.mode === "existing" ? (structure?.columns.map((c) => c.name) ?? []) : preview.columns.map((c) => c.name);
    const m: Record<string, number | null> = {};
    for (const n of names) {
      const i = preview.columns.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
      m[n] = i >= 0 ? i : null;
    }
    setMapping(m);
  }, [preview, structure, target.mode]);

  const finalMapping: ColumnMapping[] = useMemo(
    () => Object.entries(mapping).flatMap(([t, s]) => (s === null || s === undefined ? [] : [{ target: t, source: s }])),
    [mapping],
  );

  const prepare = async () => {
    setError(null);
    if (!preview || !target.table.trim()) return;
    if (target.mode === "new") {
      try {
        const stmts = await api.previewCreateTable(session.sessionId, {
          schema,
          name: target.table.trim(),
          columns: preview.columns.map((c, i) => ({ name: c.name, dataType: newTypes[i] ?? "text", nullable: true, default: null, primaryKey: false })),
        });
        setReview(stmts);
      } catch (e) {
        setError(toError(e).message);
      }
    } else setReview([]);
  };

  const run = async () => {
    if (!path || !preview) return;
    const id = uid();
    setJobId(id);
    setError(null);
    try {
      const n = await api.importFile(
        session.sessionId,
        {
          path,
          options,
          schema,
          table: target.table.trim(),
          mapping: target.mode === "new" ? preview.columns.map((c, i) => ({ target: c.name, source: i })) : finalMapping,
          skip: 0,
        },
        review ?? [],
        id,
      );
      notify(`Imported ${formatCount(n)} rows into ${target.table}`, "success");
      onDone(target.table.trim());
    } catch (e) {
      const err = toError(e);
      setError(err.detail ? `${err.message}\n${err.detail}` : err.message);
      setJobId(null);
    }
  };

  const busy = jobId !== null;
  const canPrepare = !!preview && !!target.table.trim() && (target.mode === "new" || finalMapping.length > 0);

  if (review) {
    return (
      <Dialog
        title="Review import"
        wide
        onClose={() => !busy && setReview(null)}
        footer={
          <>
            {busy && <span className="hint">{formatCount(progress)} rows imported…</span>}
            <span className="spacer" />
            {busy ? (
              <button className="btn" onClick={() => jobId && api.cancelJob(jobId)}>
                Cancel import
              </button>
            ) : (
              <button className="btn" onClick={() => setReview(null)}>
                Back
              </button>
            )}
            <button className={`btn ${session.environment === "production" ? "btn-danger" : "btn-primary"}`} onClick={run} disabled={busy}>
              Import rows
            </button>
          </>
        }
      >
        <div className="field-row" style={{ alignItems: "center" }}>
          <EnvBadge env={session.environment} />
          <strong>{session.connectionName}</strong>
          <span className="hint mono">{session.target}</span>
        </div>
        <p style={{ margin: 0 }}>
          Rows from <span className="mono">{path}</span> ({formatBytes(preview?.fileBytes ?? 0)}) will be inserted into{" "}
          <strong>
            {schema}.{target.table}
          </strong>
          {session.capabilities.transactions ? " in one transaction. If any row fails, nothing is imported." : "."}
        </p>
        {review.length > 0 && (
          <>
            <p style={{ margin: 0 }}>The table is created first:</p>
            <pre className="code-block">{review.map((s) => `${s};`).join("\n\n")}</pre>
          </>
        )}
        <p className="hint" style={{ margin: 0 }}>
          Columns: {(target.mode === "new" ? preview?.columns.map((c) => c.name) : finalMapping.map((m) => `${preview?.columns[m.source]?.name} → ${m.target}`))?.join(", ")}
        </p>
        {error && <pre className="notice notice-error">{error}</pre>}
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Import data"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={prepare} disabled={!canPrepare}>
            Review import
          </button>
        </>
      }
    >
      <div className="field-row" style={{ alignItems: "center" }}>
        <button className="btn" onClick={choose}>
          Choose file…
        </button>
        <span className="mono hint" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {path ?? "CSV, TSV, JSON array or JSON Lines"}
        </span>
      </div>

      {path && (
        <div className="field-row">
          <label className="field">
            <span>Format</span>
            <select className="select" value={options.format} onChange={(e) => setOptions({ ...options, format: e.target.value as ImportOptions["format"] })}>
              <option value="csv">Delimited text</option>
              <option value="json">JSON</option>
            </select>
          </label>
          {options.format === "csv" && (
            <>
              <label className="field">
                <span>Delimiter</span>
                <select className="select" value={options.delimiter} onChange={(e) => setOptions({ ...options, delimiter: e.target.value })}>
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                  <option value={"\t"}>Tab</option>
                  <option value="|">Pipe</option>
                </select>
              </label>
              <label className="field">
                <span>Encoding</span>
                <select className="select" value={options.encoding} onChange={(e) => setOptions({ ...options, encoding: e.target.value as ImportOptions["encoding"] })}>
                  <option value="utf8">UTF-8</option>
                  <option value="latin1">Latin-1 (ISO-8859-1)</option>
                </select>
              </label>
            </>
          )}
          <label className="field">
            <span>Treat as NULL</span>
            <input
              className="input"
              value={options.nullValues.map((v) => (v === "" ? "(empty)" : v)).join(", ")}
              onChange={(e) =>
                setOptions({
                  ...options,
                  nullValues: e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .map((v) => (v === "(empty)" ? "" : v)),
                })
              }
            />
          </label>
        </div>
      )}
      {path && options.format === "csv" && (
        <div className="field-row">
          <label className="checkbox">
            <input type="checkbox" checked={options.header} onChange={(e) => setOptions({ ...options, header: e.target.checked })} /> First row has column names
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={options.trim} onChange={(e) => setOptions({ ...options, trim: e.target.checked })} /> Trim spaces
          </label>
        </div>
      )}

      {preview && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Import into</span>
              <select
                className="select"
                value={target.mode}
                onChange={(e) => setTarget({ mode: e.target.value as Target["mode"], table: e.target.value === "existing" ? (initialTable ?? "") : "" })}
              >
                <option value="existing">An existing table</option>
                <option value="new" disabled={session.readOnly}>
                  A new table
                </option>
              </select>
            </label>
            {target.mode === "existing" ? (
              <label className="field">
                <span>Table</span>
                <select className="select" value={target.table} onChange={(e) => setTarget({ mode: "existing", table: e.target.value })}>
                  <option value="">Choose…</option>
                  {tables
                    .filter((t) => t.kind === "table")
                    .map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>New table name</span>
                <input className="input" value={target.table} onChange={(e) => setTarget({ mode: "new", table: e.target.value })} />
              </label>
            )}
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>{target.mode === "existing" ? "Table column" : "Column"}</th>
                <th>{target.mode === "existing" ? "From file column" : "Type"}</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {target.mode === "existing"
                ? (structure?.columns ?? []).map((c) => {
                    const src = mapping[c.name];
                    return (
                      <tr key={c.name}>
                        <td>
                          {c.name} <span className="hint">{c.dataType}</span>
                        </td>
                        <td>
                          <select
                            className="select"
                            aria-label={`Source for ${c.name}`}
                            value={src ?? ""}
                            onChange={(e) => setMapping({ ...mapping, [c.name]: e.target.value === "" ? null : Number(e.target.value) })}
                          >
                            <option value="">Skip (use default)</option>
                            {preview.columns.map((pc, i) => (
                              <option key={i} value={i}>
                                {pc.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="mono">{src !== null && src !== undefined ? (preview.rows[0]?.[src] ?? "NULL") : ""}</td>
                      </tr>
                    );
                  })
                : preview.columns.map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td>
                      <td>
                        <input
                          className="input mono"
                          aria-label={`Type for ${c.name}`}
                          value={newTypes[i] ?? ""}
                          onChange={(e) => setNewTypes(newTypes.map((t, k) => (k === i ? e.target.value : t)))}
                        />
                      </td>
                      <td className="mono">{preview.rows[0]?.[i] ?? "NULL"}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
          <p className="hint" style={{ margin: 0 }}>
            Previewing the first {preview.rows.length} rows. Types were inferred from up to 1,000 rows.
          </p>
        </>
      )}
      {error && <pre className="notice notice-error">{error}</pre>}
    </Dialog>
  );
}
