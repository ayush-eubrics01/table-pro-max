import { describe, expect, it } from "vitest";
import { referencedTables } from "./QueryTab";

describe("referencedTables", () => {
  it("finds tables after FROM, JOIN, UPDATE and INTO", () => {
    const sql = `select * from users u join "audit"."events" e on e.uid = u.id; update orders set x = 1; insert into \`shop\`.items values (1)`;
    expect(referencedTables(sql, "public")).toEqual([
      { schema: "public", table: "users" },
      { schema: "audit", table: "events" },
      { schema: "public", table: "orders" },
      { schema: "shop", table: "items" },
    ]);
  });

  it("deduplicates and ignores keywords in other positions", () => {
    expect(referencedTables("select fromage from users, users", "s")).toEqual([{ schema: "s", table: "users" }]);
  });
});
