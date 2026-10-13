import { useEffect } from "react";
import type { ConnectionProfile } from "../../types/backend";
import { EnvBadge } from "../../components/EnvBadge";
import { isFileDriver } from "../../lib/env";
import { useUi } from "../../stores/ui";

/**
 * Shown while a connection is being opened. Prompts (password, host trust) take its place.
 * It stays below the title bar and can be hidden; the connection carries on (the card keeps its spinner).
 */
export function ConnectingDialog({ profile: p, onHide }: { profile: ConnectionProfile; onHide: () => void }) {
  const prompting = useUi((s) => s.confirmRequest !== null || s.promptRequest !== null);
  useEffect(() => {
    if (prompting) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onHide();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompting, onHide]);
  if (prompting) return null;
  const target = isFileDriver(p.driver) ? p.filePath : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`;
  return (
    <div className="dialog-backdrop connecting-backdrop">
      <div className="dialog connecting" role="status" aria-live="polite">
        <div className="dialog-body">
          <EnvBadge env={p.environment} />
          <h2 className="connecting-title">Connecting to {p.name}</h2>
          <div className="mono connecting-target">{target}</div>
          <div className="connecting-wait">
            <span className="spinner" aria-hidden />
            Opening the connection…
            <button className="btn btn-ghost" onClick={onHide} autoFocus>
              Hide
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
