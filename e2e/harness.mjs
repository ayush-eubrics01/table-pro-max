// Starts the built app under tauri-driver, cut off from the developer's data and keyring as
// CLAUDE.md asks for local runs: scratch XDG dirs, no D-Bus session bus, no XDG_RUNTIME_DIR.
//
// TPM_E2E_APP          the app binary (default: target/debug/table-pro-max, built with
//                      `npx tauri build --debug --no-bundle` so the UI is embedded)
// TPM_E2E_TAURI_DRIVER tauri-driver (default: on PATH)
// TPM_E2E_WEBDRIVER    WebKitWebDriver (default: on PATH)

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Session } from "./webdriver.mjs";

const PORT = 4444 + Math.floor(Math.random() * 500);

export async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "tpm-e2e-"));
  for (const d of ["share", "config", "cache"]) mkdirSync(join(dir, d));
  const env = {
    ...process.env,
    HOME: dir,
    XDG_DATA_HOME: join(dir, "share"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
  };
  delete env.XDG_RUNTIME_DIR;
  const args = ["--port", String(PORT), "--native-port", String(PORT + 1000)];
  if (process.env.TPM_E2E_WEBDRIVER) args.push("--native-driver", process.env.TPM_E2E_WEBDRIVER);
  const driver = spawn(process.env.TPM_E2E_TAURI_DRIVER ?? "tauri-driver", args, { env, stdio: ["ignore", "inherit", "inherit"] });
  const base = `http://127.0.0.1:${PORT}`;
  await waitForDriver(base);
  const app = resolve(process.env.TPM_E2E_APP ?? "target/debug/table-pro-max");
  const session = await Session.start(base, app);
  return {
    session,
    dir,
    /** Saves a screenshot next to the run's files, for a failed test. */
    async snapshot(name) {
      try {
        const png = await session.screenshot();
        const shots = process.env.TPM_E2E_SHOTS ?? dir;
        mkdirSync(shots, { recursive: true });
        const path = join(shots, `${name}.png`);
        writeFileSync(path, Buffer.from(png, "base64"));
        return path;
      } catch {
        return null;
      }
    },
    async stop() {
      await session.quit().catch(() => undefined);
      driver.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForDriver(base) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/status`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`tauri-driver did not start on ${base}`);
}
