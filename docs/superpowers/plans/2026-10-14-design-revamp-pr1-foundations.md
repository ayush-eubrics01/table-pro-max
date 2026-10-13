# Design Revamp PR 1 (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole app the new design's colours, type, icons and control styles (dark from the design, light derived), with no behaviour change and nothing loaded from the network.

**Architecture:**
- **Theme and checker.** `src/styles/tokens.css` holds every colour, metric and font for both themes. A small checker module (`scripts/theme-check.mjs`) and its vitest tests enforce contrast, keep the two dark blocks identical, and keep environment colours distinct.
- **Fonts.** Geist is bundled through Fontsource.
- **Icons.** Material Symbols come from a committed, generated path map rendered by one `Icon` component, replacing Lucide.
- **Shared controls.** The rules in `src/styles/app.css` are restyled to the design's metrics.

**Tech Stack:** React 19, TypeScript, Vite, vitest (jsdom), plain CSS custom properties, Node 24 scripts (`.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`. This plan covers spec section "Delivery plan" item 1 and the "Visual foundation" section.

## Global Constraints
- **Dark palette:** copied from the spec and `FLOW.md`. Surfaces `#0B0D10` / `#0F1215` / `#111418` / `#13161A` / `#181C21`. Borders `#1C2026` / `#21262D` / `#262C34` / `#2C323A`. Text `#E7EAEE` / `#A4ADB8` / `#6E7783` / `#4E5661`. Accent `#4ED6A0` with text on accent `#06150F`. Environments: Local `#5BB8F0`, Staging `#E8B04A`, Production `#F0605A`.
- **Contrast targets:**
  - 4.5:1 for body text, accent text, danger and warning text, syntax colours (except comments), environment badge text and text on accent;
  - 3:1 for faint text, comments, focus ring and environment dots.
- **Environment colour distance:** OKLab ΔE×100 ≥ 15 between each pair of the five environment colours plus the accent, in each theme.
- **No network:** no font, icon or style from the network. CSP stays as it is (`font-src 'self' data:`).
- **No `color-mix()`:** none in `tokens.css`, and none left in `app.css` after Task 5. Older WebKit (macOS 12) lacks it; tinted colours are explicit tokens instead.
- **No behaviour change:** stores, IPC, Rust and component logic stay as they are. Markup changes only where an icon or a CSS variable hook requires it.
- **Licences:** fonts are OFL-1.1 (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`). Icons are Apache-2.0 (`@material-symbols/svg-300`, a dev dependency used only by the generator).
- **Commands:**
  - Node: `source ~/.nvm/nvm.sh && nvm use 24`.
  - Frontend checks: `npm run typecheck && npm run lint && npm test && npm run build`.
- **Commit trailer:** every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN
  ```
- **Workflow:** branch `design/revamp` (from `main`). One PR into `main` at the end, squash-merged after **CI passed** (CONTRIBUTING.md). No `full-ci` label: this PR does not touch `src-tauri/`.

## Review Focus
1. **Grid row height:** the CSS row height (30 px) and the virtualizer's `ROW_HEIGHT` must stay equal, or rows overlap and scrolling drifts. A test in Task 5 pins them together.
2. **System theme switching:** dark must look the same whether chosen in Settings or followed from the OS. The two dark blocks must stay identical (Task 1 test).
3. **Mistyped icon name:** it must fail at build time, not render nothing. The `IconName` union plus the generator test that it matches the list cover this (Task 3).
4. **Old WebKit without `color-mix()`:** environment badges must still be tinted. That needs explicit `--env-*-bg` / `--env-*-text` tokens, plus the no-`color-mix` test (Tasks 1 and 5).
5. **Keyboard focus:** it must be visible on every control in both themes. The focus colour is in the contrast pairs (Task 1), and the manual screenshot pass checks it (Task 6).

## File structure
| File | Status | Responsibility |
|---|---|---|
| `scripts/theme-check.mjs` | create | Parse `tokens.css` themes; WCAG contrast; OKLab distance; list failures. |
| `scripts/theme-check.test.mjs` | create | Theme rules as tests. |
| `src/styles/tokens.css` | rewrite | All tokens: shared metrics/fonts, light, dark (twice: system and chosen). |
| `scripts/assets.test.mjs` | create | Fonts bundled, nothing from the network, no Lucide left. |
| `src/main.tsx` | modify | Font imports. |
| `scripts/gen-icons.mjs` (+ `.test.mjs`) | create | Generate `icons.generated.ts` from the Material Symbols package. |
| `src/components/icons.generated.ts` | create (generated) | `ICON_PATHS` and `IconName`. |
| `src/components/Icon.tsx` (+ `Icon.test.tsx`) | create | The icon component. |
| 19 files importing `lucide-react` | modify | Use `Icon`. |
| `src/styles/app.css` | modify | Controls, messages, overlays, environment badge, segmented control. |
| `src/lib/env.ts`, `src/components/EnvBadge.tsx`, `src/app/WorkspaceView.tsx` | modify | Environment CSS variable hooks. |
| `src/features/data-grid/DataGrid.tsx` (+ `rowHeight.test.ts`) | modify | Export `ROW_HEIGHT = 30`. |
| `scripts/dev/seed-demo.py` | create | Seeds an isolated data folder for screenshots (all seven PRs reuse it). |
| `package.json`, `package-lock.json`, `docs/DEPENDENCY_LICENSES.md` | modify | Dependencies and licences. |

---

### Task 0: Baseline screenshots (before any change)

**Files:**
- Create: `scripts/dev/seed-demo.py`

**Interfaces:**
- Produces: `scripts/dev/seed-demo.py <app-data-dir> <light|dark> [active-tab-index]`, used again in Task 6. Screenshots go to `target/tpm-scratch/shots/before-*.png` (git-ignored).

- [ ] **Step 1: Write the seed script.** Create `scripts/dev/seed-demo.py`:

```python
#!/usr/bin/env python3
"""Seed an isolated Table Pro Max data folder for screenshots.

Creates demo SQLite databases, one connection per environment, a restored workspace (one
SQLite connection with a table tab and a query tab) and the theme setting.

Usage: scripts/dev/seed-demo.py <app-data-dir> <light|dark> [active-tab-index]
<app-data-dir> is $XDG_DATA_HOME/dev.tablepromax.app of an isolated run. The app must have
started there once so app.db exists. Never point this at a real data folder.
"""
import datetime
import json
import pathlib
import sqlite3
import sys

data = pathlib.Path(sys.argv[1])
theme = sys.argv[2]
active_tab = int(sys.argv[3]) if len(sys.argv) > 3 else 0
assert theme in ("light", "dark"), "theme must be light or dark"
app_db = data / "app.db"
assert app_db.exists(), f"{app_db} not found: start the app once with this data folder first"

demo = data / "demo"
demo.mkdir(exist_ok=True)
shop = demo / "shop.db"
if not shop.exists():
    c = sqlite3.connect(shop)
    c.executescript(
        """
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE,
                                country TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                             status TEXT NOT NULL, total REAL, paid INTEGER, note TEXT, created_at TEXT);
        CREATE INDEX orders_customer ON orders(customer_id);
        CREATE VIEW paid_orders AS SELECT * FROM orders WHERE paid = 1;
        """
    )
    for i in range(1, 61):
        c.execute("INSERT INTO customers (name, email, country) VALUES (?, ?, ?)",
                  (f"Customer {i}", f"c{i}@example.com", ["IN", "US", "DE", "JP"][i % 4]))
    for i in range(1, 301):
        c.execute(
            "INSERT INTO orders (customer_id, status, total, paid, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (i % 60 + 1, ["DRAFT", "PAID", "SHIPPED", "CANCELLED"][i % 4], round(i * 3.7 % 500, 2),
             1 if i % 3 == 0 else 0, None if i % 5 else "gift", f"2026-09-{i % 28 + 1:02d} 10:{i % 60:02d}:00"),
        )
    c.commit()
    c.close()
for name in ("billing", "analytics", "audit", "warehouse"):
    path = demo / f"{name}.db"
    if not path.exists():
        sqlite3.connect(path).execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)").connection.close()


def profile(pid, name, env, path, safety="confirm_destructive"):
    return {
        "id": pid, "name": name, "driver": "sqlite", "filePath": str(path),
        "tls": {"mode": "disable", "caCertPath": None}, "passwordMode": "none",
        "environment": env, "safetyMode": safety, "color": None, "group": None, "tags": [],
        "connectTimeoutSecs": 10, "queryTimeoutSecs": 0, "keepaliveSecs": 60,
    }


profiles = [
    profile("demo-shop", "Shop (local)", "local", shop),
    profile("demo-billing", "Billing dev", "development", demo / "billing.db"),
    profile("demo-analytics", "Analytics test", "testing", demo / "analytics.db"),
    profile("demo-audit", "Audit staging", "staging", demo / "audit.db"),
    profile("demo-warehouse", "Warehouse prod", "production", demo / "warehouse.db", "read_only"),
]
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
db = sqlite3.connect(app_db)
for order, p in enumerate(profiles, start=1):
    db.execute(
        "INSERT INTO connections (id, profile, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET profile = excluded.profile",
        (p["id"], json.dumps(p), order, now, now),
    )
session = {
    "activeIndex": 0,
    "workspaces": [{
        "connectionId": "demo-shop", "database": "main", "schema": "main", "activeIndex": active_tab,
        "tabs": [
            {"kind": "table", "title": "orders", "schema": "main", "name": "orders", "objectKind": "table"},
            {"kind": "query", "title": "Query 1", "savedQueryId": None, "dirty": True,
             "sql": "SELECT c.name, count(*) AS orders, sum(o.total) AS spent\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.paid = 1\nGROUP BY c.name\nORDER BY spent DESC\nLIMIT 20;"},
        ],
    }],
}
for key, value in (("theme", theme), ("workspace.restore", True), ("updates.auto", "off")):
    db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
               (key, json.dumps(value)))
db.execute("INSERT INTO workspace (key, value, updated_at) VALUES ('session.v1', ?, ?) "
           "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(session), now))
db.commit()
print(f"seeded {data}: theme={theme}, active tab={active_tab}")
```

- [ ] **Step 2: Start the isolated app once, then seed.**
  - Use the hidden display `:98` with framebuffer `target/tpm-scratch/fb`. Start `Xvfb :98 -screen 0 1440x900x24 -fbdir target/tpm-scratch/fb -nolisten tcp` in the background if it isn't running.
  - The Vite dev server must be serving the working tree on port 1420. Start `npm run dev` in the background if `ss -ltn | grep -q ':1420 '` fails.

```bash
cd /home/ayush/projects/table-pro-max
source target/tpm-scratch/sysroot/env.sh && cargo build -p table-pro-max
R=target/tpm-scratch/shots/run; mkdir -p $R/{share,config,cache} target/tpm-scratch/shots
launch() { env -u XDG_RUNTIME_DIR DISPLAY=:98 HOME=$R XDG_DATA_HOME=$R/share XDG_CONFIG_HOME=$R/config \
  XDG_CACHE_HOME=$R/cache DBUS_SESSION_BUS_ADDRESS=unix:path=$R/no-bus target/debug/table-pro-max > $R/app.log 2>&1 & echo $! > $R/pid; }
launch; sleep 12; kill "$(cat $R/pid)"; sleep 2
ls $R/share/dev.tablepromax.app/app.db
```
Expected: `app.db` exists.

- [ ] **Step 3: Capture the baseline.** For each theme (`dark`, then `light`):
  1. Run `python3 scripts/dev/seed-demo.py $R/share/dev.tablepromax.app <theme> 0`, launch, wait 12 s, then `bash target/tpm-scratch/e2e/shot.sh shots/before-<theme>-table`.
  2. Quit, seed with tab index `1`, launch, and capture `before-<theme>-query`.
  3. Press `Control_L+comma` with `target/tpm-scratch/e2e/xinput.py` and capture `before-<theme>-settings`. Then press `Escape`.
  4. Click the "Connections" tab (top left of the connection strip) and capture `before-<theme>-home`.

  Expected: 8 PNGs in `target/tpm-scratch/shots/` showing the current design with demo data. Read one of them to confirm the data and theme are right.

- [ ] **Step 4: Commit the seed script.**

```bash
git add scripts/dev/seed-demo.py
git commit -m "dev: seed script for isolated screenshot runs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 1: Theme checker and the new tokens

**Files:**
- Create: `scripts/theme-check.mjs`, `scripts/theme-check.test.mjs`
- Rewrite: `src/styles/tokens.css`

**Interfaces:**
- Produces:
  - **Exports of `scripts/theme-check.mjs`:**
    - `parseThemes(css) → { light, dark, darkMedia, darkAttr }`, where each is a `Record<string, string>` of custom properties and `dark` is light merged with `darkAttr`;
    - `contrast(hexA, hexB) → number` and `deltaE(hexA, hexB) → number` (OKLab ×100);
    - `failures(theme) → string[]`;
    - the constants `SURFACES`, `ENVS` and `PAIRS`.
  - **New CSS variables** used by Tasks 5 and later: `--surface-panel`, `--border-hairline`, `--border-input`, `--text-dim`, `--focus-ring`, `--danger-text`, `--backdrop`, `--env-<env>-bg` and `--env-<env>-text`. Also `--radius-xl`, `--sidebar-row-height`, `--structure-row-height`, `--tabs-height` and `--titlebar-height`.

- [ ] **Step 1: Write the failing tests.** Create `scripts/theme-check.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENVS, contrast, deltaE, failures, parseThemes } from "./theme-check.mjs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const themes = parseThemes(css);
const SHARED = /^--(font-|text-(xs|sm|md|lg|xl)$|space-|radius-|[a-z-]*height$)/;

describe("theme checker", () => {
  it("computes WCAG contrast and OKLab distance", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(deltaE("#4ED6A0", "#4ED6A0")).toBe(0);
    expect(deltaE("#000000", "#FFFFFF")).toBeCloseTo(100, 0);
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
});
```

- [ ] **Step 2: Run the tests and check they fail.**

Run: `npx vitest run scripts/theme-check.test.mjs`
Expected: FAIL. `./theme-check.mjs` can't be found.

- [ ] **Step 3: Implement the checker.** Create `scripts/theme-check.mjs`:

```js
// Theme rules from docs/superpowers/specs/2026-10-14-design-revamp-design.md: contrast targets,
// environment colours told apart, both dark blocks identical. Used by theme-check.test.mjs.

function vars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Light is the plain `:root` block; dark is light overridden by the dark block. */
export function parseThemes(css) {
  const block = (re, what) => {
    const m = re.exec(css);
    if (!m) throw new Error(`tokens.css: ${what} block not found`);
    return vars(m[1]);
  };
  const light = block(/(?:^|\n):root\s*\{([^}]*)\}/, ":root");
  const darkMedia = block(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/,
    "system dark",
  );
  const darkAttr = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/, "chosen dark");
  return { light, dark: { ...light, ...darkAttr }, darkMedia, darkAttr };
}

function rgb(hex) {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = rgb(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function oklab(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function deltaE(a, b) {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export const SURFACES = ["--bg", "--bg-sunken", "--surface", "--surface-panel"];
export const ENVS = ["local", "development", "testing", "staging", "production"];
const ROW_TINTS = ["--selection", "--selection-strong", "--edited-bg", "--inserted-bg", "--deleted-bg", "--surface-hover", "--surface-active"];
const CODE_BG = ["--bg", "--surface"];

/** [foreground, backgrounds, minimum contrast] */
export const PAIRS = [
  ["--text", SURFACES, 4.5],
  ["--text-muted", SURFACES, 4.5],
  ["--text-faint", SURFACES, 3],
  ["--accent", SURFACES, 4.5],
  ["--danger", SURFACES, 4.5],
  ["--warning", SURFACES, 4.5],
  ["--focus", SURFACES, 3],
  ["--accent-text", ["--accent", "--accent-strong"], 4.5],
  ["--danger-text", ["--danger"], 4.5],
  ["--text", ROW_TINTS, 4.5],
  ["--syn-keyword", CODE_BG, 4.5],
  ["--syn-string", CODE_BG, 4.5],
  ["--syn-number", CODE_BG, 4.5],
  ["--syn-type", CODE_BG, 4.5],
  ["--syn-ident", CODE_BG, 4.5],
  ["--syn-comment", CODE_BG, 3],
  ...ENVS.map((e) => [`--env-${e}`, ["--bg", "--bg-sunken", "--surface"], 3]),
  ...ENVS.map((e) => [`--env-${e}-text`, [`--env-${e}-bg`], 4.5]),
];

export function failures(theme) {
  const out = [];
  for (const [fg, bgs, min] of PAIRS) {
    for (const bg of bgs) {
      if (!(fg in theme)) out.push(`missing ${fg}`);
      else if (!(bg in theme)) out.push(`missing ${bg}`);
      else {
        const c = contrast(theme[fg], theme[bg]);
        if (c < min) out.push(`${fg} on ${bg}: ${c.toFixed(2)} < ${min}`);
      }
    }
  }
  return [...new Set(out)];
}
```

- [ ] **Step 4: Run the tests against the old tokens.**

Run: `npx vitest run scripts/theme-check.test.mjs`
Expected:
- The two "theme checker" tests pass.
- The token tests fail with missing `--surface-panel`, `--env-local-bg` and the like, plus `color-mix` is not involved here. This confirms the checks bite.

- [ ] **Step 5: Rewrite `src/styles/tokens.css`** with exactly this content:

```css
/* Design tokens. Every colour, size and font in the app comes from here.
   Dark follows the design (docs/superpowers/specs/2026-10-14-design-revamp-design.md); light is
   derived from it. scripts/theme-check.test.mjs checks contrast, environment colours and that
   the two dark blocks below stay identical. Tinted colours are explicit tokens: no color-mix(). */

:root {
  --font-ui: "Geist Variable", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-code: "Geist Mono Variable", ui-monospace, "Cascadia Mono", "SF Mono", monospace;

  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-lg: 15px;
  --text-xl: 20px;

  --space-1: 2px;
  --space-2: 4px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 16px;
  --space-6: 24px;

  --radius-sm: 5px;
  --radius-md: 7px;
  --radius-lg: 10px;
  --radius-xl: 14px;

  --row-height: 30px;
  --sidebar-row-height: 28px;
  --structure-row-height: 40px;
  --toolbar-height: 44px;
  --tabs-height: 38px;
  --titlebar-height: 42px;
  --statusbar-height: 28px;

  color-scheme: light;
  --bg: #f6f7f9;
  --bg-sunken: #eceef2;
  --surface: #ffffff;
  --surface-panel: #f0f2f5;
  --surface-hover: #e9ecf0;
  --surface-active: #dfe3e9;
  --border-hairline: #e3e6eb;
  --border: #d9dde3;
  --border-input: #cdd2d9;
  --border-strong: #c2c8d0;
  --text: #14181d;
  --text-muted: #4a535e;
  --text-faint: #5f6874;
  --text-dim: #9aa2ad;
  --accent: #0f7a53;
  --accent-strong: #0b6646;
  --accent-text: #ffffff;
  --focus: #0f7a53;
  --focus-ring: rgba(15, 122, 83, 0.2);
  --selection: #d5eee3;
  --selection-strong: #b9e2d0;
  --danger: #c2302b;
  --danger-text: #ffffff;
  --danger-bg: #fbe6e5;
  --warning: #8a5a00;
  --warning-bg: #fbf0dc;
  --info-bg: #e3eef8;
  --null: #9aa2ad;
  --edited-bg: #fdf1cf;
  --inserted-bg: #ddf3e8;
  --deleted-bg: #fbe1e0;
  --grid-line: #e3e6eb;
  --grid-header: #f0f2f5;
  --backdrop: rgba(20, 24, 29, 0.32);
  --shadow-pop: 0 12px 32px rgba(20, 24, 29, 0.16), 0 1px 3px rgba(20, 24, 29, 0.1);
  --env-local: #1f7fb8;
  --env-local-bg: #e0edf5;
  --env-local-text: #1a6c9c;
  --env-development: #5746a0;
  --env-development-bg: #e7e5f2;
  --env-development-text: #5746a0;
  --env-testing: #a550be;
  --env-testing-bg: #f2e6f6;
  --env-testing-text: #9448ab;
  --env-staging: #b07a10;
  --env-staging-bg: #f4ecde;
  --env-staging-text: #8d620d;
  --env-production: #d23b35;
  --env-production-bg: #f9e4e3;
  --env-production-text: #bd3530;
  --syn-keyword: #7a3fd1;
  --syn-string: #8a5a00;
  --syn-number: #1a6fa3;
  --syn-comment: #6b7480;
  --syn-type: #127a53;
  --syn-operator: #4a535e;
  --syn-ident: #14181d;
  /* Categorical chart series (validated: scripts/validate_palette.js, light surface #ffffff). */
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #6250d6;
  --series-8: #e34948;
  --chart-grid: #e3e6eb;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f1215;
    --bg-sunken: #0b0d10;
    --surface: #13161a;
    --surface-panel: #111418;
    --surface-hover: #181c21;
    --surface-active: #1e232a;
    --border-hairline: #1c2026;
    --border: #21262d;
    --border-input: #262c34;
    --border-strong: #2c323a;
    --text: #e7eaee;
    --text-muted: #a4adb8;
    --text-faint: #6e7783;
    --text-dim: #4e5661;
    --accent: #4ed6a0;
    --accent-strong: #7fe6bc;
    --accent-text: #06150f;
    --focus: #4ed6a0;
    --focus-ring: rgba(78, 214, 160, 0.22);
    --selection: #15302a;
    --selection-strong: #1d4537;
    --danger: #f0605a;
    --danger-text: #1a0907;
    --danger-bg: #2a1517;
    --warning: #e8b04a;
    --warning-bg: #2a2112;
    --info-bg: #12263a;
    --null: #4e5661;
    --edited-bg: #2e2711;
    --inserted-bg: #10291f;
    --deleted-bg: #2e1517;
    --grid-line: #1c2026;
    --grid-header: #13161a;
    --backdrop: rgba(4, 5, 7, 0.62);
    --shadow-pop: 0 16px 48px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
    --env-local: #5bb8f0;
    --env-local-bg: #1f303c;
    --env-local-text: #5bb8f0;
    --env-development: #b17be5;
    --env-development-bg: #2c263a;
    --env-development-text: #b17be5;
    --env-testing: #f7aafe;
    --env-testing-bg: #372e3e;
    --env-testing-text: #f7aafe;
    --env-staging: #e8b04a;
    --env-staging-bg: #352f22;
    --env-staging-text: #e8b04a;
    --env-production: #f0605a;
    --env-production-bg: #362224;
    --env-production-text: #f0605a;
    --syn-keyword: #c4a1ff;
    --syn-string: #e8b04a;
    --syn-number: #5bb8f0;
    --syn-comment: #6e7783;
    --syn-type: #4ed6a0;
    --syn-operator: #a4adb8;
    --syn-ident: #e7eaee;
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;
    --chart-grid: #1c2026;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1215;
  --bg-sunken: #0b0d10;
  --surface: #13161a;
  --surface-panel: #111418;
  --surface-hover: #181c21;
  --surface-active: #1e232a;
  --border-hairline: #1c2026;
  --border: #21262d;
  --border-input: #262c34;
  --border-strong: #2c323a;
  --text: #e7eaee;
  --text-muted: #a4adb8;
  --text-faint: #6e7783;
  --text-dim: #4e5661;
  --accent: #4ed6a0;
  --accent-strong: #7fe6bc;
  --accent-text: #06150f;
  --focus: #4ed6a0;
  --focus-ring: rgba(78, 214, 160, 0.22);
  --selection: #15302a;
  --selection-strong: #1d4537;
  --danger: #f0605a;
  --danger-text: #1a0907;
  --danger-bg: #2a1517;
  --warning: #e8b04a;
  --warning-bg: #2a2112;
  --info-bg: #12263a;
  --null: #4e5661;
  --edited-bg: #2e2711;
  --inserted-bg: #10291f;
  --deleted-bg: #2e1517;
  --grid-line: #1c2026;
  --grid-header: #13161a;
  --backdrop: rgba(4, 5, 7, 0.62);
  --shadow-pop: 0 16px 48px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
  --env-local: #5bb8f0;
  --env-local-bg: #1f303c;
  --env-local-text: #5bb8f0;
  --env-development: #b17be5;
  --env-development-bg: #2c263a;
  --env-development-text: #b17be5;
  --env-testing: #f7aafe;
  --env-testing-bg: #372e3e;
  --env-testing-text: #f7aafe;
  --env-staging: #e8b04a;
  --env-staging-bg: #352f22;
  --env-staging-text: #e8b04a;
  --env-production: #f0605a;
  --env-production-bg: #362224;
  --env-production-text: #f0605a;
  --syn-keyword: #c4a1ff;
  --syn-string: #e8b04a;
  --syn-number: #5bb8f0;
  --syn-comment: #6e7783;
  --syn-type: #4ed6a0;
  --syn-operator: #a4adb8;
  --syn-ident: #e7eaee;
  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --series-7: #9085e9;
  --series-8: #e66767;
  --chart-grid: #1c2026;
}
```

- [ ] **Step 6: Run the tests and check they pass.**

Run: `npx vitest run scripts/theme-check.test.mjs`
Expected: 7 tests pass. If a contrast pair fails, the message names the pair and ratio. Adjust only that value and record a ruling in the ledger.

- [ ] **Step 7: Run the whole frontend suite, then commit.**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: everything passes. `app.css` still references only existing variables, so nothing breaks.

```bash
git add scripts/theme-check.mjs scripts/theme-check.test.mjs src/styles/tokens.css
git commit -m "design: new theme tokens (dark from the design, light derived) with checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 2: Bundled Geist fonts

**Files:**
- Create: `scripts/assets.test.mjs`
- Modify: `src/main.tsx`, `package.json`, `package-lock.json`, `docs/DEPENDENCY_LICENSES.md`

**Interfaces:**
- Consumes: `--font-ui` / `--font-code` from Task 1 (`"Geist Variable"`, `"Geist Mono Variable"`).
- Produces: `scripts/assets.test.mjs`, which Task 4 extends.

- [ ] **Step 1: Write the failing test.** Create `scripts/assets.test.mjs`:

```js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
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
});
```

- [ ] **Step 2: Run the test and check it fails.**

Run: `npx vitest run scripts/assets.test.mjs`
Expected: FAIL on "ships the Geist fonts" (dependencies missing).

- [ ] **Step 3: Swap the font packages.**

```bash
npm install @fontsource-variable/geist@5.3.0 @fontsource-variable/geist-mono@5.3.0
npm uninstall @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono
```

In `src/main.tsx`, replace the five `@fontsource/ibm-plex-*` import lines with:

```ts
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
```

In `docs/DEPENDENCY_LICENSES.md`:
- replace the IBM Plex row(s) with `| @fontsource-variable/geist, @fontsource-variable/geist-mono | 5.3 | OFL-1.1 | github.com/fontsource/font-files | Bundled UI and code fonts (Geist) |`;
- in the same table style, add `| @material-symbols/svg-300 (dev, generator input) | 0.48 | Apache-2.0 | github.com/marella/material-symbols | Icon paths, copied into src/components/icons.generated.ts |`.

- [ ] **Step 4: Run the test and the suite.**

Run: `npx vitest run scripts/assets.test.mjs && npm run typecheck && npm run build`
Expected: 2 tests pass and the build succeeds. The build's assets list includes the `geist` woff2 files.

- [ ] **Step 5: Commit.**

```bash
git add scripts/assets.test.mjs src/main.tsx package.json package-lock.json docs/DEPENDENCY_LICENSES.md
git commit -m "design: bundle Geist and Geist Mono instead of IBM Plex" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 3: Icon generator and `Icon` component

**Files:**
- Create: `scripts/gen-icons.mjs`, `scripts/gen-icons.test.mjs`, `src/components/icons.generated.ts` (generated), `src/components/Icon.tsx`, `src/components/Icon.test.tsx`
- Modify: `package.json`, `package-lock.json` (dev dependency)

**Interfaces:**
- Produces:
  - `ICONS` (array of names) and `buildModule(names, readSvg) → string` from `scripts/gen-icons.mjs`;
  - `ICON_PATHS` and `type IconName` from `src/components/icons.generated.ts`;
  - `Icon({ name, size = 16, color, className, style, label })` from `src/components/Icon.tsx`, also re-exporting `IconName`.
- Icon names used by Task 4: `new_window, arrow_downward, arrow_upward, block, bar_chart, data_object, check_circle, keyboard_arrow_down, chevron_right, schedule, code, terminal, content_copy, keyboard_return, database, download, visibility, code_blocks, file_save, folder_open, function, speed, tag, history, grid_view, key, layers, lock, edit, play_arrow, play_circle, add, refresh, save, search, settings, star_shine, stop, delete, undo, link_off, upload, format_align_left, close, cancel, table`. The list also includes these, used in later PRs: `keep, filter_list, system_update_alt, minimize, crop_square, close_small, open_in_new, unfold_more, more_horiz, info, warning, error`.

- [ ] **Step 1: Install the generator input.**

```bash
npm install --save-dev @material-symbols/svg-300@0.48.0
```

- [ ] **Step 2: Write the failing tests.** Create `scripts/gen-icons.test.mjs`:

```js
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
});
```

Create `src/components/Icon.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Icon } from "./Icon";
import { ICON_PATHS } from "./icons.generated";

afterEach(cleanup);

describe("Icon", () => {
  it("draws the named symbol at the requested size", () => {
    const { container } = render(<Icon name="table" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("viewBox")).toBe("0 -960 960 960");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe(ICON_PATHS.table);
    expect(svg.getAttribute("fill")).toBe("currentColor");
  });

  it("is hidden from screen readers unless it has a label", () => {
    const { container } = render(<Icon name="search" />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    render(<Icon name="link_off" label="Connection lost" color="var(--danger)" />);
    const img = screen.getByRole("img", { name: "Connection lost" });
    expect(img.getAttribute("fill")).toBe("var(--danger)");
  });
});
```

- [ ] **Step 3: Run the tests and check they fail.**

Run: `npx vitest run scripts/gen-icons.test.mjs src/components/Icon.test.tsx`
Expected: FAIL. `./gen-icons.mjs`, `../src/components/icons.generated` and `./Icon` can't be found.

- [ ] **Step 4: Implement the generator.** Create `scripts/gen-icons.mjs`:

```js
#!/usr/bin/env node
// Writes src/components/icons.generated.ts from @material-symbols/svg-300 (rounded, weight 300).
// Only the icons in ICONS are bundled. After changing the list run: node scripts/gen-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ICONS = [
  "add", "arrow_downward", "arrow_upward", "bar_chart", "block", "cancel", "check_circle", "chevron_right",
  "close", "close_small", "code", "code_blocks", "content_copy", "crop_square", "data_object", "database",
  "delete", "download", "edit", "error", "file_save", "filter_list", "folder_open", "format_align_left",
  "function", "grid_view", "history", "info", "keep", "key", "keyboard_arrow_down", "keyboard_return",
  "layers", "link_off", "lock", "minimize", "more_horiz", "new_window", "open_in_new", "play_arrow",
  "play_circle", "refresh", "save", "schedule", "search", "settings", "speed", "star_shine", "stop",
  "system_update_alt", "table", "tag", "terminal", "undo", "unfold_more", "upload", "visibility", "warning",
];

export function extractPath(svg, name) {
  const paths = svg.match(/<path d="([^"]+)"\s*\/>/g) ?? [];
  if (!svg.includes('viewBox="0 -960 960 960"') || paths.length !== 1) throw new Error(`Unexpected SVG for ${name}`);
  return /d="([^"]+)"/.exec(paths[0])[1];
}

export function buildModule(names, readSvg) {
  const lines = [...new Set(names)].sort().map((name) => {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid icon name: ${name}`);
    return `  ${name}: ${JSON.stringify(extractPath(readSvg(name), name))},`;
  });
  return [
    "// Generated by scripts/gen-icons.mjs from @material-symbols/svg-300 (rounded, weight 300; Apache-2.0).",
    "// Do not edit: change ICONS in the script and run it again.",
    "",
    "export const ICON_PATHS = {",
    ...lines,
    "} as const;",
    "",
    "export type IconName = keyof typeof ICON_PATHS;",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = new URL("../node_modules/@material-symbols/svg-300/rounded/", import.meta.url);
  const read = (name) => {
    try {
      return readFileSync(new URL(`${name}.svg`, dir), "utf8");
    } catch {
      throw new Error(`Unknown icon: ${name}`);
    }
  };
  const out = new URL("../src/components/icons.generated.ts", import.meta.url);
  writeFileSync(out, buildModule(ICONS, read));
  console.log(`Wrote ${ICONS.length} icons to src/components/icons.generated.ts`);
}
```

- [ ] **Step 5: Generate the module and implement `Icon`.**

Run: `node scripts/gen-icons.mjs`
Expected: `Wrote 58 icons to src/components/icons.generated.ts`.

Create `src/components/Icon.tsx`:

```tsx
import type { CSSProperties } from "react";
import { ICON_PATHS, type IconName } from "./icons.generated";

export type { IconName };

interface IconProps {
  name: IconName;
  size?: number;
  /** Fill colour; defaults to the surrounding text colour. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name. Without it the icon is decorative and hidden from screen readers. */
  label?: string;
}

/** Material Symbols Rounded (weight 300), bundled at build time; see scripts/gen-icons.mjs. */
export function Icon({ name, size = 16, color, className, style, label }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const, focusable: false as const };
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill={color ?? "currentColor"}
      style={style}
      {...a11y}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
```

Add to `src/styles/app.css`, right after the `code, pre, .mono` rule:

```css
.icon {
  flex: none;
  vertical-align: middle;
}
```

- [ ] **Step 6: Run the tests.**

Run: `npx vitest run scripts/gen-icons.test.mjs src/components/Icon.test.tsx && npm run typecheck && npm run lint`
Expected: 5 tests pass; typecheck and lint are clean.

- [ ] **Step 7: Commit.**

```bash
git add scripts/gen-icons.mjs scripts/gen-icons.test.mjs src/components/icons.generated.ts src/components/Icon.tsx src/components/Icon.test.tsx src/styles/app.css package.json package-lock.json
git commit -m "design: Material Symbols icons through a generated, bundled path map" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 4: Replace Lucide everywhere

**Files:**
- Modify: the 19 files importing `lucide-react` (from `grep -rl 'from "lucide-react"' src`), `scripts/assets.test.mjs`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: `Icon` and `IconName` from Task 3.

- [ ] **Step 1: Add the failing guard test.** Append to the `describe` block in `scripts/assets.test.mjs`:

```js
  it("uses the bundled Icon component, not lucide-react", () => {
    expect(deps["lucide-react"]).toBeUndefined();
    const offenders = files("src").filter((f) => /\.tsx?$/.test(f) && read(f).includes("lucide-react"));
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Run it and check it fails.**

Run: `npx vitest run scripts/assets.test.mjs`
Expected: FAIL. `lucide-react` is still a dependency, and 19 offenders are listed.

- [ ] **Step 3: Rewrite the imports and tags.** Run this one-off codemod from the repo root. It isn't committed. It maps every Lucide name, follows `as` aliases, turns `aria-label=` into `label=` inside icon tags, and refuses unknown names:

```bash
python3 - <<'EOF'
import os, re, subprocess
MAP = {
    "AppWindow": "new_window", "ArrowDown": "arrow_downward", "ArrowUp": "arrow_upward", "Ban": "block",
    "BarChart3": "bar_chart", "Braces": "data_object", "CheckCircle2": "check_circle",
    "ChevronDown": "keyboard_arrow_down", "ChevronRight": "chevron_right", "Clock": "schedule", "Code": "code",
    "Code2": "terminal", "Copy": "content_copy", "CornerDownLeft": "keyboard_return", "Database": "database",
    "Download": "download", "Eye": "visibility", "FileCode2": "code_blocks", "FileDown": "file_save",
    "FolderOpen": "folder_open", "FunctionSquare": "function", "Gauge": "speed", "Hash": "tag",
    "History": "history", "Home": "grid_view", "KeyRound": "key", "Layers": "layers", "Lock": "lock",
    "Pencil": "edit", "Play": "play_arrow", "PlayCircle": "play_circle", "Plus": "add", "RefreshCw": "refresh",
    "Save": "save", "Search": "search", "Settings": "settings", "Sparkles": "star_shine", "Square": "stop",
    "Table2": "table", "Terminal": "terminal", "Trash2": "delete", "Undo2": "undo", "Unplug": "link_off",
    "Upload": "upload", "Wand2": "format_align_left", "X": "close", "XCircle": "cancel",
}
files = subprocess.run(["grep", "-rl", 'from "lucide-react"', "src"], capture_output=True, text=True).stdout.split()
for f in files:
    s = open(f).read()
    m = re.search(r'import \{([^}]*)\} from "lucide-react";\n', s)
    local = {}
    for part in [p.strip() for p in m.group(1).split(",") if p.strip()]:
        name, _, alias = part.partition(" as ")
        name = name.strip()
        if name not in MAP:
            raise SystemExit(f"{f}: no mapping for {name}")
        local[(alias or name).strip()] = MAP[name]
    rel = os.path.relpath("src/components/Icon", os.path.dirname(f))
    rel = rel if rel.startswith(".") else "./" + rel
    s = s.replace(m.group(0), f'import {{ Icon }} from "{rel}";\n')
    for loc, icon in local.items():
        s = re.sub(rf"<{loc}(?=[\s/>])", f'<Icon name="{icon}"', s)
    s = re.sub(r'(<Icon name="[a-z0-9_]+"[^>]*?)aria-label=', r"\1label=", s)
    open(f, "w").write(s)
    print(f"{f}: {len(local)} icons")
EOF
npm uninstall lucide-react
```

Expected: 19 lines, one per file. No "no mapping" error.

- [ ] **Step 4: Check the rewrite.**

Run: `grep -rn 'lucide' src package.json; npm run typecheck && npm run lint && npm test`
Expected:
- `grep` prints nothing.
- Typecheck, lint and all tests pass, including the guard and existing component tests such as TableView, ConnectionForm and the updates tests.
- If a test looked an icon up by its `aria-label` and now fails, it should find the same name through `label`, since `Icon` turns `label` into `aria-label`. Fix the call site, not the test.

- [ ] **Step 5: Commit.**

```bash
git add -A src scripts/assets.test.mjs package.json package-lock.json
git commit -m "design: replace Lucide icons with the bundled Material Symbols" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 5: Shared control styles, environment badges, grid row height

**Files:**
- Create: `src/features/data-grid/rowHeight.test.ts`, `src/lib/env.test.ts`
- Modify: `src/styles/app.css`, `src/features/data-grid/DataGrid.tsx`, `src/lib/env.ts`, `src/components/EnvBadge.tsx`, `src/app/WorkspaceView.tsx`, `scripts/theme-check.test.mjs`

**Interfaces:**
- Consumes: the Task 1 tokens.
- Produces:
  - `ROW_HEIGHT` exported from `DataGrid.tsx` (30);
  - `envStyle(env) → Record<string, string>` from `src/lib/env.ts`, setting `--env-color`, `--env-bg` and `--env-text`.

- [ ] **Step 1: Write the failing tests.** Create `src/features/data-grid/rowHeight.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_HEIGHT } from "./DataGrid";

describe("grid row height", () => {
  it("matches the --row-height token, so the virtualizer and CSS agree", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const css = /--row-height:\s*(\d+)px/.exec(tokens)?.[1];
    expect(ROW_HEIGHT).toBe(Number(css));
    expect(ROW_HEIGHT).toBe(30);
  });
});
```

Create `src/lib/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { envStyle } from "./env";

describe("envStyle", () => {
  it("points the environment hooks at that environment's tokens", () => {
    expect(envStyle("production")).toEqual({
      "--env-color": "var(--env-production)",
      "--env-bg": "var(--env-production-bg)",
      "--env-text": "var(--env-production-text)",
    });
  });
});
```

Add this test inside the "theme tokens" `describe` in `scripts/theme-check.test.mjs`:

```js
  it("app.css uses no color-mix() either", () => {
    const app = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
    expect(app).not.toMatch(/color-mix/);
  });
```

- [ ] **Step 2: Run them and check they fail.**

Run: `npx vitest run src/features/data-grid/rowHeight.test.ts src/lib/env.test.ts scripts/theme-check.test.mjs`
Expected:
- the row-height test fails, because `ROW_HEIGHT` isn't exported;
- the `envStyle` test fails, because it's not a function;
- `app.css` still contains `color-mix`.

- [ ] **Step 3: Implement the TypeScript hooks.**
  - In `src/features/data-grid/DataGrid.tsx`, change `const ROW_HEIGHT = 26;` to:
    ```ts
    /** Must equal --row-height in tokens.css (rowHeight.test.ts). */
    export const ROW_HEIGHT = 30;
    ```
  - In `src/lib/env.ts`, after `envColorVar`, add:
    ```ts
    /** CSS variables that colour an environment dot, stripe or badge (see .env-dot, .env-badge). */
    export function envStyle(env: Environment): Record<string, string> {
      return {
        "--env-color": `var(--env-${env})`,
        "--env-bg": `var(--env-${env}-bg)`,
        "--env-text": `var(--env-${env}-text)`,
      };
    }
    ```
  - In `src/components/EnvBadge.tsx`, import `envStyle` instead of `envColorVar`, and render:
    ```tsx
    <span className="env-badge" data-env={env} style={envStyle(env)}>
    ```
  - In `src/app/WorkspaceView.tsx` line 199, replace `style={{ ["--env-color" as string]: envColorVar(s.environment) }}` with `style={envStyle(s.environment)}`. Import `envStyle` from `../lib/env`, and keep the `envColorVar` import only if it's still used in the file.

- [ ] **Step 4: Restyle the shared controls.** In `src/styles/app.css`, replace everything from `/* ---- controls` up to (not including) `/* ---- app shell` with:

```css
/* ---- controls ------------------------------------------------------------ */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}
.btn-danger {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--danger-text);
}
.btn-danger:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--danger);
  border-color: var(--danger);
}
.btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}
.btn-ghost:hover:not(:disabled) {
  border-color: transparent;
  background: var(--surface-hover);
  color: var(--text);
}
.btn-icon {
  width: 30px;
  padding: 0;
}

.input,
.select,
.textarea {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text);
  min-width: 0;
  user-select: text;
}
.input::placeholder,
.textarea::placeholder {
  color: var(--text-dim);
}
.textarea {
  height: auto;
  padding: 8px 10px;
  resize: vertical;
  font-family: var(--font-code);
  font-size: var(--text-sm);
}
.input:focus,
.select:focus,
.textarea:focus {
  outline: none;
  border-color: var(--focus);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.input[aria-invalid="true"] {
  border-color: var(--danger);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field > span {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
}
.field-row {
  display: flex;
  gap: var(--space-4);
}
.field-row > .field {
  flex: 1;
}
.hint {
  font-size: var(--text-sm);
  color: var(--text-faint);
}
.checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
}
.checkbox input[type="checkbox"],
.checkbox input[type="radio"] {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
}

.kbd {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  font-family: var(--font-code);
  font-size: var(--text-xs);
  border: 1px solid var(--border-input);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--text-faint);
}

/* ---- messages ------------------------------------------------------------ */

.notice {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-hairline);
  background: var(--surface-panel);
  font-size: var(--text-sm);
  user-select: text;
}
.notice-error {
  border-color: var(--danger);
  background: var(--danger-bg);
}
.notice-warning {
  border-color: var(--warning);
  background: var(--warning-bg);
}
.notice pre {
  margin: var(--space-2) 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-xs);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-6);
  color: var(--text-muted);
  text-align: center;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- overlays ------------------------------------------------------------ */

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: var(--backdrop);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  z-index: 1000;
}
.dialog {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop);
  width: min(560px, calc(100vw - 32px));
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-wide {
  width: min(860px, calc(100vw - 32px));
}
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 16px 22px;
  border-bottom: 1px solid var(--border-hairline);
}
.dialog-header h2 {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0;
}
.dialog-body {
  padding: 20px 22px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-3);
  padding: 14px 22px;
  border-top: 1px solid var(--border-hairline);
  background: var(--surface-panel);
}
.dialog-footer .spacer {
  flex: 1;
}

.menu {
  position: fixed;
  z-index: 1100;
  min-width: 180px;
  padding: var(--space-2);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
}
.menu button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  text-align: left;
  cursor: pointer;
}
.menu button:hover,
.menu button:focus-visible {
  background: var(--surface-hover);
  outline: none;
}
.menu button.danger {
  color: var(--danger);
}
.menu hr {
  border: 0;
  border-top: 1px solid var(--border-hairline);
  margin: var(--space-2) 0;
}

.toasts {
  position: fixed;
  right: var(--space-5);
  bottom: calc(var(--statusbar-height) + var(--space-5));
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 420px;
  z-index: 1200;
}
.toast {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  user-select: text;
}
.toast-error {
  border-left: 3px solid var(--danger);
}
.toast-success {
  border-left: 3px solid var(--accent);
}

```

- [ ] **Step 5: Restyle the environment badge and the segmented control.**

  Replace the `.env-badge` and `.env-badge[data-env="production"]` rules with:

```css
.env-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--text-xs);
  font-weight: 500;
  background: var(--env-bg);
  color: var(--env-text);
  border: 1px solid transparent;
}
/* Production keeps an outline so it never reads as just another colour. */
.env-badge[data-env="production"] {
  border-color: var(--env-production);
  font-weight: 600;
}
```

  Replace the four `.segmented` rules with:

```css
.segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}
.segmented button {
  height: 26px;
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
}
.segmented button:hover {
  color: var(--text);
}
.segmented button[aria-pressed="true"] {
  background: var(--surface-active);
  color: var(--text);
  font-weight: 500;
}
```

  Then run `grep -n "color-mix" src/styles/app.css`. For each remaining use, replace the `color-mix(in srgb, var(--X) N%, transparent)` expression:
  - environment colours become `var(--env-bg)`;
  - accent tints become `var(--selection)`;
  - danger tints become `var(--danger-bg)`;
  - warning tints become `var(--warning-bg)`.

  Record each replacement in the ledger.

- [ ] **Step 6: Run the tests and the suite.**

Run: `npx vitest run src/features/data-grid/rowHeight.test.ts src/lib/env.test.ts scripts/theme-check.test.mjs && npm run typecheck && npm run lint && npm test && npm run build`
Expected: the new tests pass, and every other check passes.

- [ ] **Step 7: Commit.**

```bash
git add src scripts/theme-check.test.mjs
git commit -m "design: restyle shared controls, dialogs, menus, badges; 30 px grid rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QaWfJ61cQ1q8Q5ShPw9eCN"
```

---

### Task 6: After screenshots, review, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-design-revamp-design.md` (status line only).

- [ ] **Step 1: Capture the after screenshots** with the same procedure as Task 0 Steps 2–3, named `after-<theme>-<screen>.png`. Rebuild with `cargo build -p table-pro-max` first; Vite serves the new frontend live.

  Read each pair (before and after) and check:
  - fonts are Geist;
  - icons are Material Symbols with no missing glyph boxes;
  - controls match the design metrics;
  - grid rows are 30 px and line up while scrolling (press `Next` or `Page_Down` twice in the grid);
  - production badges keep their outline;
  - keyboard focus is visible (press `Tab` a few times and capture once per theme).

  Record findings in the ledger, and fix layout breaks before continuing.

- [ ] **Step 2: Full verification.**

Run: `npm run typecheck && npm run lint && npm test && npm run build && git status --short`
Expected: everything passes, and the working tree is clean apart from git-ignored scratch files.

- [ ] **Step 3: Push and open the PR** after confirming with the maintainer:

  1. Run `git push -u origin design/revamp`.
  2. Open the PR with `gh pr create --title "design: foundations (tokens, fonts, icons, controls)"`.
  3. Use a body covering what changed, how it was tested, and before/after screenshots. Attach two or four of the key PNGs to the conversation with SendUserFile, since PR bodies cannot embed local files.
  4. End the body with the 🤖 footer.

  Squash-merge after **CI passed**.

- [ ] **Step 4: Update the spec status** after merge: set the status line to "PR 1 (foundations) merged; PR 2 next". Commit on the next design branch.
