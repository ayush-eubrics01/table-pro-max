import { describe, expect, it } from "vitest";
import type { ColumnInfo, ColumnMeta, TableStructure } from "../../types/backend";
import { linkFilter, linkLabel, resultLinks, tableLinks } from "./fkLinks";

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
    expect(linkLabel(c!, row)).toBe("Open customers where id = 42");
    const s = tableLinks(orders)[2]![0]!;
    expect(linkLabel(s, row)).toBe("Open shops where region = eu and code = 7");
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
});
