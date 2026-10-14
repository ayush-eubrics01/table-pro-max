import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { EnvBadge } from "../../components/EnvBadge";
import { Icon } from "../../components/Icon";
import { SqlBlock } from "../../components/SqlBlock";
import { pluralize } from "../../lib/text";
import type { SessionInfo } from "../../types/backend";
import { toError, type BackendError } from "../../lib/ipc";

interface Props {
  session: SessionInfo;
  title: string;
  sql: string;
  summary: string;
  atomic: boolean;
  /** Number of statements in `sql`, when known. */
  statements?: number;
  commitLabel: string;
  onCommit: () => Promise<void>;
  onClose: () => void;
}

/** Shows generated SQL and the exact target before anything is written. */
export function ReviewChangesDialog({ session, title, sql, summary, atomic, statements, commitLabel, onCommit, onClose }: Props) {
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
      subtitle={[statements !== undefined ? pluralize(statements, "statement") : null, session.connectionName, atomic ? "one transaction" : "no transaction"].filter(Boolean).join(" · ")}
      tone={session.environment === "production" ? "danger" : undefined}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(sql)} disabled={busy}>
            <Icon name="content_copy" size={14} /> Copy SQL
          </button>
          <span className="spacer" />
          <span className="hint">{atomic ? "All changes apply or none do." : "This database cannot run these statements in one transaction."}</span>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Keep editing
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
      <SqlBlock sql={sql} dialect={session.dialect} maxHeight="45vh" />
      {error && (
        <div className="notice notice-error" role="alert">
          {error.message}
          {error.detail && <pre>{error.detail}</pre>}
        </div>
      )}
    </Dialog>
  );
}
