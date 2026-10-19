/** Longest text a table cell shows; the JSON view keeps the whole value. */
const MAX_CELL = 200;

/** A document from the backend's relaxed Extended JSON text; an unreadable one is empty. */
export function parseDoc(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
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
