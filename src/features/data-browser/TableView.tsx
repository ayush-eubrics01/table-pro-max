import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { BrowseResult, Cell, ColumnFetch, FetchMode, SessionInfo, SortSpec, TableStructure } from "../../types/backend";
import { api, toError, type BackendError } from "../../lib/ipc";
import { cellCopy, cellParam, isBinary, isJsonType, isLargeText, isNotLoaded, toTsv } from "../../lib/cells";
import { formatCount, formatDuration, pluralize, uid } from "../../lib/text";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { useSettings } from "../../stores/settings";
import { DataGrid, type CellPos, type GridHandle, type GridSelection } from "../data-grid/DataGrid";
import { ValueEditor } from "../value-editor/ValueEditor";
import { linkFilter, linkLabel, tableLinks } from "./fkLinks";
import type { MenuEntry } from "../../components/Menu";
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
  /** Opens SQL (e.g. the definition) in a new query tab without running it. */
  onOpenSql?: (sql: string, title: string) => void;
  /** The filter this tab starts with (a followed reference). */
  initialFilter?: GroupNode;
  /** Opens a table in a new tab filtered to one row (following a foreign key). */
  onOpenTable?: (schema: string, table: string, filter: GroupNode) => void;
}

type View = "data" | "structure" | "definition";

/** Keys per fetch_column call: well under the backend's 1,000 and SQLite's expression depth. */
const FETCH_CHUNK = 200;

export function TableView({ session, schema, table, onReconnect, onDirtyChange, onOpenSql, initialFilter, onOpenTable }: Props) {
  const pageSizeSetting = useSettings((s) => s.settings["grid.pageSize"]);
  const checkConflicts = useSettings((s) => s.settings["grid.checkConflicts"]);
  const largeValueChars = useSettings((s) => s.settings["grid.largeValueChars"]);
  // Per-column load/defer choices (column names only); null until read.
  const [overrides, setOverrides] = useState<ColumnFetch[] | null>(null);
  const [loadingCells, setLoadingCells] = useState<Set<string>>(new Set());
  const [editorAt, setEditorAt] = useState<{ row: number; col: number } | null>(null);
  const inflight = useRef(new Map<string, Promise<Cell | undefined>>());
  const [view, setView] = useState<View>("data");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [page, setPage] = useState<BrowseResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(pageSizeSetting);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filter, setFilter] = useState<GroupNode>(() => initialFilter ?? emptyGroup());
  const [draftFilter, setDraftFilter] = useState<GroupNode>(() => initialFilter ?? emptyGroup());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(EMPTY_PENDING);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selection, setSelection] = useState<GridSelection>({ rows: [], cols: [], active: null });
  const [detailOpen, setDetailOpen] = useState(false);
  const [review, setReview] = useState<{ sql: string; atomic: boolean; statements: number } | null>(null);
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
  // A table without a primary key still takes new rows; only existing rows are locked.
  const access = !canInsert ? "Read-only" : !hasPk ? "Insert only" : "Writable";

  useEffect(() => onDirtyChange?.(hasPending(pending)), [pending, onDirtyChange]);

  useEffect(() => {
    let alive = true;
    api
      .tableStructure(session.sessionId, schema, table)
      .then((s) => alive && setStructure(s))
      .catch((e) => alive && setError(toError(e)));
    api
      .listColumnFetch(session.connectionId, schema, table)
      .then((o) => alive && setOverrides(o ?? []))
      .catch(() => alive && setOverrides([]));
    return () => {
      alive = false;
    };
  }, [session.sessionId, session.connectionId, schema, table]);

  const load = useCallback(
    async (opts: { offset?: number; sort?: SortSpec[]; filter?: GroupNode; pageSize?: number } = {}) => {
      const seq = ++loadSeq.current;
      // Fetches started for the previous page must not land in this one (see putCells).
      inflight.current.clear();
      setLoadingCells(new Set());
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
          // Large columns stay in the database until a cell asks for them.
          lazy: true,
          loadColumns: (overrides ?? []).filter((o) => o.mode === "load").map((o) => o.column),
          deferColumns: (overrides ?? []).filter((o) => o.mode === "defer").map((o) => o.column),
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
    [session.sessionId, schema, table, filter, sort, pageSize, offset, overrides],
  );

  useEffect(() => {
    if (structure && overrides !== null) void load();
    // When the structure and the column choices arrive, and again when a choice changes;
    // other loads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, overrides]);

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

  /** Whether the row's values may change at all (ignoring what a given cell holds). */
  const canEditRow = useCallback(
    (row: number) => {
      if (session.readOnly || !isTable) return false;
      if (row >= rows.length) return true;
      return hasPk && !pending.deleted.includes(row);
    },
    [session.readOnly, isTable, hasPk, rows.length, pending.deleted],
  );

  const canEdit = useCallback(
    (row: number, col: number) => {
      if (!canEditRow(row)) return false;
      if (row >= rows.length) return true;
      const v = rows[row]?.[col];
      // A Not loaded cell becomes editable once its value is loaded.
      return v !== undefined && !isBinary(v) && !isNotLoaded(v);
    },
    [canEditRow, rows],
  );

  const onEdit = (row: number, col: number, value: string | null) => setPending((p) => editCell(p, rows, row, col, value));

  // ---- large values on demand ------------------------------------------------------------

  const deferredCols = useMemo(() => new Set((page?.columns ?? []).filter((c) => c.deferred).map((c) => c.name)), [page]);

  /** The primary key of a loaded row, as fetch parameters. */
  const keyOf = useCallback(
    (row: number) =>
      (structure?.columns ?? [])
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.primaryKey !== null)
        .sort((a, b) => (a.c.primaryKey ?? 0) - (b.c.primaryKey ?? 0))
        .map(({ c, i }) => ({ column: c.name, value: cellParam(rows[row]?.[i] ?? null) ?? null })),
    [structure, rows],
  );

  /**
   * Puts fetched values into the page: the page is the cache, and any reload clears it. `seq` is
   * the load the fetch started under; a value for an older page is dropped (rows are by index).
   */
  const putCells = (updates: { row: number; col: number; value: Cell }[], seq: number) =>
    setPage((p) => {
      if (!p || updates.length === 0 || seq !== loadSeq.current) return p;
      const next = p.rows.map((r) => r.slice());
      for (const u of updates) if (next[u.row]) next[u.row]![u.col] = u.value;
      return { ...p, rows: next };
    });

  const loadCell = (row: number, col: number): Promise<Cell | undefined> => {
    const k = `${row}:${col}`;
    const existing = inflight.current.get(k);
    if (existing) return existing;
    const seq = loadSeq.current;
    setLoadingCells((s) => new Set(s).add(k));
    const p = api
      .fetchValue(session.sessionId, schema, table, keyOf(row), columns[col]!.name)
      .then((value) => {
        if (seq !== loadSeq.current) return undefined; // the page changed meanwhile
        putCells([{ row, col, value }], seq);
        return value as Cell | undefined;
      })
      .catch((e) => {
        notifyError(e, "Could not load the value");
        return undefined;
      })
      .finally(() => {
        inflight.current.delete(k);
        setLoadingCells((s) => {
          const n = new Set(s);
          n.delete(k);
          return n;
        });
      });
    inflight.current.set(k, p);
    return p;
  };

  const needsEditor = (col: number, cell: Cell | undefined) => isJsonType(columns[col]?.dataType ?? "") || isLargeText(cell, largeValueChars);

  const onOpenCell = (row: number, col: number, how: "click" | "open") => {
    if (row >= rows.length) return false; // new rows edit inline
    const cell = getRow(row)?.[col];
    if (cell !== undefined && isNotLoaded(cell)) {
      void loadCell(row, col).then((v) => {
        if (v === undefined) return;
        if (needsEditor(col, v)) setEditorAt({ row, col });
        else if (how === "open") gridRef.current?.startEdit({ row, col });
      });
      return true;
    }
    if (how === "open" && needsEditor(col, cell)) {
      setEditorAt({ row, col });
      return true;
    }
    return false;
  };

  /**
   * Full values for the given cells: Not loaded ones are fetched by key, per column, in chunks the
   * backend accepts. With `strict` (copy, export, duplicate) a row that no longer exists is an
   * error rather than a silently empty value.
   */
  const fetchCells = async (cells: CellPos[], strict: boolean): Promise<Cell[]> => {
    const seq = loadSeq.current;
    const out: Cell[] = cells.map((p) => getRow(p.row)?.[p.col] ?? null);
    const byCol = new Map<number, number[]>();
    cells.forEach((p, i) => {
      const c = getRow(p.row)?.[p.col];
      if (c !== undefined && isNotLoaded(c) && p.row < rows.length) byCol.set(p.col, [...(byCol.get(p.col) ?? []), i]);
    });
    let missing = 0;
    for (const [col, idx] of byCol) {
      for (let start = 0; start < idx.length; start += FETCH_CHUNK) {
        const part = idx.slice(start, start + FETCH_CHUNK);
        const got = await api.fetchColumn(session.sessionId, schema, table, columns[col]!.name, part.map((i) => keyOf(cells[i]!.row)));
        const updates: { row: number; col: number; value: Cell }[] = [];
        got.forEach((f, k) => {
          if (!f.found) {
            missing++;
            return;
          }
          out[part[k]!] = f.value;
          updates.push({ row: cells[part[k]!]!.row, col, value: f.value });
        });
        putCells(updates, seq);
      }
    }
    if (strict && missing > 0) throw new Error(`${pluralize(missing, "value")} could not be loaded: those rows no longer exist. Reload the table and try again.`);
    return out;
  };
  const loadFull = (cells: CellPos[]) => fetchCells(cells, true);

  /** Whole rows with every Not loaded value fetched (row copies, export, duplicate). */
  const fullRows = async (rowIdx: number[]): Promise<Cell[][]> => {
    const cells = rowIdx.flatMap((r) => columns.map((_, c) => ({ row: r, col: c })));
    const flat = await fetchCells(cells, true);
    return rowIdx.map((_, i) => flat.slice(i * columns.length, (i + 1) * columns.length));
  };

  /** A copy of a row as a new pending row, with its Not loaded values fetched first. */
  const duplicateRow = (row: number) =>
    void (row < rows.length ? fullRows([row]).then(([r]) => r) : Promise.resolve(getRow(row)))
      .then((r) => addRow(r))
      .catch((e) => notifyError(e, "Could not duplicate the row"));

  const loadColumn = (col: number) =>
    void fetchCells(
      rows.map((_, r) => ({ row: r, col })),
      false,
    ).catch((e) => notifyError(e, "Could not load the column"));

  const setOverride = (column: string, mode: FetchMode | null) =>
    guard(() => {
      void (async () => {
        try {
          await api.setColumnFetch(session.connectionId, schema, table, column, mode);
          setOverrides(await api.listColumnFetch(session.connectionId, schema, table));
        } catch (e) {
          notifyError(e, "Could not save the column choice");
        }
      })();
    });

  const headerItems = (col: number): MenuEntry[] => {
    const c = columns[col];
    if (!c || !hasPk || c.primaryKey !== null || !isTable) return [];
    const current = overrides?.find((o) => o.column === c.name)?.mode ?? null;
    return [
      { label: "Load this column", onSelect: () => loadColumn(col), disabled: !deferredCols.has(c.name) },
      { label: "Always load", onSelect: () => setOverride(c.name, "load"), disabled: current === "load" },
      { label: "Don't load", onSelect: () => setOverride(c.name, "defer"), disabled: current === "defer" },
      { label: "Use default", onSelect: () => setOverride(c.name, null), disabled: current === null },
    ];
  };

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
      setReview({ sql: preview.sql, atomic: preview.atomic, statements: preview.statementCount });
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

  // ---- following foreign keys ------------------------------------------------------------

  const fkByColumn = useMemo(() => (structure ? tableLinks(structure) : []), [structure]);

  const cellLink = (row: number, col: number) => {
    if (!onOpenTable || row >= rows.length) return null; // new rows have nothing to follow yet
    const link = fkByColumn[col]?.[0];
    const cells = getRow(row);
    if (!link || !cells) return null;
    const label = linkLabel(link, cells);
    const filter = linkFilter(link, cells);
    if (!label || !filter) return null;
    return { label, open: () => onOpenTable(link.fk.refSchema, link.fk.refTable, filter) };
  };

  const contextItems = (sel: GridSelection) => {
    const first = sel.rows[0];
    const active = sel.active;
    const links = active && active.row < rows.length && onOpenTable ? (fkByColumn[active.col] ?? []) : [];
    const activeCells = active ? getRow(active.row) : undefined;
    const refItems = links.flatMap((link) => {
      const filter = activeCells ? linkFilter(link, activeCells) : null;
      if (!filter) return [];
      return [
        {
          label: links.length > 1 ? `Open referenced row in ${link.fk.refTable}` : "Open referenced row",
          onSelect: () => onOpenTable!(link.fk.refSchema, link.fk.refTable, filter),
        },
      ];
    });
    return [
      ...refItems,
      ...(refItems.length ? (["separator"] as const) : []),
      {
        label: "Copy as SQL IN list",
        onSelect: () =>
          void loadFull(sel.rows.flatMap((r) => sel.cols.map((c) => ({ row: r, col: c }))))
            .then((vals) => navigator.clipboard.writeText(vals.map((v) => (v === null ? "NULL" : `'${cellCopy(v).replace(/'/g, "''")}'`)).join(", ")))
            .catch((e) => notifyError(e, "Could not copy")),
      },
      {
        label: "Export selected rows…",
        disabled: sel.rows.length === 0,
        onSelect: () =>
          void fullRows(sel.rows)
            .then((full) =>
              setExportSource({
                kind: "rows",
                dialect: session.dialect,
                label: `${pluralize(sel.rows.length, "selected row")} from ${schema}.${table}`,
                columns: columns.map((c) => ({ name: c.name, typeName: c.dataType })),
                rows: full,
              }),
            )
            .catch((e) => notifyError(e, "Could not export")),
      },
      {
        label: "Copy rows as TSV",
        onSelect: () =>
          void fullRows(sel.rows)
            .then((full) =>
              navigator.clipboard.writeText(
                toTsv(
                  full,
                  columns.map((c) => c.name),
                ),
              ),
            )
            .catch((e) => notifyError(e, "Could not copy")),
      },
      "separator" as const,
      { label: "Set to NULL", onSelect: () => setNull(sel), disabled: !sel.rows.some((r) => sel.cols.some((c) => canEdit(r, c))) },
      {
        label: "Duplicate row",
        onSelect: () => first !== undefined && duplicateRow(first),
        disabled: !canInsert || first === undefined,
      },
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
              title="Filter rows"
            >
              <Icon name="filter_list" size={14} /> Filter{countConditions(filter) > 0 ? ` (${countConditions(filter)})` : ""}
            </button>
            <button className="btn btn-ghost btn-icon" onClick={() => guard(() => void load())} aria-label="Reload" title="Reload">
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
                  onClick={() => selection.rows[0] !== undefined && duplicateRow(selection.rows[0])}
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
            <span className={`access-pill ${access !== "Writable" ? "ro" : ""}`} title={readOnlyReason ?? "Edits stay pending until you review and commit them"}>
              <Icon name={access === "Writable" ? "edit" : "lock"} size={13} />
              {access}
              {readOnlyReason && <span className="sr-only">: {readOnlyReason}</span>}
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
        <DefinitionView session={session} schema={schema} name={table} kind={structure.kind} onOpenSql={onOpenSql} />
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
                  columns={structure.columns.map((c) => ({
                    name: c.name,
                    typeName: c.dataType,
                    primaryKey: c.primaryKey !== null,
                    foreignKey: structure.foreignKeys.some((f) => f.columns.includes(c.name)),
                    deferred: deferredCols.has(c.name),
                  }))}
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
                  onOpenCell={onOpenCell}
                  loadFull={loadFull}
                  headerItems={headerItems}
                  isLoading={(r, c) => loadingCells.has(`${r}:${c}`)}
                  largeValueChars={largeValueChars}
                  cellLink={cellLink}
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
                  {[100, 150, 300, 500, 1000, 5000].map((n) => (
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
                heading={selection.active ? `Row ${offset + selection.active.row + 1}` : "Inspector"}
                subheading={table}
                isEdited={(c) => selection.active !== null && selection.active.row < rows.length && pending.edits[selection.active.row]?.[c] !== undefined}
                onLoad={(c) => selection.active && void loadCell(selection.active.row, c)}
                onOpenEditor={(c) => selection.active && setEditorAt({ row: selection.active.row, col: c })}
                largeValueChars={largeValueChars}
                onClose={() => setDetailOpen(false)}
              />
            )}
          </div>
        </>
      )}

      {editorAt && structure && columns[editorAt.col] && (
        <ValueEditor
          title={`${table} · ${columns[editorAt.col]!.name} · ${keyOf(editorAt.row)
            .map((k) => `${k.column} = ${k.value ?? "NULL"}`)
            .join(", ")}`}
          typeName={columns[editorAt.col]!.dataType}
          mode={isJsonType(columns[editorAt.col]!.dataType) ? "json" : "text"}
          load={async () => {
            const c = getRow(editorAt.row)?.[editorAt.col] ?? null;
            if (c !== null && isNotLoaded(c)) {
              const seq = loadSeq.current;
              const v = await api.fetchValue(session.sessionId, schema, table, keyOf(editorAt.row), columns[editorAt.col]!.name);
              putCells([{ row: editorAt.row, col: editorAt.col, value: v }], seq);
              return v;
            }
            return c;
          }}
          readOnlyReason={canEditRow(editorAt.row) ? null : (readOnlyReason ?? "This value can't be changed here")}
          nullable={columns[editorAt.col]!.nullable}
          onSave={(v) => {
            onEdit(editorAt.row, editorAt.col, v);
            setEditorAt(null);
          }}
          onClose={() => setEditorAt(null)}
        />
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
          statements={review.statements}
          summary={`${pluralize(nPending, "change")} to ${schema}.${table}`}
          commitLabel="Commit changes"
          cancelLabel="Keep editing"
          onCommit={commit}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}

