import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ExportDialog } from "./ExportDialog";

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("ExportDialog", () => {
  it("refuses rows that still hold Not loaded or previewed values instead of writing them empty", async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === "plugin:dialog|save") return "/tmp/out.csv";
      return 1;
    });
    render(
      <ExportDialog
        source={{
          kind: "rows",
          dialect: "postgres",
          label: "1 selected row",
          columns: [
            { name: "id", typeName: "int4" },
            { name: "body", typeName: "text" },
          ],
          rows: [["1", { $notLoaded: true }]],
        }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file and export" }));
    expect(await screen.findByText(/not loaded/i)).toBeInTheDocument();
    expect(calls).not.toContain("export_rows");
  });

  it("keeps the SQL file's header comment when the CSV-only header box was unticked", async () => {
    const exports: { options: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "plugin:dialog|save") return "/tmp/out.sql";
      if (cmd === "export_rows") exports.push((args as { request: { options: Record<string, unknown> } }).request);
      return 1;
    });
    render(
      <ExportDialog
        source={{ kind: "rows", dialect: "postgres", label: "1 selected row", columns: [{ name: "id", typeName: "int4" }], rows: [["1"]] }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Include a header row/));
    fireEvent.change(screen.getByRole("combobox", { name: "Format" }), { target: { value: "sql" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file and export" }));
    await waitFor(() => expect(exports).toHaveLength(1));
    expect(exports[0]!.options).toMatchObject({ format: "sql", header: true });
  });
});
