# Design revamp: design

Date: 2026-10-14. Status: approved in conversation, awaiting written-spec review.
Source design: `/home/ayush/designs-claude/Rust Tauri Database Client Design/`. It contains
`FLOW.md` (the UX spec and tokens), `Table Pro Max.dc.html` (an interactive prototype) and
`tpm-data.js` (mock data). It lives outside the repo; the values the app needs are copied into
this spec and into `src/styles/tokens.css`.

## Goal
Give Table Pro Max the look and layout of the new design across every screen, without
breaking anything the app already does, and with nothing loaded from the internet.

Success means:
- **Every existing screen follows the design.** It is restyled to the design's frame, colours,
  type, icons and spacing, including screens the design does not show: AI assistant, updates,
  DuckDB, Redis, dashboards, import/export and the full filter builder.
- **Dark matches the prototype.** Light is a derived palette of equal quality. Both pass the
  contrast check.
- **No behaviour changes in phase 1.** All existing tests still pass.
- **Production stays unmistakable** everywhere a connection appears.
- **Nothing is loaded from the network.** Fonts and icons ship with the app.

## Decisions (made with the maintainer)
| Topic | Decision |
|---|---|
| Light theme | Keep Light / Dark / System. Dark uses the design's values; light is derived from them and contrast-checked. |
| Scope | Phase 1 restyles everything that exists. Phase 2 adds the design's new behaviours as separate feature PRs, each with its own short design. |
| Icons | Switch from Lucide to Material Symbols Rounded (weight 300), bundled as individual SVGs. |
| Environments | Keep all five. Local, Staging and Production use the design's colours; Development and Testing get two matching colours. |
| Delivery | A series of PRs from `design/*` branches into `main`, each small enough to review, with before/after screenshots in both themes. |

## Non-goals (phase 1)
- **New behaviour.** Phase 1 adds none, including:
  - connect progress steps, pinned objects and the "open production read-only" setting;
  - editing in the row inspector, and jumping to the row a foreign key points to;
  - type-to-confirm, an "Enums" sidebar section, or a "Count exactly" button where none exists.
  These are phase 2.
- **Rewriting existing logic.** Components may be restructured for layout, but stores, IPC and
  backend code stay as they are.
- **A separate design-system package.** Tokens and shared components stay in this repo.

## Visual foundation

### Tokens (`src/styles/tokens.css`)
The variable names already used by `app.css` stay where possible, so the change spreads without
touching every rule. New variables are added for the design's extra levels.

**Dark (from `FLOW.md`):**

| Role | Value |
|---|---|
| Title bar and status bar | `#0B0D10` |
| Main background | `#0F1215` |
| Sidebar and panels | `#111418` |
| Cards and headers | `#13161A` |
| Hover | `#181C21` |
| Borders: hairline, default, inputs, modals | `#1C2026`, `#21262D`, `#262C34`, `#2C323A` |
| Text: primary, secondary, muted, faint | `#E7EAEE`, `#A4ADB8`, `#6E7783`, `#4E5661` |
| Accent and text on accent | `#4ED6A0`, `#06150F` |
| Syntax | keyword `#C4A1FF` · string `#E8B04A` · number `#5BB8F0` · type/function `#4ED6A0` · comment `#6E7783` |

**Environment colours** (as built; each theme has its own set, checked by `scripts/theme-check.mjs`):

| Environment | Dark | Light | Source |
|---|---|---|---|
| Local | `#5BB8F0` | `#4081D2` | design (dark) |
| Staging | `#E8B04A` | `#C16E2D` | design (dark) |
| Production | `#F0605A` | `#9B1207` | design (dark); the badge is filled |
| Development | `#5D7BF1` | `#4C0C49` | new, chosen by a CVD-aware search |
| Testing | `#8EF9FF` | `#2E40A3` | new, chosen by a CVD-aware search |

The first draft of this spec named Development `#8B9CF7` and Testing `#C79BF2`. Those failed the
colour-distance check against the other three (and Staging/Production in light failed it too),
so all light values and the two new dark values were re-chosen against the floors below.

Development and Testing must be told apart from the other three by the colour-distance
validator (the same CVD/normal-vision checks used for chart palettes), with the label always
shown next to the colour.

**Light:** derived, not inverted.
- **Neutrals:** a ramp from near-white backgrounds (`#F6F7F9` main, `#FFFFFF` cards, `#EFF1F4`
  sidebar) to dark text (`#14181D` primary). It keeps the same number of surface and border
  steps as dark.
- **Accent:** darkened to `#0F7A53` (first drafted as `#1E9E6E`) so text and buttons meet 4.5:1. The text on accent buttons
  stays `#06150F`, or white if contrast requires it.
- **Environment colours and syntax:** adjusted only as far as needed to reach 3:1 against the
  light surfaces for dots, stripes and borders. Environment text labels use a darker shade of
  the same hue.

**Shape and metrics:**
- **Radius:** 6–8 controls, 10–12 cards, 14 modals.
- **Heights:** grid row 30, sidebar row 28, structure row 40, title bar 42, object tabs 38,
  status bar 28.
- **Type:** Geist 13 px for the UI; Geist Mono 12.5–13 px for data, SQL and paths.

**Contrast check:** `scripts/theme-check.mjs` (first drafted as `check-contrast.mjs`) reads both themes from `tokens.css` and fails
when a declared pair is below its target:
- 4.5:1 for body text on its surfaces;
- 3:1 for large text, icons, focus rings, environment dots and stripes.

It runs in `npm test` as a vitest test.

### Fonts
- **Bundled packages:** `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`
  (OFL-1.1). They are imported in `main.tsx` in place of IBM Plex, and the IBM Plex packages
  are removed.
- **Licences:** listed in `docs/DEPENDENCY_LICENSES.md`.
- **No network:** no Google Fonts link. The CSP stays `font-src 'self' data:`.

### Icons
- **Source package:** `@material-symbols/svg-300` (Apache-2.0), rounded set.
- **Generated file:** `scripts/gen-icons.mjs` reads a list of icon names and writes
  `src/components/icons.generated.ts`, a map of name → SVG path data (`npm run gen:icons`). Only listed icons are
  bundled, and there is no runtime dependency or HTML injection.
- **`Icon` component:** `<Icon name="table" size={16} />` renders an inline `<svg>` with
  `currentColor`. It is `aria-hidden` by default and takes a `label` prop when the icon is the
  only content.
- **Replacing Lucide:** every Lucide import (about 50 icons) is replaced, and `lucide-react` is
  removed. Rough mapping: table, grid_view, database, terminal, play_arrow, refresh, add,
  close, search, settings, push_pin, filter_list, ios_share, download, upload, edit, delete,
  key, link, schema, history, auto_awesome (AI), system_update (updates).

### Shared components
These are restyled or introduced once and used everywhere:
- **Buttons:** primary (accent), default (outlined), ghost and danger.
- **Form controls:** input, select, textarea, toggle switch, segmented control, checkbox.
- **Small labels:** `Kbd` (keyboard hints), `EnvBadge` / `EnvDot` (environment), and pills
  (Writable / Read-only, statuses).
- **Containers:** tabs (titlebar connection tabs, object tabs, view switch), cards, dialogs,
  menus and toasts.

They come with a visible keyboard focus ring (2 px, accent) and disabled states. Hover is the
only motion, and nothing moves when the user prefers reduced motion.

## Window frame

### Title bar (42 px)
- **Content:** app mark · `Connections` home tab · one tab per open connection (environment
  dot, name, close) · flexible space · search pill (opens the palette, shows the shortcut) ·
  Settings · window controls.
- **Custom drawing:**
  - `decorations: false` on Windows and Linux.
  - On macOS, `titleBarStyle: "Overlay"` with `hiddenTitle`. Native traffic lights stay on the
    left, and the title bar keeps a 72 px inset there.
- **Interaction:** the empty title-bar area is a drag region (`data-tauri-drag-region`), and a
  double click maximises.
- **Window controls on Windows/Linux:** minimise, maximise/restore and close, drawn per the
  design. They use the window API.
- **Capabilities added:** `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-close`,
  `allow-start-dragging` and `allow-is-maximized`. Nothing else is added.
- **Resizing** an undecorated window must still work on Windows and Linux (Tauri 2's built-in
  resize border). This is checked manually on Linux, and on Windows through a `full-ci` build
  the maintainer tries.
- **Secondary windows** (Ctrl+Shift+N) get the same title bar.

### Environment stripe and status bar
- **Stripe:** 2 px under the title bar in the active connection's environment colour, hidden on
  the Connections home.
- **Status bar (28 px):**
  - left: environment label, connection name, `user@host:port/db`, server version;
  - right: write mode (Writes enabled / Read-only), safety mode, schema, app version.
- **Production:** it keeps a production treatment (the existing distinct styling, re-expressed
  with the new colours).

### Update banner and consent
- **Update banner:** sits directly under the title bar and stripe, styled like the design's
  notices. Behaviour is unchanged.
- **First-launch question and Settings › Updates:** both use the new dialog and settings styles.

## Screens (phase 1 mapping)
| Screen | Design reference | Notes |
|---|---|---|
| Connections home | 01 | Cards grouped by environment (Production → Staging → Testing → Development → Local), Recent/Name sort, URL paste row, Import/Export/New. Existing search and sorting behaviour. |
| Connection form | 09 | Engine tiles (PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, Redis), General / Server / Security sections, collapsible "Safety & timeouts", inline Test result, footer buttons. Existing fields and validation. |
| Connecting | 12 | Dialog with the connection summary and a spinner; the steps list arrives in phase 2. |
| Workspace sidebar | 02 | Database/schema switcher, filter, collapsible sections with counts for the object kinds the app lists today, footer actions. |
| Object tabs and empty state | 02 | 38 px tabs, dot for unsaved edits, `+` for a new query; empty state with summary, New query, Find anything. |
| Table: Data | 03 | Toolbar, existing filter builder restyled as chips plus editor, grid styling (types in headers, PK/FK icons, NULL faint italic, enum-like values as tags, booleans coloured), pending-edit colours, floating commit bar, footer. The existing row detail panel is restyled to the inspector layout, read-only as today. |
| Table: Structure / Definition | 04, 05 | Section tables, `+ Column` / `+ Index`, DDL with line numbers, Copy SQL, Open in editor. |
| Query | 06 | Toolbar (Run, Explain, Format, Save, History, target + environment pill), CodeMirror theme from the syntax tokens, Results / Messages / Plan tabs, history drawer, AI panel in the same style. |
| Command palette | 07 | Grouped results, keyboard hints footer. |
| Settings | 08 | Left menu: General, Editor, Data grid, Safety, History, **Updates**, **AI assistant**, Shortcuts, About. Existing settings only; each lands in the section that fits. |
| Review changes / destructive confirm | 10, 11 | New dialog style; type-to-confirm comes in phase 2. |
| Not in the design | — | Import/export dialogs, dashboards and charts, Redis browser and console, DuckDB file open, explain view, toasts: restyled with the same components and tokens. |

## Phase 2 (outline; each item gets its own design before work starts)
1. **Connect progress:** the backend emits `connect://progress` steps (resolve, TLS/SSH,
   authenticate, load schema), with cancel.
2. **Pinned objects** per connection, stored locally, shown as the Pinned section.
3. **"Open production read-only" setting**, enforced by the backend session.
4. **Row inspector editing:** fields editable into pending changes, "filter by this value",
   Copy JSON / Copy INSERT.
5. **Foreign-key jump:** open the referenced table filtered to the value.
6. **Type-to-confirm** for destructive actions on non-local environments.

## Delivery plan (phase 1 PRs, in order)
1. **Foundations:** tokens (dark and light), fonts, icons and `Icon`, shared components,
   contrast check. Every screen changes look; the layout stays.
2. **Window frame:** title bar, stripe, status bar, banner placement, window capabilities.
3. **Connections:** home, form, connecting dialog.
4. **Workspace:** sidebar, object tabs, empty state.
5. **Table views:** Data (grid, toolbar, filters, inspector), Structure, Definition, review and
   confirm dialogs.
6. **Query:** editor theme, results, history, explain, AI panel.
7. **The rest:** palette, Settings (with Updates and AI), consent dialog, import/export,
   dashboards, Redis, DuckDB.

Each PR:
- branches from current `main` as `design/<area>`;
- keeps all tests green;
- shows before/after screenshots of the real app in both themes, taken on the hidden test
  display with isolated data;
- updates `docs/FEATURE_MATRIX.md` where wording or status changes.

A PR touching `src-tauri/` (PR 2) gets the `full-ci` label.

## Testing
- **Existing tests:** all Rust (core and backend) and frontend tests stay green; phase 1
  changes no behaviour. Tests that query by visible text or accessible name are updated only
  where wording changes, and each such change is listed in the PR.
- **New tests:**
  - **Contrast:** both themes, all declared pairs (vitest).
  - **`Icon`:** renders the named icon, is hidden from screen readers unless labelled, and fails
    loudly for an unknown name at build time (typed union of names).
  - **Title bar:** window-control buttons call the window API (mocked), the drag region is
    present, and macOS mode hides the custom controls.
  - **Environment colours:** the Development and Testing additions pass the palette validator
    against the other three.
- **Manual (Linux, hidden test display, isolated data):**
  - each screen in both themes, compared with the prototype;
  - keyboard focus visible on every control;
  - title-bar drag, double-click maximise, resize from every edge, minimise and close;
  - production connection styling.
- **Not testable here:** the native look on Windows and macOS (title-bar insets, traffic
  lights). Checked by the maintainer on a `full-ci` build of PR 2.

## Risks
- **Undecorated windows on Linux:** resize and drag behaviour differs between window managers.
  If resizing fails on a common one, Linux keeps native decorations and the custom bar drops
  its window controls there (decided in PR 2 after testing).
- **Light palette quality:** derived colours may need a second pass after screenshots. The
  contrast check is the floor, not the goal.
- **Long-running branch drift:** small PRs straight into `main` avoid it; `design/revamp` is not
  a long-lived integration branch.
- **Bundle size:** the variable fonts add about 70 KB (woff2) and the icons a few KB. Acceptable.
