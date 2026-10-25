// Session identity kit v1 (P1-E3-03, §5.11): auto accent assignment from the
// distinguishable palette (least-used first — seven sessions get seven
// different colors). Project-type detection for the lang badge lived here too
// until #1433 removed the badge; nothing detects a project type any more.
// The palette itself moved to `shared/accents.ts` in #946 so the §5.15 role
// templates can name an accent without a second copy of the hex values; see that
// file's header. NOT re-exported from here: the whole point of the move is that
// there is one home for it, and a re-export would leave two import paths for one
// constant — the shape `shared/sessions.ts` spends a header warning about.
import { ACCENTS } from '../../shared/accents';

export function assignAccent(inUse: string[]): string {
  const counts = new Map<string, number>(ACCENTS.map((a) => [a.value, 0]));
  for (const c of inUse) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string = ACCENTS[0].value;
  let bestCount = Infinity;
  for (const a of ACCENTS) {
    const n = counts.get(a.value) ?? 0;
    if (n < bestCount) {
      best = a.value;
      bestCount = n;
    }
  }
  return best;
}
