import { useEffect, useRef, useState } from "react";
import { Copy, CornerDownLeft, Sparkles, X } from "lucide-react";
import type { AiAnswer, AiPrompt, AiTask } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { notify, notifyError } from "../../stores/ui";
import { describeSchema, inlineCode, splitAnswer } from "./answer";

const TASKS: { id: AiTask; label: string }[] = [
  { id: "explain", label: "Explain" },
  { id: "explain_error", label: "Fix error" },
  { id: "improve", label: "Improve" },
  { id: "generate", label: "Write SQL" },
];

type Table = { schema: string; table: string };

interface Props {
  dialect: string;
  /** The selection, or the whole editor when nothing is selected. */
  getSql: () => string;
  lastError: { sql: string; message: string } | null;
  referencedTables: (sql: string) => Table[];
  allTables: Table[];
  columns: Record<string, string[] | undefined>;
  initialTask?: AiTask;
  onInsert: (sql: string) => void;
  onClose: () => void;
}

/**
 * Side panel for optional AI help. Every request is previewed exactly as it will be sent;
 * answers are shown as text and SQL is only ever inserted into the editor, never run.
 */
export function AiPanel({ dialect, getSql, lastError, referencedTables, allTables, columns, initialTask, onInsert, onClose }: Props) {
  const [task, setTask] = useState<AiTask>(initialTask ?? "explain");
  const [description, setDescription] = useState("");
  const [errorText, setErrorText] = useState(lastError?.message ?? "");
  const [includeSchema, setIncludeSchema] = useState(false);
  const [prompt, setPrompt] = useState<AiPrompt | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);
  const job = useRef<string | null>(null);

  useEffect(() => {
    if (initialTask) setTask(initialTask);
  }, [initialTask]);
  useEffect(() => setErrorText(lastError?.message ?? ""), [lastError]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      // Closing the panel abandons the request.
      if (job.current) void api.aiCancel(job.current);
    };
  }, []);

  const review = async () => {
    setFailure(null);
    setAnswer(null);
    const sql = task === "explain_error" ? (lastError?.sql ?? getSql()) : getSql();
    const tables = task === "generate" ? allTables : referencedTables(sql);
    try {
      setPrompt(
        await api.aiPreview({
          task,
          dialect,
          sql,
          error: task === "explain_error" ? errorText : null,
          description: task === "generate" ? description : null,
          schema: includeSchema ? describeSchema(tables, columns) : null,
        }),
      );
    } catch (e) {
      setFailure(toError(e).message);
    }
  };

  const send = async () => {
    if (!prompt) return;
    const id = uid();
    job.current = id;
    setJobId(id);
    setFailure(null);
    try {
      const a = await api.aiSend(prompt, id);
      if (!live.current) return;
      setAnswer(a);
      setPrompt(null);
    } catch (e) {
      if (!live.current) return;
      const err = toError(e);
      if (err.kind !== "cancelled") setFailure(err.detail ? `${err.message}: ${err.detail}` : err.message);
    } finally {
      job.current = null;
      if (live.current) setJobId(null);
    }
  };

  const busy = jobId !== null;

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <div className="ai-panel-head">
        <Sparkles size={14} aria-hidden /> AI assistant
        <span className="grow" />
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close AI assistant">
          <X size={14} />
        </button>
      </div>
      <div className="ai-panel-body">
        <div className="ai-tasks" role="group" aria-label="What do you need?">
          {TASKS.map((t) => (
            <button
              key={t.id}
              className="btn"
              aria-pressed={task === t.id}
              disabled={busy}
              onClick={() => {
                setTask(t.id);
                setPrompt(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {task === "generate" && (
          <label className="field">
            <span>Describe the query</span>
            <textarea
              className="textarea"
              rows={4}
              value={description}
              disabled={busy}
              placeholder="Customers who ordered more than three times last month, newest first"
              onChange={(e) => {
                setDescription(e.target.value);
                setPrompt(null);
              }}
            />
          </label>
        )}
        {task === "explain_error" && (
          <label className="field">
            <span>Error message</span>
            <textarea
              className="textarea mono"
              rows={4}
              value={errorText}
              disabled={busy}
              placeholder="Run the statement first, or paste the error here"
              onChange={(e) => {
                setErrorText(e.target.value);
                setPrompt(null);
              }}
            />
            <span className="hint">Error details can quote values from your data. Edit them out if needed.</span>
          </label>
        )}
        {task !== "generate" && task !== "explain_error" && (
          <span className="hint">Uses the selected text, or the whole editor when nothing is selected.</span>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeSchema}
            disabled={busy}
            onChange={(e) => {
              setIncludeSchema(e.target.checked);
              setPrompt(null);
            }}
          />
          Include table and column names
        </label>

        {!prompt && !busy && (
          <button className="btn" onClick={() => void review()}>
            Review request
          </button>
        )}

        {prompt && (
          <div className="notice">
            Will send to <span className="mono">{prompt.endpoint}</span> ({prompt.model}):
            <pre className="ai-sent" tabIndex={0} aria-label="Text that will be sent">
              {prompt.user}
            </pre>
            <details>
              <summary className="ai-meta">Instructions sent with it</summary>
              <pre className="ai-sent">{prompt.system}</pre>
            </details>
            <div className="row" style={{ marginTop: 8 }}>
              {busy ? (
                <button className="btn btn-danger" onClick={() => jobId && void api.aiCancel(jobId)}>
                  Cancel
                </button>
              ) : (
                <>
                  <button className="btn btn-primary" onClick={() => void send()}>
                    Send
                  </button>
                  <button className="btn" onClick={() => setPrompt(null)}>
                    Edit
                  </button>
                </>
              )}
              {busy && <span className="ai-meta">Waiting for the answer…</span>}
            </div>
          </div>
        )}

        {failure && (
          <div className="notice notice-error" role="alert">
            {failure}
          </div>
        )}

        {answer && <Answer answer={answer} onInsert={onInsert} />}
      </div>
    </aside>
  );
}

function Answer({ answer, onInsert }: { answer: AiAnswer; onInsert: (sql: string) => void }) {
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify("Copied", "success"),
      (e) => notifyError(e, "Could not copy"),
    );
  return (
    <div className="ai-answer" aria-live="polite">
      {answer.truncated && <div className="notice notice-warning">The answer reached the length limit and is incomplete.</div>}
      {splitAnswer(answer.text).map((part, i) =>
        part.kind === "code" ? (
          <div key={i}>
            <pre>{part.text}</pre>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={() => onInsert(part.text)} title="Insert at the cursor, replacing the selection. Nothing is run.">
                <CornerDownLeft size={14} /> Insert into editor
              </button>
              <button className="btn btn-ghost" onClick={() => void copy(part.text)}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </div>
        ) : (
          <p key={i}>{inlineCode(part.text).map((s, j) => (j % 2 ? <code key={j}>{s}</code> : s))}</p>
        ),
      )}
      <div className="ai-meta">
        {answer.model}
        {answer.inputTokens != null && answer.outputTokens != null && ` · ${answer.inputTokens} tokens in, ${answer.outputTokens} out`}
        . Check suggestions before running them.
      </div>
    </div>
  );
}
