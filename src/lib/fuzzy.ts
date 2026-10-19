// Forgiving search for the palette, the sidebar and the connections list. A query is split into
// words; every word must match one of an item's fields (the first field counts most), in any
// order, as a substring, as letters in order, or with one typo when it has four letters or more.

/** Characters that separate words in names (`order_items`, `public.users`, `my-db`). */
const SEP = /[_\-. /:@]/;

/** Weight of a match in the first field (the name) against the others (schema, connection…). */
const OTHER_FIELD = 0.6;

/** Typo matches are ordered among themselves by this share of their score… */
const TYPO = 0.25;
/** …and every match without a typo ranks above all of them. */
const EXACT_TIER = 100_000;

interface WordMatch {
  score: number;
  positions: number[];
  /** Matched only with one typo undone. */
  typo?: boolean;
}

export interface FuzzyMatch {
  score: number;
  /** Matched character indexes, per field, for highlighting. */
  positions: number[][];
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/**
 * One word against one lower-cased text: exact, substring (word starts first), or, unless
 * `contiguous`, its letters in order.
 */
function matchWord(word: string, text: string, contiguous = false): WordMatch | null {
  if (text === word) return { score: 1000, positions: range(0, word.length) };
  let best: WordMatch | null = null;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    const boundary = i === 0 || SEP.test(text[i - 1]!);
    const score = (i === 0 ? 800 : boundary ? 700 : 600 - i) - text.length / 10;
    if (!best || score > best.score) best = { score, positions: range(i, i + word.length) };
  }
  if (best || contiguous) return best;
  let score = 0;
  let from = 0;
  let run = 0;
  const positions: number[] = [];
  for (const ch of word) {
    const found = text.indexOf(ch, from);
    if (found < 0) return null;
    const boundary = found === 0 || SEP.test(text[found - 1]!);
    run = found === from ? run + 1 : 0;
    score += 10 + run * 5 + (boundary ? 15 : 0) - Math.min(10, found - from);
    positions.push(found);
    from = found + 1;
  }
  return { score: Math.max(1, score - text.length / 5), positions };
}

/** Variants of a word with one typo undone: two letters swapped, or one letter extra or wrong. */
function oneTypoAway(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < word.length; i++) out.push(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  for (let i = 0; i < word.length; i++) out.push(word.slice(0, i) + word.slice(i + 1));
  return out;
}

function matchWordForgiving(word: string, text: string): WordMatch | null {
  const exact = matchWord(word, text);
  if (exact || word.length < 4) return exact;
  let best: WordMatch | null = null;
  // A corrected word must appear unbroken: a typo plus scattered letters would match almost anything.
  for (const v of oneTypoAway(word)) {
    const m = matchWord(v, text, true);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best && { score: best.score * TYPO, positions: best.positions, typo: true };
}

type FieldMatch = { field: number; score: number; match: WordMatch };

function bestField(word: string, texts: string[]): FieldMatch | null {
  let best: FieldMatch | null = null;
  texts.forEach((text, field) => {
    const m = matchWordForgiving(word, text);
    if (!m) return;
    const score = m.score * (field === 0 ? 1 : OTHER_FIELD);
    if (!best || score > best.score) best = { field, score, match: m };
  });
  return best;
}

/**
 * Matches `query` against an item's fields; `null` when a word matches none of them. A query
 * without spaces is tried whole first (so `order_items` ranks exact and prefix matches as such);
 * otherwise, or when the whole query only matched with a typo, it is split at spaces and
 * separators into words that may match anywhere, in any order.
 */
export function fuzzyMatch(query: string, fields: string[]): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  const texts = fields.map((f) => f.toLowerCase());
  const empty = () => fields.map((): number[] => []);
  if (!q) return { score: 0, positions: empty() };
  const whole = /\s/.test(q) ? null : bestField(q, texts);
  const wholeMatch = whole && {
    score: whole.score + (whole.match.typo ? 0 : EXACT_TIER),
    positions: Object.assign(empty(), { [whole.field]: whole.match.positions }),
  };
  if (whole && wholeMatch && !whole.match.typo) return wholeMatch;
  const positions = empty();
  let score = 0;
  let typo = false;
  for (const word of q.split(/[\s_\-.]+/).filter(Boolean)) {
    const best = bestField(word, texts);
    if (!best) return wholeMatch;
    score += best.score;
    typo ||= !!best.match.typo;
    positions[best.field] = [...new Set([...positions[best.field]!, ...best.match.positions])].sort((a, b) => a - b);
  }
  if (!typo) score += EXACT_TIER;
  return wholeMatch && wholeMatch.score > score ? wholeMatch : { score, positions };
}

/** Score of `query` against one text (higher is better), or -1 when it doesn't match. */
export function fuzzyScore(query: string, text: string): number {
  return fuzzyMatch(query, [text])?.score ?? -1;
}

/** The items that match, best first, at most `limit`; all of them (capped) for an empty query. */
export function rank<T>(items: T[], query: string, key: (t: T) => string | string[], limit = 60): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => {
      const k = key(item);
      return { item, match: fuzzyMatch(query, Array.isArray(k) ? k : [k]) };
    })
    .filter((x): x is { item: T; match: FuzzyMatch } => x.match !== null)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, limit)
    .map((x) => x.item);
}
