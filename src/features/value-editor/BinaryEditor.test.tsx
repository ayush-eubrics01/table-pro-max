import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { BinaryEditor } from "./BinaryEditor";
import type { Cell } from "../../types/backend";

afterEach(() => {
  cleanup();
  clearMocks();
});
beforeEach(() => mockIPC(() => null));

const props = (value: Cell, extra: Partial<Parameters<typeof BinaryEditor>[0]> = {}) => ({
  title: "items · photo",
  typeName: "bytea",
  load: () => Promise.resolve(value),
  readOnlyReason: null,
  nullable: true,
  onSave: vi.fn(),
  onClose: vi.fn(),
  ...extra,
});

describe("BinaryEditor", () => {
  it("shows the value and applies new hex", async () => {
    const p = props({ $bytes: "00ff", size: 2 });
    render(<BinaryEditor {...p} />);
    const input = await screen.findByLabelText("Hex");
    expect(input).toHaveValue("00ff");
    expect(screen.getByText("2 bytes")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "0xDEAD BEEF" } });
    expect(screen.getByRole("status")).toHaveTextContent("4 bytes");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(p.onSave).toHaveBeenCalledWith({ $hex: "deadbeef" });
  });

  it("won't apply what isn't hex", async () => {
    const p = props(null);
    render(<BinaryEditor {...p} />);
    fireEvent.change(await screen.findByLabelText("Hex"), { target: { value: "abc" } });
    expect(screen.getByRole("status")).toHaveTextContent(/hex digits/i);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("doesn't offer a value it only has in part as the starting text", async () => {
    render(<BinaryEditor {...props({ $bytes: "00".repeat(4096), size: 100_000 })} />);
    expect(await screen.findByLabelText("Hex")).toHaveValue("");
    expect(screen.getByText(/first 4 KB/)).toBeInTheDocument();
  });

  it("loads a file as the new value", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:dialog|open") return "/home/me/pixel.png";
      if (cmd === "read_binary_file") return "89504e47";
      return null;
    });
    const p = props(null);
    render(<BinaryEditor {...p} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load file…" }));
    await waitFor(() => expect(screen.getByLabelText("Hex")).toHaveValue("89504e47"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(p.onSave).toHaveBeenCalledWith({ $hex: "89504e47" });
  });

  it("sets NULL, and saves the stored value to a file", async () => {
    const onSaveToFile = vi.fn(() => Promise.resolve());
    const p = props({ $bytes: "01", size: 1 }, { onSaveToFile });
    render(<BinaryEditor {...p} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save to file…" }));
    expect(onSaveToFile).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));
    expect(p.onSave).toHaveBeenCalledWith(null);
  });

  it("only shows the value when it can't be changed", async () => {
    render(<BinaryEditor {...props({ $bytes: "01", size: 1 }, { readOnlyReason: "Read-only connection" })} />);
    expect(await screen.findByLabelText("Hex")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load file…" })).toBeNull();
  });
});
