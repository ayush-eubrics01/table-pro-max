import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { usersStructure } from "../../test/fixtures";
import { FilterBuilder } from "./FilterBuilder";
import type { GroupNode } from "./filterModel";

beforeEach(() => mockIPC((cmd) => (cmd === "list_filter_presets" ? [] : null)));
afterEach(() => {
  cleanup();
  clearMocks();
});

function Harness({ initial, onApply }: { initial: GroupNode; onApply: (g: GroupNode) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <FilterBuilder
      columns={usersStructure.columns}
      value={value}
      onChange={setValue}
      onApply={onApply}
      connectionId="c"
      schema="public"
      table="users"
    />
  );
}

describe("FilterBuilder", () => {
  it("corrects an operator that does not fit the column type", async () => {
    const onApply = vi.fn();
    render(<Harness initial={{ type: "group", logic: "and", children: [{ type: "condition", column: "age", op: "contains", value: "3" }] }} onApply={onApply} />);
    await waitFor(() => expect(screen.getByText("WHERE age = '3'")).toBeInTheDocument());
  });

  it("builds nested groups and applies them", () => {
    const onApply = vi.fn();
    render(<Harness initial={{ type: "group", logic: "and", children: [] }} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /Condition/ }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Group/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Any of" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    const applied = onApply.mock.calls[0]![0] as GroupNode;
    expect(applied.logic).toBe("or");
    expect(applied.children[0]).toMatchObject({ type: "condition", column: "id", op: "eq", value: "5" });
    expect(applied.children[1]).toMatchObject({ type: "group" });
  });

  it("has no limit on the number of conditions", () => {
    render(<Harness initial={{ type: "group", logic: "and", children: [] }} onApply={() => undefined} />);
    const add = screen.getByRole("button", { name: /Condition/ });
    for (let i = 0; i < 40; i++) fireEvent.click(add);
    expect(screen.getAllByLabelText("Column")).toHaveLength(40);
    expect(screen.getByText("40 active")).toBeInTheDocument();
  });
});
