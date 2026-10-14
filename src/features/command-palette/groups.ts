export const GROUPS = [
  ["action", "Actions"],
  ["object", "Tables and views"],
  ["schema", "Schemas"],
  ["saved", "Saved queries"],
  ["connection", "Connections"],
] as const;

/** Palette sections in a fixed order; items keep their rank order inside a section. */
export function groupResults<T extends { kind: string }>(items: T[]): { kind: string; title: string; items: T[] }[] {
  return GROUPS.map(([kind, title]) => ({ kind, title, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}
