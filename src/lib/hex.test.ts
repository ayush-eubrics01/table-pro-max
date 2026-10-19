import { describe, expect, it } from "vitest";
import { parseHex } from "./hex";

describe("parseHex", () => {
  it("reads hex as written by databases and tools", () => {
    for (const input of ["DEADbeef", "\\xdeadbeef", "0xDEADBEEF", "X'deadbeef'", "x'DEADBEEF'", "de ad\nbe\tef", "de:ad:be:ef"]) {
      expect(parseHex(input), input).toBe("deadbeef");
    }
    expect(parseHex("")).toBe("");
    expect(parseHex("0x")).toBe("");
  });

  it("refuses what isn't whole bytes of hex", () => {
    for (const input of ["abc", "zz", "0xg0", "hello", "X'dead", "\\x\\xde"]) expect(parseHex(input), input).toBeNull();
  });
});
