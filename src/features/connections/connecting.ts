import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, toError } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { useWorkspaces } from "../../stores/workspaces";
import type { ConnectionProfile, ConnectStep } from "../../types/backend";
import { connectWithPrompt } from "./connectFlow";

/** Steps of opening a connection: the backend reports its own, the app adds "schemas". */
export type ConnectPhase = ConnectStep | "schemas";

interface ConnectingState {
  /** The attempt in progress (its id is sent with the connect request). */
  id: string | null;
  reached: ConnectPhase[];
  startedAt: number;
  cancelled: boolean;
}

export const useConnecting = create<ConnectingState>(() => ({ id: null, reached: [], startedAt: 0, cancelled: false }));

/**
 * Records a step of the attempt `id` (ignored once another attempt has started). The clock starts
 * at the first step, so time spent in a password prompt is not counted.
 */
export function reach(id: string, phase: ConnectPhase) {
  useConnecting.setState((s) =>
    s.id !== id || s.reached.includes(phase) ? s : { reached: [...s.reached, phase], ...(s.reached.length === 0 ? { startedAt: Date.now() } : {}) },
  );
}

/** Follows the backend's "connect-progress" events (once, at startup). */
export function listenConnectProgress(): Promise<() => void> {
  return listen<{ connectId: string; step: ConnectStep }>("connect-progress", (e) => reach(e.payload.connectId, e.payload.step));
}

/** Cancel in the connecting dialog: stops the attempt in the backend and drops whatever it opens. */
export async function cancelConnecting(): Promise<void> {
  const { id } = useConnecting.getState();
  if (!id) return;
  useConnecting.setState({ cancelled: true });
  await api.cancelConnect(id).catch(() => false);
}

const cancelled = (id: string) => {
  const s = useConnecting.getState();
  return s.id === id && s.cancelled;
};

/**
 * Opens a SQL connection with its steps shown in the connecting dialog and Cancel available.
 * Resolves to the new workspace id, or null when cancelled (or a prompt was dismissed). Other
 * errors are passed on.
 */
export async function openTracked(profile: ConnectionProfile): Promise<string | null> {
  const id = uid();
  useConnecting.setState({ id, reached: [], startedAt: Date.now(), cancelled: false });
  try {
    const session = await connectWithPrompt(profile, null, { connectId: id, cancelled: () => cancelled(id) });
    if (!session) return null;
    if (cancelled(id)) {
      await api.disconnect(session.sessionId).catch(() => undefined);
      return null;
    }
    reach(id, "schemas");
    const wsId = await useWorkspaces.getState().open(profile, session);
    if (cancelled(id)) {
      await useWorkspaces.getState().close(wsId);
      return null;
    }
    return wsId;
  } catch (e) {
    if (cancelled(id) || toError(e).kind === "cancelled") return null;
    throw e;
  } finally {
    if (useConnecting.getState().id === id) useConnecting.setState({ id: null, reached: [], startedAt: 0, cancelled: false });
  }
}
