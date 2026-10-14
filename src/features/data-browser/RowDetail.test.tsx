import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RowDetail } from "./RowDetail";
import { usersStructure } from "../../test/fixtures";

afterEach(cleanup);

const base = {
  columns: usersStructure.columns,
  row: ["3", "ada@example.com", null],
  editable: (c: number) => c !== 0,
  onEdit: () => undefined,
  heading: "Row 3",
  subheading: "users",
  isEdited: (c: number) => c === 1,
  onClose: () => undefined,
};

describe("RowDetail", () => {
  it("names the row, marks nullable and edited fields, and closes", () => {
    const onClose = vi.fn();
    render(<RowDetail {...base} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Row 3" })).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("nullable")).toBeInTheDocument();
    expect(screen.getByText("edited")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close row details" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("locks fields that cannot be edited", () => {
    render(<RowDetail {...base} />);
    expect(screen.queryByLabelText("id")).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByLabelText("email")).toHaveValue("ada@example.com");
  });

  it("offers Load for a Not loaded field and Open editor for JSON and long text", () => {
    const onLoad = vi.fn();
    const onOpenEditor = vi.fn();
    const columns = [
      ...usersStructure.columns.slice(0, 1),
      { ...usersStructure.columns[1]!, name: "body", dataType: "text" },
      { ...usersStructure.columns[1]!, name: "doc", dataType: "jsonb" },
    ];
    render(<RowDetail {...base} columns={columns} row={["3", { $notLoaded: true }, '{"a":1}']} onLoad={onLoad} onOpenEditor={onOpenEditor} />);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Open editor" }));
    expect(onOpenEditor).toHaveBeenCalledWith(2);
  });
});
