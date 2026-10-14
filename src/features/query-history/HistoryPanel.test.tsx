import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HistoryPanel } from "./HistoryPanel";

const entries = [
  { id: 1, connectionId: "c", databaseName: "app", sql: "select 1", startedAt: "2026-10-14T10:00:00Z", durationMs: 4, status: "success", rowCount: 1, error: null },
  { id: 2, connectionId: "c", databaseName: "app", sql: "selec 2", startedAt: "2026-10-14T10:01:00Z", durationMs: 1, status: "error", rowCount: null, error: "syntax error" },
];

beforeEach(() => mockIPC((cmd) => (cmd === "search_history" ? entries : null)));
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("HistoryPanel", () => {
  it("lists past statements with their status, inserts on click and closes", async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<HistoryPanel connectionId="c" refreshKey={0} onInsert={onInsert} onOpen={() => undefined} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    const failed = await screen.findByText("selec 2");
    expect(failed.closest("button")).toHaveAttribute("data-status", "error");
    expect(failed.closest("button")).toHaveTextContent(/error/);
    expect(screen.getByText("select 1").closest("button")).toHaveTextContent(/success/);
    fireEvent.click(screen.getByText("select 1"));
    expect(onInsert).toHaveBeenCalledWith("select 1");
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(onClose).toHaveBeenCalled();
  });
});
