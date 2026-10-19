import { useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { foldGutter, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import type { Cell } from "../../types/backend";
import { Dialog } from "../../components/Dialog";
import { confirmAction } from "../../stores/ui";
import { formatBytes } from "../../lib/cells";
import { toError } from "../../lib/ipc";
import { EDITOR_HIGHLIGHT, EDITOR_THEME } from "../sql-editor/SqlEditor";
import { formatJson, validateJson, type JsonCheck } from "./json";

export interface ValueEditorProps {
  title: string;
  typeName: string;
  mode: "json" | "text";
  load: () => Promise<Cell>;
  readOnlyReason: string | null;
  nullable: boolean;
  onSave: (value: string | null) => void;
  onClose: () => void;
  /** A way out of a load error that Retry can't fix (by error kind), shown instead of Retry. */
  recover?: (kind: string) => { label: string; run: () => void } | null;
}

type Loaded = { state: "loading" } | { state: "error"; message: string; kind: string } | { state: "ready"; original: string | null };

/** From this many characters, checking and measuring wait until typing pauses. */
const LARGE_TEXT = 100_000;
const CHECK_DELAY_MS = 300;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function ValueEditor({ title, typeName, mode, load, readOnlyReason, nullable, onSave, onClose, recover }: ValueEditorProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded({ state: "loading" });
    load()
      .then((c) => {
        if (!alive) return;
        const value = typeof c === "string" ? c : null;
        setText(value ?? "");
        setLoaded({ state: "ready", original: value });
      })
      .catch((e) => {
        const err = toError(e);
        if (alive) setLoaded({ state: "error", message: err.message, kind: err.kind });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (loaded.state !== "ready" || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: loaded.original ?? "",
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          syntaxHighlighting(EDITOR_HIGHLIGHT),
          EditorView.theme(EDITOR_THEME),
          ...(mode === "json" ? [json(), foldGutter()] : [EditorView.lineWrapping]),
          EditorState.readOnly.of(readOnlyReason !== null),
          EditorView.updateListener.of((u) => u.docChanged && setText(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, [loaded, mode, readOnlyReason]);

  const ready = loaded.state === "ready";
  const original = ready ? loaded.original : null;
  const dirty = ready && text !== (original ?? "");
  // A large value is checked and measured once typing pauses, not on every keystroke (a few MB
  // of JSON take long enough to make typing lag). Until then Save waits for the check.
  const large = text.length >= LARGE_TEXT;
  const [measured, setMeasured] = useState<{ text: string; check: JsonCheck | null; bytes: number } | null>(null);
  useEffect(() => {
    if (!ready || !large) return;
    const t = setTimeout(() => setMeasured({ text, check: mode === "json" ? validateJson(text) : null, bytes: byteLength(text) }), CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [ready, large, text, mode]);
  const current = !large ? { check: mode === "json" ? validateJson(text) : null, bytes: byteLength(text) } : measured?.text === text ? measured : null;
  const checking = ready && mode === "json" && current === null;
  const check = ready ? (current?.check ?? null) : null;
  const size = ready ? formatBytes(current?.bytes ?? byteLength(original ?? "")) : null;

  const close = async () => {
    if (dirty && !(await confirmAction({ title: "Discard your changes to this value?", body: "The edits in this editor have not been saved.", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };
  const replace = (next: string) => {
    const v = view.current;
    if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
  };

  return (
    <Dialog
      title={title}
      subtitle={
        <span className="hint">
          {typeName}
          {size ? ` · ${size}` : ""}
        </span>
      }
      className="value-editor"
      onClose={() => void close()}
      footer={
        <>
          <button className="btn btn-ghost" disabled={!ready} onClick={() => void navigator.clipboard.writeText(text)}>
            Copy
          </button>
          {mode === "json" && ready && (
            <button className="btn btn-ghost" disabled={!check?.ok || checking} onClick={() => replace(formatJson(text))}>
              Format
            </button>
          )}
          {readOnlyReason === null && nullable && ready && (
            <button className="btn btn-ghost" disabled={original === null} onClick={() => onSave(null)}>
              Set NULL
            </button>
          )}
          <span className="value-editor-status" role="status">
            {checking ? "Checking JSON…" : check ? (check.ok ? "Valid JSON" : `Invalid JSON: line ${check.line}, column ${check.column}: ${check.message}`) : null}
          </span>
          <button className="btn" onClick={() => void close()}>
            {readOnlyReason === null ? "Cancel" : "Close"}
          </button>
          {readOnlyReason === null && (
            <button className="btn btn-primary" disabled={!ready || !dirty || checking || (check !== null && !check.ok)} onClick={() => onSave(text)}>
              Save
            </button>
          )}
        </>
      }
    >
      {loaded.state === "loading" && <div className="empty"><div className="spinner" /></div>}
      {loaded.state === "error" && (
        <div className="empty">
          <p>{loaded.message}</p>
          {(() => {
            // Some failures can't be retried (an evicted result): the caller offers the way out.
            const way = recover?.(loaded.kind);
            return way ? (
              <button className="btn" onClick={way.run}>
                {way.label}
              </button>
            ) : (
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            );
          })()}
        </div>
      )}
      {readOnlyReason !== null && ready && <p className="hint">{readOnlyReason}</p>}
      {ready && <div ref={host} className="value-editor-body" />}
    </Dialog>
  );
}
