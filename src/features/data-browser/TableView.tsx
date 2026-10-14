import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { BrowseResult, Cell, SessionInfo, SortSpec, TableStructure } from "../../types/backend";
import { api, toError, type BackendError } from "../../lib/ipc";
import { cellCopy, isBinary, toTsv } from "../../lib/cells";
import { formatCount, formatDuration, pluralize, uid } from "../../lib/text";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { useSettings } from "../../stores/settings";
import { DataGrid, type GridHandle, type GridSelection } from "../data-grid/DataGrid";
import { FilterBuilder } from "../filters/FilterBuilder";
import { FilterChips } from "../filters/FilterChips";
import { countConditions, emptyGroup, newCondition, type GroupNode } from "../filters/filterModel";
import {
  EMPTY_PENDING,
  buildChangeSet,
  displayRow,
  editCell,
  hasPending,
  newInsertedRow,
  pendingCount,
  toggleDelete,
  type Pending,
} from "./pending";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { RowDetail } from "./RowDetail";
import { StructureView } from "../schema-browser/StructureView";
import { DefinitionView } from "../schema-browser/DefinitionView";
import { ExportDialog, type ExportSource } from "../import-export/ExportDialog";
import { ImportDialog } from "../import-export/ImportDialog";

interface Props {
  session: SessionInfo;
  schema: string;
  table: string;
  onReconnect: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

type View = "data" | "structure" | "definition";

export function TableView({ session, schema, table, onReconnect, onDirtyChange }: Props) {
  const pageSizeSetting = useSettings((s) => s.settings["grid.pageSize"]);
  const checkConflicts = useSettings((s) => s.settings["grid.checkConflicts"]);
  const [view, setView] = useState<View>("data");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [page, setPage] = useState<BrowseResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(pageSizeSetting);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filter, setFilter] = useState<GroupNode>(emptyGroup());
  const [draftFilter, setDraftFilter] = useState<GroupNode>(emptyGroup());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(EMPTY_PENDING);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selection, setSelection] = useState<GridSelection>({ rows: [], cols: [], active: null });
  const [detailOpen, setDetailOpen] = useState(false);
  const [review, setReview] = useState<{ sql: string; atomic: boolean } | null>(null);
  const [exportSource, setExportSource] = useState<ExportSource | null>(null);
  const [importing, setImporting] = useState(false);
  const gridRef = useRef<GridHandle>(null);
  const loadSeq = useRef(0);

  const rows: Cell[][] = useMemo(() => page?.rows ?? [], [page]);
  const isTable = structure?.kind === "table";
  const hasPk = !!structure?.columns.some((c) => c.primaryKey !== null);
  const readOnlyReason = session.readOnly
    ? "This connection is read-only"
    : !isTable
      ? "Views are read-only"
      : !hasPk
        ? "No primary key: existing rows cannot be edited"
        : null;
  const canInsert = !session.readOnly && isTable;

  useEffect(() => onDirtyChange?.(hasPending(pending)), [pending, onDirtyChange]);

  useEffect(() => {
    let alive = true;
    api
      .tableStructure(session.sessionId, schema, table)
      .then((s) => alive && setStructure(s))
      .catch((e) => alive && setError(toError(e)));
    return () => {
      alive = false;
    };
  }, [session.sessionId, schema, table]);

  const load = useCallback(
    async (opts: { offset?: number; sort?: SortSpec[]; filter?: GroupNode; pageSize?: number } = {}) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      setError(null);
      try {
        const f = opts.filter ?? filter;
        const result = await api.browseTable(session.sessionId, {
          schema,
          table,
          filter: countConditions(f) > 0 ? f : null,
          sort: opts.sort ?? sort,
          limit: opts.pageSize ?? pageSize,
          offset: opts.offset ?? offset,
        });
        if (seq !== loadSeq.current) return;
        setPage(result);
        setPending(EMPTY_PENDING);
      } catch (e) {
        if (seq === loadSeq.current) setError(toError(e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [session.sessionId, schema, table, filter, sort, pageSize, offset],
  );

  useEffect(() => {
    if (structure) void load();
    // Only when the structure first arrives; later loads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  /** Runs `action` after confirming that pending edits may be discarded. */
  const guard = async (action: () => void) => {
    if (hasPending(pending)) {
      const ok = await confirmAction({
        title: "Discard pending changes?",
        body: `${pluralize(pendingCount(pending), "change")} have not been committed and will be lost.`,
        confirmLabel: "Discard changes",
        danger: true,
      });
      if (!ok) return;
    }
    action();
  };

  const go = (newOffset: number) =>
    guard(() => {
      setOffset(newOffset);
      void load({ offset: newOffset });
    });

  const onSort = (column: string, descending: boolean | null) =>
    guard(() => {
      const next = descending === null ? [] : [{ column, descending }];
      setSort(next);
      setOffset(0);
      void load({ sort: next, offset: 0 });
    });

  const applyFilter = (g: GroupNode) =>
    guard(() => {
      setFilter(g);
      setOffset(0);
      setTotal(null);
      void load({ filter: g, offset: 0 });
    });

  const countRows = async () => {
    try {
      setTotal(await api.countRows(session.sessionId, schema, table, countConditions(filter) > 0 ? filter : null));
    } catch (e) {
      notifyError(e, "Count failed");
    }
  };

  const rowCount = rows.length + pending.inserted.length;
  const getRow = useCallback((i: number) => displayRow(pending, rows, i), [pending, rows]);
  const columns = structure?.columns ?? [];

  const canEdit = useCallback(
    (row: number, col: number) => {
      if (session.readOnly || !isTable) return false;
      if (row >= rows.length) return true;
      if (!hasPk || pending.deleted.includes(row)) return false;
      const v = rows[row]?.[col];
      return v !== undefined && !isBinary(v);
    },
    [session.readOnly, isTable, hasPk, rows, pending.deleted],
  );

  const onEdit = (row: number, col: number, value: string | null) => setPending((p) => editCell(p, rows, row, col, value));

  const addRow = (copyFrom?: Cell[]) => {
    if (!structure) return;
    setPending((p) => ({ ...p, inserted: [...p.inserted, newInsertedRow(structure.columns, uid(), copyFrom)] }));
    const newIndex = rows.length + pending.inserted.length;
    setTimeout(() => gridRef.current?.selectCell({ row: newIndex, col: 0 }), 0);
  };

  const deleteSelected = (sel: GridSelection = selection) => {
    if (sel.rows.length === 0 || session.readOnly || !isTable) return;
    const existing = sel.rows.filter((r) => r < rows.length);
    if (existing.length > 0 && !hasPk) {
      notify("Rows without a primary key cannot be deleted from the grid.", "error");
      return;
    }
    setPending((p) => toggleDelete(p, rows, sel.rows));
  };

  const setNull = (sel: GridSelection) => {
    let p = pending;
    for (const r of sel.rows) for (const c of sel.cols) if (canEdit(r, c)) p = editCell(p, rows, r, c, null);
    setPending(p);
  };

  const openReview = async () => {
    if (!structure) return;
    try {
      const set = buildChangeSet(pending, rows, structure.columns, schema, table, checkConflicts);
      const preview = await api.previewChanges(session.sessionId, set);
      setReview({ sql: preview.sql, atomic: preview.atomic });
    } catch (e) {
      notifyError(e, "Changes cannot be committed");
    }
  };

  const commit = async () => {
    if (!structure) return;
    const set = buildChangeSet(pending, rows, structure.columns, schema, table, checkConflicts);
    const counts = await api.applyChanges(session.sessionId, set);
    setReview(null);
    notify(`Committed ${pluralize(counts.length, "change")}`, "success");
    setTotal(null);
    await load();
  };

  const contextItems = (sel: GridSelection) => {
    const first = sel.rows[0];
    return [
      {
        label: "Copy as SQL IN list",
        onSelect: () => {
          const vals = sel.rows.flatMap((r) => sel.cols.map((c) => getRow(r)?.[c] ?? null));
          void navigator.clipboard.writeText(vals.map((v) => (v === null ? "NULL" : `'${cellCopy(v).replace(/'/g, "''")}'`)).join(", "));
        },
      },
      {
        label: "Export selected rows…",
        disabled: sel.rows.length === 0,
        onSelect: () =>
          setExportSource({
            kind: "rows",
            dialect: session.dialect,
            label: `${pluralize(sel.rows.length, "selected row")} from ${schema}.${table}`,
            columns: columns.map((c) => ({ name: c.name, typeName: c.dataType })),
            rows: sel.rows.map((r) => getRow(r) ?? []),
          }),
      },
      {
        label: "Copy rows as TSV",
        onSelect: () =>
          void navigator.clipboard.writeText(
            toTsv(
              sel.rows.map((r) => getRow(r) ?? []),
              columns.map((c) => c.name),
            ),
          ),
      },
      "separator" as const,
      { label: "Set to NULL", onSelect: () => setNull(sel), disabled: !sel.rows.some((r) => sel.cols.some((c) => canEdit(r, c))) },
      { label: "Duplicate row", onSelect: () => first !== undefined && addRow(getRow(first)), disabled: !canInsert || first === undefined },
      {
        label: sel.rows.every((r) => pending.deleted.includes(r)) && sel.rows.length > 0 ? "Restore rows" : "Delete rows",
        onSelect: () => deleteSelected(sel),
        danger: true,
        disabled: session.readOnly || !isTable,
      },
    ];
  };

  const activeRow = selection.active ? getRow(selection.active.row) : undefined;
  const nPending = pendingCount(pending);
  const firstShown = rows.length === 0 ? 0 : offset + 1;
  const lastShown = offset + rows.length;

  return (
    <div className="tab-panel">
      <div className="toolbar" role="toolbar" aria-label={`${table} tools`}>
        <div className="segmented" role="group" aria-label="View">
          {(["data", "structure", "definition"] as View[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "data" ? "Data" : v === "structure" ? "Structure" : "Definition"}
            </button>
          ))}
        </div>
        {view === "data" && (
          <>
            <span className="sep" />
            <button
              className="btn btn-ghost"
              aria-pressed={filtersOpen}
              onClick={() => {
                if (!filtersOpen && draftFilter.children.length === 0 && columns[0]) {
                  setDraftFilter({ ...draftFilter, children: [newCondition(columns[0])] });
                }
                setFiltersOpen(!filtersOpen);
              }}
              title="Filter rows (Ctrl+F)"
            >
              <Icon name="filter_list" size={14} /> Filter{countConditions(filter) > 0 ? ` (${countConditions(filter)})` : ""}
            </button>
            <button className="btn btn-ghost btn-icon" onClick={() => guard(() => void load())} aria-label="Reload" title="Reload (F5)">
              <Icon name="refresh" size={14} className={loading ? "spin" : undefined} />
            </button>
            {canInsert && (
              <>
                <span className="sep" />
                <button className="btn btn-ghost" onClick={() => addRow()} title="Insert row">
                  <Icon name="add" size={14} /> Row
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Duplicate row"
                  title="Duplicate selected row"
                  disabled={selection.rows.length === 0}
                  onClick={() => selection.rows[0] !== undefined && addRow(getRow(selection.rows[0]))}
                >
                  <Icon name="content_copy" size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete selected rows"
                  title="Delete selected rows (Delete)"
                  disabled={selection.rows.length === 0}
                  onClick={() => deleteSelected()}
                >
                  <Icon name="delete" size={14} />
                </button>
              </>
            )}
            <span className="sep" />
            <button
              className="btn btn-ghost btn-icon"
              aria-label="Export"
              title="Export rows (current filter and sort)"
              onClick={() =>
                setExportSource({
                  kind: "table",
                  sessionId: session.sessionId,
                  dialect: session.dialect,
                  filtered: countConditions(filter) > 0 || sort.length > 0,
                  request: { schema, table, filter: countConditions(filter) > 0 ? filter : null, sort, limit: 1, offset: 0 },
                })
              }
            >
              <Icon name="download" size={14} />
            </button>
            {canInsert && (
              <button className="btn btn-ghost btn-icon" aria-label="Import" title="Import rows from a file" onClick={() => setImporting(true)}>
                <Icon name="upload" size={14} />
              </button>
            )}
            <span className="grow" />
            <span className={`access-pill ${readOnlyReason ? "ro" : ""}`} title={readOnlyReason ?? "Edits stay pending until you review and commit them"}>
              <Icon name={readOnlyReason ? "lock" : "edit"} size={13} />
              {readOnlyReason ? "Read-only" : "Writable"}
            </span>
            <button
              className="btn btn-ghost btn-icon"
              aria-pressed={detailOpen}
              aria-label="Toggle row details"
              title="Row details"
              onClick={() => setDetailOpen(!detailOpen)}
            >
              <Icon name="right_panel_open" size={14} />
            </button>
          </>
        )}
      </div>

      {view === "structure" && structure && (
        <StructureView
          session={session}
          structure={structure}
          onChanged={async () => {
            const s = await api.tableStructure(session.sessionId, schema, table, true);
            setStructure(s);
          }}
        />
      )}
      {view === "definition" && structure && (
        <DefinitionView session={session} schema={schema} name={table} kind={structure.kind} />
      )}

      {view === "data" && (
        <>
          {!filtersOpen && (
            <FilterChips
              filter={filter}
              onEdit={() => {
                setDraftFilter(filter);
                setFiltersOpen(true);
              }}
            />
          )}
          {filtersOpen && structure && (
            <FilterBuilder
              columns={structure.columns}
              value={draftFilter}
              onChange={setDraftFilter}
              onApply={applyFilter}
              connectionId={session.connectionId}
              schema={schema}
              table={table}
            />
          )}
          {error && (
            <div className="notice notice-error" role="alert" style={{ margin: 8 }}>
              {error.message}
              {error.detail && <pre>{error.detail}</pre>}
              {(error.kind === "network" || error.code === "broken") && (
                <div style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => onReconnect().then(() => load())}>
                    Reconnect
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="split-h" style={{ minHeight: 0 }}>
            <div className="grid-area" style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              {structure && page && (
                <DataGrid
                  ref={gridRef}
                  ariaLabel={`Rows of ${table}`}
                  columns={structure.columns.map((c) => ({ name: c.name, typeName: c.dataType, primaryKey: c.primaryKey !== null, foreignKey: structure.foreignKeys.some((f) => f.columns.includes(c.name)) }))}
                  rowCount={rowCount}
                  getRow={getRow}
                  rowState={(i) => (i >= rows.length ? "inserted" : pending.deleted.includes(i) ? "deleted" : undefined)}
                  isEdited={(r, c) => r < rows.length && pending.edits[r]?.[c] !== undefined}
                  canEdit={canEdit}
                  onEdit={onEdit}
                  sort={sort}
                  onSort={onSort}
                  onSelectionChange={setSelection}
                  contextItems={contextItems}
                  onDeleteKey={(sel) => deleteSelected(sel)}
                  rowNumberOffset={offset}
                  bottomInset={nPending > 0 ? 56 : 0}
                />
              )}
              {nPending > 0 && (
                <div className="commit-bar" role="region" aria-label="Pending changes">
                  <span className="dot" />
                  <span role="status">{pluralize(nPending, "pending change")}</span>
                  <button className="btn btn-ghost" onClick={() => setPending(EMPTY_PENDING)}>
                    <Icon name="undo" size={14} /> Discard
                  </button>
                  <button className="btn btn-primary" onClick={openReview}>
                    Review and commit
                  </button>
                </div>
              )}
              {!page && !error && <div className="empty">{loading ? <div className="spinner" /> : null}</div>}
              <div className="grid-footer">
                <button className="btn btn-ghost btn-icon" aria-label="Previous page" disabled={offset === 0 || loading} onClick={() => go(Math.max(0, offset - pageSize))}>
                  <Icon name="chevron_left" size={14} />
                </button>
                <span>
                  {rows.length === 0 ? "No rows" : `Rows ${formatCount(firstShown)}–${formatCount(lastShown)}`}
                  {total !== null ? ` of ${formatCount(total)}` : ""}
                </span>
                <button className="btn btn-ghost btn-icon" aria-label="Next page" disabled={!page?.hasMore || loading} onClick={() => go(offset + pageSize)}>
                  <Icon name="chevron_right" size={14} />
                </button>
                <select
                  className="select"
                  aria-label="Rows per page"
                  value={pageSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    guard(() => {
                      setPageSize(n);
                      setOffset(0);
                      void load({ pageSize: n, offset: 0 });
                    });
                  }}
                >
                  {[100, 300, 500, 1000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n} per page
                    </option>
                  ))}
                </select>
                <button className="btn btn-link" onClick={countRows}>
                  Count rows
                </button>
                <span className="grow" />
                {page && <span title={page.sql}>{formatDuration(page.durationMs)}</span>}
              </div>
            </div>
            {detailOpen && structure && (
              <RowDetail
                columns={structure.columns}
                row={activeRow}
                editable={(c) => selection.active !== null && canEdit(selection.active.row, c)}
                onEdit={(c, v) => selection.active && onEdit(selection.active.row, c, v)}
              />
            )}
          </div>
        </>
      )}

      {exportSource && <ExportDialog source={exportSource} onClose={() => setExportSource(null)} />}
      {importing && (
        <ImportDialog
          session={session}
          schema={schema}
          tables={[{ schema, name: table, kind: "table" }]}
          initialTable={table}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            setTotal(null);
            void load();
          }}
        />
      )}
      {review && (
        <ReviewChangesDialog
          session={session}
          title="Review changes"
          sql={review.sql}
          atomic={review.atomic}
          summary={`${pluralize(nPending, "change")} to ${schema}.${table}`}
          commitLabel="Commit changes"
          onCommit={commit}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}

