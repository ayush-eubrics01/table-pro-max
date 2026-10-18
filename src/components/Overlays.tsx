import { useState } from "react";
import { useUi, type ConfirmRequest, type PromptRequest } from "../stores/ui";
import { Dialog } from "./Dialog";

/** Global toasts and the shared confirmation dialog. */
export function Overlays() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  const confirm = useUi((s) => s.confirmRequest);
  const prompt = useUi((s) => s.promptRequest);

  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            <div>{t.message}</div>
            {t.detail && <pre className="hint" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{t.detail}</pre>}
          </div>
        ))}
      </div>
      {confirm && <ConfirmDialog key={confirm.title} req={confirm} />}
      {prompt && <PromptDialog key={prompt.title} req={prompt} />}
    </>
  );
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const [typed, setTyped] = useState("");
  const matches = req.typeToConfirm === undefined || typed.trim() === req.typeToConfirm.trim();
  return (
    <Dialog
      title={req.title}
      onClose={() => req.resolve(false)}
      tone={req.danger ? "danger" : undefined}
      initialFocus={req.typeToConfirm === undefined ? ".dialog-footer .btn-cancel" : ".type-to-confirm input"}
      footer={
        <>
          <button className="btn btn-cancel" onClick={() => req.resolve(false)}>
            Cancel
          </button>
          <button className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} disabled={!matches} onClick={() => req.resolve(true)}>
            {req.confirmLabel}
          </button>
        </>
      }
    >
      {req.body}
      {req.typeToConfirm !== undefined && (
        <label className="field type-to-confirm">
          <span>
            Type <strong>{req.typeToConfirm}</strong> to confirm
          </span>
          <input
            className="input"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${req.typeToConfirm} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches) req.resolve(true);
              }
            }}
          />
        </label>
      )}
    </Dialog>
  );
}

function PromptDialog({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial);
  const submit = () => (req.secret ? value.length > 0 : value.trim()) && req.resolve(req.secret ? value : value.trim());
  return (
    <Dialog
      title={req.title}
      onClose={() => req.resolve(null)}
      footer={
        <>
          <button className="btn" onClick={() => req.resolve(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={req.secret ? value.length === 0 : !value.trim()}>
            {req.confirmLabel}
          </button>
        </>
      }
    >
      {req.description && <p className="hint" style={{ margin: 0 }}>{req.description}</p>}
      <label className="field">
        <span>{req.label}</span>
        <input
          className="input"
          type={req.secret ? "password" : "text"}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Keep Enter from also activating whatever regains focus after the dialog closes.
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
    </Dialog>
  );
}
