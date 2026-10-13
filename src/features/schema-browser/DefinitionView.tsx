import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import type { ObjectKind, SessionInfo } from "../../types/backend";
import { api, toError, type BackendError } from "../../lib/ipc";
import { notify } from "../../stores/ui";

export function DefinitionView({
  session,
  schema,
  name,
  kind,
}: {
  session: SessionInfo;
  schema: string;
  name: string;
  kind: ObjectKind;
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
          <div>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(sql);
                notify("Definition copied", "success");
              }}
            >
              <Copy size={14} /> Copy SQL
            </button>
          </div>
          <pre className="code-block">{sql}</pre>
        </>
      )}
    </div>
  );
}
