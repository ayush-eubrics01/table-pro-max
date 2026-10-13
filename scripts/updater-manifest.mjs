#!/usr/bin/env node
// Builds latest.json for the Tauri updater from the files collected by release.yml.
// Usage: node scripts/updater-manifest.mjs --version 0.2.0 --repo owner/name \
//          --notes docs/releases/v0.2.0.md --dir release-assets --out release-assets/latest.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One updater file per install type. Names match the collect step in release.yml. */
export const PLATFORMS = [
  ["linux-x86_64-appimage", (v) => `table-pro-max_${v}_amd64.AppImage`],
  ["linux-x86_64-deb", (v) => `table-pro-max_${v}_amd64.deb`],
  ["linux-x86_64-rpm", (v) => `table-pro-max-${v}-1.x86_64.rpm`],
  ["windows-x86_64-nsis", (v) => `table-pro-max_${v}_x64-setup.exe`],
  ["windows-x86_64-msi", (v) => `table-pro-max_${v}_x64_en-US.msi`],
  ["darwin-aarch64-app", (v) => `table-pro-max_${v}_aarch64.app.tar.gz`],
];

/** Used by an app that does not know how it was installed. */
export const FALLBACKS = {
  "linux-x86_64": "linux-x86_64-appimage",
  "windows-x86_64": "windows-x86_64-nsis",
  "darwin-aarch64": "darwin-aarch64-app",
};

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function buildManifest({ version, repo, notes, pubDate, readSignature }) {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!REPO.test(repo) || repo.includes("..")) throw new Error(`Not a GitHub repository: ${repo}`);
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const platforms = {};
  for (const [key, name] of PLATFORMS) {
    const file = name(version);
    const signature = readSignature(`${file}.sig`).trim();
    if (!signature) throw new Error(`Empty signature: ${file}.sig`);
    platforms[key] = { url: `${base}/${encodeURIComponent(file)}`, signature };
  }
  for (const [key, target] of Object.entries(FALLBACKS)) platforms[key] = platforms[target];
  return { version, notes, pub_date: pubDate, platforms };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      repo: { type: "string" },
      notes: { type: "string" },
      dir: { type: "string" },
      out: { type: "string" },
    },
  });
  for (const k of ["version", "repo", "notes", "dir", "out"]) if (!values[k]) throw new Error(`--${k} is required`);
  const manifest = buildManifest({
    version: values.version,
    repo: values.repo,
    notes: readFileSync(values.notes, "utf8"),
    pubDate: new Date().toISOString(),
    readSignature: (file) => {
      try {
        return readFileSync(join(values.dir, file), "utf8");
      } catch {
        throw new Error(`Missing signature: ${file}`);
      }
    },
  });
  writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${values.out} with ${Object.keys(manifest.platforms).length} targets`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
