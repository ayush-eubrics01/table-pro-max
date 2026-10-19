import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { ImportDialog } from "./ImportDialog";
import { session, usersStructure } from "../../test/fixtures";
import { useUi } from "../../stores/ui";
import type { DbObject, ImportOptions, ImportPreview, SessionInfo } from "../../types/backend";

const csvPreview: ImportPreview = {
  columns: [
    { name: "ID", kind: "integer", nullable: false },
    { name: "Email", kind: "text", nullable: false },
    { name: "joined", kind: "timestamp", nullable: true },
  ],
  rows: [
    ["1", "ada@example.com", null],
    ["2", "bob@example.com", "2026-01-02 10:00:00"],
  ],
  fileBytes: 2048,
};

const tables: DbObject[] = [
  { schema: "public", name: "users", kind: "table" },
  { schema: "public", name: "orders", kind: "table" },
  { schema: "public", name: "active_users", kind: "view" },
];

type Call = [string, Record<string, unknown>];
let calls: Call[] = [];
let pickedPath: string | null = "/data/people.csv";
let handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

const callsOf = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

function setup(extra: Record<string, (args: Record<string, unknown>) => unknown> = {}, events = false) {
  handlers = {
    "plugin:dialog|open": () => pickedPath,
    preview_import: () => csvPreview,
    table_structure: () => usersStructure,
    preview_create_table: () => ['CREATE TABLE "public"."people" ("ID" bigint, "Email" text, "joined" timestamp)'],
    import_file: () => 2,
    cancel_job: () => true,
    ...extra,
  };
  mockIPC(
    (cmd, args) => {
      calls.push([cmd, args as Record<string, unknown>]);
      const h = handlers[cmd];
      return h ? h(args as Record<string, unknown>) : null;
    },
    events ? { shouldMockEvents: true } : undefined,
  );
}

function renderDialog(props: Partial<Parameters<typeof ImportDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<ImportDialog session={session} schema="public" tables={tables} onClose={onClose} onDone={onDone} {...props} />);
  return { onClose, onDone };
}

const chooseFile = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
  await screen.findByRole("combobox", { name: "Import into" });
};

const combo = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
const lastPreviewOptions = () => callsOf("preview_import").at(-1)!.options as ImportOptions;
const reviewButton = () => screen.getByRole("button", { name: "Review import" });

beforeEach(() => {
  calls = [];
  pickedPath = "/data/people.csv";
  useUi.setState({ toasts: [] });
  setup();
});
afterEach(() => {
  cleanup();
  clearMocks();
});


/** Waits for the table's columns and the mapping by name, which follows them in a later render. */
const mapped = () => waitFor(() => expect((screen.getByRole("combobox", { name: "Source for id" }) as HTMLSelectElement).value).toBe("0"));

describe("ImportDialog: choosing a file", () => {
  it("shows a hint and no options until a file is chosen", () => {
    renderDialog();
    expect(screen.getByText("CSV, TSV, JSON array or JSON Lines")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Format" })).not.toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });

  it("asks for a data file and previews it as comma-separated text with the default options", async () => {
    renderDialog();
    await chooseFile();
    const open = callsOf("plugin:dialog|open")[0]!.options as { multiple: boolean; filters: { extensions: string[] }[] };
    expect(open.multiple).toBe(false);
    expect(open.filters[0]!.extensions).toEqual(["csv", "tsv", "txt", "json", "jsonl", "ndjson"]);
    expect(screen.getByText("/data/people.csv")).toBeInTheDocument();
    expect(callsOf("preview_import")).toEqual([
      {
        path: "/data/people.csv",
        options: { format: "csv", delimiter: ",", quote: '"', header: true, encoding: "utf8", nullValues: ["", "NULL"], trim: false },
      },
    ]);
    expect(combo("Format").value).toBe("csv");
    expect(combo("Delimiter").value).toBe(",");
    expect(combo("Encoding").value).toBe("utf8");
    expect(screen.getByRole("textbox", { name: "Treat as NULL" })).toHaveValue("(empty), NULL");
    expect(screen.getByRole("checkbox", { name: /First row has column names/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Trim spaces/ })).not.toBeChecked();
  });

  it("does nothing when the file picker is dismissed", async () => {
    pickedPath = null;
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await waitFor(() => expect(callsOf("plugin:dialog|open")).toHaveLength(1));
    expect(callsOf("preview_import")).toHaveLength(0);
    expect(screen.getByText("CSV, TSV, JSON array or JSON Lines")).toBeInTheDocument();
  });

  it("reads a .tsv file with a tab delimiter", async () => {
    pickedPath = "/data/people.TSV";
    renderDialog();
    await chooseFile();
    expect(lastPreviewOptions()).toMatchObject({ format: "csv", delimiter: "\t" });
    expect(combo("Delimiter").value).toBe("\t");
  });

  it.each(["/data/people.json", "/data/people.jsonl", "/data/people.NDJSON"])("reads %s as JSON and hides the delimited-text options", async (p) => {
    pickedPath = p;
    renderDialog();
    await chooseFile();
    expect(lastPreviewOptions().format).toBe("json");
    expect(combo("Format").value).toBe("json");
    expect(screen.queryByRole("combobox", { name: "Delimiter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Encoding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /First row has column names/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Treat as NULL" })).toBeInTheDocument();
  });

  it("shows why a file can't be previewed", async () => {
    setup({
      preview_import: () => {
        throw { kind: "invalid_input", message: "Line 3 has 4 fields, expected 3" };
      },
    });
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("Line 3 has 4 fields, expected 3")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Import into" })).not.toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });
});

describe("ImportDialog: parsing options", () => {
  it("re-reads the preview with each changed parsing option", async () => {
    renderDialog();
    await chooseFile();
    fireEvent.change(combo("Delimiter"), { target: { value: ";" } });
    await waitFor(() => expect(lastPreviewOptions().delimiter).toBe(";"));
    fireEvent.change(combo("Encoding"), { target: { value: "latin1" } });
    await waitFor(() => expect(lastPreviewOptions().encoding).toBe("latin1"));
    fireEvent.click(screen.getByRole("checkbox", { name: /First row has column names/ }));
    await waitFor(() => expect(lastPreviewOptions().header).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: /Trim spaces/ }));
    await waitFor(() => expect(lastPreviewOptions().trim).toBe(true));
    fireEvent.change(combo("Format"), { target: { value: "json" } });
    await waitFor(() => expect(lastPreviewOptions().format).toBe("json"));
    expect(lastPreviewOptions()).toMatchObject({ delimiter: ";", encoding: "latin1", header: false, trim: true });
  });

  it("turns the NULL list into values, with (empty) standing for an empty field", async () => {
    renderDialog();
    await chooseFile();
    const box = screen.getByRole("textbox", { name: "Treat as NULL" });
    fireEvent.change(box, { target: { value: "(empty), NA ,null" } });
    fireEvent.blur(box);
    await waitFor(() => expect(lastPreviewOptions().nullValues).toEqual(["", "NA", "null"]));
  });

  it("lets the NULL list be typed as written, and applies it when the field is left", async () => {
    renderDialog();
    await chooseFile();
    const reads = callsOf("preview_import").length;
    const box = screen.getByRole("textbox", { name: "Treat as NULL" });
    fireEvent.change(box, { target: { value: "(empty), NULL," } });
    expect(box).toHaveValue("(empty), NULL,");
    fireEvent.change(box, { target: { value: "(empty), NULL, N" } });
    expect(box).toHaveValue("(empty), NULL, N");
    expect(callsOf("preview_import")).toHaveLength(reads);
    fireEvent.blur(box);
    await waitFor(() => expect(lastPreviewOptions().nullValues).toEqual(["", "NULL", "N"]));
  });

  it("goes back to commas when a .csv follows a .tsv", async () => {
    pickedPath = "/data/a.tsv";
    renderDialog();
    await chooseFile();
    await waitFor(() => expect(lastPreviewOptions().delimiter).toBe("\t"));
    pickedPath = "/data/b.csv";
    fireEvent.click(screen.getByRole("button", { name: /Choose|Change/ }));
    await waitFor(() => expect(callsOf("preview_import").at(-1)!.path).toBe("/data/b.csv"));
    expect(lastPreviewOptions().delimiter).toBe(",");
  });

  it("clears an earlier preview error once the file reads cleanly with new options", async () => {
    let fail = true;
    setup({
      preview_import: () => {
        if (fail) throw { kind: "invalid_input", message: "Not valid UTF-8" };
        return csvPreview;
      },
    });
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("Not valid UTF-8")).toBeInTheDocument();
    fail = false;
    fireEvent.change(combo("Encoding"), { target: { value: "latin1" } });
    await screen.findByRole("combobox", { name: "Import into" });
    expect(screen.queryByText("Not valid UTF-8")).not.toBeInTheDocument();
  });
});

describe("ImportDialog: into a new table", () => {
  it("starts with a new table and suggests column types from the inferred kinds for the dialect", async () => {
    renderDialog();
    await chooseFile();
    expect(combo("Import into").value).toBe("new");
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Type for ID" })).toHaveValue("bigint");
    expect(screen.getByRole("textbox", { name: "Type for Email" })).toHaveValue("text");
    expect(screen.getByRole("textbox", { name: "Type for joined" })).toHaveValue("timestamp");
    // Samples come from the first row; a missing value reads NULL.
    expect(screen.getByRole("cell", { name: "ada@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "NULL" })).toBeInTheDocument();
    expect(screen.getByText(/Previewing the first 2 rows/)).toBeInTheDocument();
  });

  it.each([
    ["mysql", "datetime(6)"],
    ["sqlite", "TEXT"],
  ] as const)("suggests %s types", async (dialect, timestampType) => {
    renderDialog({ session: { ...session, dialect } });
    await chooseFile();
    expect(screen.getByRole("textbox", { name: "Type for joined" })).toHaveValue(timestampType);
  });

  it("needs a table name before the import can be reviewed", async () => {
    renderDialog();
    await chooseFile();
    expect(reviewButton()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "New table name" }), { target: { value: "   " } });
    expect(reviewButton()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "New table name" }), { target: { value: "people" } });
    expect(reviewButton()).toBeEnabled();
  });

  it("previews CREATE TABLE with the edited types, then imports every file column into it", async () => {
    const { onDone } = renderDialog();
    await chooseFile();
    fireEvent.change(screen.getByRole("textbox", { name: "New table name" }), { target: { value: " people " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Type for joined" }), { target: { value: "timestamptz" } });
    fireEvent.click(reviewButton());

    const dialog = await screen.findByRole("dialog", { name: "Review import" });
    expect(callsOf("preview_create_table")).toEqual([
      {
        sessionId: "sess-1",
        request: {
          schema: "public",
          name: "people",
          columns: [
            { name: "ID", dataType: "bigint", nullable: true, default: null, primaryKey: false },
            { name: "Email", dataType: "text", nullable: true, default: null, primaryKey: false },
            { name: "joined", dataType: "timestamptz", nullable: true, default: null, primaryKey: false },
          ],
        },
      },
    ]);
    expect(within(dialog).getByText("The table is created first:")).toBeInTheDocument();
    expect(within(dialog).getByText(/CREATE TABLE "public"."people"/)).toHaveTextContent(/\);$/);
    expect(within(dialog).getByText("Columns: ID, Email, joined")).toBeInTheDocument();
    expect(within(dialog).getByText("/data/people.csv")).toBeInTheDocument();
    expect(within(dialog).getByText(/\(2\.0 KB\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/in one transaction\. If any row fails, nothing is imported\./)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("people"));
    const req = callsOf("import_file")[0]!.request as Record<string, unknown>;
    expect(req).toMatchObject({
      sessionId: "sess-1",
      createStatements: ['CREATE TABLE "public"."people" ("ID" bigint, "Email" text, "joined" timestamp)'],
      confirmed: true,
      import: {
        path: "/data/people.csv",
        options: { format: "csv", delimiter: "," },
        schema: "public",
        table: "people",
        mapping: [
          { target: "ID", source: 0 },
          { target: "Email", source: 1 },
          { target: "joined", source: 2 },
        ],
        skip: 0,
      },
    });
    expect(typeof req.jobId).toBe("string");
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ kind: "success", message: expect.stringMatching(/^Imported 2 rows into/) });
  });

  it("stays on the options when the CREATE TABLE preview is refused", async () => {
    setup({
      preview_create_table: () => {
        throw { kind: "invalid_input", message: 'Unknown type "strng"' };
      },
    });
    renderDialog();
    await chooseFile();
    fireEvent.change(screen.getByRole("textbox", { name: "New table name" }), { target: { value: "people" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Type for Email" }), { target: { value: "strng" } });
    fireEvent.click(reviewButton());
    expect(await screen.findByText('Unknown type "strng"')).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Import data" })).toBeInTheDocument();
    expect(callsOf("import_file")).toHaveLength(0);
  });

  it("opens on an existing table on a read-only session", async () => {
    renderDialog({ session: { ...session, readOnly: true } });
    await chooseFile();
    expect(combo("Import into").value).toBe("existing");
  });

  it("does not offer a new table on a read-only session", async () => {
    renderDialog({ session: { ...session, readOnly: true }, initialTable: "users" });
    await chooseFile();
    expect(within(combo("Import into")).getByRole("option", { name: "A new table" })).toBeDisabled();
  });
});

describe("ImportDialog: into an existing table", () => {
  it("lists only tables, loads the chosen table's columns and maps file columns by name ignoring case", async () => {
    renderDialog();
    await chooseFile();
    fireEvent.change(combo("Import into"), { target: { value: "existing" } });
    const tableSelect = combo("Table");
    expect(within(tableSelect).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "users", "orders"]);
    expect(reviewButton()).toBeDisabled();

    fireEvent.change(tableSelect, { target: { value: "users" } });
    await mapped();
    expect(callsOf("table_structure")).toContainEqual({ sessionId: "sess-1", schema: "public", table: "users", refresh: true });
    expect(screen.getByRole("columnheader", { name: "Table column" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "From file column" })).toBeInTheDocument();
    expect(combo("Source for email").value).toBe("1");
    expect(combo("Source for age").value).toBe("");
    // The sample shows the mapped value from the first row.
    expect(screen.getByRole("cell", { name: "ada@example.com" })).toBeInTheDocument();
    expect(reviewButton()).toBeEnabled();
  });

  it("imports with the mapping the user chose, skipping unmapped columns, and creates nothing", async () => {
    const { onDone } = renderDialog({ initialTable: "users" });
    await chooseFile();
    expect(combo("Import into").value).toBe("existing");
    await mapped();
    fireEvent.change(combo("Source for email"), { target: { value: "" } });
    fireEvent.change(combo("Source for age"), { target: { value: "1" } });
    fireEvent.click(reviewButton());

    const dialog = await screen.findByRole("dialog", { name: "Review import" });
    expect(callsOf("preview_create_table")).toHaveLength(0);
    expect(within(dialog).queryByText("The table is created first:")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Columns: ID → id, Email → age")).toBeInTheDocument();
    expect(within(dialog).getByText("public.users")).toBeInTheDocument();
    expect(within(dialog).getByText("Local PG")).toBeInTheDocument();
    expect(within(dialog).getByText("app@localhost:5432/app")).toBeInTheDocument();
    // Production imports use the danger style.
    expect(within(dialog).getByRole("button", { name: "Import rows" })).toHaveClass("btn-danger");

    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("users"));
    const req = callsOf("import_file")[0]!.request as { import: Record<string, unknown>; createStatements: string[] };
    expect(req.createStatements).toEqual([]);
    expect(req.import).toMatchObject({
      table: "users",
      mapping: [
        { target: "id", source: 0 },
        { target: "age", source: 1 },
      ],
    });
  });

  it("can't be reviewed when no file column is mapped", async () => {
    renderDialog({ initialTable: "users" });
    await chooseFile();
    await mapped();
    fireEvent.change(combo("Source for id"), { target: { value: "" } });
    fireEvent.change(combo("Source for email"), { target: { value: "" } });
    expect(reviewButton()).toBeDisabled();
  });

  it("shows why the table's columns couldn't be loaded", async () => {
    setup({
      table_structure: () => {
        throw { kind: "not_found", message: 'relation "users" does not exist' };
      },
    });
    renderDialog();
    await chooseFile();
    fireEvent.change(combo("Import into"), { target: { value: "existing" } });
    fireEvent.change(combo("Table"), { target: { value: "users" } });
    expect(await screen.findByText('relation "users" does not exist')).toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });

  it("keeps the table's column error when a file is chosen afterwards", async () => {
    setup({
      table_structure: () => {
        throw { kind: "not_found", message: 'relation "users" does not exist' };
      },
    });
    renderDialog({ initialTable: "users" });
    await chooseFile();
    expect(await screen.findByText('relation "users" does not exist')).toBeInTheDocument();
  });

  it("maps the table chosen last, even when an earlier table's columns arrive later", async () => {
    const orders = { ...usersStructure, name: "orders", columns: [{ ...usersStructure.columns[0]!, name: "total" }] };
    setup({
      table_structure: (args) =>
        args.table === "users" ? new Promise((r) => setTimeout(() => r(usersStructure), 80)) : orders,
    });
    renderDialog();
    await chooseFile();
    fireEvent.change(combo("Import into"), { target: { value: "existing" } });
    fireEvent.change(combo("Table"), { target: { value: "users" } });
    fireEvent.change(combo("Table"), { target: { value: "orders" } });
    await screen.findByRole("combobox", { name: "Source for total" });
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole("combobox", { name: "Source for id" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Source for total" })).toBeInTheDocument();
  });

  it("switching to a new table maps every file column and clears the table name", async () => {
    renderDialog({ initialTable: "users" });
    await chooseFile();
    await mapped();
    fireEvent.change(combo("Import into"), { target: { value: "new" } });
    expect(screen.getByRole("textbox", { name: "New table name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Type for ID" })).toBeInTheDocument();
    fireEvent.change(combo("Import into"), { target: { value: "existing" } });
    expect(combo("Table").value).toBe("users");
    await mapped();
  });

  it("says nothing about a transaction where the database has none", async () => {
    renderDialog({
      initialTable: "users",
      session: { ...session, environment: "development", capabilities: { ...session.capabilities, transactions: false } } as SessionInfo,
    });
    await chooseFile();
    await mapped();
    fireEvent.click(reviewButton());
    const dialog = await screen.findByRole("dialog", { name: "Review import" });
    expect(within(dialog).queryByText(/transaction/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import rows" })).toHaveClass("btn-primary");
  });
});

describe("ImportDialog: review and running", () => {
  const toReview = async () => {
    await chooseFile();
    await mapped();
    fireEvent.click(reviewButton());
    return screen.findByRole("dialog", { name: "Review import" });
  };

  it("goes back from the review to the options with the choices kept", async () => {
    renderDialog({ initialTable: "users" });
    const dialog = await toReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "Import data" })).toBeInTheDocument();
    expect(combo("Table").value).toBe("users");
    expect(combo("Source for id").value).toBe("0");
  });

  it("Cancel and Escape close the dialog before the review", async () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Escape on the review goes back to the options", async () => {
    const { onClose } = renderDialog({ initialTable: "users" });
    await toReview();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("dialog", { name: "Import data" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the failure with its detail and lets the user retry", async () => {
    let attempt = 0;
    setup({
      import_file: () => {
        attempt += 1;
        if (attempt === 1) throw { kind: "query", message: "Row 7 failed", detail: 'null value in column "email" violates not-null constraint' };
        return 5;
      },
    });
    const { onDone } = renderDialog({ initialTable: "users" });
    const dialog = await toReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    const err = await within(dialog).findByText(/Row 7 failed/);
    expect(err).toHaveTextContent('Row 7 failed null value in column "email" violates not-null constraint');
    expect(onDone).not.toHaveBeenCalled();
    // The job is over: Back returns, and Import rows works again.
    expect(within(dialog).getByRole("button", { name: "Back" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("users"));
    expect(useUi.getState().toasts.at(-1)?.message).toBe("Imported 5 rows into users");
    const [first, second] = callsOf("import_file").map((a) => (a.request as { jobId: string }).jobId);
    expect(first).not.toBe(second);
  });

  it("says so when a cancel can't be sent, instead of failing silently", async () => {
    setup({
      import_file: () => new Promise(() => undefined),
      cancel_job: () => {
        throw { kind: "internal", message: "the job is gone" };
      },
    });
    renderDialog({ initialTable: "users" });
    const dialog = await toReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel import" }));
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message).join()).toMatch(/Could not cancel the import/));
  });

  it("shows progress for its own job and cancels it on request", async () => {
    let jobId = "";
    let finish: (e: unknown) => void = () => {};
    const cancelled: string[] = [];
    setup(
      {
        import_file: (args) => {
          jobId = (args.request as { jobId: string }).jobId;
          return new Promise((_, reject) => (finish = reject));
        },
        cancel_job: (args) => {
          cancelled.push(args.jobId as string);
          finish({ kind: "cancelled", message: "Import cancelled; nothing was imported." });
          return true;
        },
      },
      true,
    );
    const { onDone } = renderDialog({ initialTable: "users" });
    const dialog = await toReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(jobId).not.toBe(""));
    expect(within(dialog).getByRole("button", { name: "Import rows" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(await within(dialog).findByText("0 rows imported…")).toBeInTheDocument();

    await emit("job-progress", { jobId: "another-job", done: 99 });
    await emit("job-progress", { jobId, done: 12500 });
    expect(await within(dialog).findByText("12,500 rows imported…")).toBeInTheDocument();

    // Escape does not leave the review while the import runs.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Review import" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel import" }));
    await waitFor(() => expect(cancelled).toEqual([jobId]));
    expect(await within(dialog).findByText("Import cancelled; nothing was imported.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/rows imported…/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import rows" })).toBeEnabled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
