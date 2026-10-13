import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

function files(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

describe("bundled assets", () => {
  it("ships the Geist fonts and no IBM Plex", () => {
    expect(deps["@fontsource-variable/geist"]).toBeTruthy();
    expect(deps["@fontsource-variable/geist-mono"]).toBeTruthy();
    expect(Object.keys(deps).filter((d) => d.includes("ibm-plex"))).toEqual([]);
    const main = read("src/main.tsx");
    expect(main).toContain('import "@fontsource-variable/geist";');
    expect(main).toContain('import "@fontsource-variable/geist-mono";');
  });

  it("loads no fonts, styles or icons from the network", () => {
    const sources = [read("index.html"), ...files("src").filter((f) => /\.(css|tsx?|html)$/.test(f)).map(read)];
    for (const s of sources) expect(s).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import\s+url\(\s*["']?https?:/);
  });

  it("uses the bundled Icon component, not lucide-react", () => {
    expect(deps["lucide-react"]).toBeUndefined();
    const offenders = files("src").filter((f) => /\.tsx?$/.test(f) && read(f).includes("lucide-react"));
    expect(offenders).toEqual([]);
  });

  it("tracks no Python bytecode or other build output", () => {
    const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n");
    expect(tracked.filter((f) => /__pycache__|\.pyc$/.test(f))).toEqual([]);
  });
});
