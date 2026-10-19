import type { Cell } from "../types/backend";

/** Binary column types (as `large_values::is_binary_type` in the core). */
export function isBinaryType(dataType: string): boolean {
  const base = dataType.trim().toLowerCase().split(/[( ]/)[0] ?? "";
  return ["bytea", "binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob", "image", "rowversion"].includes(base);
}

export function isBinary(c: Cell): c is { $bytes: string; size: number } {
  return typeof c === "object" && c !== null && "$bytes" in c;
}

export function isNotLoaded(c: Cell): c is { $notLoaded: true } {
  return typeof c === "object" && c !== null && "$notLoaded" in c;
}

export function isPartial(c: Cell): c is { $partial: string; length: number } {
  return typeof c === "object" && c !== null && "$partial" in c;
}

/** The grid holds a placeholder; the full value must be fetched before copying or editing. */
export function needsFetch(c: Cell | undefined): boolean {
  return c !== undefined && (isNotLoaded(c) || isPartial(c));
}

/** Characters of a long value shown before it is opened (matches the backend's PREVIEW_CHARS). */
export const PREVIEW_CHARS = 80;

export function isLargeText(c: Cell | undefined, limit: number): c is string {
  return typeof c === "string" && c.length > limit;
}

export function previewText(s: string): string {
  // Walk only the first PREVIEW_CHARS code points: values can be megabytes long.
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n++ === PREVIEW_CHARS) break;
    out += ch;
  }
  return out;
}

export function sizeLabel(typeName: string, length: number): string {
  return isJsonType(typeName) ? formatBytes(length) : `${length.toLocaleString("en-US")} chars`;
}

/** Display text for a cell (single line). */
export function cellDisplay(c: Cell): string {
  if (c === null) return "NULL";
  if (isBinary(c)) return `<binary ${formatBytes(c.size)}>`;
  if (isNotLoaded(c)) return "Not loaded";
  if (isPartial(c)) return `${c.$partial}…`;
  return c.length > 2000 ? `${c.slice(0, 2000)}…` : c.replace(/[\r\n]+/g, " ⏎ ");
}

/** Text used for clipboard copies: NULL becomes an empty string by default. */
export function cellCopy(c: Cell, nullText = ""): string {
  if (c === null) return nullText;
  if (isBinary(c)) return `\\x${c.$bytes}`;
  if (isNotLoaded(c) || isPartial(c)) return ""; // placeholders are fetched before copying
  return c;
}

/** Value usable as an edit/key parameter. Binary values cannot round-trip. */
export function cellParam(c: Cell): string | null | undefined {
  if (c === null) return null;
  if (isBinary(c)) return undefined;
  if (isNotLoaded(c) || isPartial(c)) return undefined; // a placeholder is not the value
  return c;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const NUMERIC = /^(small|big)?int|integer|serial|numeric|decimal|real|double|float|money|tinyint|mediumint|long|short|year|oid/i;

export function isNumericType(typeName: string): boolean {
  return NUMERIC.test(typeName.trim());
}

const BOOLEAN = /^bool/i;
export function isBooleanType(typeName: string): boolean {
  return BOOLEAN.test(typeName.trim());
}

const ENUM = /enum/i;
const TRUE = /^(t|true|1|yes|on)$/i;
const FALSE = /^(f|false|0|no|off)$/i;

/** How a cell is drawn: enum values as tags, booleans coloured. NULL and binary values are never toned. */
export function cellTone(typeName: string, value: Cell | undefined): "enum" | "true" | "false" | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  if (isBooleanType(typeName)) return TRUE.test(value) ? "true" : FALSE.test(value) ? "false" : null;
  if (ENUM.test(typeName)) return "enum";
  return null;
}

const DATE = /date|time/i;
export function isDateType(typeName: string): boolean {
  return DATE.test(typeName);
}

const JSONISH = /json/i;
export function isJsonType(typeName: string): boolean {
  return JSONISH.test(typeName);
}

export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Tab-separated text for a block of cells, as spreadsheets expect when pasting. */
export function toTsv(rows: Cell[][], header?: string[]): string {
  const esc = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = rows.map((r) => r.map((c) => esc(cellCopy(c))).join("\t"));
  if (header) lines.unshift(header.map(esc).join("\t"));
  return lines.join("\n");
}
