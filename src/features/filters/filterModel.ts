import type { ColumnInfo, FilterNode, FilterOp } from "../../types/backend";
import { isBooleanType, isDateType, isNumericType } from "../../lib/cells";

export type GroupNode = Extract<FilterNode, { type: "group" }>;
export type ConditionNode = Extract<FilterNode, { type: "condition" }>;

export const OPS: { op: FilterOp; label: string; arity: 0 | 1 | 2 | "list" }[] = [
  { op: "eq", label: "=", arity: 1 },
  { op: "ne", label: "≠", arity: 1 },
  { op: "gt", label: ">", arity: 1 },
  { op: "gte", label: "≥", arity: 1 },
  { op: "lt", label: "<", arity: 1 },
  { op: "lte", label: "≤", arity: 1 },
  { op: "contains", label: "contains", arity: 1 },
  { op: "not_contains", label: "does not contain", arity: 1 },
  { op: "starts_with", label: "starts with", arity: 1 },
  { op: "ends_with", label: "ends with", arity: 1 },
  { op: "like", label: "LIKE", arity: 1 },
  { op: "not_like", label: "NOT LIKE", arity: 1 },
  { op: "in", label: "in list", arity: "list" },
  { op: "not_in", label: "not in list", arity: "list" },
  { op: "between", label: "between", arity: 2 },
  { op: "not_between", label: "not between", arity: 2 },
  { op: "is_null", label: "is NULL", arity: 0 },
  { op: "is_not_null", label: "is not NULL", arity: 0 },
  { op: "is_true", label: "is true", arity: 0 },
  { op: "is_false", label: "is false", arity: 0 },
];

export function opInfo(op: FilterOp) {
  return OPS.find((o) => o.op === op)!;
}

/** Operators that make sense for a column type. */
export function opsForType(typeName: string): FilterOp[] {
  if (isBooleanType(typeName)) return ["eq", "ne", "is_true", "is_false", "is_null", "is_not_null"];
  if (isNumericType(typeName) || isDateType(typeName))
    return ["eq", "ne", "gt", "gte", "lt", "lte", "between", "not_between", "in", "not_in", "is_null", "is_not_null"];
  return OPS.filter((o) => o.op !== "is_true" && o.op !== "is_false").map((o) => o.op);
}

export function defaultOp(typeName: string): FilterOp {
  return isNumericType(typeName) || isDateType(typeName) || isBooleanType(typeName) ? "eq" : "contains";
}

export function placeholderFor(typeName: string): string {
  if (/timestamp|datetime/i.test(typeName)) return "YYYY-MM-DD HH:MM:SS";
  if (/date/i.test(typeName)) return "YYYY-MM-DD";
  if (/time/i.test(typeName)) return "HH:MM:SS";
  if (isNumericType(typeName)) return "number";
  return "value";
}

export function emptyGroup(): GroupNode {
  return { type: "group", logic: "and", children: [] };
}

export function newCondition(column: ColumnInfo): ConditionNode {
  return { type: "condition", column: column.name, op: defaultOp(column.dataType), value: "", enabled: true };
}

/** Path-based immutable update helpers. A path is a list of child indices from the root. */
export function updateAt(root: GroupNode, path: number[], f: (n: FilterNode) => FilterNode | null): GroupNode {
  if (path.length === 0) return f(root) as GroupNode;
  const [head, ...rest] = path;
  const children: FilterNode[] = [];
  root.children.forEach((child, i) => {
    if (i !== head) return children.push(child);
    if (rest.length === 0) {
      const r = f(child);
      if (r) children.push(r);
    } else if (child.type === "group") {
      children.push(updateAt(child, rest, f));
    } else children.push(child);
  });
  return { ...root, children };
}

export function countConditions(node: FilterNode): number {
  if (node.type === "group") return node.children.reduce((n, c) => n + countConditions(c), 0);
  return node.enabled === false ? 0 : 1;
}

/** Human-readable preview with literal values (display only; execution uses bind parameters). */
export function filterToText(node: FilterNode): string {
  const lit = (v: string | null | undefined) => (v === null || v === undefined ? "NULL" : `'${v.replace(/'/g, "''")}'`);
  switch (node.type) {
    case "raw":
      return node.enabled === false || !node.sql.trim() ? "" : `(${node.sql.trim()})`;
    case "condition": {
      if (node.enabled === false) return "";
      const c = node.column;
      switch (node.op) {
        case "eq":
          return `${c} = ${lit(node.value)}`;
        case "ne":
          return `${c} <> ${lit(node.value)}`;
        case "gt":
          return `${c} > ${lit(node.value)}`;
        case "gte":
          return `${c} >= ${lit(node.value)}`;
        case "lt":
          return `${c} < ${lit(node.value)}`;
        case "lte":
          return `${c} <= ${lit(node.value)}`;
        case "contains":
          return `${c} contains ${lit(node.value)}`;
        case "not_contains":
          return `${c} does not contain ${lit(node.value)}`;
        case "starts_with":
          return `${c} starts with ${lit(node.value)}`;
        case "ends_with":
          return `${c} ends with ${lit(node.value)}`;
        case "like":
          return `${c} LIKE ${lit(node.value)}`;
        case "not_like":
          return `${c} NOT LIKE ${lit(node.value)}`;
        case "in":
        case "not_in":
          return `${c} ${node.op === "in" ? "IN" : "NOT IN"} (${(node.values ?? []).map(lit).join(", ")})`;
        case "between":
        case "not_between":
          return `${c} ${node.op === "between" ? "BETWEEN" : "NOT BETWEEN"} ${lit(node.value)} AND ${lit(node.value2)}`;
        case "is_null":
          return `${c} IS NULL`;
        case "is_not_null":
          return `${c} IS NOT NULL`;
        case "is_true":
          return `${c} IS TRUE`;
        case "is_false":
          return `${c} IS FALSE`;
      }
      return "";
    }
    case "group": {
      const parts = node.children.map(filterToText).filter(Boolean);
      if (parts.length === 0) return "";
      const inner = parts.length === 1 ? parts[0]! : `(${parts.join(node.logic === "and" ? " AND " : " OR ")})`;
      return node.negate ? `NOT ${inner}` : inner;
    }
  }
}

/** Splits an IN-list input on commas, honouring double quotes for values containing commas. */
export function parseList(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() || out.length > 0) out.push(cur.trim());
  return out.filter((v) => v.length > 0);
}

export function formatList(values: string[]): string {
  return values.map((v) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(", ");
}
