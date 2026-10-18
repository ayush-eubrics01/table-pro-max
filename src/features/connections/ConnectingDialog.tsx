import { useEffect, useState } from "react";
import type { ConnectionProfile } from "../../types/backend";
import { EnvBadge } from "../../components/EnvBadge";
import { Icon } from "../../components/Icon";
import { isFileDriver } from "../../lib/env";
import { useUi } from "../../stores/ui";
import { cancelConnecting, useConnecting, type ConnectPhase } from "./connecting";

const LABELS: Record<ConnectPhase, string> = {
  tunnel: "Opening SSH tunnel",
  // The drivers do TCP, TLS and signing in in one call, so they are one step here.
  connect: "Connecting and signing in",
  server_info: "Reading server info",
  schemas: "Loading schemas",
};

/**
 * Shown while a connection is being opened. Prompts (password, host trust) take its place.
 * It stays below the title bar and can be hidden; the connection carries on (the card keeps its spinner).
 * A tracked attempt (SQL databases) lists its steps and can be cancelled (Cancel or Escape).
 */
export function ConnectingDialog({ profile: p, onHide }: { profile: ConnectionProfile; onHide: () => void }) {
  const prompting = useUi((s) => s.confirmRequest !== null || s.promptRequest !== null);
  const { id, reached, startedAt } = useConnecting();
  const tracked = id !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tracked) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [tracked]);
  useEffect(() => {
    if (prompting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (tracked) void cancelConnecting();
      else onHide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompting, onHide, tracked]);
  if (prompting) return null;
  const target = isFileDriver(p.driver) ? p.filePath : `${p.user ? `${p.user}@` : ""}${p.host}:${p.port ?? ""}/${p.database}`;
  const phases: ConnectPhase[] = [...(p.ssh ? (["tunnel"] as const) : []), "connect", "server_info", "schemas"];
  const current = Math.max(0, ...reached.map((r) => phases.indexOf(r)));
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="dialog-backdrop connecting-backdrop">
      <div className="dialog connecting" role="status" aria-live="polite">
        <div className="dialog-body">
          <EnvBadge env={p.environment} />
          <h2 className="connecting-title">Connecting to {p.name}</h2>
          <div className="mono connecting-target">{target}</div>
          {tracked ? (
            <>
              <ol className="connecting-steps">
                {phases.map((phase, i) => {
                  const state = i < current ? "done" : i === current ? "active" : "waiting";
                  return (
                    <li key={phase} data-state={state}>
                      {state === "done" ? <Icon name="check_circle" size={14} /> : state === "active" ? <span className="spinner" aria-hidden /> : <span className="step-dot" aria-hidden />}
                      {LABELS[phase]}
                    </li>
                  );
                })}
              </ol>
              <div className="connecting-wait">
                <span className="hint" aria-label="Time spent connecting">
                  {seconds} s · stops after {p.connectTimeoutSecs} s without an answer
                </span>
                <button className="btn btn-ghost" onClick={onHide}>
                  Hide
                </button>
                <button className="btn" onClick={() => void cancelConnecting()} autoFocus>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="connecting-wait">
              <span className="spinner" aria-hidden />
              Opening the connection…
              <button className="btn btn-ghost" onClick={onHide} autoFocus>
                Hide
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
