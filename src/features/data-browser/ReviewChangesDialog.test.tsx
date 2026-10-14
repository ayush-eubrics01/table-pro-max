import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { session } from "../../test/fixtures";

afterEach(cleanup);

const props = {
  session,
  title: "Review changes",
  sql: "UPDATE \"users\" SET \"email\" = 'a' WHERE \"id\" = 1;",
  summary: "1 change to public.users",
  atomic: true,
  statements: 1,
  commitLabel: "Commit changes",
  onCommit: async () => undefined,
  onClose: () => undefined,
};

describe("ReviewChangesDialog", () => {
  it("summarises statements, target and transaction, and keeps production unmistakable", () => {
    render(<ReviewChangesDialog {...props} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`1 statement · ${session.connectionName} · one transaction`)).toBeInTheDocument();
    expect(within(dialog).getByText("Production")).toBeInTheDocument();
    expect(within(dialog).getByText(session.target)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Commit changes" })).toHaveClass("btn-danger");
    expect(dialog.querySelector(".syn-keyword")?.textContent).toBe("UPDATE");
  });

  it("copies the SQL and goes back to editing", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onClose = vi.fn();
    render(<ReviewChangesDialog {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy SQL/ }));
    expect(writeText).toHaveBeenCalledWith(props.sql);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).toHaveBeenCalled();
  });
});
