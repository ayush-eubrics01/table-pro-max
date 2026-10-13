/**
 * Subsequence fuzzy match. Returns a score (higher is better) or -1 when `query` is not a
 * subsequence of `text`. Rewards prefix matches, consecutive runs and word boundaries.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 600 - idx - t.length / 10;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const boundary = found === 0 || /[_\-. /]/.test(t[found - 1]!);
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 5 + (boundary ? 15 : 0) - Math.min(10, found - ti);
    ti = found + 1;
  }
  return Math.max(1, score - t.length / 5);
}

export function rank<T>(items: T[], query: string, key: (t: T) => string, limit = 60): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query.trim(), key(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
