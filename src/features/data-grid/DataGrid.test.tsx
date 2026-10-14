import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DataGrid } from "./DataGrid";

afterEach(cleanup);

const columns = [
  { name: "id", typeName: "integer", primaryKey: true },
  { name: "status", typeName: "status_enum" },
  { name: "paid", typeName: "boolean" },
  { name: "owner_id", typeName: "integer", foreignKey: true },
];
const rows = [
  ["1", "DRAFT", "true", "7"],
  ["2", null, "false", null],
];

describe("DataGrid", () => {
  it("marks keys in the header and styles enum and boolean cells", () => {
    render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={rows.length} getRow={(i) => rows[i]} sort={[]} />);
    expect(screen.getByLabelText("Primary key")).toBeInTheDocument();
    expect(screen.getByLabelText("Foreign key")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toHaveClass("tag");
    expect(screen.getByText("true").closest(".grid-cell")).toHaveClass("bool-true");
    expect(screen.getByText("false").closest(".grid-cell")).toHaveClass("bool-false");
    const nulls = screen.getAllByText("NULL");
    expect(nulls.every((n) => !n.classList.contains("tag"))).toBe(true);
  });

  it("adds scroll space under the last row when asked", () => {
    const height = (inset?: number) => {
      const { container, unmount } = render(<DataGrid ariaLabel="Rows" columns={columns} rowCount={2} getRow={(i) => rows[i]} sort={[]} bottomInset={inset} />);
      const sized = container.querySelector(".grid > div:not(.grid-header)") as HTMLElement;
      const h = parseInt(sized.style.height, 10);
      unmount();
      return h;
    };
    expect(height(56) - height()).toBe(56);
  });
});
