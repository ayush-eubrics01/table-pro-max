import { describe, expect, it } from "vitest";
import { cellText, isEveryDocument, parseDoc } from "./mongoText";

describe("Extended JSON in table cells", () => {
  it("shows MongoDB's types the way the shell does", () => {
    expect(cellText({ $oid: "65f1a2b3c4d5e6f708091a2b" })).toBe('ObjectId("65f1a2b3c4d5e6f708091a2b")');
    expect(cellText({ $date: "2024-01-02T03:04:05.678Z" })).toBe("2024-01-02T03:04:05.678Z");
    expect(cellText({ $date: { $numberLong: "-62135596800000" } })).toBe("-62135596800000");
    expect(cellText({ $numberDecimal: "12.50" })).toBe("12.50");
    expect(cellText({ $numberLong: "9007199254740993" })).toBe("9007199254740993");
    expect(cellText({ $binary: { base64: "3q0=", subType: "00" } })).toBe('Binary("3q0=")');
    expect(cellText(null)).toBe("null");
    expect(cellText(undefined)).toBe("");
    expect(cellText("é 漢字")).toBe("é 漢字");
    expect(cellText(1.5)).toBe("1.5");
    expect(cellText(true)).toBe("true");
    expect(cellText({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(cellText({ big: "x".repeat(400) }).length).toBeLessThanOrEqual(201);
  });

  it("keeps integers too large for a JavaScript number exact", () => {
    const d = parseDoc('{ "_id": 9007199254740993, "n": -9223372036854775808, "ok": 42, "f": 1.5e300, "s": "9007199254740993 in text" }');
    expect(cellText(d._id)).toBe("9007199254740993");
    expect(cellText(d.n)).toBe("-9223372036854775808");
    expect(d.ok).toBe(42);
    expect(d.f).toBe(1.5e300);
    expect(d.s).toBe("9007199254740993 in text");
    expect(cellText(parseDoc('{ "a": [12345678901234567890, "q\\"9007199254740993"] }').a)).toBe('[{"$numberLong":"12345678901234567890"},"q\\"9007199254740993"]');
  });

  it("reads documents and recognises a filter for every document", () => {
    expect(parseDoc('{ "_id": 1, "a": "b" }')).toEqual({ _id: 1, a: "b" });
    expect(parseDoc("not json")).toEqual({});
    expect(isEveryDocument("")).toBe(true);
    expect(isEveryDocument("  {  }  ")).toBe(true);
    expect(isEveryDocument('{ "status": "paid" }')).toBe(false);
  });
});
