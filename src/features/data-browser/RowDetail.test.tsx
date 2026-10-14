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
});
