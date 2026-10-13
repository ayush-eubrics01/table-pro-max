import type { ConnectionProfile } from "../../types/backend";
import { EnvBadge } from "../../components/EnvBadge";
import { isFileDriver } from "../../lib/env";
import { useUi } from "../../stores/ui";

/** Shown while a connection is being opened. Prompts (password, host trust) take its place. */
export function ConnectingDialog({ profile: p }: { profile: ConnectionProfile }) {
  const prompting = useUi((s) => s.confirmRequest !== null || s.promptRequest !== null);
  if (prompting) return null;
  const target = isFileDriver(p.driver) ? p.filePath : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`;
  return (
    <div className="dialog-backdrop">
      <div className="dialog connecting" role="status" aria-live="polite">
        <div className="dialog-body">
          <EnvBadge env={p.environment} />
          <h2 className="connecting-title">Connecting to {p.name}</h2>
          <div className="mono connecting-target">{target}</div>
          <div className="connecting-wait">
            <span className="spinner" aria-hidden />
            Opening the connection…
          </div>
        </div>
      </div>
    </div>
  );
}
