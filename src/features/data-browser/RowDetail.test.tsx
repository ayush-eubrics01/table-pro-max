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

  it("edits an enum field with a list of its values", () => {
    const onEdit = vi.fn();
    const columns = [
      { name: "id", dataType: "integer", nullable: false, default: null, primaryKey: 1, autoIncrement: false, comment: null },
      { name: "mood", dataType: "mood", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null, enumValues: ["sad", "ok", "happy"] },
    ];
    render(<RowDetail {...base} columns={columns} row={["1", "ok"]} onEdit={onEdit} />);
    const list = screen.getByRole("combobox", { name: "mood" });
    expect(list).toHaveValue("ok");
    fireEvent.change(list, { target: { value: "sad" } });
    expect(onEdit).toHaveBeenCalledWith(1, "sad");
    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));
    expect(onEdit).toHaveBeenCalledWith(1, null);
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
