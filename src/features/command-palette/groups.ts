export const GROUPS = [
  ["action", "Actions"],
  ["object", "Tables and views"],
  ["schema", "Schemas"],
  ["saved", "Saved queries"],
  ["connection", "Connections"],
] as const;

/**
 * Palette sections; items keep their rank order inside a section. Without a query the sections
 * come in a fixed order; with one (`byRank`), the section holding the best match comes first, so
 * Enter still opens the best match.
 */
export function groupResults<T extends { kind: string }>(items: T[], byRank = false): { kind: string; title: string; items: T[] }[] {
  const groups = GROUPS.map(([kind, title]) => ({ kind, title, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
  return byRank ? groups.sort((a, b) => items.indexOf(a.items[0]!) - items.indexOf(b.items[0]!)) : groups;
}
