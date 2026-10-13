import { describe, expect, it } from "vitest";
import { fuzzyScore, rank } from "./fuzzy";

describe("fuzzy ranking", () => {
  it("prefers exact, prefix, then substring, then subsequence", () => {
    const items = ["user_roles", "users", "audit_users", "u_s_e_r"];
    expect(rank(items, "users", (x) => x)).toEqual(["users", "audit_users", "user_roles"].filter((x) => fuzzyScore("users", x) >= 0));
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
