import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { EnvBadge } from "../../components/EnvBadge";
import type { SessionInfo } from "../../types/backend";
import { toError, type BackendError } from "../../lib/ipc";

interface Props {
  session: SessionInfo;
  title: string;
  sql: string;
  summary: string;
  atomic: boolean;
  commitLabel: string;
  onCommit: () => Promise<void>;
  onClose: () => void;
}

/** Shows generated SQL and the exact target before anything is written. */
export function ReviewChangesDialog({ session, title, sql, summary, atomic, commitLabel, onCommit, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BackendError | null>(null);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCommit();
    } catch (e) {
      setError(toError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      wide
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="hint">
            {atomic ? "Runs in one transaction: all changes apply or none do." : "This database cannot run these statements in one transaction."}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${session.environment === "production" ? "btn-danger" : "btn-primary"}`}
            onClick={commit}
            disabled={busy}
          >
            {busy ? "Committing…" : commitLabel}
          </button>
        </>
      }
    >
      <div className="field-row" style={{ alignItems: "center" }}>
        <EnvBadge env={session.environment} />
        <span>
          <strong>{session.connectionName}</strong> <span className="hint mono">{session.target}</span>
        </span>
      </div>
      <div>{summary}</div>
      <pre className="code-block" style={{ maxHeight: "45vh" }}>
        {sql}
      </pre>
      {error && (
        <div className="notice notice-error" role="alert">
          {error.message}
          {error.detail && <pre>{error.detail}</pre>}
        </div>
      )}
    </Dialog>
  );
}
