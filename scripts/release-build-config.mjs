#!/usr/bin/env node
// Prints the `tauri build --config` override used by release.yml for a version.
// Usage: npx tauri build --config "$(node scripts/release-build-config.mjs 0.2.0-rc.1)"
import { pathToFileURL } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function releaseBuildConfig(version) {
  const m = VERSION.exec(version);
  if (!m) throw new Error(`Not a release version: ${version}`);
  const config = { bundle: { createUpdaterArtifacts: true } };
  const pre = m[4];
  if (pre) {
    // WiX only accepts major.minor.patch.build with a numeric build <= 65535, so a
    // pre-release such as 0.2.0-rc.1 gets the MSI version 0.2.0.1.
    const last = Number(pre.split(".").pop());
    const build = Number.isInteger(last) && last >= 0 && last <= 65535 ? last : 0;
    config.bundle.windows = { wix: { version: `${m[1]}.${m[2]}.${m[3]}.${build}` } };
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(releaseBuildConfig(process.argv[2] ?? "")));
}
