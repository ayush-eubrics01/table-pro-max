import { describe, expect, it } from "vitest";
import { cellCopy, cellDisplay, cellParam, cellTone, isLargeText, isNotLoaded, isPartial, needsFetch, previewText, sizeLabel } from "./cells";

describe("cellTone", () => {
  it("tags enum values and colours booleans, never NULL or other types", () => {
    expect(cellTone("status_enum", "DRAFT")).toBe("enum");
    expect(cellTone("enum('a','b')", "a")).toBe("enum");
    expect(cellTone("status_enum", null)).toBeNull();
    expect(cellTone("boolean", "true")).toBe("true");
    expect(cellTone("bool", "f")).toBe("false");
    expect(cellTone("boolean", null)).toBeNull();
    expect(cellTone("text", "true")).toBeNull();
    expect(cellTone("integer", "1")).toBeNull();
  });
});

describe("placeholder cells", () => {
  const nl = { $notLoaded: true } as const;
  const part = { $partial: "abc", length: 9000 };
  it("recognises and never round-trips placeholders", () => {
    expect(isNotLoaded(nl)).toBe(true);
    expect(isPartial(part)).toBe(true);
    expect(needsFetch(nl) && needsFetch(part)).toBe(true);
    expect(needsFetch("x") || needsFetch(null) || needsFetch(undefined)).toBe(false);
    expect(cellParam(nl)).toBeUndefined();
    expect(cellParam(part)).toBeUndefined();
    expect(cellCopy(nl)).toBe("");
    expect(cellDisplay(nl)).toBe("Not loaded");
    expect(cellDisplay(part)).toBe("abc…");
  });
  it("labels sizes and previews long text", () => {
    expect(sizeLabel("jsonb", 18_432)).toBe("18.0 KB");
    expect(sizeLabel("text", 4210)).toBe("4,210 chars");
    expect(isLargeText("x".repeat(257), 256)).toBe(true);
    expect(isLargeText("x".repeat(256), 256)).toBe(false);
    expect(previewText("y".repeat(300))).toBe("y".repeat(80));
  });
});
