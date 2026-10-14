import { isMacPlatform } from "../app/WindowControls";

const MAC: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Enter: "↵" };
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];

/** A shortcut as each platform writes it: "Mod+Shift+F" → "⇧⌘F" on macOS, "Ctrl+Shift+F" elsewhere. */
export function shortcut(spec: string, mac: boolean = isMacPlatform()): string {
  const parts = spec.split("+");
  if (!mac) return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return [...mods, key].map((p) => MAC[p] ?? p).join("");
}
