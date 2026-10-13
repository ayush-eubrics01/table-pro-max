import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_HEIGHT } from "./DataGrid";

describe("grid row height", () => {
  it("matches the --row-height token, so the virtualizer and CSS agree", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const css = /--row-height:\s*(\d+)px/.exec(tokens)?.[1];
    expect(ROW_HEIGHT).toBe(Number(css));
    expect(ROW_HEIGHT).toBe(30);
  });
});
