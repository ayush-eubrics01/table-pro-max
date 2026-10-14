import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
