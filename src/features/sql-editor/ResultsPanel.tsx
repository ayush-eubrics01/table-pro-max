import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { Cell, ColumnInfo, Dialect, ScriptResult, SessionInfo, StatementResult } from "../../types/backend";
import { api } from "../../lib/ipc";
import { formatCount, formatDuration, pluralize } from "../../lib/text";
import { DataGrid } from "../data-grid/DataGrid";
import { ExportDialog } from "../import-export/ExportDialog";
import { isMacPlatform } from "../../app/WindowControls";
import { ReviewChangesDialog } from "../data-browser/ReviewChangesDialog";
import { RowDetail } from "../data-browser/RowDetail";
import { notify, notifyError } from "../../stores/ui";
import { buildResultChangeSets, cellId, displayCell, readOnlyReason, setEdit, type ResultEdits } from "./resultEdits";

const PAGE = 1000;

/** Result rows for one statement, loading further pages from the backend on demand. */
function ResultGrid({
  st,
  editable,
  edits,
  applied,
  onEdit,
  onSelectRow,
}: {
  st: StatementResult;
  editable: boolean;
  edits: ResultEdits;
  applied: Record<string, string | null>;
  onEdit: (row: Cell[], col: number, value: string | null) => void;
  onSelectRow: (row: Cell[] | undefined) => void;
}) {
  const [rows, setRows] = useState<(Cell[] | undefined)[]>(() => st.rows ?? []);
  const inflight = useRef(new Set<number>());
  const total = st.totalRows ?? st.rows?.length ?? 0;

  useEffect(() => {
    setRows(st.rows ?? []);
    inflight.current.clear();
  }, [st]);

  // Rows keep the values as loaded (the originals); edits and committed values are laid over them.
  const getRow = useCallback(
    (i: number) => {
      const r = rows[i];
      return r && r.map((_, c) => displayCell(edits, applied, st, r, c));
    },
    [rows, edits, applied, st],
  );
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
      canEdit={(r, c) => editable && readOnlyReason(st, rows[r], c, applied) === null}
      onEdit={(r, c, v) => {
        const row = rows[r];
        if (row) onEdit(row, c, v);
      }}
      isEdited={(r, c) => {
        const row = rows[r];
        const id = row && cellId(st, row, c);
        return !!id && id in edits;
      }}
      cellTitle={(r, c) => (st.editing ? (readOnlyReason(st, rows[r], c, applied) ?? undefined) : undefined)}
      onSelectionChange={(sel) => onSelectRow(sel.active ? rows[sel.active.row] : undefined)}
    />
  );
}

export function ResultsPanel({
  result,
  running,
  dialect,
  session,
  onRunAgain,
  onDirtyChange,
}: {
  result: ScriptResult | null;
  running: boolean;
  dialect: Dialect;
  /** The query tab's session; editing results needs it. */
  session?: SessionInfo;
  onRunAgain?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<number | "messages">("messages");
  const [exporting, setExporting] = useState<StatementResult | null>(null);
  // Pending and committed result edits, per statement (result tab).
  const [edits, setEdits] = useState<Record<number, ResultEdits>>({});
  const [applied, setApplied] = useState<Record<number, Record<string, string | null>>>({});
  const [review, setReview] = useState<{ sql: string; statements: number; atomic: boolean } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedRow, setSelectedRow] = useState<Cell[] | undefined>();
  const nPending = Object.values(edits).reduce((n, e) => n + Object.keys(e).length, 0);

  // A new run replaces the results, and with them any edits.
  useEffect(() => {
    setEdits({});
    setApplied({});
    setReview(null);
    setSelectedRow(undefined);
  }, [result]);
  useEffect(() => onDirtyChange?.(nPending > 0), [nPending, onDirtyChange]);
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
  const ti = typeof tab === "number" ? tab : -1;
  const curEdits = edits[ti] ?? {};
  const curApplied = applied[ti] ?? {};
  const editable = !!session && !session.readOnly && !running;
  const nCur = Object.keys(curEdits).length;
  // When nothing in the result can be edited, say why (unless it is only computed columns).
  const hint =
    current?.editing && current.editing.tables.length === 0 ? current.editing.readOnly.find((r) => r.reason !== "Computed column")?.reason : undefined;

  const onEdit = (row: Cell[], col: number, value: string | null) => {
    if (!current) return;
    setEdits((all) => ({ ...all, [ti]: setEdit(all[ti] ?? {}, current, row, col, value, applied[ti] ?? {}) }));
  };

  const openReview = async () => {
    if (!current || !session) return;
    try {
      const p = await api.previewChangeSets(session.sessionId, buildResultChangeSets(current, curEdits));
      setReview({ sql: p.sql, statements: p.statementCount, atomic: p.atomic });
    } catch (e) {
      notifyError(e, "Changes cannot be committed");
    }
  };

  const commit = async () => {
    if (!current || !session) return;
    await api.applyChangeSets(session.sessionId, buildResultChangeSets(current, curEdits));
    const now: Record<string, string | null> = { ...curApplied };
    for (const [id, e] of Object.entries(curEdits)) now[id] = e.value;
    setApplied((all) => ({ ...all, [ti]: now }));
    setEdits((all) => ({ ...all, [ti]: {} }));
    setReview(null);
    notify(`Committed ${pluralize(nCur, "change")}`, "success");
  };

  const detailColumns: ColumnInfo[] = (current?.columns ?? []).map((c) => ({
    name: c.name,
    dataType: c.typeName,
    // Unknown for query results; false keeps the inspector from labelling every field "nullable".
    nullable: false,
    default: null,
    primaryKey: null,
    autoIncrement: false,
    comment: null,
  }));

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
          {hint && <div className="hint result-hint">{hint}</div>}
          {Object.keys(curApplied).length > 0 && (
            <div className="notice result-note">
              Shows values from when the query ran, plus your edits.{" "}
              {onRunAgain && (
                <button className="btn btn-link" onClick={onRunAgain}>
                  Run again
                </button>
              )}
            </div>
          )}
          <div className="split-h" style={{ minHeight: 0, flex: 1 }}>
            <div className="grid-area" style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <ResultGrid st={current} editable={editable} edits={curEdits} applied={curApplied} onEdit={onEdit} onSelectRow={setSelectedRow} />
              {nCur > 0 && (
                <div className="commit-bar" role="region" aria-label="Pending changes">
                  <span className="dot" />
                  <span role="status">{pluralize(nCur, "pending change")}</span>
                  <button className="btn btn-ghost" onClick={() => setEdits((all) => ({ ...all, [ti]: {} }))}>
                    <Icon name="undo" size={14} /> Discard
                  </button>
                  <button className="btn btn-primary" onClick={() => void openReview()} disabled={!editable}>
                    Review and commit
                  </button>
                </div>
              )}
            </div>
            {detailOpen && (
              <RowDetail
                columns={detailColumns}
                row={selectedRow?.map((_, c) => displayCell(curEdits, curApplied, current, selectedRow, c))}
                editable={(c) => editable && readOnlyReason(current, selectedRow, c, curApplied) === null}
                readOnlyReason={(c) => (selectedRow ? readOnlyReason(current, selectedRow, c, curApplied) : null)}
                onEdit={(c, v) => selectedRow && onEdit(selectedRow, c, v)}
                heading="Selected row"
                subheading={current.editing?.tables.map((t) => t.table).join(", ") || "Query result"}
                isEdited={(c) => {
                  const id = selectedRow && cellId(current, selectedRow, c);
                  return !!id && id in curEdits;
                }}
                onClose={() => setDetailOpen(false)}
              />
            )}
          </div>
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
            <button
              className="btn btn-ghost btn-icon"
              aria-pressed={detailOpen}
              aria-label="Toggle row details"
              title="Row details"
              onClick={() => setDetailOpen(!detailOpen)}
            >
              <Icon name="right_panel_open" size={14} />
            </button>
          </div>
          {review && session && (
            <ReviewChangesDialog
              session={session}
              title="Review changes"
              sql={review.sql}
              atomic={review.atomic}
              statements={review.statements}
              summary={`${pluralize(nCur, "change")} to ${(current.editing?.tables ?? [])
                .filter((_, i) => Object.values(curEdits).some((e) => e.table === i))
                .map((t) => t.table)
                .join(", ")}`}
              commitLabel="Commit changes"
              cancelLabel="Keep editing"
              onCommit={commit}
              onClose={() => setReview(null)}
            />
          )}
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
