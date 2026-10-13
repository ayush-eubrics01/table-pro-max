# Design Revamp PR 2 (Window Frame) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the connection strip with the design's custom title bar (app mark, connection tabs, search pill, settings, window controls), add the environment stripe, and restyle the status bar, on Windows, Linux and macOS.

**Architecture:**
- **Window chrome per platform.** Windows and Linux get `decorations: false` through `tauri.windows.conf.json` and `tauri.linux.conf.json`, and the React title bar draws the window controls. macOS gets `titleBarStyle: "Overlay"` and `hiddenTitle`, so its native traffic lights stay, with a 78 px inset in the bar. Secondary windows built in Rust (`open_window`) get the same settings.
- **New shell components.**
  - `TitleBar` takes over the strip markup from `App.tsx`.
  - `WindowControls` calls the Tauri window API.
  - The environment stripe and status bar live in the shell.
- **Permissions.** Only the window permissions the bar needs are added to the capability.

**Tech Stack:** Tauri 2.12 config and capabilities, `@tauri-apps/api/window`, React 19, vitest with `@tauri-apps/api/mocks` (`mockIPC`, `mockWindows`).

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, sections "Window frame" and "Delivery plan" item 2.

## Global Constraints
- **Title bar:** 42 px (`--titlebar-height`). Environment stripe 2 px, 3 px for production. Status bar 28 px (`--statusbar-height`).
- **Title bar content:** app mark · `Connections` home tab · one tab per open connection (environment dot, name, close) · flexible drag space · search pill (opens the palette; shows `Ctrl K`, `⌘ K` on macOS) · new window · Settings · window controls (not on macOS).
- **Dragging:** the drag region is `data-tauri-drag-region` on the empty title-bar areas. Double click maximises, which needs `core:window:allow-internal-toggle-maximize`.
- **Permissions:** add exactly `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-close`, `allow-start-dragging`, `allow-is-maximized` and `allow-internal-toggle-maximize`. Nothing else, and no `core:window:default`.
- **Status bar:**
  - left: environment (dot and label), name, `user@host:port/db`, server version;
  - right: write mode ("Writes enabled" or "Read-only"), safety mode, schema, app version.
  - Production keeps its tinted bar.
- **Behaviour unchanged:** tab activation, close-with-unsaved warning, the palette, Settings, new window, reconnect.
- **Labels stay:** existing accessible names stay the same (`Disconnect <name>`, `New window`, `Settings`).
- **Commits:** Node 24, frontend checks, commit trailer and workflow exactly as in the PR 1 plan. This PR touches `src-tauri/`, so the PR gets the `full-ci` label.
- **Rust toolchain:** for `cargo clippy/build -p table-pro-max`, first run `source target/tpm-scratch/sysroot/env.sh`.

## Review Focus
1. **The window can't be dragged or resized on Linux or Windows** once decorations are off. The drag region must cover the empty title-bar space, and resizing must still work. Linux is checked by the maintainer on a real desktop (Task 4).
2. **A second window (Ctrl+Shift+N) shows a native frame and the custom bar together, or neither.** `open_window` must apply the same per-platform settings (Task 1).
3. **macOS traffic lights overlap the app mark or the tabs.** The 78 px inset applies only on macOS (Task 2 test: macOS mode hides custom controls and marks the bar `data-mac`).
4. **Tabs overflow with many connections.** The tab strip scrolls horizontally and never pushes the search pill or window controls off-screen (`min-width: 0` plus `overflow-x: auto`, checked in Task 4 screenshots with 5 open connections).
5. **Production loses its band** when the workspace border is removed. The stripe is 3 px and production-coloured, and the status bar stays tinted (Task 3 test).

---

### Task 1: Per-platform window chrome and permissions

**Files:**
- Create: `src-tauri/tauri.linux.conf.json`, `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.macos.conf.json`, `scripts/window-config.test.mjs`
- Modify: `src-tauri/capabilities/default.json`, `src-tauri/src/commands/connections.rs` (`open_window`)

- [ ] **Step 1: Write the failing test.** Create `scripts/window-config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it and check it fails.** Run `npx vitest run scripts/window-config.test.mjs`.
  Expected: FAIL. `src-tauri/tauri.linux.conf.json` is not found, and the permissions are missing.

- [ ] **Step 3: Add the platform configs and permissions.** Each platform file replaces `app.windows`, so it repeats the full window. Create `src-tauri/tauri.linux.conf.json` and `src-tauri/tauri.windows.conf.json`, both with:

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Table Pro Max",
        "width": 1360,
        "height": 860,
        "minWidth": 900,
        "minHeight": 560,
        "resizable": true,
        "decorations": false
      }
    ]
  }
}
```

  Create `src-tauri/tauri.macos.conf.json`:

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Table Pro Max",
        "width": 1360,
        "height": 860,
        "minWidth": 900,
        "minHeight": 560,
        "resizable": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true
      }
    ]
  }
}
```

  In `src-tauri/capabilities/default.json`, add after `"core:window:allow-set-title",`:

```json
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
```

  Update the capability `description` to end with: "Window permissions are limited to what the custom title bar needs (drag, minimise, maximise, close)."

- [ ] **Step 4: Give secondary windows the same chrome.** In `src-tauri/src/commands/connections.rs`, replace the body of `open_window` with:

```rust
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let builder = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Table Pro Max")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 560.0);
    // Same chrome as the main window (tauri.<os>.conf.json): native traffic lights on macOS,
    // the app's own title bar elsewhere.
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder.build().map_err(|e| AppError::internal(format!("Could not open a window: {e}")))?;
    Ok(())
```

- [ ] **Step 5: Run the checks.**

Run:
```bash
npx vitest run scripts/window-config.test.mjs
source target/tpm-scratch/sysroot/env.sh && cargo clippy -p table-pro-max --all-targets -- -D warnings && cargo fmt --all -- --check
```
Expected: 3 tests pass. clippy and fmt are clean, and Tauri's build script accepts the platform config and capability (an unknown permission would fail the build).

- [ ] **Step 6: Commit** with message `design: custom title bar chrome per platform and window permissions` (add the trailer).

---

### Task 2: `TitleBar` and `WindowControls`

**Files:**
- Create: `src/app/TitleBar.tsx`, `src/app/WindowControls.tsx`, `src/app/TitleBar.test.tsx`
- Modify: `src/app/App.tsx`, `src/styles/app.css`

**Interfaces:**
- Produces:
  - `TitleBar({ mac, onCloseWorkspace })`;
  - `WindowControls()`;
  - `isMacPlatform(): boolean` (exported from `WindowControls.tsx`).

- [ ] **Step 1: Write the failing tests.** Create `src/app/TitleBar.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { TitleBar } from "./TitleBar";
import { useUi } from "../stores/ui";
import { useWorkspaces } from "../stores/workspaces";
import { profile, session } from "../test/fixtures";

let cmds: string[];

beforeEach(() => {
  cmds = [];
  mockWindows("main");
  mockIPC((cmd) => {
    cmds.push(cmd);
    return cmd === "plugin:window|is_maximized" ? false : null;
  });
  useUi.setState({ paletteOpen: false });
  useWorkspaces.setState({
    workspaces: [{ id: "ws-1", profile, session, schema: "public", tabs: [], activeTabId: null, health: "ok" }],
    activeId: "ws-1",
  } as never);
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("TitleBar", () => {
  it("shows the home tab and one tab per open connection, and marks drag space", () => {
    const { container } = render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    expect(screen.getByRole("tab", { name: /Connections/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Local PG/ })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector("header")).toHaveAttribute("data-tauri-drag-region");
  });

  it("opens the palette from the search pill", () => {
    render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Search tables, actions and connections/ }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("asks before disconnecting through the tab's close button", () => {
    const close = vi.fn();
    render(<TitleBar mac={false} onCloseWorkspace={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Local PG" }));
    expect(close).toHaveBeenCalledWith("ws-1");
  });

  it("minimises, maximises and closes through the window API", async () => {
    render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(cmds).toEqual(expect.arrayContaining(["plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close"])),
    );
  });

  it("leaves the window buttons to macOS and makes room for its traffic lights", () => {
    const { container } = render(<TitleBar mac onCloseWorkspace={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument();
    expect(container.querySelector("header")).toHaveAttribute("data-mac", "true");
    expect(screen.getByText("⌘ K")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and check it fails.** Run `npx vitest run src/app/TitleBar.test.tsx`.
  Expected: FAIL. `./TitleBar` can't be found.

- [ ] **Step 3: Implement `WindowControls`.** Create `src/app/WindowControls.tsx`:

```tsx
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../components/Icon";

/** macOS keeps its native traffic lights; everywhere else the app draws the window buttons. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const refresh = () =>
      getCurrentWindow()
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => undefined);
    try {
      void refresh();
      void getCurrentWindow()
        .onResized(() => void refresh())
        .then((u) => {
          if (alive) unlisten = u;
          else u();
        })
        .catch(() => undefined);
    } catch {
      // Outside Tauri (tests without window mocks) there is no window to follow.
    }
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return (
    <div className="window-controls">
      <button className="window-control" aria-label="Minimize" title="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <Icon name="minimize" size={16} />
      </button>
      <button
        className="window-control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <Icon name="crop_square" size={14} />
      </button>
      <button className="window-control close" aria-label="Close" title="Close" onClick={() => void getCurrentWindow().close()}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Implement `TitleBar`.** Create `src/app/TitleBar.tsx`. The tab markup is moved from `App.tsx`, with the same behaviour and accessible names:

```tsx
import { Icon } from "../components/Icon";
import { api } from "../lib/ipc";
import { envStyle } from "../lib/env";
import { notifyError, useUi } from "../stores/ui";
import { useWorkspaces } from "../stores/workspaces";
import { WindowControls } from "./WindowControls";

interface Props {
  /** macOS draws its own traffic lights in the top-left corner. */
  mac: boolean;
  onCloseWorkspace: (id: string) => void;
}

/** The window's title bar: connection tabs, search, settings and (off macOS) window buttons. */
export function TitleBar({ mac, onCloseWorkspace }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const activate = (id: string | null) => useWorkspaces.getState().activate(id);

  return (
    <header className="titlebar" data-tauri-drag-region data-mac={mac || undefined}>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="app-mark" aria-hidden>
          <Icon name="table" size={14} />
        </span>
        <span data-tauri-drag-region>Table Pro Max</span>
      </div>
      <nav className="titlebar-tabs" role="tablist" aria-label="Open connections">
        <button className="tb-tab" role="tab" aria-selected={activeId === null} onClick={() => activate(null)}>
          <Icon name="grid_view" size={15} />
          <span className="label">Connections</span>
        </button>
        {workspaces.map((w) => (
          <div
            key={w.id}
            className="tb-tab"
            role="tab"
            tabIndex={0}
            aria-selected={activeId === w.id}
            style={envStyle(w.session.environment)}
            onClick={() => activate(w.id)}
            onKeyDown={(e) => e.key === "Enter" && activate(w.id)}
            title={w.session.target}
          >
            {w.health === "down" ? <Icon name="link_off" size={13} label="Connection lost" color="var(--danger)" /> : <span className="env-dot" />}
            <span className="label">{w.profile.name}</span>
            <button
              className="tab-close"
              aria-label={`Disconnect ${w.profile.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseWorkspace(w.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </nav>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-actions">
        <button className="search-pill" aria-label="Search tables, actions and connections" onClick={() => useUi.getState().setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span>Search tables, actions…</span>
          <span className="kbd">{mac ? "⌘ K" : "Ctrl K"}</span>
        </button>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="New window"
          title="New window (Ctrl+Shift+N)"
          onClick={() => void api.openWindow().catch((err) => notifyError(err, "Could not open a window"))}
        >
          <Icon name="new_window" size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => useUi.getState().setSettingsOpen(true)}>
          <Icon name="settings" size={16} />
        </button>
      </div>
      {!mac && <WindowControls />}
    </header>
  );
}
```

- [ ] **Step 5: Use it in `App.tsx`.**
  - Replace the whole `<nav className="conn-strip" …>…</nav>` element with `<TitleBar mac={isMac} onCloseWorkspace={(id) => void closeWorkspace(id)} />`.
  - Add `const isMac = useRef(isMacPlatform()).current;` next to `isMainWindow`.
  - Add the imports `import { TitleBar } from "./TitleBar";` and `import { isMacPlatform } from "./WindowControls";`.
  - Remove imports that are now unused. Lint reports them (for example `envColorVar` and `api.openWindow` users). Keep `api` if it's still used elsewhere in `App.tsx`.

- [ ] **Step 6: Title-bar styles.** In `src/styles/app.css`, replace the rules `.conn-strip`, `.conn-strip-tab`, `.conn-strip-tab[aria-selected="true"]`, `.conn-strip-tab[aria-selected="true"]::after` and `.conn-strip-tab .label` with:

```css
.titlebar {
  display: flex;
  align-items: stretch;
  height: var(--titlebar-height);
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border-hairline);
  user-select: none;
  min-width: 0;
}
.titlebar[data-mac] {
  padding-left: 78px;
}
.titlebar-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 16px 0 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  flex: none;
}
.app-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
}
.titlebar-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding-top: 6px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tb-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  max-width: 240px;
  flex: none;
  white-space: nowrap;
}
.tb-tab:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.tb-tab[aria-selected="true"] {
  background: var(--bg);
  color: var(--text);
}
.tb-tab .label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.titlebar-drag {
  flex: 1;
  min-width: 24px;
}
.titlebar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  flex: none;
}
.search-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  width: 240px;
  margin-right: 6px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text-faint);
  cursor: pointer;
}
.search-pill > span:not(.kbd) {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-pill:hover {
  border-color: var(--border-strong);
  color: var(--text-muted);
}
.window-controls {
  display: flex;
  align-items: stretch;
  border-left: 1px solid var(--border-hairline);
  flex: none;
}
.window-control {
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.window-control:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.window-control.close:hover {
  background: var(--danger);
  color: var(--danger-text);
}
```

- [ ] **Step 7: Run the checks.** Run `npx vitest run src/app/TitleBar.test.tsx && npm run typecheck && npm run lint && npm test`.
  Expected: 5 TitleBar tests pass, and all other checks pass.

- [ ] **Step 8: Commit** with message `design: custom title bar with connection tabs, search pill and window controls` (add the trailer).

---

### Task 3: Environment stripe and status bar

**Files:**
- Create: `src/app/StatusBar.test.tsx`
- Modify: `src/app/App.tsx`, `src/app/WorkspaceView.tsx` (`StatusBar`), `src/styles/app.css`

**Interfaces:**
- Consumes: `envStyle`, `envLabel`, `safetyLabel` from `src/lib/env.ts`.
- Produces:
  - `StatusBar({ ws, version })`, where `version` is a `string | undefined`;
  - an `env-stripe` element rendered by `App`.

- [ ] **Step 1: Write the failing tests.** Create `src/app/StatusBar.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./WorkspaceView";
import { profile, session } from "../test/fixtures";
import type { Workspace } from "../stores/workspaces";

afterEach(cleanup);
const ws = (over: Partial<typeof session> = {}) =>
  ({ id: "ws-1", profile, session: { ...session, ...over }, schema: "public", tabs: [], activeTabId: null, health: "ok" }) as unknown as Workspace;

describe("StatusBar", () => {
  it("shows where you are and what you can do", () => {
    render(<StatusBar ws={ws({ readOnly: false })} version="0.1.0" />);
    expect(screen.getByText("Writes enabled")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("says read-only and keeps the production tint", () => {
    const { container } = render(<StatusBar ws={ws({ readOnly: true, environment: "production" })} version="0.1.0" />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(container.querySelector("footer")).toHaveAttribute("data-env", "production");
  });

  it("shows the version with no connection open", () => {
    render(<StatusBar ws={undefined} version="0.1.0" />);
    expect(screen.getByText("No connection open")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });
});
```

  Check that the `session` fixture in `src/test/fixtures.ts` has `readOnly` and `environment` fields. If a field name differs, use the fixture's real name and record a ruling.

- [ ] **Step 2: Run it and check it fails.** Run `npx vitest run src/app/StatusBar.test.tsx`.
  Expected: FAIL. "Writes enabled" and "v0.1.0" aren't found.

- [ ] **Step 3: Implement the status bar.** In `src/app/WorkspaceView.tsx`, change the `StatusBar` signature to `({ ws, version }: { ws: Workspace | undefined; version?: string })`. Then:
  - Make the no-connection branch:
    ```tsx
    <footer className="statusbar"><span>No connection open</span><span className="grow" />{version && <span className="version">v{version}</span>}</footer>
    ```
  - Replace the returned JSX from `<span className="env-dot" …/>` to the end with:

```tsx
      <span className="env-label" style={envStyle(s.environment)}>
        <span className="env-dot" />
        {envLabel(s.environment)}
      </span>
      <span>{s.connectionName}</span>
      <span className="mono">{s.target}</span>
      <span>
        {s.server.product} {s.server.version}
      </span>
      <span className="grow" />
      {s.readOnly ? (
        <span className="write-mode">
          <Icon name="lock" size={12} /> Read-only
        </span>
      ) : (
        <span className="write-mode">Writes enabled</span>
      )}
      <span title="Query safety mode">{safetyLabel(s.safetyMode)}</span>
      <span className="mono">{ws.schema}</span>
      {version && <span className="version">v{version}</span>}
    </footer>
```

  Keep the "Connection lost / Reconnect" part as it is.

- [ ] **Step 4: Add the stripe and pass the version.** In `src/app/App.tsx`:
  - Replace `<StatusBar ws={active} />` with `<StatusBar ws={active} version={appInfo?.version} />`.
  - Directly after `<TitleBar … />`, add:
    ```tsx
    <div className="env-stripe" data-env={active?.session.environment} style={active ? envStyle(active.session.environment) : undefined} />
    ```
  - Import `envStyle` from `../lib/env`.

- [ ] **Step 5: Styles.** In `src/styles/app.css`:
  - Change `.shell`'s `grid-template-rows` to `var(--titlebar-height) auto 1fr var(--statusbar-height);`.
  - Remove `border-top: 3px solid var(--env-color, transparent);` from `.workspace`, and delete the `.workspace[data-env="production"]` rule.
  - Replace the `.statusbar` rule (keep `.statusbar[data-env="production"]` and `.statusbar .grow`) with the rules below, and add the stripe rules before it:

```css
.env-stripe {
  height: 2px;
  background: var(--env-color, transparent);
}
.env-stripe[data-env="production"] {
  height: 3px;
}

.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 12px;
  height: var(--statusbar-height);
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--bg-sunken);
  border-top: 1px solid var(--border-hairline);
  white-space: nowrap;
  overflow: hidden;
}
.statusbar .env-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--env-text);
  font-weight: 600;
}
.statusbar .mono,
.statusbar .version {
  font-family: var(--font-code);
  color: var(--text-faint);
}
.statusbar .write-mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

- [ ] **Step 6: Run the checks.** Run `npx vitest run src/app/StatusBar.test.tsx && npm run typecheck && npm run lint && npm test && npm run build`.
  Expected: 3 StatusBar tests pass, and all other checks pass.

- [ ] **Step 7: Commit** with message `design: environment stripe and the new status bar` (add the trailer).

---

### Task 4: Screenshots, maintainer check on a real desktop, PR

- [ ] **Step 1: Capture after screenshots.**
  1. Run `cargo build -p table-pro-max` with the sysroot environment.
  2. Run `target/tpm-scratch/shots/capture.sh after2 dark` and the same for `light`. The script clicks the home tab at (60,16); with the new bar that's the brand area. In `capture.sh`, change the home click to the `Connections` tab position seen in the first screenshot, and record a ruling.
  3. Also seed five open connections. Extend the session in a one-off copy of the seed run with the other four demo connections, then capture `after2-dark-tabs` to check that tabs overflow without pushing out the search pill.
  4. Read the screenshots against `target/tpm-scratch/design-shots/s1-workspace.png` (the prototype).

- [ ] **Step 2: Full verification.** Run `npm run typecheck && npm run lint && npm test && npm run build`, plus `cargo clippy -p table-pro-max --all-targets -- -D warnings` (sysroot environment).

- [ ] **Step 3: Maintainer check on a real Linux desktop** (Xvfb has no window manager, so it can't show this). Ask the maintainer to run the debug build with the Vite dev server running: `target/debug/table-pro-max`. They check:
  - dragging by the title bar;
  - double-click to maximise;
  - resizing from every edge and corner;
  - minimise, maximise/restore and close;
  - Ctrl+Shift+N opens a second window with the same bar.

  **Linux resize fallback:** if resizing or dragging fails on their desktop, rule on it with the spec's risk. On Linux, keep native decorations (remove `tauri.linux.conf.json`'s `decorations: false`, and gate `open_window`'s `decorations(false)` to Windows), and hide `WindowControls` on Linux. Record the ruling and re-run Task 1 and 2 tests updated to match.

- [ ] **Step 4: Push and open the PR with the `full-ci` label.** CI then builds Windows and macOS installers, which the maintainer can try. Squash-merge after **CI passed**.
