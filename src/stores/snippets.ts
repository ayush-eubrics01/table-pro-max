import { create } from "zustand";
import { api } from "../lib/ipc";
import type { Snippet } from "../types/backend";

/** The user's snippets (kept in the local app database), shared by every editor. */
interface SnippetsState {
  snippets: Snippet[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (snippet: Snippet) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useSnippets = create<SnippetsState>((set) => ({
  snippets: [],
  loaded: false,
  load: async () => set({ snippets: (await api.listSnippets()) ?? [], loaded: true }),
  save: async (snippet) => {
    await api.saveSnippet(snippet);
    set({ snippets: (await api.listSnippets()) ?? [] });
  },
  remove: async (id) => {
    await api.deleteSnippet(id);
    set({ snippets: (await api.listSnippets()) ?? [] });
  },
}));
