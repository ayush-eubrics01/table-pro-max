#!/usr/bin/env node
// Sets the app version in every file that declares it (Cargo workspace + lock, npm package +
// lock, tauri.conf.json). The release workflow refuses a tag that does not match.
// Usage: node scripts/bump-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FILES = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "src-tauri/tauri.conf.json"];
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_CRATES = ["table-pro-max", "tpm-core"];

function replaceOnce(text, pattern, replacement, file) {
  if (!pattern.test(text)) throw new Error(`${file}: could not find the version to update`);
  return text.replace(pattern, replacement);
}

/** Returns the files with the new version; `files` maps each path in FILES to its contents. */
export function bumpFiles(files, version) {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  const out = { ...files };
  out["Cargo.toml"] = replaceOnce(
    files["Cargo.toml"],
    /(\[workspace\.package\]\nversion = ")[^"]+(")/,
    `$1${version}$2`,
    "Cargo.toml",
  );
  let lock = files["Cargo.lock"];
  for (const name of WORKSPACE_CRATES) {
    lock = replaceOnce(lock, new RegExp(`(name = "${name}"\\nversion = ")[^"]+(")`), `$1${version}$2`, "Cargo.lock");
  }
  out["Cargo.lock"] = lock;
  const pkg = JSON.parse(files["package.json"]);
  pkg.version = version;
  out["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
  const pkgLock = JSON.parse(files["package-lock.json"]);
  pkgLock.version = version;
  if (pkgLock.packages?.[""]) pkgLock.packages[""].version = version;
  out["package-lock.json"] = `${JSON.stringify(pkgLock, null, 2)}\n`;
  const conf = JSON.parse(files["src-tauri/tauri.conf.json"]);
  conf.version = version;
  out["src-tauri/tauri.conf.json"] = `${JSON.stringify(conf, null, 2)}\n`;
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? "";
  const files = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
  const out = bumpFiles(files, version);
  for (const f of FILES) if (out[f] !== files[f]) writeFileSync(f, out[f]);
  console.log(`Version set to ${version} in ${FILES.join(", ")}`);
  console.log(`Next: write docs/releases/v${version}.md, open a PR, merge, then tag v${version}.`);
}
