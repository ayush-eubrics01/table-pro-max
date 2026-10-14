import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { Cell, Dialect, ScriptResult, StatementResult } from "../../types/backend";
import { api } from "../../lib/ipc";
import { formatCount, formatDuration, pluralize } from "../../lib/text";
import { DataGrid } from "../data-grid/DataGrid";
import { ExportDialog } from "../import-export/ExportDialog";
import { isMacPlatform } from "../../app/WindowControls";

const PAGE = 1000;

/** Result rows for one statement, loading further pages from the backend on demand. */
function ResultGrid({ st }: { st: StatementResult }) {
  const [rows, setRows] = useState<(Cell[] | undefined)[]>(() => st.rows ?? []);
  const inflight = useRef(new Set<number>());
  const total = st.totalRows ?? st.rows?.length ?? 0;

  useEffect(() => {
    setRows(st.rows ?? []);
    inflight.current.clear();
  }, [st]);

  const getRow = useCallback((i: number) => rows[i], [rows]);
  const onNeedRows = useCallback(
    (start: number, end: number) => {
      if (!st.resultId) return;
      const first = Math.floor(start / PAGE) * PAGE;
      for (let p = first; p <= end; p += PAGE) {
        if (inflight.current.has(p) || rows[p] !== undefined) continue;
        inflight.current.add(p);
        api
          .fetchRows(st.resultId, p, PAGE)
          .then((chunk) =>
            setRows((prev) => {
              const next = prev.slice();
              chunk.forEach((r, k) => (next[p + k] = r));
              return next;
            }),
          )
          .catch(() => undefined)
          .finally(() => inflight.current.delete(p));
      }
    },
    [st.resultId, rows],
  );

  return (
    <DataGrid
      ariaLabel="Query result"
      columns={(st.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName }))}
      rowCount={total}
      getRow={getRow}
      onNeedRows={onNeedRows}
    />
  );
}

export function ResultsPanel({ result, running, dialect }: { result: ScriptResult | null; running: boolean; dialect: Dialect }) {
  const [tab, setTab] = useState<number | "messages">("messages");
  const [exporting, setExporting] = useState<StatementResult | null>(null);
  const withRows = result?.statements.filter((s) => s.columns) ?? [];
  const mod = isMacPlatform() ? "⌘" : "Ctrl";

  useEffect(() => {
    if (!result) return;
    const firstError = result.statements.findIndex((s) => s.error);
    const lastRows = [...result.statements].reverse().find((s) => s.columns);
    setTab(firstError >= 0 || !lastRows ? "messages" : result.statements.indexOf(lastRows));
  }, [result]);

  if (!result) {
    return (
      <div className="results">
        <div className="empty">
          {running ? (
            <div className="spinner" aria-label="Running" />
          ) : (
            <span>
              <span className="kbd">{mod} ↵</span> to run the statement at the cursor or the selection, <span className="kbd">{mod} ⇧ ↵</span> to run everything.
            </span>
          )}
        </div>
      </div>
    );
  }

  const current = typeof tab === "number" ? result.statements[tab] : undefined;

  return (
    <div className="results">
      <div className="results-tabs" role="tablist" aria-label="Results">
        {result.statements.map((s, i) =>
          s.columns ? (
            <button key={i} role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>
              Result {withRows.length > 1 ? withRows.indexOf(s) + 1 : ""} ({formatCount(s.totalRows ?? 0)}
              {s.truncated ? "+" : ""})
            </button>
          ) : null,
        )}
        <button
          role="tab"
          aria-selected={tab === "messages"}
          className={result.statements.some((s) => s.error) ? "error" : undefined}
          onClick={() => setTab("messages")}
        >
          Messages
        </button>
      </div>
      {current?.columns ? (
        <>
          <ResultGrid st={current} />
          <div className="grid-footer">
            <span>
              {pluralize(current.totalRows ?? 0, "row")}
              {current.truncated ? " (row limit reached; refine the query or raise the limit in Settings)" : ""}
            </span>
            <span className="grow" />
            <span>{formatDuration(current.durationMs)}</span>
            {current.resultId && (
              <button className="btn btn-ghost" onClick={() => setExporting(current)}>
                <Icon name="download" size={14} /> Export
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="messages" role="log">
          {result.statements.length === 0 && <div className="hint">Nothing to run.</div>}
          {result.statements.map((s, i) => (
            <div className="entry" key={i}>
              {s.error ? (
                s.error.kind === "cancelled" ? (
                  <Icon name="block" size={16} color="var(--warning)" label="Cancelled" />
                ) : (
                  <Icon name="cancel" size={16} color="var(--danger)" label="Error" />
                )
              ) : (
                <Icon name="check_circle" size={16} color="var(--accent)" label="Success" />
              )}
              <div>
                <div>
                  {s.error
                    ? s.error.message
                    : s.columns
                      ? `${pluralize(s.totalRows ?? 0, "row")} returned`
                      : `${pluralize(s.rowsAffected ?? 0, "row")} affected`}
                </div>
                {s.error?.detail && <code>{s.error.detail}</code>}
                <code>{s.sql.length > 400 ? `${s.sql.slice(0, 400)}…` : s.sql}</code>
              </div>
              <span className="hint">{formatDuration(s.durationMs)}</span>
            </div>
          ))}
          {result.cancelled && <div className="hint">Execution was cancelled; remaining statements did not run.</div>}
        </div>
      )}
      {exporting && <ExportDialog source={{ kind: "result", statement: exporting, dialect }} onClose={() => setExporting(null)} />}
    </div>
  );
}
