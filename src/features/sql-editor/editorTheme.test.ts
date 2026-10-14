import { describe, expect, it } from "vitest";
import { EDITOR_THEME } from "./SqlEditor";

describe("EDITOR_THEME", () => {
  it("takes every colour from tokens and gives the gutter room", () => {
    const values = Object.values(EDITOR_THEME).flatMap((rule) => Object.values(rule));
    expect(values.some((v) => v.includes("color-mix"))).toBe(false);
    expect(EDITOR_THEME[".cm-activeLine"]!.backgroundColor).toBe("var(--editor-active-line)");
    expect(EDITOR_THEME[".cm-searchMatch"]!.backgroundColor).toBe("var(--search-match)");
    expect(EDITOR_THEME[".cm-gutters"]!.backgroundColor).toBe("var(--surface)");
    expect(EDITOR_THEME[".cm-lineNumbers .cm-gutterElement"]!.minWidth).toBe("32px");
  });
});
