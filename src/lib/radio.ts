import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a radio group (ARIA pattern): move to the next or previous enabled option,
 * select it and focus it. Only the checked option is a Tab stop (tabIndex 0, others -1).
 */
export function radioKeyDown<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, select: (v: T) => void, enabled: (v: T) => boolean = () => true) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  let i = Math.max(0, values.indexOf(current));
  for (let n = 0; n < values.length; n++) {
    i = (i + step + values.length) % values.length;
    if (enabled(values[i]!)) break;
  }
  select(values[i]!);
  const group = (e.currentTarget.closest('[role="radiogroup"]') ?? e.currentTarget) as HTMLElement;
  group.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
}
