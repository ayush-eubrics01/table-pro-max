import { describe, expect, it } from "vitest";
import { cellTone } from "./cells";

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
