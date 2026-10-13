# Design Revamp PR 3 (Connections) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Connections home, the connection form and the connecting state to the design (screens 01, 09 and 12), keeping every existing behaviour.

**Architecture:**
- **Home** becomes environment-grouped cards (Production → Staging → Testing → Development → Local) with a sort control and a URL-paste shortcut that opens the form already filled.
- **The form** keeps its state and logic, and only its markup changes: engine tiles, sectioned layout, environment choice chips, an SSH toggle card and a collapsible "Safety & timeouts" section.
- **A `ConnectingDialog`** shows the connection summary and a spinner while `App` is connecting, and steps aside whenever a password or host-trust prompt is open.

**Tech Stack:** React 19, zustand, vitest with Testing Library and `@tauri-apps/api/mocks`.

**Spec:** `docs/superpowers/specs/2026-10-14-design-revamp-design.md`, the screens table rows "Connections home", "Connection form" and "Connecting", and "Delivery plan" item 3.

## Global Constraints
- **No behaviour changes.** Search, sort (custom order, name, recent), the context menu (connect, edit, duplicate, export, delete), import/export, all form fields and validation, URL parsing, test connection, save and save-and-connect, keychain fallback, SSH, TLS and file create/choose all stay.
- **Kept accessible names:** existing form tests use these, so they stay: the "Connection URL" input, the "Fill from URL" button, "Save", the "Password storage" select and the "TLS" select.
- **Environment order** for grouping: production, staging, testing, development, local. Labels come from `ENVIRONMENTS`.
- **Engine short marks** become two letters like the design: PG, MY, MA, SQ, DU, RD (`DRIVERS[].short`).
- **Connecting dialog:** no Cancel button and no step list in this PR (phase 2: progress events and cancel). It renders nothing while `useUi` has a `confirmRequest` or `promptRequest`.
- **Shared rules:** Node, commands, commit trailer and workflow as in the PR 1 plan. This PR is frontend only, so no `full-ci`. The vite dev server must be restarted if screenshots look stale (PR 2 ledger).

## Review Focus
1. **A connection whose environment has no group** still appears, under its environment heading (Task 1 test covers all five).
2. **A pasted URL with a password** must not leave the password in the search box or anywhere visible after the form opens. The search box is cleared when the form opens (Task 1 test).
3. **A password prompt during connect** must not hide behind the connecting dialog (Task 3 test).
4. **Switching engine in the form** (tile click) keeps the same resets as the old select. File engines show the file picker and hide server fields; Redis shows "Database number" (Task 2 test).
5. **Long names or paths on cards** truncate with an ellipsis and never widen the grid (CSS `min-width: 0` plus `text-overflow`, checked in screenshots).

---

### Task 1: Connections home

**Files:**
- Create: `src/features/connections/Home.test.tsx`
- Modify: `src/features/connections/Home.tsx`, `src/lib/env.ts` (`DRIVERS` short marks, new `ENV_ORDER`), `src/styles/app.css` (home rules)

**Interfaces:**
- Produces:
  - `ENV_ORDER: Environment[]` from `src/lib/env.ts`;
  - a new `ConnectionForm` prop `initialUrl?: string`, implemented in Task 2. In this task, Home passes it, and the form ignores it until Task 2.

- [ ] **Step 1: Write the failing tests.** Create `src/features/connections/Home.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ConnectionProfile, StoredConnection } from "../../types/backend";
import { Home } from "./Home";
import { useConnections } from "../../stores/connections";
import { profile } from "../../test/fixtures";

const conn = (over: Partial<ConnectionProfile>, lastUsedAt: string | null = null, sortOrder = 0): StoredConnection => ({
  profile: { ...profile, ...over },
  lastUsedAt,
  sortOrder,
});

beforeEach(() => {
  mockIPC(() => null);
  useConnections.setState({
    connections: [
      conn({ id: "l", name: "Local Dev", environment: "local", group: null }, null, 1),
      conn({ id: "p", name: "Prod Core", environment: "production", group: "Pilot", safetyMode: "read_only", ssh: { host: "bastion", port: 22, user: "me", auth: "key", keyPath: null, secretMode: "ask" } }, "2026-10-13T10:00:00Z", 2),
      conn({ id: "s", name: "Stage", environment: "staging", group: "Pilot" }, "2026-10-14T09:00:00Z", 3),
      conn({ id: "d", name: "Dev", environment: "development" }, null, 4),
      conn({ id: "t", name: "Tests", environment: "testing" }, null, 5),
    ],
  } as never);
});
afterEach(() => {
  cleanup();
  clearMocks();
});

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.replace(/\d+$/, "").trim());

describe("Home", () => {
  it("groups connections by environment, production first", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    expect(headings()).toEqual(["Production", "Staging", "Testing", "Development", "Local"]);
  });

  it("shows group, tunnel and read-only facts on the card, and connects on click", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    const card = screen.getByRole("button", { name: "Connect to Prod Core" });
    expect(within(card).getByText(/Pilot · SSH tunnel · Opens read-only/)).toBeInTheDocument();
    fireEvent.click(card);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }));
  });

  it("filters by search text and sorts by name", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "stage" } });
    expect(screen.queryByText("Prod Core")).not.toBeInTheDocument();
    expect(screen.getByText("Stage")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(screen.getByRole("button", { name: "Name" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers to create a connection from a pasted URL and clears the search box", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const search = screen.getByLabelText("Search connections") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "postgres://svc:s3cret@db.internal:5432/shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Create connection from this URL/ }));
    expect(screen.getByRole("dialog", { name: "New connection" })).toBeInTheDocument();
    expect(search.value).toBe("");
  });

  it("opens the edit form from the card's edit button without connecting", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Stage" }));
    expect(screen.getByRole("dialog", { name: "Edit Stage" })).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });
});
```

  Check that `Dialog` labels its dialog by title (`aria-labelledby`). If `getByRole("dialog", { name })` fails, read `src/components/Dialog.tsx`; if it isn't labelled, use `getByText(<title>)` and record a ruling.

- [ ] **Step 2: Run and check it fails.** Run `npx vitest run src/features/connections/Home.test.tsx`.
  Expected: FAIL. The environment headings and the "Create connection from this URL" button are missing.

- [ ] **Step 3: Implement.** Make these changes:
  - **`src/lib/env.ts`:**
    - Change the short marks to `PG`, `MY`, `MA`, `SQ`, `DU`, `RD`.
    - Add:
      ```ts
      /** Order of the environment groups on the Connections home: the riskiest first. */
      export const ENV_ORDER: Environment[] = ["production", "staging", "testing", "development", "local"];
      ```
  - **`Home.tsx`:**
    - Grouping becomes by `profile.environment` in `ENV_ORDER`. Empty environments are skipped. Within a group, keep the chosen sort.
    - Header: `<h1>Connections</h1>`, with a subtitle `{n} saved · passwords in {appInfo?.credentialStore ?? "your system keychain"}`, and the Import, Export and New connection buttons as now.
    - Toolbar:
      - the search input (same `aria-label`), with placeholder "Search by name, host, database — or paste a connection URL";
      - then a segmented control with the buttons `Custom`, `Recent` and `Name` (`aria-pressed`), replacing the select.
    - **URL row:** when the trimmed search starts with `[a-z][a-z0-9+.-]*://` (no spaces), render a row above the groups: `<button className="url-row">Create connection from this URL …</button>`.
      - Clicking it calls `setPendingUrl(search.trim())`, then `setSearch("")` and `setEditing("new")`.
      - Filtering is skipped while the search is a URL.
    - Each group renders as:
      ```tsx
      <section className="conn-group" aria-label={label}>
        <h2 className="conn-group-head" style={envStyle(env)}>
          <span className="env-dot" />{label} <span className="count">{items.length}</span>
        </h2>
        <div className="conn-cards">…cards…</div>
      </section>
      ```
    - Each card is `<div className="conn-card" role="button" tabIndex={0} aria-label={`Connect to ${p.name}`} …>`, with the same click, Enter and context-menu handlers as the old row:
      - **top row:** `<span className="driver-mark">{driverShort}</span>`, the name, `driverLabel · {relative or locale date of lastUsedAt}`, and `<EnvBadge>`;
      - **middle:** the target in `.mono` (the file path for file drivers, else `user@host:port/db`);
      - **footer:** the facts joined with ` · ` from `[group || "No group", ssh ? "SSH tunnel" : null, safetyMode === "read_only" ? "Opens read-only" : null]`, plus the spinner when `connecting === p.id`, then `<button className="btn btn-ghost btn-icon" aria-label={`Edit ${p.name}`} onClick={(e) => { e.stopPropagation(); setEditing(p); }}><Icon name="edit" size={15} /></button>` and `<span className="connect-link">Connect <Icon name="chevron_right" size={15} /></span>`.
    - Pass `initialUrl={pendingUrl ?? undefined}` to `ConnectionForm`, and clear `pendingUrl` in `onClose`/`onSaved`.
    - Keep the empty state and the data-folder hint.
  - **CSS:** replace the `.conn-group h3`, `.conn-list`, `.conn-row*` rules with:

```css
.home-sub {
  margin: 2px 0 0;
  color: var(--text-muted);
}
.home-toolbar {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}
.url-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: 10px 14px;
  border: 1px dashed var(--accent);
  border-radius: var(--radius-lg);
  background: var(--selection);
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.conn-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.conn-group-head .count {
  color: var(--text-faint);
  font-weight: 500;
}
.conn-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
}
.conn-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  cursor: pointer;
}
.conn-card:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}
.conn-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.conn-card-title {
  flex: 1;
  min-width: 0;
}
.conn-card-title strong,
.conn-card-title span,
.conn-card .target {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conn-card-title span {
  font-size: var(--text-sm);
  color: var(--text-faint);
}
.conn-card .target {
  font-family: var(--font-code);
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.conn-card-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-top: 10px;
  border-top: 1px solid var(--border-hairline);
  font-size: var(--text-sm);
  color: var(--text-faint);
}
.conn-card-foot .facts {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connect-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--accent);
  font-weight: 500;
}
```

  Change `.driver-mark` to `min-width: 28px; height: 28px; border-radius: var(--radius-md); font-family: var(--font-code);`, keeping its colours. Change `.home-inner` to `width: min(1056px, 100%)`.

- [ ] **Step 4: Run the checks.** Run `npx vitest run src/features/connections && npm run typecheck && npm run lint && npm test`.
  Expected: the 5 Home tests and the existing form tests pass, and everything else passes.

- [ ] **Step 5: Commit** with message `design: Connections home as environment-grouped cards` (add the trailer).

---

### Task 2: Connection form

**Files:**
- Modify: `src/features/connections/ConnectionForm.tsx`, `src/features/connections/ConnectionForm.test.tsx`, `src/styles/app.css`

**Interfaces:**
- Consumes: `initialUrl` from Task 1.

- [ ] **Step 1: Write the failing tests.** Append to `ConnectionForm.test.tsx`, inside its top-level `describe`. Use the file's existing render helper and `appInfo(true)`:

```tsx
  it("switches engine with the tiles: file engines show the file picker, Redis asks for a database number", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    expect(screen.getByText("Database file")).toBeInTheDocument();
    expect(screen.queryByText("Host")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Redis/ }));
    expect(screen.getByText("Database number (0–15)")).toBeInTheDocument();
  });

  it("sets the environment with the colour chips and warns for an unguarded production connection", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Production" }));
    expect(screen.getByRole("radio", { name: "Production" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByText("Safety & timeouts"));
    fireEvent.change(screen.getByLabelText("Query safety"), { target: { value: "normal" } });
    expect(screen.getByText(/production connection runs statements without confirmation/)).toBeInTheDocument();
  });

  it("fills the form from a URL passed in from the home screen", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="postgres://svc:s3cret@db.internal:6543/shop" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue("db.internal")).toBeInTheDocument());
    expect(screen.queryByDisplayValue(/s3cret@/)).not.toBeInTheDocument();
  });
```

  The existing `mockIPC` in this file answers `parse_url` with the db.internal profile, so the URL test uses it. If `waitFor` or `appInfo` aren't imported or defined under those names, use the file's names.

- [ ] **Step 2: Run and check it fails.** Run `npx vitest run src/features/connections/ConnectionForm.test.tsx`.
  Expected: FAIL. There are no radios (engine tiles and environment chips), no "Safety & timeouts" section, and `initialUrl` is ignored.

- [ ] **Step 3: Implement the markup.** All state and handlers stay; only the layout changes.
  - **URL import (new connections only):** keep the URL row, with the same `aria-label` and the same "Fill from URL" button. Prefix the input with `<Icon name="open_in_new" size={15} />`, and add the hint "Optional — or fill the fields by hand".
  - **`initialUrl` prop:**
    ```tsx
    useEffect(() => { if (initialUrl) { setUrl(initialUrl); void importFrom(initialUrl); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
    ```
    Refactor `importUrl` into `importFrom(u: string)`, with `importUrl = () => importFrom(url)`. After a successful parse `url` is already cleared, so the password never stays visible.
  - **Engine tiles:** `<div role="radiogroup" aria-label="Database type" className="engine-tiles">`. Each `DRIVERS` entry renders:
    ```tsx
    <button role="radio" aria-checked={p.driver === d.value} disabled={isEdit && p.driver !== d.value} onClick={() => setDriver(d.value)}><span className="driver-mark">{d.short}</span>{d.label}</button>
    ```
  - **Section "General":** a `<h3 className="form-section">General</h3>`, then Name and Group in a `field-row`. Then the environment chips:
    ```tsx
    <div role="radiogroup" aria-label="Environment" className="env-chips">{ENVIRONMENTS.map((e) => <button role="radio" aria-checked={p.environment === e.value} style={envStyle(e.value)} onClick={() => set({ environment: e.value })}><span className="env-dot" />{e.label}</button>)}</div>
    ```
    Add the hint "Colours the window so you always know where you are".
  - **Section "Server"**, for non-file drivers: host, port, user, database, password, and password storage, as now. For file drivers, a section "File" with the file field.
  - **Section "Security"**, for non-file drivers: TLS and CA as now, then the SSH toggle as a card:
    ```tsx
    <label className="toggle-card"><Icon name="key" size={16} /><span><strong>Connect through an SSH tunnel</strong><span className="hint">For databases inside a private network</span></span><input type="checkbox" className="switch" checked={!!p.ssh} onChange={…same…} /></label>
    ```
    The SSH fields follow, as now.
  - **Safety & timeouts:** `<details className="form-collapse"><summary>Safety & timeouts</summary>…query safety, query timeout, connect timeout fields as now…</details>`. Keep the production warning outside `<details>`, so it's always visible when it applies.
  - **Footer:** a `btn` labelled "Test" (with `Icon name="speed"`), then the inline result text (`Connected to …` with a success style, or "Test before saving — nothing is stored until you save." when idle), spacer, Cancel, Save, then `Save & connect` (primary).
  - **Errors:** stay as a notice above the footer, as now.

  Add the CSS:

```css
.form-section {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.engine-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}
.engine-tiles button,
.env-chips button {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.engine-tiles button[aria-checked="true"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.engine-tiles button:disabled {
  opacity: 0.45;
  cursor: default;
}
.env-chips {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-3);
}
.env-chips button {
  height: 34px;
}
.env-chips button[aria-checked="true"] {
  border-color: var(--env-color);
  background: var(--env-bg);
  color: var(--env-text);
  font-weight: 500;
}
.toggle-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
}
.toggle-card > span {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.switch {
  appearance: none;
  width: 32px;
  height: 18px;
  margin: 0;
  border-radius: 999px;
  background: var(--border-strong);
  position: relative;
  cursor: pointer;
}
.switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--surface);
}
.switch:checked {
  background: var(--accent);
}
.switch:checked::after {
  left: 16px;
}
.form-collapse summary {
  cursor: pointer;
  font-weight: 500;
  color: var(--text-muted);
}
.form-collapse[open] summary {
  margin-bottom: var(--space-4);
}
```

- [ ] **Step 4: Run the checks.** Run `npx vitest run src/features/connections && npm run typecheck && npm run lint && npm test`.
  Expected: all form tests pass (3 old and 3 new), plus Home's, and everything else passes.

- [ ] **Step 5: Commit** with message `design: connection form with engine tiles, sections and environment chips` (add the trailer).

---

### Task 3: Connecting dialog

**Files:**
- Create: `src/features/connections/ConnectingDialog.tsx`, `src/features/connections/ConnectingDialog.test.tsx`
- Modify: `src/app/App.tsx`, `src/styles/app.css`

**Interfaces:**
- Consumes: the `connecting` state in `App` (a profile id or `null`) and `useConnections.getState().byId(id)`.
- Produces: `ConnectingDialog({ profile }: { profile: ConnectionProfile })`.

- [ ] **Step 1: Write the failing tests.** Create `src/features/connections/ConnectingDialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectingDialog } from "./ConnectingDialog";
import { profile } from "../../test/fixtures";
import { useUi } from "../../stores/ui";

afterEach(() => {
  cleanup();
  useUi.setState({ confirmRequest: null, promptRequest: null });
});

describe("ConnectingDialog", () => {
  it("names the connection, its environment and target while connecting", () => {
    render(<ConnectingDialog profile={profile} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Connecting to ${profile.name}`);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText(/app@localhost:5432\/app/)).toBeInTheDocument();
  });

  it("steps aside while a password or host-trust prompt is open", () => {
    useUi.setState({ promptRequest: { title: "Password", label: "Password", initial: "", confirmLabel: "Connect", resolve: () => undefined } });
    const { container } = render(<ConnectingDialog profile={profile} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run and check it fails.** Run `npx vitest run src/features/connections/ConnectingDialog.test.tsx`.
  Expected: FAIL. `./ConnectingDialog` can't be found.

- [ ] **Step 3: Implement.** Create `src/features/connections/ConnectingDialog.tsx`:

```tsx
import type { ConnectionProfile } from "../../types/backend";
import { EnvBadge } from "../../components/EnvBadge";
import { isFileDriver } from "../../lib/env";
import { useUi } from "../../stores/ui";

/** Shown while a connection is being opened. Prompts (password, host trust) take its place. */
export function ConnectingDialog({ profile: p }: { profile: ConnectionProfile }) {
  const prompting = useUi((s) => s.confirmRequest !== null || s.promptRequest !== null);
  if (prompting) return null;
  const target = isFileDriver(p.driver) ? p.filePath : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`;
  return (
    <div className="dialog-backdrop">
      <div className="dialog connecting" role="status" aria-live="polite">
        <div className="dialog-body">
          <EnvBadge env={p.environment} />
          <h2 className="connecting-title">Connecting to {p.name}</h2>
          <div className="mono connecting-target">{target}</div>
          <div className="connecting-wait">
            <span className="spinner" aria-hidden />
            Opening the connection…
          </div>
        </div>
      </div>
    </div>
  );
}
```

  In `App.tsx`, render `{connecting && useConnections.getState().byId(connecting) && <ConnectingDialog profile={useConnections.getState().byId(connecting)!} />}` before `<Overlays />`. The `connecting` state is already set by `connect()`.

  Add the CSS:

```css
.dialog.connecting {
  width: min(440px, calc(100vw - 32px));
  margin-top: 18vh;
}
.connecting-title {
  margin: 6px 0 0;
  font-size: var(--text-lg);
  font-weight: 600;
}
.connecting-target {
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.connecting-wait {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-muted);
}
```

- [ ] **Step 4: Run the checks.** Run `npx vitest run src/features/connections && npm run typecheck && npm run lint && npm test && npm run build`.
  Expected: everything passes.

- [ ] **Step 5: Commit** with message `design: connecting dialog` (add the trailer).

---

### Task 4: Screenshots, review, PR
- [ ] Restart Vite if it has been running since before the branch's changes, then clear the isolated WebKit cache (PR 2 ledger).
- [ ] Capture `after3-{dark,light}-{home,table,query,settings}` with `capture.sh`. Also capture the New connection form: click "New connection", which sits at the home header's right edge; read its position from the home shot. Also capture the connecting dialog (in the seeded shop, a connect happens at start-up, so take the screenshot at about 2 s instead of 12 s, or note that it's too fast to capture).
- [ ] Compare with the prototype shots `target/tpm-scratch/design-shots/home.png` and `s2-formparsed.png`.
- [ ] Full verification, then a fresh whole-branch review, the fix pass, push, and the PR (no `full-ci`). Squash-merge after **CI passed**.
