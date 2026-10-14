import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DefinitionView } from "./DefinitionView";
import { session } from "../../test/fixtures";

const DDL = 'CREATE TABLE "public"."users" (\n  "id" integer NOT NULL\n);';

beforeEach(() => mockIPC((cmd) => (cmd === "object_definition" ? DDL : null)));
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("DefinitionView", () => {
  it("shows the DDL with line numbers and opens it in the editor without running it", async () => {
    const onOpenSql = vi.fn();
    render(<DefinitionView session={session} schema="public" name="users" kind="table" onOpenSql={onOpenSql} />);
    expect(await screen.findByText("3")).toHaveClass("ln");
    fireEvent.click(screen.getByRole("button", { name: /Open in editor/ }));
    expect(onOpenSql).toHaveBeenCalledWith(DDL, "users (definition)");
    expect(screen.getByRole("button", { name: /Copy SQL/ })).toBeInTheDocument();
  });

  it("hides Open in editor when there is nowhere to open it", async () => {
    render(<DefinitionView session={session} schema="public" name="users" kind="table" />);
    await screen.findByText("3");
    expect(screen.queryByRole("button", { name: /Open in editor/ })).not.toBeInTheDocument();
  });
});
