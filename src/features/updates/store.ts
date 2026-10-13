import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { AvailableUpdate, UpdateProgress, UpdateStatus } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { confirmAction } from "../../stores/ui";
import { pendingTableCount } from "../../stores/pendingEdits";
import { useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { saveNow } from "../../app/restore";

export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

interface UpdatesState {
  status: UpdateStatus | null;
  available: AvailableUpdate | null;
  phase: UpdatePhase;
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  bannerHidden: boolean;
  jobId: string | null;
  /** Set synchronously by "Update now", so a second click is ignored even while the
   *  unsaved-edits confirmation is open. */
  installClaimed: boolean;
  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  check: (manual: boolean) => Promise<void>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  later: () => void;
  openReleasePage: () => Promise<void>;
}

const busy = (phase: UpdatePhase) => phase === "checking" || phase === "downloading" || phase === "installing";

function describe(e: unknown): string {
  const err = toError(e);
  return err.detail ? `${err.message}: ${err.detail}` : err.message;
}

/** In-app updates: nothing is checked automatically unless the user agreed (`updates.auto`). */
export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  available: null,
  phase: "idle",
  progress: null,
  error: null,
  bannerHidden: false,
  jobId: null,
  installClaimed: false,

  refreshStatus: async () => {
    try {
      set({ status: await api.updateStatus() });
    } catch {
      // Status is informational; the Settings section shows what it has.
    }
  },

  init: async () => {
    await get().refreshStatus();
    if (get().status?.auto === "on") await get().check(false);
  },

  check: async (manual) => {
    if (busy(get().phase)) return;
    set({ phase: "checking", error: null });
    try {
      const r = await api.updateCheck(manual);
      if (r.skipped) set({ phase: get().available ? "available" : "idle" });
      else if (r.available) set({ available: r.available, phase: "available", bannerHidden: false });
      else set({ available: null, phase: "upToDate" });
    } catch (e) {
      // Automatic checks fail quietly (offline, GitHub down); the next start tries again.
      set({ phase: manual ? "error" : "idle", error: manual ? describe(e) : null });
    }
    await get().refreshStatus();
  },

  install: async () => {
    const { available, phase } = get();
    if (!available || busy(phase) || get().installClaimed) return;
    set({ installClaimed: true });
    try {
      const pending = pendingTableCount();
      if (pending > 0) {
        const ok = await confirmAction({
          title: `Update to ${available.version} now?`,
          body: `${pending} ${pending === 1 ? "table has" : "tables have"} uncommitted changes. They will be lost when the app restarts.`,
          confirmLabel: "Update anyway",
          danger: true,
        });
        if (!ok) return;
      }
      await runInstall();
    } finally {
      set({ installClaimed: false });
    }
  },

  cancel: async () => {
    const { jobId } = get();
    if (jobId) await api.updateCancel(jobId).catch(() => undefined);
  },

  later: () => set({ bannerHidden: true }),

  openReleasePage: async () => {
    const version = get().available?.version;
    if (version) await api.updateOpenReleasePage(version).catch((e) => set({ error: describe(e) }));
  },
}));

/** Downloads, verifies and installs the pending update; on success the app restarts. */
async function runInstall() {
  const set = useUpdates.setState;
  const jobId = uid();
  set({ phase: "downloading", progress: { downloaded: 0, total: null }, error: null, jobId });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<UpdateProgress>("update-progress", (e) => {
      if (e.payload.jobId !== jobId) return;
      const { downloaded, total } = e.payload;
      set({ progress: { downloaded, total }, phase: total != null && downloaded >= total ? "installing" : "downloading" });
    });
  } catch {
    // Progress is optional.
  }
  try {
    if (useSettings.getState().settings["workspace.restore"]) {
      const ws = useWorkspaces.getState();
      await saveNow(ws.workspaces, ws.activeId).catch(() => undefined);
    }
    await api.updateInstall(jobId);
    // On success the app restarts before this returns.
  } catch (e) {
    set({ phase: "available", error: toError(e).kind === "cancelled" ? null : describe(e) });
  } finally {
    unlisten?.();
    set({ jobId: null, progress: null });
  }
}
