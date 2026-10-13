import { describe, expect, it } from "vitest";
import { FALLBACKS, PLATFORMS, buildManifest } from "./updater-manifest.mjs";

const REPO = "ayush-eubrics01/table-pro-max";
const signatures = (v) => Object.fromEntries(PLATFORMS.map(([, name]) => [`${name(v)}.sig`, `sig-of-${name(v)}\n`]));

function build(version, overrides = {}) {
  const sigs = { ...signatures(version), ...overrides };
  return buildManifest({
    version,
    repo: REPO,
    notes: "Notes with <b>markup</b>\nand lines",
    pubDate: "2026-10-13T00:00:00.000Z",
    readSignature: (file) => {
      if (!(file in sigs)) throw new Error(`Missing signature: ${file}`);
      return sigs[file];
    },
  });
}

describe("updater manifest", () => {
  it("has every install type plus the fallbacks", () => {
    const m = build("0.2.0");
    expect(Object.keys(m.platforms).sort()).toEqual(
      [...PLATFORMS.map(([k]) => k), ...Object.keys(FALLBACKS)].sort(),
    );
    expect(m.platforms["linux-x86_64-deb"]).toEqual({
      url: `https://github.com/${REPO}/releases/download/v0.2.0/table-pro-max_0.2.0_amd64.deb`,
      signature: "sig-of-table-pro-max_0.2.0_amd64.deb",
    });
    expect(m.platforms["linux-x86_64"]).toEqual(m.platforms["linux-x86_64-appimage"]);
    expect(m.platforms["windows-x86_64"]).toEqual(m.platforms["windows-x86_64-nsis"]);
    expect(m.platforms["darwin-aarch64"]).toEqual(m.platforms["darwin-aarch64-app"]);
    expect(m.version).toBe("0.2.0");
    expect(m.pub_date).toBe("2026-10-13T00:00:00.000Z");
  });

  it("points pre-release versions at their own tag", () => {
    const m = build("0.2.0-rc.1");
    expect(m.platforms["darwin-aarch64-app"].url).toBe(
      `https://github.com/${REPO}/releases/download/v0.2.0-rc.1/table-pro-max_0.2.0-rc.1_aarch64.app.tar.gz`,
    );
  });

  it("keeps the notes verbatim", () => {
    expect(build("0.2.0").notes).toBe("Notes with <b>markup</b>\nand lines");
  });

  it("fails when a signature is missing or empty", () => {
    const missing = signatures("0.2.0");
    delete missing["table-pro-max-0.2.0-1.x86_64.rpm.sig"];
    expect(() =>
      buildManifest({ version: "0.2.0", repo: REPO, notes: "", pubDate: "x", readSignature: (f) => {
        if (!(f in missing)) throw new Error(`Missing signature: ${f}`);
        return missing[f];
      } }),
    ).toThrow("Missing signature: table-pro-max-0.2.0-1.x86_64.rpm.sig");
    expect(() => build("0.2.0", { "table-pro-max_0.2.0_x64-setup.exe.sig": "  \n" })).toThrow("Empty signature");
  });

  it("rejects versions and repositories that are not valid", () => {
    expect(() => build("v0.2.0")).toThrow("Not a release version");
    expect(() => build("0.2")).toThrow("Not a release version");
    expect(() => buildManifest({ version: "0.2.0", repo: "a/b/../c", notes: "", pubDate: "x", readSignature: () => "s" })).toThrow(
      "Not a GitHub repository",
    );
  });
});
