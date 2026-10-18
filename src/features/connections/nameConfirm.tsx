import { EnvBadge } from "../../components/EnvBadge";
import { toError } from "../../lib/ipc";
import { confirmAction } from "../../stores/ui";
import type { SessionInfo } from "../../types/backend";

/** The connection a confirmation is about: environment, name and target (long paths wrap). */
export function ConnectionLine({ session }: { session: SessionInfo }) {
  return (
    <div className="field-row" style={{ alignItems: "center" }}>
      <EnvBadge env={session.environment} />
      <strong>{session.connectionName}</strong>
      <span className="hint mono confirm-target">{session.target}</span>
    </div>
  );
}

/** Where a confirmed statement will run, and what it may do. */
export function ConfirmRunBody({ session, detail }: { session: SessionInfo; detail?: string | null }) {
  return (
    <>
      <ConnectionLine session={session} />
      <p style={{ margin: 0 }}>These statements may change or destroy data:</p>
      <pre className="code-block" style={{ maxHeight: 240 }}>
        {detail}
      </pre>
    </>
  );
}

/** Whether the backend wants the connection name typed (statements that destroy data on production). */
export function needsName(e: unknown): boolean {
  const err = toError(e);
  return err.kind === "confirmation_required" && err.code === "confirm_typed";
}

/** Runs `attempt`; when the backend asks for the connection name, asks for it and retries. */
export async function withNameConfirm<T>(session: SessionInfo, attempt: (typed?: string) => Promise<T>): Promise<T | null> {
  try {
    return await attempt();
  } catch (e) {
    if (!needsName(e)) throw e;
    const ok = await confirmAction({
      title: "Confirm execution",
      confirmLabel: "Run anyway",
      danger: true,
      typeToConfirm: session.connectionName,
      body: <ConfirmRunBody session={session} detail={toError(e).detail} />,
    });
    return ok ? attempt(session.connectionName) : null;
  }
}
