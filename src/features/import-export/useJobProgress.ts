import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Latest `done` count reported by the backend for a job id. */
export function useJobProgress(jobId: string | null): number {
  const [done, setDone] = useState(0);
  useEffect(() => {
    setDone(0);
    if (!jobId) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen<{ jobId: string; done: number }>("job-progress", (e) => {
      if (e.payload.jobId === jobId) setDone(e.payload.done);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [jobId]);
  return done;
}
