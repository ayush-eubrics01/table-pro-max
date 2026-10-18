import { create } from "zustand";
import type { ReactNode } from "react";
import { toError } from "../lib/ipc";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
}

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** The confirm button stays disabled until exactly this text is typed (a connection name). */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}

export interface PromptRequest {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  /** Masks the input (passwords). */
  secret?: boolean;
  /** Extra explanation shown above the field. */
  description?: string;
  resolve: (value: string | null) => void;
}

interface UiState {
  toasts: Toast[];
  confirmRequest: ConfirmRequest | null;
  promptRequest: PromptRequest | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
}

let nextToast = 1;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  confirmRequest: null,
  promptRequest: null,
  paletteOpen: false,
  settingsOpen: false,
  push: (t) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    setTimeout(() => useUi.getState().dismiss(id), t.kind === "error" ? 9000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));

export function notify(message: string, kind: Toast["kind"] = "info") {
  useUi.getState().push({ kind, message });
}

export function notifyError(e: unknown, prefix?: string) {
  const err = toError(e);
  useUi.getState().push({ kind: "error", message: prefix ? `${prefix}: ${err.message}` : err.message, detail: err.detail });
}

/** Promise-based confirmation dialog. */
export function confirmAction(req: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.setState({
      confirmRequest: {
        ...req,
        resolve: (ok) => {
          useUi.setState({ confirmRequest: null });
          resolve(ok);
        },
      },
    });
  });
}

/** Promise-based single-field text prompt (window.prompt is unreliable in webviews). */
export function promptText(req: Omit<PromptRequest, "resolve" | "initial" | "confirmLabel"> & { initial?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useUi.setState({
      promptRequest: {
        initial: "",
        confirmLabel: "Save",
        ...req,
        resolve: (value) => {
          useUi.setState({ promptRequest: null });
          resolve(value);
        },
      },
    });
  });
}
