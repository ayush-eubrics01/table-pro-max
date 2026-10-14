import { describe, expect, it } from "vitest";
import { formatJson, validateJson } from "./json";

describe("validateJson", () => {
  it("accepts valid documents", () => {
    for (const t of ['{"a": [1, 2.5e3, true, null, "x"]}', "[]", '"s"', "12345678901234567890", ' { "é": "\\u00e9" } ']) {
      expect(validateJson(t)).toEqual({ ok: true });
    }
  });
  it("reports line and column of the first error", () => {
    expect(validateJson('{\n  "a": 1,\n  }')).toMatchObject({ ok: false, line: 3, column: 3 });
    expect(validateJson('{"a" 1}')).toMatchObject({ ok: false, line: 1, column: 6 });
    expect(validateJson("")).toMatchObject({ ok: false, line: 1, column: 1, message: "Empty document" });
    expect(validateJson("[1,]")).toMatchObject({ ok: false, line: 1, column: 4 });
    expect(validateJson('{"a": 1} x')).toMatchObject({ ok: false, line: 1, column: 10 });
    expect(validateJson("NaN").ok).toBe(false);
  });
});

describe("formatJson", () => {
  it("indents with two spaces and never changes literals", () => {
    const src = '{"big":12345678901234567890,"f":1.0,"s":"\\u00e9\\n","b":[true,null],"o":{}}';
    expect(formatJson(src)).toBe(
      '{\n  "big": 12345678901234567890,\n  "f": 1.0,\n  "s": "\\u00e9\\n",\n  "b": [\n    true,\n    null\n  ],\n  "o": {}\n}',
    );
    expect(formatJson('{"z":1,"a":2}')).toBe('{\n  "z": 1,\n  "a": 2\n}');
    expect(() => formatJson("{")).toThrow();
  });
});
