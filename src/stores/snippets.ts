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

/** Numbers each read, so a slow older read can't replace the list a newer one brought. */
let reads = 0;

export const useSnippets = create<SnippetsState>((set) => {
  const refresh = async () => {
    const n = ++reads;
    const snippets = (await api.listSnippets()) ?? [];
    if (n === reads) set({ snippets, loaded: true });
  };
  return {
    snippets: [],
    loaded: false,
    load: refresh,
    save: async (snippet) => {
      await api.saveSnippet(snippet);
      await refresh();
    },
    remove: async (id) => {
      await api.deleteSnippet(id);
      await refresh();
    },
  };
});
