import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CVD_TYPES, ENVS, contrast, deltaE, failures, parseThemes, simulate } from "./theme-check.mjs";

const css = readFileSync("src/styles/tokens.css", "utf8");
const themes = parseThemes(css);
const SHARED = /^--(font-|text-(xs|sm|md|lg|xl)$|space-|radius-|[a-z-]*height$)/;

describe("theme checker", () => {
  it("computes WCAG contrast and OKLab distance", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(deltaE("#4ED6A0", "#4ED6A0")).toBe(0);
    expect(deltaE("#000000", "#FFFFFF")).toBeCloseTo(100, 0);
    // Red and green move closer for a protanope; grey is unchanged.
    expect(deltaE(simulate("#ff0000", "protanopia"), simulate("#00ff00", "protanopia"))).toBeLessThan(deltaE("#ff0000", "#00ff00"));
    expect(simulate("#808080", "deuteranopia")).toBe("#808080");
  });

  it("reports a pair below its target and a missing token", () => {
    const theme = { "--text": "#777777", "--bg": "#888888" };
    const f = failures(theme);
    expect(f.some((x) => x.startsWith("--text on --bg"))).toBe(true);
    expect(f.some((x) => x.includes("missing --surface"))).toBe(true);
  });
});

describe("theme tokens", () => {
  it("dark is identical whether chosen in Settings or followed from the system", () => {
    expect(themes.darkMedia).toEqual(themes.darkAttr);
  });

  it("both themes define the same colour tokens", () => {
    const lightColours = Object.keys(themes.light).filter((k) => !SHARED.test(k)).sort();
    expect(Object.keys(themes.darkAttr).sort()).toEqual(lightColours);
  });

  it("text, icons, focus and environment colours are readable in both themes", () => {
    expect(failures(themes.light)).toEqual([]);
    expect(failures(themes.dark)).toEqual([]);
  });

  it("environment colours are distinct from each other and from the accent", () => {
    for (const [name, theme] of [["light", themes.light], ["dark", themes.dark]]) {
      const keys = [...ENVS.map((e) => `--env-${e}`), "--accent"];
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const d = deltaE(theme[keys[i]], theme[keys[j]]);
          expect(d, `${name}: ${keys[i]} vs ${keys[j]}`).toBeGreaterThanOrEqual(15);
        }
    }
  });

  it("uses explicit tokens instead of color-mix()", () => {
    expect(css).not.toMatch(/color-mix/);
  });

  it("draws selects itself: no native look, a token-coloured arrow, room for it", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const rule = app.match(/\n\.select \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/appearance:\s*none/);
    expect(rule).toMatch(/background-image:[^;]*var\(--text-muted\)/);
    expect(rule).toMatch(/padding-right:\s*30px/);
    expect(rule).toMatch(/-webkit-appearance:\s*none/);
    // Nothing later may reset the arrow with the background shorthand, and focus keeps its ring.
    const after = app.slice(app.indexOf(rule) + rule.length);
    expect(after).not.toMatch(/\.select(?![\w-])[^{,]*\{[^}]*\bbackground:/);
    expect(app).toMatch(/\.select:focus,?[^{]*\{[^}]*box-shadow:/);
    // Forced colours drop gradient images: hand the arrow back to the system there.
    expect(app).toMatch(/@media \(forced-colors: active\) \{\s*\.select \{[^}]*appearance:\s*auto/);
  });

  it("no source file uses color-mix()", () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const offenders = walk("src")
      .filter((f) => /\.(css|ts|tsx)$/.test(f) && !/\.test\./.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("color-mix("));
    expect(offenders).toEqual([]);
  });

  it("environment colours stay apart for protanopia and deuteranopia (production most of all)", () => {
    for (const [name, theme] of [["light", themes.light], ["dark", themes.dark]]) {
      for (const type of CVD_TYPES) {
        for (let i = 0; i < ENVS.length; i++)
          for (let j = i + 1; j < ENVS.length; j++) {
            const [a, b] = [ENVS[i], ENVS[j]];
            const d = deltaE(simulate(theme[`--env-${a}`], type), simulate(theme[`--env-${b}`], type));
            const floor = a === "production" || b === "production" ? 8 : 6;
            expect(d, `${name}/${type}: ${a} vs ${b}`).toBeGreaterThanOrEqual(floor);
          }
      }
    }
  });

  it("production badges are filled and placeholders use the checked faint text colour", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const prod = /\.env-badge\[data-env="production"\]\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(prod).toMatch(/background:\s*var\(--env-production\)/);
    expect(prod).toMatch(/color:\s*var\(--env-production-on\)/);
    const placeholder = /\.input::placeholder,\s*\.textarea::placeholder\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(placeholder).toMatch(/color:\s*var\(--text-faint\)/);
  });

  it("keyboard focus is a solid accent ring on inputs and an accent bar on menu items", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const input = /\.input:focus,\s*\.select:focus,\s*\.textarea:focus\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(input).toMatch(/border-color:\s*var\(--focus\)/);
    expect(input).toMatch(/box-shadow:\s*0 0 0 1px var\(--focus\)/);
    const menu = /\.menu button:focus-visible\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(menu).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--focus\)/);
    expect(menu).toMatch(/background:\s*var\(--surface-active\)/);
  });

  it("secondary status bar text stays readable on the production tint", () => {
    const app = readFileSync("src/styles/app.css", "utf8");
    const rule = /\.statusbar\[data-env="production"\] \.mono,\s*\.statusbar\[data-env="production"\] \.version\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--text-muted\)/);
  });
});
