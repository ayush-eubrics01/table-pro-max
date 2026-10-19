import { describe, expect, it } from "vitest";
import type { ColumnInfo, ColumnMeta, TableStructure } from "../../types/backend";
import { firstLink, linkFilter, linkLabel, referencingItems, resultLinks, tableLinks } from "./fkLinks";

const col = (name: string, primaryKey: number | null = null): ColumnInfo => ({
  name,
  dataType: "integer",
  nullable: true,
  default: null,
  primaryKey,
  autoIncrement: false,
  comment: null,
});
const orders: TableStructure = {
  schema: "public",
  name: "orders",
  kind: "table",
  columns: [col("id", 1), col("customer_id"), col("region"), col("shop")],
  indexes: [],
  constraints: [],
  triggers: [],
  foreignKeys: [
    { name: "fk_c", columns: ["customer_id"], refSchema: "public", refTable: "customers", refColumns: ["id"], onUpdate: "", onDelete: "" },
    { name: "fk_s", columns: ["region", "shop"], refSchema: "public", refTable: "shops", refColumns: ["region", "code"], onUpdate: "", onDelete: "" },
    { name: "fk_c2", columns: ["customer_id"], refSchema: "public", refTable: "accounts", refColumns: ["owner"], onUpdate: "", onDelete: "" },
  ],
};

describe("fkLinks", () => {
  it("maps table columns to their foreign keys, composite keys included", () => {
    const links = tableLinks(orders);
    expect(links[0]).toEqual([]);
    expect(links[1]!.map((l) => l.fk.refTable)).toEqual(["customers", "accounts"]);
    expect(links[2]![0]!.columns).toEqual([2, 3]);
    expect(links[3]![0]!.fk.name).toBe("fk_s");
  });

  it("builds the target filter and label, and refuses unusable values", () => {
    const [c] = tableLinks(orders)[1]!;
    const row = ["1", "42", "eu", "7"];
    expect(linkFilter(c!, row)).toEqual({
      type: "group",
      logic: "and",
      children: [{ type: "condition", column: "id", op: "eq", value: "42", enabled: true }],
    });
    expect(linkLabel(c!, row)).toBe("Open customers where id = '42'");
    const s = tableLinks(orders)[2]![0]!;
    expect(linkLabel(s, row)).toBe("Open shops where region = 'eu' and code = '7'");
    expect(linkFilter(s, ["1", "42", "eu", null])).toBeNull();
    expect(linkFilter(c!, ["1", null, "eu", "7"])).toBeNull();
    expect(linkFilter(c!, ["1", { $notLoaded: true }, "eu", "7"])).toBeNull();
    expect(linkFilter(c!, ["1", { $partial: "4", length: 900 }, "eu", "7"])).toBeNull();
    expect(linkFilter(c!, ["1", { $bytes: "00", size: 1 }, "eu", "7"])).toBeNull();
  });

  it("links result columns through their origins, each duplicate with its own value", () => {
    const o = (column: string) => ({ schema: "public", table: "orders", column });
    const cols: ColumnMeta[] = [
      { name: "id", typeName: "int4", origin: o("id") },
      { name: "customer_id", typeName: "int4", origin: o("customer_id") },
      { name: "again", typeName: "int4", origin: o("customer_id") },
      { name: "region", typeName: "text", origin: o("region") },
      { name: "n", typeName: "int8" },
    ];
    const links = resultLinks(cols, [orders]);
    expect(links[1]!.map((l) => l.columns)).toEqual([[1], [1]]);
    expect(links[2]!.map((l) => l.columns)).toEqual([[2], [2]]);
    expect(links[3]).toEqual([]); // composite fk_s: `shop` is not in the result
    expect(links[4]).toEqual([]);
    const twice: ColumnMeta[] = [...cols, { name: "shop", typeName: "int4", origin: o("shop") }, { name: "region2", typeName: "text", origin: o("region") }];
    expect(resultLinks(twice, [orders])[5]).toEqual([]); // `region` appears twice: the composite key is ambiguous
  });

  it("does no row work for unlinked columns and uses the first usable foreign key", () => {
    const links = tableLinks(orders);
    let calls = 0;
    const row = () => {
      calls++;
      return ["1", "42", null, "7"];
    };
    expect(firstLink(links, 0, row)).toBeNull();
    expect(calls).toBe(0);
    // `region` is only in the composite key, whose `region` part is NULL here: no link.
    expect(firstLink(links, 2, row)).toBeNull();
    const twoKeys = { ...orders, foreignKeys: [orders.foreignKeys[1]!, { ...orders.foreignKeys[0]!, columns: ["shop"], refTable: "stores" }] };
    const got = firstLink(tableLinks(twoKeys), 3, row);
    expect(got?.link.fk.refTable).toBe("stores"); // the composite key is unusable, the second one works
    expect(got?.label).toBe("Open stores where id = '7'");
  });

  it("skips foreign keys whose referenced columns are unknown", () => {
    const broken = { ...orders, foreignKeys: [{ ...orders.foreignKeys[0]!, refColumns: [""] }] };
    expect(tableLinks(broken)[1]).toEqual([]);
  });

  it("finds the rows that point at a row, by the columns each key holds", () => {
    const shops: TableStructure = { ...orders, name: "shops", columns: [col("region", 1), col("code", 2), col("name")], foreignKeys: [] };
    const keys = [
      { schema: "public", table: "orders", name: "fk_s", columns: ["region", "shop"], refColumns: ["region", "code"] },
      { schema: "sales", table: "visits", name: "fk_v", columns: ["shop_code"], refColumns: ["code"] },
      { schema: "public", table: "orders", name: "fk_s2", columns: ["ship_region", "ship_shop"], refColumns: ["region", "code"] },
    ];
    const items = referencingItems(keys, shops, ["eu", "S1", "Main"]);
    expect(items.map((i) => i.label)).toEqual([
      "Rows in orders that point here (region, shop)",
      "Rows in sales.visits that point here",
      "Rows in orders that point here (ship_region, ship_shop)",
    ]);
    expect(items[0]!.filter.children).toEqual([
      { type: "condition", column: "region", op: "eq", value: "eu", enabled: true },
      { type: "condition", column: "shop", op: "eq", value: "S1", enabled: true },
    ]);
    expect(items[1]!).toMatchObject({ schema: "sales", table: "visits" });
    // A NULL or unloaded value can't be pointed at; an unknown column is skipped.
    expect(referencingItems(keys, shops, [null, "S1", "Main"]).map((i) => i.table)).toEqual(["visits"]);
    expect(referencingItems([{ ...keys[1]!, refColumns: ["gone"] }], shops, ["eu", "S1", "Main"])).toEqual([]);
  });
});
