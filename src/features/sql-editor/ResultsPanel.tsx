import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { committedMessage, useRestore } from "../../stores/restore";
import type { Cell, ColumnInfo, Dialect, ScriptResult, SessionInfo, StatementResult, TableStructure } from "../../types/backend";
import { api } from "../../lib/ipc";
import { formatCount, formatDuration, pluralize } from "../../lib/text";
import { DataGrid, type CellPos } from "../data-grid/DataGrid";
import { firstLink, linkFilter, resultLinks, type FkLink } from "../data-browser/fkLinks";
import type { GroupNode } from "../filters/filterModel";
import { ValueEditor } from "../value-editor/ValueEditor";
import { useSettings } from "../../stores/settings";
import { isJsonType, isLargeText, isPartial } from "../../lib/cells";
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
  valueAt,
  onValueAt,
  links,
  onOpenTable,
}: {
  st: StatementResult;
  editable: boolean;
  edits: ResultEdits;
  applied: Record<string, string | null>;
  onEdit: (row: Cell[], col: number, value: string | null) => void;
  onSelectRow: (row: Cell[] | undefined, index: number | null) => void;
  /** The cell open in the value editor (owned by the panel so the inspector can open it too). */
  valueAt: { row: number; col: number } | null;
  onValueAt: (at: { row: number; col: number } | null) => void;
  /** Foreign keys per result column, traced through column origins. */
  links: FkLink[][];
  onOpenTable?: (schema: string, table: string, filter: GroupNode) => void;
}) {
  const [rows, setRows] = useState<(Cell[] | undefined)[]>(() => st.rows ?? []);
  const inflight = useRef(new Set<number>());
  const largeValueChars = useSettings((s) => s.settings["grid.largeValueChars"]);
  // The row of the cell in the value editor, with the full value (for keys and the original).
  const setValueAt = onValueAt;
  const fullRow = useRef<Cell[] | null>(null);
  const total = st.totalRows ?? st.rows?.length ?? 0;

  useEffect(() => {
    setRows(st.rows ?? []);
    inflight.current.clear();
  }, [st]);

  /** The full value of a cell: previews are read from the result store (no new query). */
  const fullValue = async (row: number, col: number): Promise<Cell> => {
    const c = rows[row]?.[col] ?? null;
    if (c === null || !isPartial(c) || !st.resultId) return c;
    const full = await api.resultValue(st.resultId, row, col);
    setRows((prev) => {
      const next = prev.slice();
      const r = next[row];
      if (r) next[row] = r.map((v, i) => (i === col ? full : v));
      return next;
    });
    return full;
  };

  const columnType = (col: number) => st.columns?.[col]?.typeName ?? "";

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

  const valueReason =
    valueAt === null ? null : !editable ? "Query results can't be edited here" : readOnlyReason(st, rows[valueAt.row], valueAt.col, applied);

  return (
    <>
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
      onSelectionChange={(sel) => onSelectRow(sel.active ? rows[sel.active.row] : undefined, sel.active ? sel.active.row : null)}
      largeValueChars={largeValueChars}
      onOpenCell={(r, c, how) => {
        const cell = rows[r]?.[c];
        if (how !== "open" || cell === undefined) return false;
        if (isPartial(cell) || isJsonType(columnType(c)) || isLargeText(cell, largeValueChars)) {
          setValueAt({ row: r, col: c });
          return true;
        }
        return false;
      }}
      loadFull={(cells: CellPos[]) => Promise.all(cells.map((p) => fullValue(p.row, p.col)))}
      cellLink={(r, c) => {
        if (!onOpenTable) return null;
        const hit = firstLink(links, c, () => getRow(r));
        return hit && { label: hit.label, open: () => onOpenTable(hit.link.fk.refSchema, hit.link.fk.refTable, hit.filter) };
      }}
      contextItems={(sel) => {
        if (!sel.active || !onOpenTable) return [];
        const cells = getRow(sel.active.row);
        const ls = links[sel.active.col] ?? [];
        return ls.flatMap((link) => {
          const filter = cells ? linkFilter(link, cells) : null;
          return filter
            ? [{ label: ls.length > 1 ? `Open referenced row in ${link.fk.refTable}` : "Open referenced row", onSelect: () => onOpenTable(link.fk.refSchema, link.fk.refTable, filter) }]
            : [];
        });
      }}
    />
    {valueAt && st.columns?.[valueAt.col] && (
      <ValueEditor
        title={`Query result · ${st.columns[valueAt.col]!.name} · row ${valueAt.row + 1}`}
        typeName={columnType(valueAt.col)}
        mode={isJsonType(columnType(valueAt.col)) ? "json" : "text"}
        load={async () => {
          const full = await fullValue(valueAt.row, valueAt.col);
          // The row as loaded (with the full value) stays the edit's original; the editor shows
          // what the grid shows: a pending or committed edit takes precedence.
          fullRow.current = (rows[valueAt.row] ?? []).map((v, i) => (i === valueAt.col ? full : v));
          return displayCell(edits, applied, st, fullRow.current, valueAt.col);
        }}
        readOnlyReason={valueReason}
        nullable
        onSave={(v) => {
          if (fullRow.current) onEdit(fullRow.current, valueAt.col, v);
          setValueAt(null);
        }}
        onClose={() => setValueAt(null)}
      />
    )}
    </>
  );
}

export function ResultsPanel({
  result,
  running,
  dialect,
  session,
  onRunAgain,
  onDirtyChange,
  onOpenTable,
}: {
  result: ScriptResult | null;
  running: boolean;
  dialect: Dialect;
  /** The query tab's session; editing results needs it. */
  session?: SessionInfo;
  onRunAgain?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Opens a table in a new tab filtered to one row (following a foreign key). */
  onOpenTable?: (schema: string, table: string, filter: GroupNode) => void;
}) {
  const [tab, setTab] = useState<number | "messages">("messages");
  const [exporting, setExporting] = useState<StatementResult | null>(null);
  // Pending and committed result edits, per statement (result tab).
  const [edits, setEdits] = useState<Record<number, ResultEdits>>({});
  const [applied, setApplied] = useState<Record<number, Record<string, string | null>>>({});
  const [review, setReview] = useState<{ sql: string; statements: number; atomic: boolean } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedRow, setSelectedRow] = useState<Cell[] | undefined>();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [valueAt, setValueAt] = useState<{ row: number; col: number } | null>(null);
  const largeValueChars = useSettings((s) => s.settings["grid.largeValueChars"]);
  const nPending = Object.values(edits).reduce((n, e) => n + Object.keys(e).length, 0);

  // A new run replaces the results, and with them any edits.
  useEffect(() => {
    setEdits({});
    setApplied({});
    setReview(null);
    setSelectedRow(undefined);
    setSelectedIndex(null);
    setValueAt(null);
  }, [result]);
  useEffect(() => onDirtyChange?.(nPending > 0), [nPending, onDirtyChange]);
  // The value editor belongs to one statement's grid; switching result tabs closes it.
  useEffect(() => setValueAt(null), [tab]);

  // Foreign keys of the tables the current result's columns come from (structures are cached
  // by the engine), so cells traced to a foreign-key column can link to the referenced row.
  const shown = result && typeof tab === "number" ? result.statements[tab] : undefined;
  const [structures, setStructures] = useState<TableStructure[]>([]);
  useEffect(() => {
    setStructures([]);
    if (!shown?.columns || !session || !onOpenTable) return;
    const tables = new Map<string, { schema: string; table: string }>();
    for (const c of shown.columns) if (c.origin) tables.set(`${c.origin.schema}.${c.origin.table}`, { schema: c.origin.schema, table: c.origin.table });
    if (tables.size === 0) return;
    let alive = true;
    void Promise.all([...tables.values()].map((t) => api.tableStructure(session.sessionId, t.schema, t.table).catch(() => null))).then(
      (all) => alive && setStructures(all.filter((s): s is TableStructure => s !== null)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per statement shown
  }, [shown, session?.sessionId]);
  const fkByColumn = useMemo(() => (shown?.columns ? resultLinks(shown.columns, structures) : []), [shown, structures]);
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
    const r = await api.applyChangeSets(session.sessionId, buildResultChangeSets(current, curEdits));
    useRestore.getState().bump();
    const now: Record<string, string | null> = { ...curApplied };
    for (const [id, e] of Object.entries(curEdits)) now[id] = e.value;
    setApplied((all) => ({ ...all, [ti]: now }));
    setEdits((all) => ({ ...all, [ti]: {} }));
    setReview(null);
    const missed = r.restore.some((n) => n.reason);
    notify(committedMessage(`Committed ${pluralize(nCur, "change")}`, r.restore), missed ? "info" : "success");
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
              <ResultGrid
                st={current}
                editable={editable}
                edits={curEdits}
                applied={curApplied}
                onEdit={onEdit}
                onSelectRow={(r, i) => {
                  setSelectedRow(r);
                  setSelectedIndex(i);
                }}
                valueAt={valueAt}
                onValueAt={setValueAt}
                links={fkByColumn}
                onOpenTable={onOpenTable}
              />
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
                onOpenEditor={(c) => selectedIndex !== null && setValueAt({ row: selectedIndex, col: c })}
                largeValueChars={largeValueChars}
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
                {s.restore?.pointId && (
                  <div className="restore-note">
                    <Icon name="history" size={14} /> Restore point saved
                    <button className="btn-link" aria-label="Open restore points" onClick={() => useRestore.getState().setOpen(true)}>
                      Open
                    </button>
                  </div>
                )}
                {s.restore?.reason && (
                  <div className="restore-note warn">
                    <Icon name="warning" size={14} /> {`No restore point: ${s.restore.reason}`}
                  </div>
                )}
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
