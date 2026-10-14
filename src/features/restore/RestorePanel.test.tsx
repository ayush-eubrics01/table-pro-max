import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { RestorePanel } from "./RestorePanel";
import { Overlays } from "../../components/Overlays";
import { session } from "../../test/fixtures";
import { useRestore } from "../../stores/restore";
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
  calls = [];
  points = [summary];
  mockIPC((cmd, args) => {
    calls.push([cmd, args as Record<string, unknown>]);
    if (cmd === "list_restore_points") return points;
    if (cmd === "get_restore_point") return { ...point, ...points.find((p) => p.id === (args as { id: string }).id) };
    if (cmd === "preview_restore") return { sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1 …", statementCount: 1, atomic: true };
    if (cmd === "apply_restore") return [1];
    if (cmd === "delete_restore_point") {
      points = [];
      return null;
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
});
