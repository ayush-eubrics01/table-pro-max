import { describe, expect, it } from "vitest";
import { compact, niceTicks, shortLabel, toDataset, toSlices } from "./chartData";

const cols = [
  { name: "day", typeName: "" },
  { name: "orders", typeName: "" },
  { name: "note", typeName: "" },
  { name: "revenue", typeName: "" },
];
const rows = [
  ["2026-10-01", "10", "x", "100.5"],
  ["2026-10-02", "12", "y", null],
  ["2026-10-03", null, "z", "80"],
];

describe("chart data", () => {
  it("uses the first column as x and numeric columns as series", () => {
    const d = toDataset(cols, rows);
    expect(d.x).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(d.series.map((s) => s.name)).toEqual(["orders", "revenue"]);
    expect(d.series[1]!.values).toEqual([100.5, null, 80]);
  });

  it("folds small slices into Other and drops non-positive values", () => {
    const r = [["a", "50"], ["b", "20"], ["c", "10"], ["d", "5"], ["e", "4"], ["f", "3"], ["g", "2"], ["h", "-1"]];
    const s = toSlices([{ name: "k", typeName: "" }, { name: "v", typeName: "" }], r, 5);
    expect(s.map((x) => x.label)).toEqual(["a", "b", "c", "d", "e", "Other"]);
    expect(s[5]!.value).toBe(5);
  });

  it("formats compactly and picks nice ticks", () => {
    expect(compact(1284)).toBe("1,284");
    expect(compact(12900)).toBe("12.9K");
    expect(compact(4_200_000)).toBe("4.2M");
    expect(niceTicks(0, 87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-30, 70)[0]).toBeLessThanOrEqual(-30);
  });

  it("shortens timestamps", () => {
    expect(shortLabel("2026-10-01 00:00:00+00")).toBe("2026-10-01");
    expect(shortLabel("2026-10-01 14:30:00")).toBe("10-01 14:30");
    expect(shortLabel("Netherlands")).toBe("Netherlands");
  });
});
