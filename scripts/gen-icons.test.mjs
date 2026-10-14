import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS, buildModule, extractPath } from "./gen-icons.mjs";
import { ICON_PATHS } from "../src/components/icons.generated";

const svg = (d) => `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 -960 960 960"><path d="${d}"/></svg>`;

describe("gen-icons", () => {
  it("writes a sorted, typed map of path data", () => {
    const out = buildModule(["search", "add"], (n) => svg(`M${n}`));
    expect(out).toContain('  add: "Madd",\n  search: "Msearch",');
    expect(out).toContain("export type IconName = keyof typeof ICON_PATHS;");
    expect(out.indexOf("add:")).toBeLessThan(out.indexOf("search:"));
  });

  it("refuses unknown icons, odd SVGs and unsafe names", () => {
    expect(() => buildModule(["nope"], () => { throw new Error("Unknown icon: nope"); })).toThrow("Unknown icon: nope");
    expect(() => extractPath('<svg viewBox="0 0 24 24"><path d="M0"/></svg>', "x")).toThrow("Unexpected SVG for x");
    expect(() => extractPath(svg("M0").replace("</svg>", '<path d="M1"/></svg>'), "x")).toThrow("Unexpected SVG for x");
    expect(() => buildModule(["../etc"], () => svg("M0"))).toThrow("Invalid icon name");
  });

  it("the committed module matches the icon list", () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICONS].sort());
  });

  it("the committed module is exactly what the generator writes from the installed icons", () => {
    const read = (name) => readFileSync(`node_modules/@material-symbols/svg-300/rounded/${name}.svg`, "utf8");
    expect(readFileSync("src/components/icons.generated.ts", "utf8")).toBe(buildModule(ICONS, read));
  });
});
