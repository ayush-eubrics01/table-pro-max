import { create } from "zustand";

/** Tables with uncommitted grid edits, per workspace, so app-wide actions (updating) can warn first. */
interface PendingEditsState {
  byWorkspace: Record<string, number>;
  set: (workspaceId: string, tables: number) => void;
}

export const usePendingEdits = create<PendingEditsState>((set) => ({
  byWorkspace: {},
  set: (workspaceId, tables) =>
    set((s) => {
      if ((s.byWorkspace[workspaceId] ?? 0) === tables) return s;
      const byWorkspace = { ...s.byWorkspace };
      if (tables > 0) byWorkspace[workspaceId] = tables;
      else delete byWorkspace[workspaceId];
      return { byWorkspace };
    }),
}));

export function pendingTableCount(): number {
  return Object.values(usePendingEdits.getState().byWorkspace).reduce((a, b) => a + b, 0);
}
