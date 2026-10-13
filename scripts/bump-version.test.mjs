import { describe, expect, it } from "vitest";
import { bumpFiles } from "./bump-version.mjs";

const files = () => ({
  "Cargo.toml": '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n[workspace.dependencies]\nfoo = { version = "0.1.0" }\n',
  "Cargo.lock": '[[package]]\nname = "serde"\nversion = "0.1.0"\n\n[[package]]\nname = "table-pro-max"\nversion = "0.1.0"\n\n[[package]]\nname = "tpm-core"\nversion = "0.1.0"\n',
  "package.json": '{\n  "name": "table-pro-max",\n  "version": "0.1.0"\n}\n',
  "package-lock.json": '{\n  "name": "table-pro-max",\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "name": "table-pro-max",\n      "version": "0.1.0"\n    },\n    "node_modules/x": {\n      "version": "0.1.0"\n    }\n  }\n}\n',
  "src-tauri/tauri.conf.json": '{\n  "productName": "Table Pro Max",\n  "version": "0.1.0"\n}\n',
});

describe("bump-version", () => {
  it("sets the app version everywhere it is declared, and nowhere else", () => {
    const out = bumpFiles(files(), "0.2.0");
    expect(out["Cargo.toml"]).toContain('[workspace.package]\nversion = "0.2.0"');
    expect(out["Cargo.toml"]).toContain('foo = { version = "0.1.0" }');
    expect(out["Cargo.lock"]).toContain('name = "table-pro-max"\nversion = "0.2.0"');
    expect(out["Cargo.lock"]).toContain('name = "tpm-core"\nversion = "0.2.0"');
    expect(out["Cargo.lock"]).toContain('name = "serde"\nversion = "0.1.0"');
    expect(JSON.parse(out["package.json"]).version).toBe("0.2.0");
    const lock = JSON.parse(out["package-lock.json"]);
    expect([lock.version, lock.packages[""].version, lock.packages["node_modules/x"].version]).toEqual(["0.2.0", "0.2.0", "0.1.0"]);
    expect(JSON.parse(out["src-tauri/tauri.conf.json"]).version).toBe("0.2.0");
  });

  it("accepts pre-release versions", () => {
    expect(JSON.parse(bumpFiles(files(), "0.2.0-rc.1")["package.json"]).version).toBe("0.2.0-rc.1");
  });

  it("refuses invalid versions and files it cannot update", () => {
    expect(() => bumpFiles(files(), "v0.2.0")).toThrow("Not a release version");
    const broken = files();
    broken["Cargo.toml"] = "[workspace]\n";
    expect(() => bumpFiles(broken, "0.2.0")).toThrow("Cargo.toml");
  });
});
