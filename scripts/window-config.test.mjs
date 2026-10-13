import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const main = (p) => read(p).app.windows.find((w) => w.label === "main");
const SIZE = { width: 1360, height: 860, minWidth: 900, minHeight: 560, resizable: true };

describe("window chrome", () => {
  it("draws its own title bar on Windows and Linux", () => {
    for (const os of ["linux", "windows"]) {
      const w = main(`src-tauri/tauri.${os}.conf.json`);
      expect(w.decorations, os).toBe(false);
      expect(w).toMatchObject(SIZE);
    }
  });

  it("keeps the native traffic lights on macOS, under an overlay title bar", () => {
    const w = main("src-tauri/tauri.macos.conf.json");
    expect(w).toMatchObject({ ...SIZE, titleBarStyle: "Overlay", hiddenTitle: true });
    // Centre the 14 px traffic lights in the 42 px bar (the default suits a 28 px one).
    expect(w.trafficLightPosition).toEqual({ x: 14, y: 14 });
    expect(w.decorations).not.toBe(false);
  });

  it("grants only the window permissions the title bar needs", () => {
    const perms = read("src-tauri/capabilities/default.json").permissions.filter((p) => p.startsWith("core:window"));
    expect([...perms].sort()).toEqual(
      [
        "core:window:allow-close",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-is-maximized",
        "core:window:allow-minimize",
        "core:window:allow-set-title",
        "core:window:allow-start-dragging",
        "core:window:allow-toggle-maximize",
      ].sort(),
    );
  });
});
