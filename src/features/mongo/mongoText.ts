/** Longest text a table cell shows; the JSON view keeps the whole value. */
const MAX_CELL = 200;

/**
 * Relaxed Extended JSON writes 64-bit integers as plain numbers, which `JSON.parse` would round
 * past 2^53: such integers (outside strings) become `{"$numberLong": "…"}` and keep every digit.
 */
function keepBigIntegers(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy the string as is, escapes included.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))!;
      const token = m[0];
      const integer = m[1] === undefined && m[2] === undefined;
      out += integer && !Number.isSafeInteger(Number(token)) ? `{"$numberLong":"${token}"}` : token;
      i += token.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** A document from the backend's relaxed Extended JSON text; an unreadable one is empty. */
export function parseDoc(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(keepBigIntegers(text));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A field's value for a table cell: MongoDB's Extended JSON types as the shell writes them. */
export function cellText(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const [k] = keys;
    const inner = o[k!];
    if (k === "$oid" && typeof inner === "string") return `ObjectId("${inner}")`;
    if (k === "$date") return typeof inner === "string" ? inner : cellText(inner);
    if ((k === "$numberDecimal" || k === "$numberLong" || k === "$numberDouble" || k === "$numberInt") && typeof inner === "string") return inner;
    if (k === "$binary" && inner && typeof inner === "object") return `Binary("${String((inner as Record<string, unknown>).base64 ?? "")}")`;
  }
  const json = JSON.stringify(v);
  return json.length > MAX_CELL ? `${json.slice(0, MAX_CELL)}…` : json;
}

/** An empty filter matches every document in the collection. */
export function isEveryDocument(filter: string): boolean {
  return filter.replace(/\s/g, "") === "" || filter.replace(/\s/g, "") === "{}";
}
