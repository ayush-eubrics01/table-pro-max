// Turns a text result set into chart-ready series. Pure functions, unit tested.

import type { Cell, ColumnMeta } from "../../types/backend";

export interface Series {
  name: string;
  values: (number | null)[];
}

export interface Dataset {
  x: string[];
  series: Series[];
}

export const MAX_SERIES = 8;

export function toNumber(c: Cell | undefined): number | null {
  if (typeof c !== "string" || c.trim() === "") return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

/** A column is numeric when at least 80% of its non-NULL values parse as numbers. */
export function isNumericColumn(rows: Cell[][], col: number): boolean {
  let seen = 0;
  let numeric = 0;
  for (const r of rows) {
    const c = r[col];
    if (c === null || c === undefined) continue;
    seen++;
    if (toNumber(c) !== null) numeric++;
  }
  return seen > 0 && numeric / seen >= 0.8;
}

/** First column is the x/category axis; numeric columns after it become series. */
export function toDataset(columns: ColumnMeta[], rows: Cell[][]): Dataset {
  const x = rows.map((r) => (typeof r[0] === "string" ? r[0] : r[0] === null ? "NULL" : "binary"));
  const series: Series[] = [];
  for (let c = 1; c < columns.length && series.length < MAX_SERIES; c++) {
    if (!isNumericColumn(rows, c)) continue;
    series.push({ name: columns[c]!.name, values: rows.map((r) => toNumber(r[c])) });
  }
  return { x, series };
}

export interface Slice {
  label: string;
  value: number;
}

/** Parts of a whole: the largest `keep` slices plus "Other" for the rest. Negative values are dropped. */
export function toSlices(columns: ColumnMeta[], rows: Cell[][], keep = 5): Slice[] {
  const valueCol = columns.findIndex((_, i) => i > 0 && isNumericColumn(rows, i));
  if (valueCol < 0) return [];
  const all = rows
    .map((r) => ({ label: typeof r[0] === "string" ? r[0] : "NULL", value: toNumber(r[valueCol]) ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (all.length <= keep + 1) return all;
  const other = all.slice(keep).reduce((sum, s) => sum + s.value, 0);
  return [...all.slice(0, keep), { label: "Other", value: other }];
}

/** Compact number formatting: 1,284 / 12.9K / 4.2M. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}K`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** "Nice" axis ticks from 0 (or the minimum, if negative) to at least `max`. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < hi) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** Shortens ISO timestamps for axis labels. */
export function shortLabel(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return s.length > 14 ? `${s.slice(0, 13)}…` : s;
  return m[4] && m[4] !== "00" ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
