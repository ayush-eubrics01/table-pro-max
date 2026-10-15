import { create } from "zustand";

/**
 * The restore points panel (one per window, showing the visible workspace's connection) and a
 * version that goes up whenever new restore points may exist.
 */
export const useRestore = create<{ open: boolean; version: number; setOpen: (open: boolean) => void; bump: () => void }>((set) => ({
  open: false,
  version: 0,
  setOpen: (open) => set({ open }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
