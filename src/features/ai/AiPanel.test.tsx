import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { AiPanel } from "./AiPanel";
import { Overlays } from "../../components/Overlays";
import { useUi } from "../../stores/ui";
import type { AiAnswer, AiPrompt, AiRequest, AiTask } from "../../types/backend";

type Call = { cmd: string; args: Record<string, unknown> };

const PROMPT: AiPrompt = {
  endpoint: "https://api.anthropic.com/v1/messages",
  model: "claude-opus-5-5",
  system: "You help with PostgreSQL SQL. Answer briefly.",
  user: "Explain this SQL:\nSELECT * FROM users",
};

const ANSWER: AiAnswer = {
  text: "It reads every row of `users`.\n```sql\nSELECT id FROM users\n```\nThat is cheaper.",
  sql: "SELECT id FROM users",
  model: "claude-opus-5-5",
  truncated: false,
  inputTokens: 120,
  outputTokens: 40,
};

let calls: Call[] = [];
let sendResult: () => Promise<unknown>;
let previewResult: () => Promise<unknown>;

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  calls = [];
  previewResult = async () => PROMPT;
  sendResult = async () => ANSWER;
  useUi.setState({ toasts: [] });
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "ai_preview") return previewResult();
    if (cmd === "ai_send") return sendResult();
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
});

function setup(
  overrides: Partial<{
    getSql: () => string;
    lastError: { sql: string; message: string } | null;
    initialTask: AiTask;
  }> = {},
) {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  const referencedTables = vi.fn(() => [{ schema: "public", table: "users" }]);
  const props = {
    dialect: "postgres",
    getSql: overrides.getSql ?? (() => "SELECT * FROM users"),
    lastError: overrides.lastError ?? null,
    referencedTables,
    allTables: [
      { schema: "public", table: "users" },
      { schema: "public", table: "orders" },
    ],
    columns: { "public.users": ["id", "email"], "public.orders": ["id", "user_id"] },
    initialTask: overrides.initialTask,
    onInsert,
    onClose,
  };
  const utils = render(
    <>
      <AiPanel {...props} />
      <Overlays />
    </>,
  );
  return { ...utils, props, onInsert, onClose, referencedTables };
}

const previewRequest = () => sent("ai_preview").at(-1)!.args.request as AiRequest;

async function reviewAndSend() {
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send" }));
}

describe("AiPanel", () => {
  it("offers the four tasks with Explain selected by default", () => {
    setup();
    const group = screen.getByRole("group", { name: "What do you need?" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Explain", "Fix error", "Improve", "Write SQL"]);
    expect(within(group).getByRole("button", { name: "Explain" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Uses the selected text, or the whole editor when nothing is selected.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include table and column names" })).not.toBeChecked();
  });

  it("sends nothing until the request is reviewed and Send is clicked", async () => {
    setup();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(sent("ai_preview")).toHaveLength(1);
    expect(sent("ai_send")).toHaveLength(0);
  });

  it("previews exactly the text, instructions, endpoint and model that will be sent", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    const text = await screen.findByLabelText("Text that will be sent");
    expect(text.textContent).toBe(PROMPT.user);
    expect(screen.getByText(PROMPT.endpoint)).toBeInTheDocument();
    expect(screen.getByText(/\(claude-opus-5-5\)/)).toBeInTheDocument();
    expect(screen.getByText("Instructions sent with it")).toBeInTheDocument();
    expect(screen.getByText(PROMPT.system)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
  });

  it("asks the backend to explain the editor SQL without the schema by default", async () => {
    const { referencedTables } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest()).toEqual({ task: "explain", dialect: "postgres", sql: "SELECT * FROM users", error: null, description: null, schema: null });
    expect(referencedTables).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("includes only the referenced tables' names and columns when the box is ticked", async () => {
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include table and column names" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest().schema).toBe("public.users(id, email)");
  });

  it("sends exactly the previewed prompt with a job id after Send", async () => {
    setup();
    await reviewAndSend();
    await screen.findByText("SELECT id FROM users");
    const [send] = sent("ai_send");
    expect(send!.args.prompt).toEqual(PROMPT);
    expect(typeof send!.args.jobId).toBe("string");
    expect((send!.args.jobId as string).length).toBeGreaterThan(0);
  });

  it("shows the answer with prose, inline code, the SQL block and token counts", async () => {
    setup();
    await reviewAndSend();
    const sql = await screen.findByText("SELECT id FROM users");
    expect(sql.tagName).toBe("PRE");
    expect(screen.getByText("users", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("That is cheaper.")).toBeInTheDocument();
    expect(screen.getByText(/120 tokens in, 40 out/)).toBeInTheDocument();
    expect(screen.getByText(/Check suggestions before running them/)).toBeInTheDocument();
    // The preview goes away once answered, so the next request needs a fresh review.
    expect(screen.queryByLabelText("Text that will be sent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review request" })).toBeInTheDocument();
  });

  it("renders HTML in the answer as plain text, never as markup", async () => {
    sendResult = async () => ({ ...ANSWER, text: "<img src=x onerror=alert(1)> is risky" });
    const { container } = setup();
    await reviewAndSend();
    expect(await screen.findByText("<img src=x onerror=alert(1)> is risky")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("inserts suggested SQL into the editor through the callback and runs nothing", async () => {
    const { onInsert } = setup();
    await reviewAndSend();
    await screen.findByText("SELECT id FROM users");
    const before = calls.length;
    const insert = screen.getByRole("button", { name: "Insert into editor" });
    expect(insert).toHaveAttribute("title", expect.stringContaining("Nothing is run."));
    fireEvent.click(insert);
    expect(onInsert).toHaveBeenCalledExactlyOnceWith("SELECT id FROM users");
    // No backend call of any kind (no query, no second AI request) follows the insert.
    expect(calls.length).toBe(before);
  });

  it("never inserts SQL on its own when the answer arrives", async () => {
    const { onInsert } = setup();
    await reviewAndSend();
    await screen.findByText("SELECT id FROM users");
    expect(onInsert).not.toHaveBeenCalled();
    expect(calls.map((c) => c.cmd)).toEqual(["ai_preview", "ai_send"]);
  });

  it("copies a suggested SQL block to the clipboard", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    setup();
    await reviewAndSend();
    await screen.findByText("SELECT id FROM users");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith("SELECT id FROM users");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("says so when copying fails", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    setup();
    await reviewAndSend();
    await screen.findByText("SELECT id FROM users");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  });

  it("warns when the answer was cut off at the length limit, and omits unknown token counts", async () => {
    sendResult = async () => ({ ...ANSWER, truncated: true, inputTokens: null, outputTokens: null });
    setup();
    await reviewAndSend();
    expect(await screen.findByText("The answer reached the length limit and is incomplete.")).toBeInTheDocument();
    expect(screen.queryByText(/tokens in/)).not.toBeInTheDocument();
  });

  it("Fix error sends the failing statement and the error, which the user can edit first", async () => {
    setup({
      getSql: () => "SELECT 1",
      lastError: { sql: "SELEC * FROM users", message: 'syntax error at or near "SELEC"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    const error = screen.getByRole("textbox", { name: /Error message/ });
    expect(error).toHaveValue('syntax error at or near "SELEC"');
    expect(screen.getByText(/Error details can quote values from your data/)).toBeInTheDocument();
    fireEvent.change(error, { target: { value: "syntax error (value redacted)" } });
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest()).toMatchObject({ task: "explain_error", sql: "SELEC * FROM users", error: "syntax error (value redacted)", description: null });
  });

  it("Fix error falls back to the editor SQL when nothing failed yet", async () => {
    setup({ initialTask: "explain_error", getSql: () => "SELECT 2" });
    expect(screen.getByRole("button", { name: "Fix error" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: /Error message/ })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest()).toMatchObject({ task: "explain_error", sql: "SELECT 2", error: "" });
  });

  it("Improve sends the editor SQL as an improve task", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Improve" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest()).toMatchObject({ task: "improve", sql: "SELECT * FROM users", error: null, description: null });
  });

  it("Write SQL sends the description and, when ticked, every loaded table", async () => {
    const { referencedTables } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Write SQL" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Describe the query/ }), { target: { value: "users with orders" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include table and column names" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(previewRequest()).toMatchObject({
      task: "generate",
      description: "users with orders",
      error: null,
      schema: "public.users(id, email)\npublic.orders(id, user_id)",
    });
    expect(referencedTables).not.toHaveBeenCalled();
  });

  it("drops the preview when anything that changes the request is edited", async () => {
    setup();
    const preview = () => screen.queryByLabelText("Text that will be sent");

    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByLabelText("Text that will be sent");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include table and column names" }));
    expect(preview()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByLabelText("Text that will be sent");
    fireEvent.click(screen.getByRole("button", { name: "Write SQL" }));
    expect(preview()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByLabelText("Text that will be sent");
    fireEvent.change(screen.getByRole("textbox", { name: /Describe the query/ }), { target: { value: "x" } });
    expect(preview()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fix error" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByLabelText("Text that will be sent");
    fireEvent.change(screen.getByRole("textbox", { name: /Error message/ }), { target: { value: "y" } });
    expect(preview()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByLabelText("Text that will be sent");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(preview()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review request" })).toBeInTheDocument();
    expect(sent("ai_send")).toHaveLength(0);
  });

  it("shows a preview error, such as AI being turned off, and sends nothing", async () => {
    previewResult = async () => {
      throw { kind: "policyViolation", message: "AI assistance is turned off in Settings" };
    };
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI assistance is turned off in Settings");
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(sent("ai_send")).toHaveLength(0);
  });

  it("shows a send error with its detail and keeps the preview to try again", async () => {
    sendResult = async () => {
      throw { kind: "network", message: "The AI service returned 401", detail: "invalid x-api-key" };
    };
    setup();
    await reviewAndSend();
    expect(await screen.findByRole("alert")).toHaveTextContent("The AI service returned 401: invalid x-api-key");
    expect(screen.getByLabelText("Text that will be sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("clears an earlier error when the request is reviewed again", async () => {
    let fail = true;
    previewResult = async () => {
      if (fail) throw { kind: "internal", message: "boom" };
      return PROMPT;
    };
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    await screen.findByRole("button", { name: "Send" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("locks the form while waiting and cancels the job on Cancel without showing an error", async () => {
    let reject!: (e: unknown) => void;
    sendResult = () => new Promise((_, rej) => (reject = rej));
    setup();
    await reviewAndSend();
    expect(await screen.findByText("Waiting for the answer…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    for (const b of within(screen.getByRole("group", { name: "What do you need?" })).getAllByRole("button")) expect(b).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Include table and column names" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sent("ai_cancel")).toHaveLength(1));
    expect(sent("ai_cancel")[0]!.args.jobId).toBe(sent("ai_send")[0]!.args.jobId);

    await act(async () => reject({ kind: "cancelled", message: "Cancelled" }));
    expect(screen.queryByText("Waiting for the answer…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("cancels a pending request when the panel closes, and ignores its late answer", async () => {
    let resolve!: (a: AiAnswer) => void;
    sendResult = () => new Promise((res) => (resolve = res));
    const { unmount, onInsert } = setup();
    await reviewAndSend();
    await screen.findByText("Waiting for the answer…");
    const jobId = sent("ai_send")[0]!.args.jobId;
    unmount();
    await waitFor(() => expect(sent("ai_cancel")).toHaveLength(1));
    expect(sent("ai_cancel")[0]!.args.jobId).toBe(jobId);
    await act(async () => resolve(ANSWER));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("does not cancel anything when closed while idle", async () => {
    const { unmount } = setup();
    unmount();
    await Promise.resolve();
    expect(sent("ai_cancel")).toHaveLength(0);
  });

  it("closes from the header button", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close AI assistant" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("follows a new initial task and a new last error from the editor", () => {
    const { rerender, props } = setup();
    rerender(
      <>
        <AiPanel {...props} initialTask="explain_error" lastError={{ sql: "SELECT x", message: "column x does not exist" }} />
        <Overlays />
      </>,
    );
    expect(screen.getByRole("button", { name: "Fix error" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: /Error message/ })).toHaveValue("column x does not exist");
  });
});
