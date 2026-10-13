import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEADER_HEIGHT, ROW_HEIGHT } from "./DataGrid";

describe("grid row height", () => {
  it("matches the --row-height token, so the virtualizer and CSS agree", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const css = /--row-height:\s*(\d+)px/.exec(tokens)?.[1];
    expect(ROW_HEIGHT).toBe(Number(css));
    expect(ROW_HEIGHT).toBe(30);
  });

  it("uses the same height for the sticky header, which is styled with --row-height", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const header = /\.grid-header \{[^}]*height:\s*var\(--row-height\)/.test(app);
    expect(header).toBe(true);
    expect(HEADER_HEIGHT).toBe(ROW_HEIGHT);
  });
});
