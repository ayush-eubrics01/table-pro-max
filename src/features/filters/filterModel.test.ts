import { describe, expect, it } from "vitest";
import type { FilterNode } from "../../types/backend";
import { countConditions, filterToText, formatList, opsForType, parseList, updateAt, type GroupNode } from "./filterModel";

const tree: GroupNode = {
  type: "group",
  logic: "and",
  children: [
    { type: "condition", column: "age", op: "gte", value: "18" },
    {
      type: "group",
      logic: "or",
      children: [
        { type: "condition", column: "name", op: "contains", value: "o'neil" },
        { type: "condition", column: "email", op: "is_null" },
      ],
    },
  ],
};

describe("filter model", () => {
  it("renders a readable preview", () => {
    expect(filterToText(tree)).toBe("(age >= '18' AND (name contains 'o''neil' OR email IS NULL))");
  });

  it("updates and removes nodes by path", () => {
    const changed = updateAt(tree, [1, 0], (n) => ({ ...(n as Extract<FilterNode, { type: "condition" }>), value: "x" }));
    expect(filterToText(changed)).toContain("name contains 'x'");
    expect(filterToText(tree)).toContain("o''neil");
    const removed = updateAt(tree, [1, 1], () => null);
    expect(countConditions(removed)).toBe(2);
  });

  it("disabled conditions are skipped", () => {
    const t = updateAt(tree, [0], (n) => ({ ...n, enabled: false }) as FilterNode);
    expect(filterToText(t)).toBe("(name contains 'o''neil' OR email IS NULL)");
    expect(countConditions(t)).toBe(2);
  });

  it("offers type-appropriate operators", () => {
    expect(opsForType("boolean")).toContain("is_true");
    expect(opsForType("integer")).not.toContain("contains");
    expect(opsForType("text")).toContain("contains");
  });

  it("parses IN lists with quoted commas", () => {
    expect(parseList('a, b ,"c, d", "say ""hi"""')).toEqual(["a", "b", "c, d", 'say "hi"']);
    expect(parseList("")).toEqual([]);
    expect(parseList(formatList(["x,y", "z"]))).toEqual(["x,y", "z"]);
  });
});
