import { create } from "zustand";

/** Bumped when saved queries change outside the lists that show them (a tab saves one), so those lists read them again. */
export const useSavedQueries = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
