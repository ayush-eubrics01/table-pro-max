import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { SqlBlock } from "../../components/SqlBlock";
import type { ObjectKind, SessionInfo } from "../../types/backend";
import { api, toError, type BackendError } from "../../lib/ipc";
import { notify } from "../../stores/ui";

export function DefinitionView({
  session,
  schema,
  name,
  kind,
  onOpenSql,
}: {
  session: SessionInfo;
  schema: string;
  name: string;
  kind: ObjectKind;
  /** Opens the DDL in a new query tab (never runs it). Hidden when not given. */
  onOpenSql?: (sql: string, title: string) => void;
}) {
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<BackendError | null>(null);

  useEffect(() => {
    let alive = true;
    setSql(null);
    setError(null);
    api
      .objectDefinition(session.sessionId, schema, name, kind)
      .then((s) => alive && setSql(s))
      .catch((e) => alive && setError(toError(e)));
    return () => {
      alive = false;
    };
  }, [session.sessionId, schema, name, kind]);

  return (
    <div className="structure">
      {error && <div className="notice notice-error">{error.message}</div>}
      {sql === null && !error && <div className="spinner" aria-label="Loading definition" />}
      {sql !== null && (
        <>
          <div className="definition-bar">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(sql);
                notify("Definition copied", "success");
              }}
            >
              <Icon name="content_copy" size={14} /> Copy SQL
            </button>
            {onOpenSql && (
              <button className="btn" onClick={() => onOpenSql(sql, `${name} (definition)`)}>
                <Icon name="terminal" size={14} /> Open in editor
              </button>
            )}
            <span className="grow" />
            <span className="hint">Generated from the catalog · read-only</span>
          </div>
          <SqlBlock sql={sql} dialect={session.dialect} />
        </>
      )}
    </div>
  );
}
