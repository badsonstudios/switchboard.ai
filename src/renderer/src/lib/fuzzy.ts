// Fuzzy subsequence matching for the command palette (P2-E9-02). Deliberately
// small and dependency-free: the palette ranks a few dozen commands, not a
// codebase. Pure — the whole ranking is unit-tested without a DOM.
//
// Scoring favours what a person means when they type three letters: a prefix
// beats a word-boundary hit, which beats characters scattered through the
// string; shorter targets win ties, so "Close session" outranks
// "Toggle Changes view" for "cs".

export interface FuzzyMatch {
  score: number;
  /** indices in the target that matched — the palette bolds these */
  indices: number[];
}

const PREFIX_BONUS = 12;
const BOUNDARY_BONUS = 8;
const CONSECUTIVE_BONUS = 5;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return prev === ' ' || prev === '-' || prev === '.' || prev === '/';
}

/**
 * Match `query` against `target` as a subsequence, case-insensitively.
 * Returns null when a character can't be found in order. An empty query
 * matches everything with score 0 (the palette then keeps registry order).
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  // Two passes. Greedy-leftmost always finds a match if one exists; the
  // word-start pass prefers the acronym reading ("cs" -> Close session, not
  // Clo(s)e) but can dead-end, so it only wins when it succeeds AND scores
  // higher. Lists here are dozens of rows — two passes cost nothing.
  const greedy = scan(q, target, false);
  const acronym = scan(q, target, true);
  if (!greedy) return acronym;
  if (!acronym) return greedy;
  return acronym.score >= greedy.score ? acronym : greedy;
}

function scan(q: string, target: string, preferWordStart: boolean): FuzzyMatch | null {
  const t = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let lastIndex = -2;
  for (const ch of q) {
    if (ch === ' ') continue; // spaces are separators in the query, not literals
    let at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (preferWordStart && !isBoundary(t, at)) {
      // look for the same character starting a later word
      for (let i = at + 1; i < t.length; i++) {
        if (t[i] === ch && isBoundary(t, i)) {
          at = i;
          break;
        }
      }
    }
    score += 1;
    if (at === 0) score += PREFIX_BONUS;
    else if (isBoundary(t, at)) score += BOUNDARY_BONUS;
    if (at === lastIndex + 1) score += CONSECUTIVE_BONUS;
    indices.push(at);
    lastIndex = at;
    from = at + 1;
  }
  // shorter targets are the better answer for the same characters
  score -= Math.floor(target.length / 10);
  return { score, indices };
}

/**
 * Rank `items` against a query, dropping non-matches. Stable: equal scores keep
 * their input order, so an empty query renders the registry as authored.
 */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  textOf: (item: T) => string
): Array<{ item: T; match: FuzzyMatch }> {
  return items
    .map((item, i) => ({ item, i, match: fuzzyMatch(query, textOf(item)) }))
    .filter((r): r is { item: T; i: number; match: FuzzyMatch } => r.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.i - b.i)
    .map(({ item, match }) => ({ item, match }));
}
