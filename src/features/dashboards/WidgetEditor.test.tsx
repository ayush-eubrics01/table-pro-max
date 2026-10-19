import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WidgetEditor } from "./WidgetEditor";
import { session } from "../../test/fixtures";
import type { WidgetDef } from "../../types/backend";

afterEach(() => {
  cleanup();
  clearMocks();
});

const existing: WidgetDef = { id: "w-7", title: "Orders per day", type: "line", sql: "SELECT day, count(*) FROM orders GROUP BY 1", span: 2 };
const result = {
  columns: [
    { name: "day", typeName: "date" },
    { name: "orders", typeName: "bigint" },
  ],
  rows: [
    ["2024-03-01", "12"],
    ["2024-03-02", "18"],
  ],
  truncated: false,
};

function setup(props: Partial<Parameters<typeof WidgetEditor>[0]> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<WidgetEditor session={session} params={{}} onClose={onClose} onSave={onSave} {...props} />);
  return { onSave, onClose };
}

const sqlBox = () => screen.getByLabelText("Query (one read-only SELECT)");
const saveButton = () => screen.getByRole("button", { name: "Save widget" });
const previewButton = () => screen.getByRole("button", { name: "Preview" });

describe("WidgetEditor", () => {
  it("starts a new widget as an empty half-width number", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByLabelText("Show as")).toHaveValue("kpi");
    expect(screen.getByLabelText("Width")).toHaveValue("1");
    expect(sqlBox()).toHaveValue("");
    expect(screen.getByText(/First numeric value of the first row/)).toBeInTheDocument();
  });

  it("cannot save or preview without a query, including one of only whitespace", () => {
    setup();
    expect(saveButton()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    fireEvent.change(sqlBox(), { target: { value: "   \n " } });
    expect(saveButton()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    fireEvent.change(sqlBox(), { target: { value: "SELECT 1" } });
    expect(saveButton()).toBeEnabled();
    expect(previewButton()).toBeEnabled();
  });

  it("saves a new widget with the chosen title, kind, width and query", () => {
    const { onSave, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Revenue by region  " } });
    fireEvent.change(screen.getByLabelText("Show as"), { target: { value: "pie" } });
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "2" } });
    fireEvent.change(sqlBox(), { target: { value: "SELECT region, sum(total) FROM orders GROUP BY 1" } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as WidgetDef;
    expect(saved).toEqual({ id: expect.any(String), title: "Revenue by region", type: "pie", span: 2, sql: "SELECT region, sum(total) FROM orders GROUP BY 1" });
    expect(saved.id).not.toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("names a widget without a title Untitled", () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.change(sqlBox(), { target: { value: "SELECT 1" } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ title: "Untitled", type: "kpi", span: 1, sql: "SELECT 1" });
  });

  it("gives every new widget its own id", () => {
    const first = setup();
    fireEvent.change(sqlBox(), { target: { value: "SELECT 1" } });
    fireEvent.click(saveButton());
    cleanup();
    const second = setup();
    fireEvent.change(sqlBox(), { target: { value: "SELECT 1" } });
    fireEvent.click(saveButton());
    expect(first.onSave.mock.calls[0]![0].id).not.toBe(second.onSave.mock.calls[0]![0].id);
  });

  it("edits an existing widget in place and keeps its id", () => {
    const { onSave } = setup({ initial: existing });
    expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Orders per day");
    expect(screen.getByLabelText("Show as")).toHaveValue("line");
    expect(screen.getByLabelText("Width")).toHaveValue("2");
    expect(sqlBox()).toHaveValue(existing.sql);
    fireEvent.change(screen.getByLabelText("Show as"), { target: { value: "bar" } });
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "1" } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({ ...existing, type: "bar", span: 1 });
  });

  it("explains how each kind reads the query result", () => {
    setup();
    const kind = screen.getByLabelText("Show as");
    const options = Array.from((kind as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(["Number", "Line chart", "Bar chart", "Share (donut)", "Table"]);
    fireEvent.change(kind, { target: { value: "line" } });
    expect(screen.getByText(/numeric columns as lines/)).toBeInTheDocument();
    fireEvent.change(kind, { target: { value: "bar" } });
    expect(screen.getByText(/First column as categories/)).toBeInTheDocument();
    fireEvent.change(kind, { target: { value: "pie" } });
    expect(screen.getByText(/largest five slices plus Other/)).toBeInTheDocument();
    fireEvent.change(kind, { target: { value: "table" } });
    expect(screen.getByText("The result rows.")).toBeInTheDocument();
  });

  it("closes on Cancel, the close button and Escape without saving", () => {
    const { onSave, onClose } = setup({ initial: existing });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cannot preview without a session", () => {
    setup({ session: null, initial: existing });
    expect(previewButton()).toBeDisabled();
    expect(saveButton()).toBeEnabled();
  });

  it("previews the query in a read-only widget run, sending only the parameters it uses", async () => {
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "run_widget_query") {
        calls.push(args);
        return result;
      }
      return null;
    });
    setup({ initial: { ...existing, sql: "SELECT day, count(*) FROM orders WHERE day >= {{from}} GROUP BY 1" }, params: { from: "2024-03-01", to: "2024-03-31", region: "" } });
    fireEvent.click(previewButton());
    expect(await screen.findByRole("img", { name: "Line chart of orders" })).toBeInTheDocument();
    expect(calls).toEqual([
      {
        request: {
          sessionId: session.sessionId,
          sql: "SELECT day, count(*) FROM orders WHERE day >= {{from}} GROUP BY 1",
          params: { from: "2024-03-01" },
          timeoutSecs: 30,
        },
      },
    ]);
  });

  it("leaves out empty parameters even when the query uses them", async () => {
    const calls: { request: { params: Record<string, string> } }[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "run_widget_query") {
        calls.push(args as (typeof calls)[number]);
        return result;
      }
      return null;
    });
    setup({ initial: { ...existing, sql: "SELECT {{region}}, {{from}}" }, params: { region: "", from: "2024" } });
    fireEvent.click(previewButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.request.params).toEqual({ from: "2024" });
    await screen.findByRole("img");
  });

  it("shows Running… while the preview runs and blocks a second run", async () => {
    let finish: (v: typeof result) => void = () => undefined;
    let runs = 0;
    mockIPC((cmd) => {
      if (cmd === "run_widget_query") {
        runs++;
        return new Promise((resolve) => (finish = resolve));
      }
      return null;
    });
    setup({ initial: existing });
    fireEvent.click(previewButton());
    const running = await screen.findByRole("button", { name: "Running…" });
    expect(running).toBeDisabled();
    fireEvent.click(running);
    expect(runs).toBe(1);
    finish(result);
    expect(await screen.findByRole("button", { name: "Preview" })).toBeEnabled();
    expect(screen.getByRole("img", { name: "Line chart of orders" })).toBeInTheDocument();
  });

  it("previews with the kind chosen in the editor, and as a grid for a table", async () => {
    mockIPC((cmd) => (cmd === "run_widget_query" ? result : null));
    setup({ initial: existing });
    fireEvent.click(previewButton());
    await screen.findByRole("img", { name: "Line chart of orders" });
    fireEvent.change(screen.getByLabelText("Show as"), { target: { value: "bar" } });
    expect(screen.getByRole("img", { name: "Bar chart of orders" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Show as"), { target: { value: "kpi" } });
    expect(screen.getByText("12")).toHaveClass("kpi-value");
    fireEvent.change(screen.getByLabelText("Show as"), { target: { value: "table" } });
    expect(screen.getByRole("grid", { name: "Widget data" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows the preview error and clears the previous preview", async () => {
    let fail = false;
    mockIPC((cmd) => {
      if (cmd !== "run_widget_query") return null;
      if (fail) throw { kind: "query", message: 'relation "orderz" does not exist' };
      return result;
    });
    setup({ initial: existing });
    fireEvent.click(previewButton());
    await screen.findByRole("img");
    fail = true;
    fireEvent.change(sqlBox(), { target: { value: "SELECT * FROM orderz" } });
    fireEvent.click(previewButton());
    expect(await screen.findByText('relation "orderz" does not exist')).toHaveClass("notice-error");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });

  it("clears the error when a later preview succeeds", async () => {
    let fail = true;
    mockIPC((cmd) => {
      if (cmd !== "run_widget_query") return null;
      if (fail) throw new Error("timed out");
      return result;
    });
    setup({ initial: existing });
    fireEvent.click(previewButton());
    expect(await screen.findByText("timed out")).toBeInTheDocument();
    fail = false;
    fireEvent.click(previewButton());
    await screen.findByRole("img");
    expect(screen.queryByText("timed out")).not.toBeInTheDocument();
  });

  it("shows the no-rows hint for a preview that returns nothing", async () => {
    mockIPC((cmd) => (cmd === "run_widget_query" ? { ...result, rows: [] } : null));
    setup({ initial: existing });
    fireEvent.click(previewButton());
    expect(await screen.findByText("The query returned no rows.")).toBeInTheDocument();
  });
});
