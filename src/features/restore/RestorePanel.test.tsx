import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { RestorePanel } from "./RestorePanel";
import { Overlays } from "../../components/Overlays";
import { session } from "../../test/fixtures";
import { useRestore } from "../../stores/restore";
import { useUi } from "../../stores/ui";
import type { RestorePoint, RestorePointSummary } from "../../types/backend";

const summary: RestorePointSummary = {
  id: "p1",
  connectionId: session.connectionId,
  createdAt: "2026-10-14T10:42:00Z",
  status: "kept",
  restoredAt: null,
  kind: "update",
  schema: "public",
  table: "orders",
  statement: "UPDATE orders SET status = 'x' WHERE customer_id = 42",
  rowCount: 2,
  bytes: 120,
};
const point: RestorePoint = {
  ...summary,
  data: {
    columns: ["id", "status"],
    types: ["integer", "text"],
    keyColumns: ["id"],
    before: [
      ["7", "paid"],
      ["8", "new"],
    ],
    after: [
      ["7", "x"],
      ["8", "x"],
    ],
    ddl: null,
    columnType: null,
  },
};
let calls: [string, Record<string, unknown>][] = [];
let points: RestorePointSummary[] = [];

beforeEach(() => {
  useUi.setState({ toasts: [] });
  calls = [];
  points = [summary];
  mockIPC((cmd, args) => {
    calls.push([cmd, args as Record<string, unknown>]);
    if (cmd === "list_restore_points") return points;
    if (cmd === "get_restore_point") return { ...point, ...points.find((p) => p.id === (args as { id: string }).id) };
    if (cmd === "preview_restore") return { sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1 …", statementCount: 1, atomic: true };
    if (cmd === "apply_restore") return [1, 0];
    if (cmd === "delete_restore_point") {
      points = [];
      return null;
    }
    if (cmd === "delete_restore_points") {
      const n = points.filter((p) => p.status !== "pending").length;
      points = points.filter((p) => p.status === "pending");
      return n;
    }
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

const openPoint = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /orders · Update · 2 rows/ }));
  return screen.findByRole("region", { name: "Restore point" });
};

describe("RestorePanel", () => {
  it("lists restore points and shows before → after", async () => {
    render(<RestorePanel session={session} onClose={() => {}} />);
    const detail = await openPoint();
    expect(within(detail).getByText("UPDATE orders SET status = 'x' WHERE customer_id = 42")).toBeInTheDocument();
    expect(within(detail).getByText("paid")).toBeInTheDocument();
    expect(within(detail).getAllByText("x")).toHaveLength(2);
    expect(calls.find(([c]) => c === "list_restore_points")![1]).toMatchObject({ connectionId: session.connectionId });
  });

  it("restores chosen rows through the review dialog", async () => {
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    await openPoint();
    expect(screen.getByRole("button", { name: "Restore selected" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Row 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some(([c]) => c === "apply_restore")).toBe(true));
    expect(calls.find(([c]) => c === "preview_restore")![1]).toMatchObject({ sessionId: session.sessionId, rows: [1] });
    expect(calls.find(([c]) => c === "apply_restore")![1]).toMatchObject({ pointId: "p1", rows: [1] });
  });

  it("restores everything with Restore all", async () => {
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    await openPoint();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some(([c]) => c === "apply_restore")).toBe(true));
    expect(calls.find(([c]) => c === "apply_restore")![1]).toMatchObject({ rows: null });
    // The message counts the rows that changed (rows already back are skipped).
    expect(await screen.findByText(/Restored 1 row in orders/)).toBeInTheDocument();
  });

  it("shows a long restore's progress and stops it on request", async () => {
    let finish: (e: unknown) => void = () => undefined;
    const cancelled: string[] = [];
    let taskId = "";
    mockIPC(
      (cmd, args) => {
        calls.push([cmd, args as Record<string, unknown>]);
        if (cmd === "list_restore_points") return points;
        if (cmd === "get_restore_point") return point;
        if (cmd === "preview_restore") return { sql: "INSERT …", statementCount: 1200, atomic: true };
        if (cmd === "apply_restore") {
          taskId = (args as { taskId: string }).taskId;
          return new Promise((_, reject) => (finish = reject));
        }
        if (cmd === "cancel_query") {
          cancelled.push((args as { taskId: string }).taskId);
          finish({ kind: "cancelled", message: "Cancelled; no rows were restored." });
          return true;
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    await openPoint();
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(taskId).not.toBe(""));
    await emit("restore-progress", { taskId: "someone-else", done: 9, total: 9 });
    await emit("restore-progress", { taskId, done: 500, total: 1200 });
    const bar = await screen.findByRole("progressbar", { name: "Restoring" });
    expect(bar).toHaveAttribute("value", "500");
    expect(bar).toHaveAttribute("max", "1200");
    expect(screen.getByText("500 of 1,200 statements")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop restore" }));
    await waitFor(() => expect(cancelled).toEqual([taskId]));
    expect(await screen.findByText("Cancelled; no rows were restored.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("stops listening for progress cleanly, even where events aren't available", async () => {
    const rejected: unknown[] = [];
    const record = (e: unknown) => rejected.push(e);
    process.on("unhandledRejection", record);
    // No event plugin here: stopping the listener fails, and that must not surface.
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: {} });
    try {
      render(
        <>
          <RestorePanel session={session} onClose={() => {}} />
          <Overlays />
        </>,
      );
      await openPoint();
      fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
      expect(await screen.findByText(/Restored 1 row in orders/)).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(rejected).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("deletes a restore point after asking", async () => {
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    await openPoint();
    fireEvent.click(screen.getByRole("button", { name: "Delete restore point" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete restore point" }));
    await waitFor(() => expect(calls.some(([c]) => c === "delete_restore_point")).toBe(true));
    expect(await screen.findByText(/No restore points/)).toBeInTheDocument();
  });

  it("deletes all of the connection's restore points after asking, keeping pending ones", async () => {
    points = [summary, { ...summary, id: "p2", bytes: 80 }, { ...summary, id: "p3", status: "pending" }];
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete all restore points" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete all restore points?" });
    expect(dialog).toHaveTextContent("2 restore points");
    expect(dialog).toHaveTextContent("200 B");
    expect(dialog).toHaveTextContent(/pending/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 restore points" }));
    await waitFor(() => expect(calls.some(([c, a]) => c === "delete_restore_points" && a.connectionId === session.connectionId)).toBe(true));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });

  it("names each item with its status, so the Pending and Restored tags are heard too", async () => {
    points = [{ ...summary, status: "pending" }, { ...summary, id: "p2", status: "restored" }, { ...summary, id: "p3" }];
    render(<RestorePanel session={session} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /orders · Update · 2 rows, .*, pending$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /orders · Update · 2 rows, .*, restored$/ })).toBeInTheDocument();
    const names = screen.getAllByRole("button", { name: /orders · Update · 2 rows/ }).map((b) => b.getAttribute("aria-label") ?? "");
    expect(names.filter((n) => !/, (pending|restored)$/.test(n))).toHaveLength(1);
  });

  it("says in words which rows were deleted and what changed, with no labels on plain text", async () => {
    points = [{ ...summary, kind: "delete" }];
    const deleted: RestorePoint = { ...point, kind: "delete", data: { ...point.data, after: [] } };
    mockIPC((cmd) => (cmd === "list_restore_points" ? points : cmd === "get_restore_point" ? deleted : null));
    const { container } = render(<RestorePanel session={session} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /orders · Delete · 2 rows/ }));
    await screen.findByRole("region", { name: "Restore point" });
    expect(await screen.findAllByText("Deleted")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Row 1, deleted" })).toBeInTheDocument();
    expect(container.querySelectorAll("span[aria-label]")).toHaveLength(0);
  });

  it("marks changed values in words without an aria-label", async () => {
    const { container } = render(<RestorePanel session={session} onClose={() => {}} />);
    await openPoint();
    await screen.findAllByText("changed to");
    expect(container.querySelectorAll("span[aria-label]")).toHaveLength(0);
  });

  it("moves focus into a restore point and back to its item", async () => {
    render(<RestorePanel session={session} onClose={() => {}} />);
    const item = await screen.findByRole("button", { name: /orders · Update · 2 rows/ });
    item.focus();
    fireEvent.click(item);
    await screen.findByRole("region", { name: "Restore point" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: /public\.orders/ })));
    fireEvent.click(screen.getByRole("button", { name: /All restore points/ }));
    // CI with coverage is slow: give the list its render.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /orders · Update · 2 rows/ })), { timeout: 3000 });
  });

  it("offers no Delete all when only pending restore points exist", async () => {
    points = [{ ...summary, status: "pending" }];
    render(<RestorePanel session={session} onClose={() => {}} />);
    await screen.findByRole("button", { name: /orders · Update/ });
    expect(screen.queryByRole("button", { name: "Delete all restore points" })).not.toBeInTheDocument();
  });

  it("can't restore on a read-only connection or before the transaction ends", async () => {
    render(<RestorePanel session={{ ...session, readOnly: true }} onClose={() => {}} />);
    await openPoint();
    expect(screen.getByRole("button", { name: "Restore all" })).toBeDisabled();
    cleanup();
    points = [{ ...summary, status: "pending" }];
    render(<RestorePanel session={session} onClose={() => {}} />);
    await openPoint();
    expect(screen.getByRole("button", { name: "Restore all" })).toBeDisabled();
    expect(screen.getByText(/Pending/)).toBeInTheDocument();
  });

  it("reloads when new restore points may exist", async () => {
    points = [];
    render(<RestorePanel session={session} onClose={() => {}} />);
    expect(await screen.findByText(/No restore points/)).toBeInTheDocument();
    points = [summary];
    useRestore.getState().bump();
    expect(await screen.findByRole("button", { name: /orders · Update · 2 rows/ })).toBeInTheDocument();
  });

  it("shows a dropped column's rows as changed, not deleted, and says the restore runs in two steps", async () => {
    const dropped: RestorePointSummary = { ...summary, kind: "drop_column", statement: "ALTER TABLE orders DROP COLUMN status" };
    points = [dropped];
    mockIPC((cmd) => {
      if (cmd === "list_restore_points") return points;
      if (cmd === "get_restore_point") return { ...dropped, data: { ...point.data, after: [], columnType: "text" } };
      if (cmd === "preview_restore") return { sql: "ALTER TABLE …; UPDATE …", statementCount: 3, atomic: false };
      return null;
    });
    render(
      <>
        <RestorePanel session={session} onClose={() => {}} />
        <Overlays />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /orders · Drop column · 2 rows/ }));
    const detail = await screen.findByRole("region", { name: "Restore point" });
    expect(detail.querySelectorAll("tr.deleted")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    expect(await screen.findByText("The column or table comes back first, then its rows.")).toBeInTheDocument();
  });

  it("restores a table without a primary key only all at once, and only once", async () => {
    const nokey: RestorePointSummary = { ...summary, kind: "delete" };
    points = [nokey];
    let restored = false;
    mockIPC((cmd) => {
      if (cmd === "list_restore_points") return points;
      if (cmd === "get_restore_point")
        return { ...nokey, status: restored ? "restored" : "kept", data: { ...point.data, keyColumns: [], after: [] } };
      return null;
    });
    render(<RestorePanel session={session} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /orders · Delete · 2 rows/ }));
    await screen.findByRole("region", { name: "Restore point" });
    expect(screen.queryByRole("checkbox", { name: "Row 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore all" })).toBeEnabled();
    cleanup();
    restored = true;
    render(<RestorePanel session={session} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /orders · Delete · 2 rows/ }));
    await screen.findByRole("region", { name: "Restore point" });
    expect(screen.getByRole("button", { name: "Restore all" })).toBeDisabled();
  });

  it("loads a point once while it stays open, whatever the parent re-renders", async () => {
    const { rerender } = render(<RestorePanel session={session} onClose={() => {}} />);
    await openPoint();
    rerender(<RestorePanel session={session} onClose={() => {}} />);
    rerender(<RestorePanel session={session} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter(([c]) => c === "get_restore_point")).toHaveLength(1);
  });
});

