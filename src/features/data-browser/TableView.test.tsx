import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { ChangeSet, TableStructure } from "../../types/backend";
import { session, usersStructure } from "../../test/fixtures";
import { TableView } from "./TableView";
import { Overlays } from "../../components/Overlays";

let calls: { cmd: string; args: Record<string, unknown> }[] = [];
let structure: TableStructure = usersStructure;
let rows = [
  ["1", "ada@example.com", "36"],
  ["2", "grace@example.com", null],
];

beforeEach(() => {
  calls = [];
  structure = usersStructure;
  rows = [
    ["1", "ada@example.com", "36"],
    ["2", "grace@example.com", null],
  ];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    switch (cmd) {
      case "table_structure":
        return structure;
      case "browse_table":
        return { columns: [], rows, sql: "SELECT …", durationMs: 1, hasMore: false };
      case "preview_changes":
        return { sql: "UPDATE \"public\".\"users\" SET \"email\" = 'new@example.com' …;", statementCount: 1, atomic: true };
      case "apply_changes":
        return [1];
      case "list_filter_presets":
        return [];
      default:
        return null;
    }
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

const renderView = () =>
  render(
    <>
      <TableView session={session} schema="public" table="users" onReconnect={async () => undefined} />
      <Overlays />
    </>,
  );

/** Rows and the table structure load separately; editing starts only once both are in. */
async function openEditor(text: string) {
  const cell = await screen.findByText(text);
  return waitFor(() => {
    fireEvent.doubleClick(cell.closest(".grid-cell")!);
    return screen.getByLabelText("Edit email");
  });
}

describe("TableView", () => {
  it("loads rows with NULL shown distinctly", async () => {
    renderView();
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("NULL").closest(".grid-cell")).toHaveClass("null");
    const browse = calls.find((c) => c.cmd === "browse_table")!;
    expect(browse.args.request).toMatchObject({ schema: "public", table: "users", offset: 0 });
  });

  it("keeps edits pending until reviewed, then commits a parameterised change set", async () => {
    renderView();
    const editor = await openEditor("ada@example.com");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "apply_changes")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    const dialog = await screen.findByRole("dialog");
    // Production connections name the target and use the danger style.
    expect(within(dialog).getByText("Production")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit changes" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_changes")).toBe(true));
    const set = calls.find((c) => c.cmd === "apply_changes")!.args.changes as ChangeSet;
    expect(set.changes).toEqual([
      {
        type: "update",
        key: [{ column: "id", value: "1" }],
        edits: [{ column: "email", value: { kind: "value", value: "new@example.com" }, original: "ada@example.com" }],
      },
    ]);
    expect(calls.find((c) => c.cmd === "apply_changes")!.args.confirmed).toBe(true);
  });

  it("discard drops pending edits without touching the database", async () => {
    renderView();
    const editor = await openEditor("grace@example.com");
    fireEvent.change(editor, { target: { value: "x" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /Discard/ }));
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "preview_changes" || c.cmd === "apply_changes")).toBe(false);
  });

  it("read-only connections cannot edit", async () => {
    render(<TableView session={{ ...session, readOnly: true }} schema="public" table="users" onReconnect={async () => undefined} />);
    const cell = await screen.findByText("ada@example.com");
    fireEvent.doubleClick(cell.closest(".grid-cell")!);
    expect(screen.queryByLabelText("Edit email")).not.toBeInTheDocument();
    expect(screen.getByTitle("This connection is read-only")).toHaveTextContent("Read-only");
  });

  it("shows the access pill, and pending changes in a floating bar", async () => {
    renderView();
    expect(await screen.findByText("Writable")).toBeInTheDocument();
    const editor = await openEditor("ada@example.com");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    const bar = await screen.findByRole("region", { name: "Pending changes" });
    expect(bar).toHaveTextContent("1 pending change");
    expect(within(bar).getByRole("button", { name: /Discard/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Review and commit" })).toBeInTheDocument();
  });

  it("says Insert only for a table without a primary key, and Read-only for a view", async () => {
    structure = { ...usersStructure, columns: usersStructure.columns.map((c) => ({ ...c, primaryKey: null })) };
    const { unmount } = renderView();
    const pill = await screen.findByTitle("No primary key: existing rows cannot be edited");
    expect(pill).toHaveTextContent("Insert only");
    expect(screen.getByRole("button", { name: /Row/ })).toBeInTheDocument();
    unmount();
    structure = { ...usersStructure, kind: "view" };
    renderView();
    expect(await screen.findByTitle("Views are read-only")).toHaveTextContent("Read-only");
    expect(screen.queryByRole("button", { name: "Delete selected rows" })).not.toBeInTheDocument();
  });

  it("centres the commit bar without halving the room it may use", async () => {
    const { readFileSync } = await import("node:fs");
    const rule = readFileSync("src/styles/app.css", "utf8").match(/\n\.commit-bar \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/left:\s*12px/);
    expect(rule).toMatch(/right:\s*12px/);
    expect(rule).toMatch(/width:\s*fit-content/);
    expect(rule).not.toMatch(/translateX|left:\s*50%/);
  });
});
