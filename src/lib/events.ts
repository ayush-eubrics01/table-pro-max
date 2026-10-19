import { listen } from "@tauri-apps/api/event";

/**
 * Listens to a backend event until the returned `stop` is called. Registering is asynchronous, so
 * `stop` also works before it finishes; and stopping never throws or rejects, since the event
 * bridge may already be gone (a closed window, the end of a test).
 */
export function listenFor<T>(event: string, handler: (payload: T) => void): () => void {
  let stopped = false;
  let off: (() => void) | undefined;
  const unlisten = (u: () => void) => void Promise.resolve().then(u).catch(() => undefined);
  void listen<T>(event, (e) => {
    if (!stopped) handler(e.payload);
  })
    .then((u) => (stopped ? unlisten(u) : (off = u)))
    .catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    if (off) unlisten(off);
  };
}
