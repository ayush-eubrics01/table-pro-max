import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { session } from "../../test/fixtures";
import { ResultsPanel } from "./ResultsPanel";
import type { ScriptResult, StatementResult } from "../../types/backend";

afterEach(cleanup);

const ok: StatementResult = { index: 0, sql: "select 1", start: 0, end: 8, durationMs: 3, columns: [{ name: "x", typeName: "int" }], rows: [["1"]], totalRows: 1, truncated: false };
const bad: StatementResult = { index: 1, sql: "selec 1", start: 9, end: 16, durationMs: 1, truncated: false, error: { kind: "database", message: "syntax error" } };

describe("ResultsPanel", () => {
  it("shows how to run when idle, with the platform's key", () => {
    render(<ResultsPanel result={null} running={false} dialect="postgres" />);
    const hint = screen.getByText(/to run the statement at the cursor/);
    expect(hint).toHaveTextContent(navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl");
  });

  it("opens Messages, marked as an error, after a failing run", () => {
    const result: ScriptResult = { taskId: "t", statements: [ok, bad], cancelled: false, durationMs: 4 };
    render(<ResultsPanel result={result} running={false} dialect="postgres" />);
    const messages = screen.getByRole("tab", { name: "Messages" });
    expect(messages).toHaveAttribute("aria-selected", "true");
    expect(messages).toHaveClass("error");
    expect(screen.getByRole("tab", { name: /Result.*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByText("syntax error")).toBeInTheDocument();
  });
});

const editable: StatementResult = {
  index: 0,
  sql: "select id, email, count(*) over () n from users",
  start: 0,
  end: 10,
  durationMs: 1,
  truncated: false,
  resultId: "r1",
  totalRows: 2,
  columns: [
    { name: "id", typeName: "int4", origin: { schema: "public", table: "users", column: "id" } },
    { name: "email", typeName: "text", origin: { schema: "public", table: "users", column: "email" } },
    { name: "n", typeName: "int8" },
  ],
  rows: [["1", "ada@example.com", "2"], ["2", "grace@example.com", "2"]],
  editing: { tables: [{ schema: "public", table: "users", keyColumns: [0] }], columns: [0, 0, null], readOnly: [{ column: 2, reason: "Computed column" }] },
};

describe("editable results", () => {
  let calls: { cmd: string; args: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "preview_change_sets") return { sql: "UPDATE …", statementCount: 1, atomic: true };
      if (cmd === "apply_change_sets") return [1];
      return null;
    });
  });
  afterEach(() => clearMocks());
  const scriptOf = (st: StatementResult): ScriptResult => ({ taskId: "t", statements: [st], cancelled: false, durationMs: 1 });

  it("edits a cell, reviews and commits through apply_change_sets", async () => {
    const onDirty = vi.fn();
    render(<ResultsPanel result={scriptOf(editable)} running={false} dialect="postgres" session={session} onDirtyChange={onDirty} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    const editor = screen.getByLabelText("Edit email");
    fireEvent.change(editor, { target: { value: "new@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByText("1 pending change")).toBeInTheDocument();
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Review and commit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "apply_change_sets")).toBe(true));
    const sets = (calls.find((c) => c.cmd === "apply_change_sets")!.args as { sets: unknown[] }).sets;
    expect(sets).toHaveLength(1);
    expect(await screen.findByText(/Shows values from when the query ran, plus your edits/)).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
  });

  it("explains read-only cells and never edits them", () => {
    render(<ResultsPanel result={scriptOf(editable)} running={false} dialect="postgres" session={session} />);
    const cell = screen.getAllByText("2").find((el) => el.closest(".grid-cell")?.getAttribute("aria-colindex") === "4")!.closest(".grid-cell")!;
    expect(cell).toHaveAttribute("title", "Computed column");
    fireEvent.doubleClick(cell);
    expect(screen.queryByLabelText("Edit n")).not.toBeInTheDocument();
  });

  it("does not edit while the tab is running", () => {
    render(<ResultsPanel result={scriptOf(editable)} running dialect="postgres" session={session} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    expect(screen.queryByLabelText("Edit email")).not.toBeInTheDocument();
  });

  it("shows why a whole result is read-only", () => {
    const st = { ...editable, editing: { tables: [], columns: [null, null, null], readOnly: [{ column: 1, reason: "Add id to the SELECT to edit users" }] } };
    render(<ResultsPanel result={scriptOf(st)} running={false} dialect="postgres" session={session} />);
    expect(screen.getByText("Add id to the SELECT to edit users")).toBeInTheDocument();
  });

  it("keeps edits on loaded rows when more pages arrive", async () => {
    // Paging happens inside the grid; the result object stays the same (a new object means a new run).
    const big = scriptOf({ ...editable, totalRows: 3000, rows: editable.rows });
    const { rerender } = render(<ResultsPanel result={big} running={false} dialect="postgres" session={session} />);
    fireEvent.doubleClick(screen.getByText("ada@example.com").closest(".grid-cell")!);
    const editor = screen.getByLabelText("Edit email");
    fireEvent.change(editor, { target: { value: "kept@example.com" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    rerender(<ResultsPanel result={big} running={false} dialect="postgres" session={session} />);
    expect(screen.getByText("kept@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 pending change")).toBeInTheDocument();
  });
});
