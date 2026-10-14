import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../../components/Icon";
import type { Cell, SortSpec } from "../../types/backend";
import { cellDisplay, cellTone, formatBytes, isBinary, isLargeText, isNotLoaded, isNumericType, isPartial, needsFetch, previewText, sizeLabel, toTsv } from "../../lib/cells";
import { ContextMenu, useContextMenu, type MenuEntry } from "../../components/Menu";
import { notify, notifyError } from "../../stores/ui";
import { pluralize } from "../../lib/text";

export interface GridColumn {
  name: string;
  typeName: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
  /** Left out of the page query; cells hold `{ $notLoaded: true }` until loaded. */
  deferred?: boolean;
}

export interface CellPos {
  row: number;
  col: number;
}

export interface GridSelection {
  /** Sorted distinct row indices covered by the selection. */
  rows: number[];
  /** Data column indices covered by the selection, in display order. */
  cols: number[];
  active: CellPos | null;
}

export interface GridHandle {
  focus: () => void;
  selectCell: (pos: CellPos) => void;
  copySelection: (withHeader?: boolean) => Promise<void>;
  getSelection: () => GridSelection;
  /** Opens the inline editor on a cell (after its value has been loaded, say). */
  startEdit: (pos: CellPos) => void;
}

export interface DataGridProps {
  columns: GridColumn[];
  rowCount: number;
  getRow: (index: number) => Cell[] | undefined;
  /** Called with the visible row range when some rows are not loaded yet. */
  onNeedRows?: (start: number, end: number) => void;
  rowState?: (index: number) => "inserted" | "deleted" | undefined;
  isEdited?: (row: number, col: number) => boolean;
  canEdit?: (row: number, col: number) => boolean;
  onEdit?: (row: number, col: number, value: string | null) => void;
  sort?: SortSpec[];
  onSort?: (column: string, descending: boolean | null) => void;
  onSelectionChange?: (sel: GridSelection) => void;
  /** Tooltip for a data cell, e.g. why it cannot be edited. */
  cellTitle?: (row: number, col: number) => string | undefined;
  /** Extra items for the cell context menu. */
  contextItems?: (sel: GridSelection) => MenuEntry[];
  onDeleteKey?: (sel: GridSelection) => void;
  rowNumberOffset?: number;
  /** Extra scroll space below the last row (px), e.g. under a floating bar. */
  bottomInset?: number;
  /**
   * "click" on a Not loaded cell, or "open" (double-click, Enter) on any cell. Return true when
   * the parent handled it (loaded the value, opened an editor); the inline editor then stays shut.
   */
  onOpenCell?: (row: number, col: number, how: "click" | "open") => boolean;
  /** Full values for placeholder cells, in the given order (copying fetches them first). */
  loadFull?: (cells: CellPos[]) => Promise<Cell[]>;
  /** Extra items for a column header's menu. */
  headerItems?: (col: number) => MenuEntry[];
  /** A link from this cell to the row it references (foreign keys); the arrow opens it. */
  cellLink?: (row: number, col: number) => { label: string; open: () => void } | null;
  /** A cell whose value is being fetched. */
  isLoading?: (row: number, col: number) => boolean;
  /** Text longer than this shows as a preview with its size, and opens in an editor. */
  largeValueChars?: number;
  ref?: Ref<GridHandle>;
  ariaLabel: string;
}

/** Must equal --row-height in tokens.css (rowHeight.test.ts). */
export const ROW_HEIGHT = 30;
/** The sticky header is one row tall (.grid-header uses --row-height). */
export const HEADER_HEIGHT = ROW_HEIGHT;
const ROWNUM_WIDTH = 56;
const MIN_COL = 48;

function initialWidth(c: GridColumn): number {
  const byName = c.name.length * 8 + 40;
  const byType = isNumericType(c.typeName) ? 110 : /bool/i.test(c.typeName) ? 80 : 180;
  return Math.max(MIN_COL, Math.min(320, Math.max(byName, byType)));
}

export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rowCount,
    getRow,
    onNeedRows,
    rowState,
    isEdited,
    canEdit,
    onEdit,
    sort,
    onSort,
    onSelectionChange,
    cellTitle,
    contextItems,
    onDeleteKey,
    rowNumberOffset = 0,
    bottomInset,
    onOpenCell,
    loadFull,
    headerItems,
    isLoading,
    cellLink,
    largeValueChars = 256,
    ref,
    ariaLabel,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnKey = columns.map((c) => c.name).join("\u0000");
  const [widths, setWidths] = useState<number[]>(() => columns.map(initialWidth));
  const [order, setOrder] = useState<number[]>(() => columns.map((_, i) => i));
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [focus, setFocus] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const menu = useContextMenu();

  // Reset layout when the column set changes (new table or new query result).
  useEffect(() => {
    setWidths(columns.map(initialWidth));
    setOrder(columns.map((_, i) => i));
    setHidden(new Set());
    setAnchor(null);
    setFocus(null);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);

  const visible = useMemo(() => order.filter((i) => !hidden.has(i) && i < columns.length), [order, hidden, columns.length]);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollPaddingStart: HEADER_HEIGHT,
    // Replaced by real measurements once mounted; lets the first frame (and jsdom) render rows.
    initialRect: { width: 1200, height: 700 },
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[visible[i]!] ?? 150,
    overscan: 4,
    scrollPaddingStart: ROWNUM_WIDTH,
    initialRect: { width: 1200, height: 700 },
  });

  useEffect(() => {
    colVirtualizer.measure();
  }, [widths, visible, colVirtualizer]);

  const rowItems = rowVirtualizer.getVirtualItems();
  const colItems = colVirtualizer.getVirtualItems();

  // Ask the parent for rows that are visible but not loaded.
  const firstRow = rowItems[0]?.index ?? 0;
  const lastRow = rowItems[rowItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (!onNeedRows || rowCount === 0) return;
    for (let i = firstRow; i <= lastRow; i++) {
      if (!getRow(i)) {
        onNeedRows(firstRow, lastRow);
        return;
      }
    }
  }, [firstRow, lastRow, rowCount, getRow, onNeedRows]);

  const selection = useMemo<GridSelection>(() => {
    if (!anchor || !focus) return { rows: [], cols: [], active: focus };
    const r0 = Math.min(anchor.row, focus.row);
    const r1 = Math.max(anchor.row, focus.row);
    const rows: number[] = [];
    for (let r = r0; r <= r1 && r < rowCount; r++) rows.push(r);
    let cols: number[];
    if (anchor.col < 0 || focus.col < 0) cols = visible;
    else {
      const a = visible.indexOf(anchor.col);
      const b = visible.indexOf(focus.col);
      cols = visible.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    return { rows, cols, active: focus };
  }, [anchor, focus, visible, rowCount]);

  useEffect(() => {
    onSelectionChange?.(selection);
  }, [selection, onSelectionChange]);

  const inSelection = useCallback(
    (row: number, col: number) => {
      if (!anchor || !focus) return false;
      if (row < Math.min(anchor.row, focus.row) || row > Math.max(anchor.row, focus.row)) return false;
      if (anchor.col < 0 || focus.col < 0) return true;
      const v = visible.indexOf(col);
      const a = visible.indexOf(anchor.col);
      const b = visible.indexOf(focus.col);
      return v >= Math.min(a, b) && v <= Math.max(a, b);
    },
    [anchor, focus, visible],
  );

  const scrollTo = useCallback(
    (pos: CellPos) => {
      rowVirtualizer.scrollToIndex(pos.row, { align: "auto" });
      const vi = visible.indexOf(pos.col);
      if (vi >= 0) colVirtualizer.scrollToIndex(vi, { align: "auto" });
    },
    [rowVirtualizer, colVirtualizer, visible],
  );

  /** Swaps placeholders in `data` (laid out as `rows` x `cols`) for full values before copying. */
  const fillPlaceholders = useCallback(
    async (data: Cell[][], rows: number[], cols: number[]): Promise<number> => {
      const missing: { pos: CellPos; i: number; j: number }[] = [];
      data.forEach((row, i) => row.forEach((cell, j) => needsFetch(cell) && missing.push({ pos: { row: rows[i]!, col: cols[j]! }, i, j })));
      if (missing.length > 0 && loadFull) {
        const full = await loadFull(missing.map((m) => m.pos));
        missing.forEach((m, k) => (data[m.i]![m.j] = full[k] ?? null));
      }
      return missing.length;
    },
    [loadFull],
  );

  const copySelection = useCallback(
    async (withHeader = false) => {
      if (selection.rows.length === 0) return;
      const data = selection.rows.map((r) => {
        const row = getRow(r);
        return selection.cols.map((c) => (row ? (row[c] ?? null) : null));
      });
      let fetched: number;
      try {
        fetched = await fillPlaceholders(data, selection.rows, selection.cols);
      } catch (e) {
        // Never leave a stale clipboard behind silently.
        notifyError(e, "Could not copy");
        return;
      }
      const header = withHeader ? selection.cols.map((c) => columns[c]!.name) : undefined;
      const text = toTsv(data, header);
      await navigator.clipboard.writeText(text);
      if (fetched > 0) notify(`Copied ${pluralize(selection.rows.length, "row")} (${formatBytes(new TextEncoder().encode(text).length)})`, "success");
    },
    [selection, getRow, columns, fillPlaceholders],
  );

  const select = useCallback(
    (pos: CellPos, extend = false) => {
      setFocus(pos);
      if (!extend) setAnchor(pos);
      if (pos.col >= 0) scrollTo(pos);
      else rowVirtualizer.scrollToIndex(pos.row, { align: "auto" });
    },
    [scrollTo, rowVirtualizer],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => scrollRef.current?.focus(),
      selectCell: (pos) => select(pos),
      copySelection,
      getSelection: () => selection,
      startEdit: (pos) => startEdit(pos),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startEdit reads current state when called
    [select, copySelection, selection],
  );

  const startEdit = (pos: CellPos, initial?: string) => {
    if (!onEdit || !canEdit?.(pos.row, pos.col)) return;
    const cell = getRow(pos.row)?.[pos.col];
    if (cell === undefined || (cell !== null && typeof cell === "object")) return;
    if (isLargeText(cell, largeValueChars)) return; // long text opens in the value editor
    setEditing({ pos, value: initial ?? cell ?? "" });
  };

  const commitEdit = (move?: "down" | "right" | "left") => {
    if (!editing) return;
    onEdit?.(editing.pos.row, editing.pos.col, editing.value);
    const { row, col } = editing.pos;
    setEditing(null);
    scrollRef.current?.focus();
    const vi = visible.indexOf(col);
    if (move === "down" && row + 1 < rowCount) select({ row: row + 1, col });
    if (move === "right" && vi + 1 < visible.length) select({ row, col: visible[vi + 1]! });
    if (move === "left" && vi > 0) select({ row, col: visible[vi - 1]! });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection(e.shiftKey);
      return;
    }
    if (mod && e.key === "Enter" && focus && focus.col >= 0) {
      const link = cellLink?.(focus.row, focus.col);
      if (link) {
        e.preventDefault();
        link.open();
        return;
      }
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (rowCount > 0 && visible.length > 0) {
        setAnchor({ row: 0, col: visible[0]! });
        setFocus({ row: rowCount - 1, col: visible[visible.length - 1]! });
      }
      return;
    }
    const cur = focus ?? (rowCount > 0 && visible.length > 0 ? { row: 0, col: visible[0]! } : null);
    if (!cur) return;
    const vi = Math.max(0, visible.indexOf(cur.col));
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 2);
    let next: CellPos | null;
    switch (e.key) {
      case "ArrowDown":
        next = { row: Math.min(rowCount - 1, mod ? rowCount - 1 : cur.row + 1), col: cur.col };
        break;
      case "ArrowUp":
        next = { row: Math.max(0, mod ? 0 : cur.row - 1), col: cur.col };
        break;
      case "ArrowRight":
        next = { row: cur.row, col: visible[mod ? visible.length - 1 : Math.min(visible.length - 1, vi + 1)]! };
        break;
      case "ArrowLeft":
        next = { row: cur.row, col: visible[mod ? 0 : Math.max(0, vi - 1)]! };
        break;
      case "PageDown":
        next = { row: Math.min(rowCount - 1, cur.row + page), col: cur.col };
        break;
      case "PageUp":
        next = { row: Math.max(0, cur.row - page), col: cur.col };
        break;
      case "Home":
        next = mod ? { row: 0, col: visible[0]! } : { row: cur.row, col: visible[0]! };
        break;
      case "End":
        next = mod ? { row: rowCount - 1, col: visible[visible.length - 1]! } : { row: cur.row, col: visible[visible.length - 1]! };
        break;
      case "Tab":
        e.preventDefault();
        select({ row: cur.row, col: visible[e.shiftKey ? Math.max(0, vi - 1) : Math.min(visible.length - 1, vi + 1)]! });
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        if (cur.col >= 0 && !onOpenCell?.(cur.row, cur.col, "open")) startEdit(cur);
        return;
      case "Delete":
      case "Backspace":
        if (onDeleteKey) {
          e.preventDefault();
          onDeleteKey(selection);
        }
        return;
      default:
        if (e.key.length === 1 && !mod && !e.altKey && cur.col >= 0 && canEdit?.(cur.row, cur.col)) {
          e.preventDefault();
          startEdit(cur, e.key);
        }
        return;
    }
    if (next) {
      e.preventDefault();
      select(next, e.shiftKey);
    }
  };

  const onResizeStart = (e: React.MouseEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col] ?? 150;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, i) => (i === col ? w : x)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autoFit = (col: number) => {
    let max = columns[col]!.name.length * 8 + 40;
    for (const item of rowItems) {
      const v = getRow(item.index)?.[col];
      if (v !== undefined) max = Math.max(max, Math.min(600, cellDisplay(v).length * 7.4 + 24));
    }
    setWidths((ws) => ws.map((x, i) => (i === col ? Math.max(MIN_COL, max) : x)));
  };

  const sortOf = (name: string) => sort?.find((s) => s.column === name);

  const headerMenu = (col: number): MenuEntry[] => {
    const c = columns[col]!;
    return [
      ...(onSort
        ? ([
            { label: "Sort ascending", onSelect: () => onSort(c.name, false) },
            { label: "Sort descending", onSelect: () => onSort(c.name, true) },
            { label: "Clear sort", onSelect: () => onSort(c.name, null), disabled: !sortOf(c.name) },
            "separator",
          ] as MenuEntry[])
        : []),
      { label: "Hide column", onSelect: () => setHidden((h) => new Set(h).add(col)), disabled: visible.length <= 1 },
      { label: "Show all columns", onSelect: () => setHidden(new Set()), disabled: hidden.size === 0 },
      { label: "Fit width to content", onSelect: () => autoFit(col) },
      "separator",
      { label: "Copy column name", onSelect: () => void navigator.clipboard.writeText(c.name) },
      {
        label: "Copy column values",
        onSelect: () => {
          const vals: Cell[][] = [];
          const rows: number[] = [];
          for (let r = 0; r < rowCount; r++) {
            const row = getRow(r);
            if (row) {
              vals.push([row[col] ?? null]);
              rows.push(r);
            }
          }
          void fillPlaceholders(vals, rows, [col])
            .then(() => navigator.clipboard.writeText(toTsv(vals)))
            .catch((e) => notifyError(e, "Could not copy"));
        },
      },
      ...(headerItems ? (["separator", ...headerItems(col)] as MenuEntry[]) : []),
    ];
  };

  const cellMenu = (): MenuEntry[] => [
    { label: "Copy", shortcut: "Ctrl+C", onSelect: () => copySelection(false) },
    { label: "Copy with column names", shortcut: "Ctrl+Shift+C", onSelect: () => copySelection(true) },
    ...((): MenuEntry[] => {
      const extra = contextItems?.(selection) ?? [];
      return extra.length ? ["separator", ...extra] : [];
    })(),
  ];

  const totalWidth = ROWNUM_WIDTH + colVirtualizer.getTotalSize();
  const totalHeight = HEADER_HEIGHT + rowVirtualizer.getTotalSize() + (bottomInset ?? 0);
  const activeId = focus ? `cell-${focus.row}-${focus.col}` : undefined;

  return (
    <>
      <div
        ref={scrollRef}
        className="grid"
        role="grid"
        aria-label={ariaLabel}
        aria-rowcount={rowCount + 1}
        aria-colcount={visible.length + 1}
        aria-multiselectable="true"
        aria-activedescendant={activeId}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div style={{ width: totalWidth, height: totalHeight, position: "relative" }}>
          <div className="grid-header" role="row" aria-rowindex={1} style={{ width: totalWidth }}>
            <div
              className="grid-hcell grid-rownum"
              style={{ left: 0, width: ROWNUM_WIDTH, position: "sticky", zIndex: 4 }}
              role="columnheader"
              aria-label="Row number"
              onClick={() => {
                if (rowCount > 0 && visible.length > 0) {
                  setAnchor({ row: 0, col: -1 });
                  setFocus({ row: rowCount - 1, col: -1 });
                }
              }}
            />
            {colItems.map((item) => {
              const col = visible[item.index]!;
              const c = columns[col]!;
              const s = sortOf(c.name);
              return (
                <div
                  key={col}
                  role="columnheader"
                  aria-colindex={item.index + 2}
                  aria-sort={s ? (s.descending ? "descending" : "ascending") : undefined}
                  className={`grid-hcell ${dropAt === item.index ? "drop-target" : ""}`}
                  style={{ left: ROWNUM_WIDTH + item.start, width: item.size }}
                  title={`${c.name} · ${c.typeName || "unknown type"}`}
                  draggable
                  onDragStart={(e) => {
                    setDragFrom(item.index);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return;
                    e.preventDefault();
                    setDropAt(item.index);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom === null) return;
                    const visCols = [...visible];
                    const [moved] = visCols.splice(dragFrom, 1);
                    visCols.splice(item.index, 0, moved!);
                    setOrder([...visCols, ...order.filter((o) => !visCols.includes(o))]);
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  onClick={() => {
                    if (!onSort) return;
                    onSort(c.name, s ? (s.descending ? null : true) : false);
                  }}
                  onContextMenu={(e) => menu.open(e, headerMenu(col))}
                >
                  {c.primaryKey && <Icon name="key" size={12} label="Primary key" />}
                  {c.foreignKey && <Icon name="link" size={12} label="Foreign key" />}
                  {c.deferred && (
                    <span className="col-deferred">
                      <Icon name="visibility" size={12} label="Loaded on demand" />
                    </span>
                  )}
                  <span className="name">{c.name}</span>
                  <span className="type">{c.typeName}</span>
                  {s && (s.descending ? <Icon name="arrow_downward" size={12} /> : <Icon name="arrow_upward" size={12} />)}
                  <span
                    className="grid-resize"
                    onMouseDown={(e) => onResizeStart(e, col)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autoFit(col);
                    }}
                  />
                </div>
              );
            })}
          </div>

          {rowItems.map((ri) => {
            const row = getRow(ri.index);
            const state = rowState?.(ri.index);
            const rowSelected = inSelection(ri.index, visible[0] ?? 0) && (anchor?.col === -1 || focus?.col === -1);
            return (
              <div
                key={ri.key}
                role="row"
                aria-rowindex={ri.index + 2}
                className={`grid-row ${state ?? ""} ${rowSelected ? "row-selected" : ""}`}
                style={{ top: HEADER_HEIGHT + ri.start, width: totalWidth }}
              >
                <div
                  className="grid-cell grid-rownum"
                  style={{ width: ROWNUM_WIDTH, position: "sticky" }}
                  role="rowheader"
                  onMouseDown={(e) => {
                    scrollRef.current?.focus();
                    select({ row: ri.index, col: -1 }, e.shiftKey);
                    if (!e.shiftKey) setAnchor({ row: ri.index, col: -1 });
                  }}
                  onContextMenu={(e) => {
                    if (!inSelection(ri.index, visible[0] ?? 0)) {
                      setAnchor({ row: ri.index, col: -1 });
                      setFocus({ row: ri.index, col: -1 });
                    }
                    menu.open(e, cellMenu());
                  }}
                >
                  {state === "inserted" ? "+" : ri.index + 1 + rowNumberOffset}
                </div>
                {colItems.map((ci) => {
                  const col = visible[ci.index]!;
                  const c = columns[col]!;
                  const v = row?.[col];
                  const isEditing = editing && editing.pos.row === ri.index && editing.pos.col === col;
                  const selected = inSelection(ri.index, col);
                  const active = focus?.row === ri.index && focus.col === col;
                  const tone = cellTone(c.typeName, v);
                  const link = isEditing ? null : (cellLink?.(ri.index, col) ?? null);
                  const cls = [
                    "grid-cell",
                    v === null ? "null" : "",
                    v !== undefined && isBinary(v) ? "binary" : "",
                    v !== undefined && isNotLoaded(v) ? "not-loaded" : "",
                    v !== undefined && (isPartial(v) || isLargeText(v, largeValueChars)) ? "partial" : "",
                    isLoading?.(ri.index, col) ? "loading" : "",
                    link ? "has-link" : "",
                    isNumericType(c.typeName) ? "num" : "",
                    selected ? "selected" : "",
                    active ? "active" : "",
                    isEdited?.(ri.index, col) ? "edited" : "",
                    tone === "true" ? "bool-true" : tone === "false" ? "bool-false" : "",
                  ].join(" ");
                  return (
                    <div
                      key={col}
                      id={`cell-${ri.index}-${col}`}
                      role="gridcell"
                      aria-colindex={ci.index + 2}
                      aria-selected={selected}
                      className={cls}
                      title={
                        cellTitle?.(ri.index, col) ??
                        (v !== undefined && isNotLoaded(v) ? "Click to load" : v !== undefined && (isPartial(v) || isLargeText(v, largeValueChars)) ? "Open to see the full value" : undefined)
                      }
                      style={{ left: ROWNUM_WIDTH + ci.start, width: ci.size }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (editing) commitEdit();
                        scrollRef.current?.focus();
                        select({ row: ri.index, col }, e.shiftKey);
                      }}
                      onMouseEnter={(e) => {
                        if (e.buttons === 1 && anchor && anchor.col >= 0) setFocus({ row: ri.index, col });
                      }}
                      onDoubleClick={() => {
                        if (onOpenCell?.(ri.index, col, "open")) return;
                        startEdit({ row: ri.index, col });
                      }}
                      onClick={() => {
                        if (v !== undefined && isNotLoaded(v)) onOpenCell?.(ri.index, col, "click");
                      }}
                      onContextMenu={(e) => {
                        if (!inSelection(ri.index, col)) select({ row: ri.index, col });
                        menu.open(e, cellMenu());
                      }}
                    >
                      {isEditing ? (
                        <input
                          className="grid-editor"
                          autoFocus
                          aria-label={`Edit ${c.name}`}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={() => commitEdit()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit("down");
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit(e.shiftKey ? "left" : "right");
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                              scrollRef.current?.focus();
                            }
                          }}
                        />
                      ) : (
                        v !== undefined && isNotLoaded(v) ? (
                          <span className="not-loaded-label">{isLoading?.(ri.index, col) ? <span className="spinner spinner-xs" /> : "Not loaded"}</span>
                        ) : v !== undefined && (isPartial(v) || isLargeText(v, largeValueChars)) ? (
                          <>
                            <span className="partial-preview">{(isPartial(v) ? v.$partial : previewText(v)).replace(/[\r\n]+/g, " ⏎ ")}…</span>
                            <span className="size-tag">{sizeLabel(c.typeName, v.length)}</span>
                          </>
                        ) : (
                          <span className={tone === "enum" ? "tag" : undefined}>{v === undefined ? "…" : cellDisplay(v)}</span>
                        )
                      )}
                      {link && (
                            <button
                              type="button"
                              className="fk-jump"
                              aria-label={link.label}
                              title={link.label}
                              tabIndex={-1}
                              onMouseDown={(e) => {
                                // Keep focus on the grid (so Space can't re-press the arrow later),
                                // and select the cell as a click on it would.
                                e.preventDefault();
                                e.stopPropagation();
                                if (editing) commitEdit();
                                scrollRef.current?.focus();
                                select({ row: ri.index, col });
                              }}
                              onDoubleClick={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                link.open();
                              }}
                            >
                              <Icon name="open_in_new" size={12} />
                            </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {rowCount === 0 && (
          <div className="empty" style={{ position: "absolute", inset: `${HEADER_HEIGHT}px 0 0 0`, height: "auto" }}>
            No rows
          </div>
        )}
      </div>
      <ContextMenu state={menu.menu} onClose={menu.close} />
    </>
  );
}
