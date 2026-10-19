import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { AlterOp, SessionInfo, TableStructure } from "../../types/backend";
import { session, usersStructure } from "../../test/fixtures";
import { Overlays } from "../../components/Overlays";
import { useUi } from "../../stores/ui";
import { StructureView } from "./StructureView";

const orders: TableStructure = {
  schema: "public",
  name: "orders",
  kind: "table",
  columns: [
    { name: "id", dataType: "bigint", nullable: false, default: null, primaryKey: 1, autoIncrement: true, comment: null },
    { name: "user_id", dataType: "integer", nullable: false, default: null, primaryKey: null, autoIncrement: false, comment: null },
    { name: "status", dataType: "text", nullable: false, default: "'draft'::text", primaryKey: null, autoIncrement: false, comment: "Order state" },
    { name: "note", dataType: "text", nullable: true, default: null, primaryKey: null, autoIncrement: false, comment: null },
  ],
  indexes: [
    { name: "orders_pkey", columns: ["id"], unique: true, primary: true, definition: null },
    { name: "orders_user_id_idx", columns: ["user_id", "status"], unique: false, primary: false, definition: "btree (user_id, status)" },
  ],
  foreignKeys: [
    { name: "orders_user_id_fkey", columns: ["user_id"], refSchema: "public", refTable: "users", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" },
  ],
  constraints: [{ name: "orders_status_check", kind: "check_constraint", definition: "CHECK (status <> '')" }],
  triggers: [{ name: "orders_touch", timing: "BEFORE", event: "UPDATE", definition: "EXECUTE FUNCTION touch()" }],
};

const STATEMENTS = ['ALTER TABLE "public"."orders" DROP COLUMN "note"', 'CREATE INDEX "orders_status_idx" ON "public"."orders" ("status")'];

let previews: { schema: string; table: string; ops: AlterOp[] }[] = [];
let ddl: { statements: string[]; typedConfirmation: string | null }[] = [];
let previewError: unknown = null;
let applyError: (typed: string | null) => unknown = () => null;

beforeEach(() => {
  previews = [];
  ddl = [];
  previewError = null;
  applyError = () => null;
  useUi.setState({ toasts: [], confirmRequest: null });
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    switch (cmd) {
      case "preview_alter_table":
        if (previewError) throw previewError;
        previews.push({ schema: a.schema as string, table: a.table as string, ops: a.ops as AlterOp[] });
        return STATEMENTS;
      case "apply_ddl": {
        const typed = a.typedConfirmation as string | null;
        ddl.push({ statements: a.statements as string[], typedConfirmation: typed });
        const err = applyError(typed);
        if (err) throw err;
        return null;
      }
      default:
        return null;
    }
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

function renderView(opts: { structure?: TableStructure; session?: SessionInfo; onChanged?: () => Promise<void> } = {}) {
  const onChanged = opts.onChanged ?? vi.fn(async () => undefined);
  render(
    <>
      <StructureView session={opts.session ?? session} structure={opts.structure ?? orders} onChanged={onChanged} />
      <Overlays />
    </>,
  );
  return { onChanged };
}

const section = (heading: RegExp) => screen.getByRole("heading", { name: heading }).closest("section")!;
/** A row of the Columns table. */
const row = (name: string) => within(section(/^Columns/)).getByRole("cell", { name }).closest("tr")!;

async function reviewSql() {
  fireEvent.click(screen.getByRole("button", { name: "Review SQL" }));
  return screen.findByRole("dialog", { name: "Review structure change" });
}

describe("StructureView", () => {
  it("lists columns, indexes, foreign keys, constraints and triggers with their counts", () => {
    renderView();
    expect(screen.getByRole("heading", { name: "Columns 4" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Indexes 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Foreign keys 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Constraints 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Triggers 1" })).toBeInTheDocument();

    const id = within(row("id"));
    expect(id.getByRole("img", { name: "Primary key position 1" })).toBeInTheDocument();
    expect(id.getByText("auto")).toBeInTheDocument();
    expect(id.getByText("required")).toBeInTheDocument();
    expect(within(row("user_id")).getByRole("img", { name: "Foreign key" })).toBeInTheDocument();
    expect(within(row("status")).getByText("'draft'::text")).toBeInTheDocument();
    expect(within(row("status")).getByText("Order state")).toBeInTheDocument();
    expect(within(row("note")).getByText("nullable")).toBeInTheDocument();

    const indexes = within(section(/^Indexes/));
    expect(indexes.getByText("(primary)")).toBeInTheDocument();
    expect(indexes.getByText("user_id, status")).toBeInTheDocument();
    expect(indexes.getByText("btree (user_id, status)")).toBeInTheDocument();

    const fks = within(section(/^Foreign keys/));
    expect(fks.getByText("public.users (id)")).toBeInTheDocument();
    expect(fks.getByText("CASCADE")).toBeInTheDocument();

    expect(within(section(/^Constraints/)).getByText("check constraint")).toBeInTheDocument();
    expect(within(section(/^Triggers/)).getByText("EXECUTE FUNCTION touch()")).toBeInTheDocument();
  });

  it("says when there are no indexes or foreign keys and hides empty constraint and trigger sections", () => {
    renderView({ structure: usersStructure });
    expect(screen.getByText("No indexes.")).toBeInTheDocument();
    expect(screen.getByText("No foreign keys.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Constraints/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Triggers/ })).not.toBeInTheDocument();
  });

  it.each([
    ["a read-only session", { session: { ...session, readOnly: true } }],
    ["a view", { structure: { ...orders, kind: "view" as const } }],
  ])("offers no structure changes on %s", (_, opts) => {
    renderView(opts);
    expect(screen.getByRole("cell", { name: "note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add column/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add index/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drop note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drop index orders_user_id_idx" })).not.toBeInTheDocument();
  });

  it("stages a dropped column, can undo it, and discards all pending changes", () => {
    renderView();
    expect(screen.queryByRole("button", { name: "Review SQL" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    expect(row("note")).toHaveClass("removed");
    expect(screen.getByText("1 pending structure change")).toBeInTheDocument();

    // Clicking again undoes the drop.
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    expect(row("note")).not.toHaveClass("removed");
    expect(screen.queryByRole("button", { name: "Review SQL" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    fireEvent.click(screen.getByRole("button", { name: "Drop status" }));
    expect(screen.getByText("2 pending structure changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    expect(row("note")).not.toHaveClass("removed");
    expect(row("status")).not.toHaveClass("removed");
    expect(screen.queryByText(/pending structure change/)).not.toBeInTheDocument();
  });

  it("stages a new column from the add dialog and sends it for review", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    const dialog = within(screen.getByRole("dialog", { name: "Add column" }));
    const stage = dialog.getByRole("button", { name: "Stage column" });
    expect(stage).toBeDisabled();

    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "total" } });
    expect(stage).toBeEnabled();
    fireEvent.change(dialog.getByLabelText("Data type"), { target: { value: "  " } });
    expect(stage).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Data type"), { target: { value: "numeric(12,2)" } });
    fireEvent.change(dialog.getByLabelText("Default expression"), { target: { value: "0" } });
    fireEvent.click(dialog.getByLabelText("Allow NULL"));
    fireEvent.click(stage);

    expect(screen.queryByRole("dialog", { name: "Add column" })).not.toBeInTheDocument();
    const added = row("total");
    expect(added).toHaveClass("pending");
    expect(within(added).getByText("numeric(12,2)")).toBeInTheDocument();
    expect(within(added).getByText("required")).toBeInTheDocument();

    await reviewSql();
    expect(previews).toEqual([
      {
        schema: "public",
        table: "orders",
        ops: [{ type: "addColumn", column: { name: "total", dataType: "numeric(12,2)", nullable: false, default: "0", primaryKey: false } }],
      },
    ]);
  });

  it("removes a staged new column without touching other changes", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "total" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage column" }));
    expect(screen.getByText("2 pending structure changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove new column" }));
    expect(screen.queryByRole("cell", { name: "total" })).not.toBeInTheDocument();
    expect(screen.getByText("1 pending structure change")).toBeInTheDocument();
    expect(row("note")).toHaveClass("removed");
  });

  it("cancels the column dialog without staging anything", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Add column/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "total" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/pending structure change/)).not.toBeInTheDocument();
  });

  it("stages only what changed when editing a column, renaming last", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit status" }));
    const dialog = within(screen.getByRole("dialog", { name: "Edit column status" }));
    expect(dialog.getByLabelText("Name")).toHaveValue("status");
    expect(dialog.getByLabelText("Data type")).toHaveValue("text");
    expect(dialog.getByLabelText("Default expression")).toHaveValue("'draft'::text");
    expect(dialog.getByLabelText("Allow NULL")).not.toBeChecked();

    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "state" } });
    fireEvent.change(dialog.getByLabelText("Data type"), { target: { value: "varchar(20)" } });
    fireEvent.change(dialog.getByLabelText("Default expression"), { target: { value: "" } });
    fireEvent.click(dialog.getByLabelText("Allow NULL"));
    fireEvent.click(dialog.getByRole("button", { name: "Stage changes" }));

    expect(row("status")).toHaveClass("pending");
    expect(screen.getByText("4 pending structure changes")).toBeInTheDocument();
    await reviewSql();
    expect(previews[0]!.ops).toEqual([
      { type: "setType", name: "status", dataType: "varchar(20)" },
      { type: "setNullable", name: "status", nullable: true },
      { type: "setDefault", name: "status", default: null },
      { type: "renameColumn", from: "status", to: "state" },
    ]);
  });

  it("stages nothing when a column is saved unchanged", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage changes" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/pending structure change/)).not.toBeInTheDocument();
    expect(row("note")).not.toHaveClass("pending");
  });

  it("stages a new index with columns in the order picked and a generated name", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Add index/ }));
    const dialog = within(screen.getByRole("dialog", { name: "Add index" }));
    const stage = dialog.getByRole("button", { name: "Stage index" });
    expect(stage).toBeDisabled();

    fireEvent.click(dialog.getByRole("checkbox", { name: "status" }));
    fireEvent.click(dialog.getByRole("checkbox", { name: "user_id" }));
    expect(dialog.getByRole("checkbox", { name: "status #1" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "user_id #2" })).toBeChecked();
    fireEvent.click(dialog.getByLabelText("Unique"));
    expect(dialog.getByLabelText("Index name")).toHaveAttribute("placeholder", "orders_status_user_id_key");

    // Unpicking renumbers the rest.
    fireEvent.click(dialog.getByRole("checkbox", { name: "status #1" }));
    expect(dialog.getByRole("checkbox", { name: "user_id #1" })).toBeChecked();
    fireEvent.click(dialog.getByRole("checkbox", { name: "status" }));
    fireEvent.click(stage);

    expect(screen.queryByRole("dialog", { name: "Add index" })).not.toBeInTheDocument();
    await reviewSql();
    expect(previews[0]!.ops).toEqual([{ type: "createIndex", name: "orders_user_id_status_key", columns: ["user_id", "status"], unique: true }]);
  });

  it("uses a typed index name instead of the generated one", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Add index/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "note" }));
    fireEvent.change(screen.getByLabelText("Index name"), { target: { value: "  notes_lookup  " } });
    fireEvent.click(screen.getByRole("button", { name: "Stage index" }));
    await reviewSql();
    expect(previews[0]!.ops).toEqual([{ type: "createIndex", name: "notes_lookup", columns: ["note"], unique: false }]);
  });

  it("closes the index dialog on Cancel", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Add index/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stages dropping an index, can undo it, and never offers to drop the primary key index", async () => {
    renderView();
    expect(screen.queryByRole("button", { name: "Drop index orders_pkey" })).not.toBeInTheDocument();
    const drop = screen.getByRole("button", { name: "Drop index orders_user_id_idx" });
    fireEvent.click(drop);
    expect(screen.getByText("orders_user_id_idx").closest("tr")).toHaveClass("removed");
    fireEvent.click(drop);
    expect(screen.getByText("orders_user_id_idx").closest("tr")).not.toHaveClass("removed");
    expect(screen.queryByRole("button", { name: "Review SQL" })).not.toBeInTheDocument();

    fireEvent.click(drop);
    await reviewSql();
    expect(previews[0]!.ops).toEqual([{ type: "dropIndex", name: "orders_user_id_idx" }]);
  });

  it("shows the generated SQL for review and applies it, then reloads the structure", async () => {
    const { onChanged } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    const review = await reviewSql();
    expect(review).toHaveTextContent('ALTER TABLE "public"."orders" DROP COLUMN "note";');
    expect(review).toHaveTextContent("2 statements on public.orders");
    expect(review).toHaveTextContent("one transaction");
    expect(ddl).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(ddl).toEqual([{ statements: STATEMENTS, typedConfirmation: null }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Structure updated");
    expect(screen.queryByText(/pending structure change/)).not.toBeInTheDocument();
    expect(row("note")).not.toHaveClass("removed");
  });

  it("asks for the connection name before a destructive change on production and retries with it", async () => {
    applyError = (typed) =>
      typed === "Local PG" ? null : { kind: "confirmation_required", message: "Confirm execution on Local PG", code: "confirm_typed", detail: "DROP COLUMN removes data: note" };
    const { onChanged } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    const review = await reviewSql();
    fireEvent.click(within(review).getByRole("button", { name: "Apply changes" }));

    const confirm = await screen.findByRole("dialog", { name: "Confirm execution" });
    expect(confirm).toHaveTextContent("DROP COLUMN removes data: note");
    const run = within(confirm).getByRole("button", { name: "Run anyway" });
    expect(run).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText("Type Local PG to confirm"), { target: { value: "Local PG" } });
    fireEvent.click(run);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ddl.map((d) => d.typedConfirmation)).toEqual([null, "Local PG"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the review and the staged changes when the name confirmation is cancelled", async () => {
    applyError = () => ({ kind: "confirmation_required", message: "Confirm execution on Local PG", code: "confirm_typed", detail: "DROP COLUMN" });
    const { onChanged } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    const review = await reviewSql();
    fireEvent.click(within(review).getByRole("button", { name: "Apply changes" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm execution" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm execution" })).not.toBeInTheDocument());
    await waitFor(() => expect(within(review).getByRole("button", { name: "Apply changes" })).toBeEnabled());
    expect(ddl).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Review structure change" })).toBeInTheDocument();
    expect(screen.getByText("1 pending structure change")).toBeInTheDocument();
  });

  it("shows a failed apply in the review and keeps the staged changes", async () => {
    applyError = () => ({ kind: "database", message: "column \"note\" is referenced by a view", detail: "view order_notes depends on it" });
    const { onChanged } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    const review = await reviewSql();
    fireEvent.click(within(review).getByRole("button", { name: "Apply changes" }));

    const alert = await within(review).findByRole("alert");
    expect(alert).toHaveTextContent('column "note" is referenced by a view');
    expect(alert).toHaveTextContent("view order_notes depends on it");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText("1 pending structure change")).toBeInTheDocument();
  });

  it("reports a change the backend cannot express and opens no review", async () => {
    previewError = { kind: "unsupported", message: "SQLite cannot change a column type" };
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Data type"), { target: { value: "integer" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Review SQL" }));

    expect(await screen.findByText("Change cannot be applied: SQLite cannot change a column type")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the review on Cancel and keeps the staged changes", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Drop note" }));
    const review = await reviewSql();
    fireEvent.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(ddl).toEqual([]);
    expect(screen.getByText("1 pending structure change")).toBeInTheDocument();
  });
});
