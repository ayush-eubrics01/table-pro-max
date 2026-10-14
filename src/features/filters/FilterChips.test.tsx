import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilterChips } from "./FilterChips";
import type { GroupNode } from "./filterModel";

afterEach(cleanup);

const filter: GroupNode = {
  type: "group",
  logic: "and",
  children: [
    { type: "condition", column: "status", op: "eq", value: "PAID" },
    { type: "condition", column: "note", op: "is_null" },
    { type: "condition", column: "total", op: "gt", value: "10", enabled: false },
  ],
};

describe("FilterChips", () => {
  it("shows each enabled condition as a chip and opens the editor on click", () => {
    const onEdit = vi.fn();
    render(<FilterChips filter={filter} onEdit={onEdit} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent(/status/);
    expect(list).toHaveTextContent(/note/);
    expect(list).not.toHaveTextContent(/total/);
    fireEvent.click(screen.getAllByRole("button", { name: /Edit filter/ })[0]!);
    expect(onEdit).toHaveBeenCalled();
  });

  it("renders nothing without enabled conditions", () => {
    const { container } = render(<FilterChips filter={{ type: "group", logic: "and", children: [] }} onEdit={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a negated filter as NOT and skips groups with nothing enabled", () => {
    const negated: GroupNode = {
      type: "group",
      logic: "or",
      negate: true,
      children: [
        { type: "condition", column: "a", op: "eq", value: "1" },
        { type: "condition", column: "b", op: "eq", value: "2" },
        { type: "group", logic: "and", children: [{ type: "condition", column: "c", op: "eq", value: "3", enabled: false }] },
      ],
    };
    render(<FilterChips filter={negated} onEdit={() => undefined} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent(/or/);
    expect(screen.getByText("NOT")).toBeInTheDocument();
  });
});
