import { useEffect, useState } from "react";
import { listenFor } from "../../lib/events";

/** Latest `done` count reported by the backend for a job id. */
export function useJobProgress(jobId: string | null): number {
  const [done, setDone] = useState(0);
  useEffect(() => {
    setDone(0);
    if (!jobId) return;
    return listenFor<{ jobId: string; done: number }>("job-progress", (p) => {
      if (p.jobId === jobId) setDone(p.done);
    });
  }, [jobId]);
  return done;
}
