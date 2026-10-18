import { useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { BrowseRequest, Cell, ColumnMeta, Dialect, ExportFormat, ExportOptions, StatementResult } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { cellCopy, needsFetch } from "../../lib/cells";
import { uid, formatCount } from "../../lib/text";
import { Dialog } from "../../components/Dialog";
import { notify } from "../../stores/ui";
import { useJobProgress } from "./useJobProgress";

export type ExportSource =
  | { kind: "result"; statement: StatementResult; dialect: Dialect }
  | { kind: "table"; sessionId: string; request: BrowseRequest; dialect: Dialect; filtered: boolean }
  | { kind: "rows"; columns: ColumnMeta[]; rows: Cell[][]; dialect: Dialect; label: string };

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON array", ext: "json" },
  { value: "json_lines", label: "JSON Lines", ext: "jsonl" },
  { value: "sql", label: "SQL INSERT statements", ext: "sql" },
  { value: "xlsx", label: "Excel workbook", ext: "xlsx" },
];

export function ExportDialog({ source, onClose }: { source: ExportSource; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [nullText, setNullText] = useState("");
  const defaultTable = source.kind === "table" ? source.request.table : "exported_rows";
  const [sqlTable, setSqlTable] = useState(defaultTable);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJobProgress(jobId);

  const description =
    source.kind === "result"
      ? `${formatCount(source.statement.totalRows ?? 0)} rows from the query result`
      : source.kind === "rows"
        ? source.label
        : `${source.request.schema}.${source.request.table}${source.filtered ? " with the current filter and sort" : ", all rows"}`;

  const run = async () => {
    // Rows from the grid must hold full values; a placeholder would be written as an empty string.
    if (source.kind === "rows" && source.rows.some((r) => r.some((c) => needsFetch(c)))) {
      setError("Some values are not loaded yet, so these rows can't be exported as they are. Load them first, or export the whole table.");
      return;
    }
    const ext = FORMATS.find((f) => f.value === format)!.ext;
    const base = source.kind === "table" ? source.request.table : "export";
    const path = await saveDialog({ defaultPath: `${base}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return;
    // The header box is shown for CSV only; for SQL it is the "Exported by" comment, always written.
    const options: ExportOptions = { format, delimiter, header: format === "csv" ? header : true, nullText, sqlTable, dialect: source.dialect, sqlBatch: 100 };
    const id = uid();
    setJobId(id);
    setError(null);
    try {
      let n: number;
      if (source.kind === "result") n = await api.exportResult(source.statement.resultId!, path, options);
      else if (source.kind === "table") n = await api.exportTable(source.sessionId, source.request, path, options, id);
      else
        n = await api.exportRows(
          source.columns,
          source.rows.map((r) => r.map((c) => (c === null ? null : cellCopy(c)))),
          path,
          options,
        );
      notify(`Exported ${formatCount(n)} rows to ${path}`, "success");
      onClose();
    } catch (e) {
      setError(toError(e).message);
      setJobId(null);
    }
  };

  const busy = jobId !== null;
  return (
    <Dialog
      title="Export"
      onClose={() => !busy && onClose()}
      footer={
        <>
          {busy && <span className="hint">{progress > 0 ? `${formatCount(progress)} rows written…` : "Exporting…"}</span>}
          <span className="spacer" />
          {busy && source.kind === "table" ? (
            <button className="btn" onClick={() => jobId && api.cancelJob(jobId)}>
              Cancel export
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            Choose file and export
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{description}</p>
      <label className="field">
        <span>Format</span>
        <select className="select" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {format === "csv" && (
        <div className="field-row">
          <label className="field">
            <span>Delimiter</span>
            <select className="select" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
              <option value=",">Comma</option>
              <option value=";">Semicolon</option>
              <option value={"\t"}>Tab</option>
              <option value="|">Pipe</option>
            </select>
          </label>
          <label className="field">
            <span>Write NULL as</span>
            <input className="input" value={nullText} placeholder="(empty)" onChange={(e) => setNullText(e.target.value)} />
          </label>
        </div>
      )}
      {format === "csv" && (
        <label className="checkbox">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Include a header row
        </label>
      )}
      {format === "sql" && (
        <label className="field">
          <span>Table name in INSERT statements</span>
          <input className="input mono" value={sqlTable} onChange={(e) => setSqlTable(e.target.value)} />
        </label>
      )}
      {format === "xlsx" && <p className="hint">Excel sheets hold up to 1,048,576 rows. Use CSV for larger exports.</p>}
      {error && <div className="notice notice-error">{error}</div>}
    </Dialog>
  );
}
