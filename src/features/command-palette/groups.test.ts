import { describe, expect, it } from "vitest";
import { groupResults } from "./groups";

describe("groupResults", () => {
  it("groups by kind in a fixed order, keeping rank order inside each group", () => {
    const items = [
      { kind: "connection", label: "c1" },
      { kind: "object", label: "o1" },
      { kind: "action", label: "a1" },
      { kind: "object", label: "o2" },
    ];
    const groups = groupResults(items);
    expect(groups.map((g) => g.title)).toEqual(["Actions", "Tables and views", "Connections"]);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(["o1", "o2"]);
    expect(groups.flatMap((g) => g.items).map((i) => i.label)).toEqual(["a1", "o1", "o2", "c1"]);
  });

  it("puts the group of the best match first when searching", () => {
    const items = [
      { kind: "connection", label: "prod" },
      { kind: "object", label: "product" },
      { kind: "action", label: "Settings" },
    ];
    expect(groupResults(items, true).map((g) => g.title)).toEqual(["Connections", "Tables and views", "Actions"]);
    expect(groupResults(items, true).flatMap((g) => g.items)[0]!.label).toBe("prod");
  });
});
