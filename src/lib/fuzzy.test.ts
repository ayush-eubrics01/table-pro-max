import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyScore, rank } from "./fuzzy";

describe("fuzzy ranking", () => {
  it("prefers exact, prefix, then substring, then subsequence", () => {
    const items = ["user_roles", "users", "audit_users", "u_s_e_r"];
    expect(rank(items, "users", (x) => x)).toEqual(["users", "audit_users", "user_roles"]);
    // A typo is forgiven only where the corrected word appears unbroken.
    expect(fuzzyScore("stage", "postgres")).toBe(-1);
    expect(rank(items, "user", (x) => x)[0]).toBe("users");
  });

  it("matches word-boundary abbreviations", () => {
    expect(fuzzyScore("ur", "user_roles")).toBeGreaterThan(0);
    expect(fuzzyScore("zz", "user_roles")).toBe(-1);
  });

  it("returns everything for an empty query, capped", () => {
    expect(rank(Array.from({ length: 100 }, (_, i) => `t${i}`), "", (x) => x, 10)).toHaveLength(10);
  });
});

describe("forgiving search", () => {
  const found = (q: string, ...fields: string[]) => fuzzyMatch(q, fields) !== null;

  it("finds a table however its name is typed", () => {
    for (const q of ["order items", "items order", "ordit", "oi", "odrer_items", "orderr_items", "ordez items", "ORDER_ITEMS"]) {
      expect(found(q, "order_items"), q).toBe(true);
    }
    expect(found("cust ord", "customer_orders")).toBe(true);
    // A word may match another field: the schema or the connection.
    expect(found("public items", "order_items", "public")).toBe(true);
  });

  it("does not match what was not typed", () => {
    expect(found("xyz", "order_items")).toBe(false);
    expect(found("oz", "order_items")).toBe(false); // short words get no typo allowance
    expect(found("order zzz", "order_items")).toBe(false); // every word must match
    expect(found("payments", "order_items")).toBe(false);
  });

  it("ranks exact, then prefix, then word starts, then the rest, and typos last", () => {
    const names = ["order_items_archive", "border_items", "order_items", "orders_items_x", "ordr_itms"];
    // One typo per word: `ordr_itms` still matches, after every exact match.
    expect(rank(names, "order_items", (x) => x)).toEqual(["order_items", "order_items_archive", "border_items", "orders_items_x", "ordr_itms"]);
    expect(rank(["odrer_log", "order_log"], "order", (x) => x)).toEqual(["order_log", "odrer_log"]);
    // The name counts more than the other fields.
    expect(rank([["users", "public"], ["public_users", "x"]], "public", (x) => x)[0]).toEqual(["public_users", "x"]);
  });

  it("reports the matched characters for highlighting", () => {
    expect(fuzzyMatch("order items", ["order_items"])!.positions[0]).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(fuzzyMatch("public items", ["order_items", "public"])!.positions).toEqual([[6, 7, 8, 9, 10], [0, 1, 2, 3, 4, 5]]);
  });
});
