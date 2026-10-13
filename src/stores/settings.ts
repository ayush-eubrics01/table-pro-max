import { create } from "zustand";
import { api } from "../lib/ipc";
import { notifyError } from "./ui";

export interface Settings {
  theme: "system" | "light" | "dark";
  "editor.fontSize": number;
  "editor.wordWrap": boolean;
  "grid.pageSize": number;
  "grid.checkConflicts": boolean;
  "query.maxRows": number;
  "query.timeoutSecs": number;
  "history.enabled": boolean;
  "history.retentionDays": number;
  "history.maxEntries": number;
  "workspace.restore": boolean;
  "log.level": "error" | "warn" | "info" | "debug";
  "ai.enabled": boolean;
  "ai.provider": "anthropic" | "openai_compatible";
  /** Empty means the provider default. */
  "ai.model": string;
  "ai.baseUrl": string;
  /** Automatic update checks: asked once on first launch. */
  "updates.auto": "ask" | "on" | "off";
  /** Written by the backend after each completed check (ms since the epoch). */
  "updates.lastCheck": number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  "editor.fontSize": 13,
  "editor.wordWrap": false,
  "grid.pageSize": 300,
  "grid.checkConflicts": true,
  "query.maxRows": 100_000,
  "query.timeoutSecs": 0,
  "history.enabled": true,
  "history.retentionDays": 90,
  "history.maxEntries": 10_000,
  "workspace.restore": true,
  "log.level": "info",
  "ai.enabled": false,
  "ai.provider": "anthropic",
  "ai.model": "",
  "ai.baseUrl": "",
  "updates.auto": "ask",
  "updates.lastCheck": 0,
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  reset: () => Promise<void>;
}

function applyTheme(theme: Settings["theme"]) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const stored = await api.getSettings();
      const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
      for (const [k, v] of Object.entries(stored)) {
        if (k in DEFAULT_SETTINGS && typeof v === typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]) merged[k] = v;
      }
      const settings = merged as unknown as Settings;
      applyTheme(settings.theme);
      set({ settings, loaded: true });
    } catch (e) {
      notifyError(e, "Settings could not be loaded");
      set({ loaded: true });
    }
  },
  set: async (key, value) => {
    const settings = { ...get().settings, [key]: value };
    set({ settings });
    if (key === "theme") applyTheme(value as Settings["theme"]);
    try {
      await api.setSetting(key, value);
    } catch (e) {
      notifyError(e, "Setting was not saved");
    }
  },
  reset: async () => {
    await api.resetSettings();
    applyTheme(DEFAULT_SETTINGS.theme);
    set({ settings: DEFAULT_SETTINGS });
  },
}));
