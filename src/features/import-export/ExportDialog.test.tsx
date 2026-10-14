import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
