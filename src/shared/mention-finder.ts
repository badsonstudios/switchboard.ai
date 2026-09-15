// Finding `@Name` mentions in a draft AT SEND (P2-E11-08).
//
// NOT `mentionToken` (`shared/mention-token.ts`). That is a popup TRIGGER: it
// stops at a space and an apostrophe because it only has to follow the word the
// caret is in. A real session title contains both ("My Project", "Dan's App"),
// and the design's own example is `@TradingApp's last output`, where `'s` must
// END the name. So at send, each word-boundary `@` is matched against the
// LONGEST known session name that fits there.
//
// Pure: no I/O, no session lookup. It finds where known names are mentioned;
// it does not decide what a mention RESOLVES to. That is `SessionQueries.resolve`
// — ids first, then an exact name, then case-insensitive, and an AMBIGUOUS name
// is refused there, not guessed here. Two sessions sharing a title are one name
// to this function.
//
// SKIPPED, left as literal text: an `@` inside a fenced code block or an inline
// code span (a decorator, an npm scope, a CSS rule someone is asking about), an
// `@` that is not at a word boundary (an email address), and a name followed by
// more word characters (`@TradingAppX` is not `@TradingApp`).

/** Characters a mention may follow — the same set the `@` popup opens after. */
const BOUNDARY = /[\s([{"'`]/;

/**
 * A name ends here: end of text, whitespace, or closing punctuation. Both
 * apostrophes end a name, so `'s` works whether it was typed or arrived as the
 * typographic `’` that smart quotes and pasted text produce.
 */
const NAME_END = /[\s)\]}"'’`,;:!?.]/;

/**
 * Could `text` hold a mention at all? A cheap SUPERSET of `findMentions` that
 * needs no names: an `@` at a word boundary with something after it. The
 * composer uses it so a draft with no such `@` keeps its instant send path and
 * never waits on a lookup.
 */
export function mayMention(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '@' && (i === 0 || BOUNDARY.test(text[i - 1]))) return true;
  }
  return false;
}

export interface FoundMention {
  /** index of the `@` */
  start: number;
  /** index just past the matched name */
  end: number;
  /** the matched name, spelled as the session list spells it */
  name: string;
  /**
   * The same name spelled AS THE USER TYPED IT — which is what must be resolved.
   *
   * Review blocker, #798. Matching here is case-insensitive, so two sessions
   * whose titles differ only in case (`API` and `api`, the ordinary result of
   * two checkouts) both match either spelling, and `name` is whichever one the
   * sort happened to reach first. Resolving THAT hands back a session the user
   * did not name, silently — while an agent calling `get_session_output("api")`
   * gets the other one, because `SessionQueries.resolve` matches exact-first and
   * only falls back to case-insensitive when nothing matched exactly.
   *
   * So the typed spelling is carried through and resolved: `resolve` then either
   * finds the exact session the user meant, or refuses a genuine same-case
   * duplicate as ambiguous. `name` remains what the list calls it — useful for
   * grouping and for a human-readable log, never for the lookup.
   */
  typed: string;
}

/** `[from, to)` ranges of fenced code blocks and inline code spans. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced blocks first; an unterminated fence runs to the end of the text,
  // which is what a Markdown renderer does with it too.
  const fence = /```[\s\S]*?(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) fence.lastIndex++;
  }
  const inFence = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const inline = /`[^`\n]*`/g;
  while ((m = inline.exec(text)) !== null) {
    if (!inFence(m.index)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * Every mention of a known session name in `text`, in order, non-overlapping.
 * The same name mentioned twice is returned twice; injecting it once is the
 * caller's decision.
 */
export function findMentions(text: string, names: readonly string[]): FoundMention[] {
  // TRIMMED, not merely non-blank (review nit): a title is user-editable, so
  // `"Trading "` and `"Trading"` can both exist. Untrimmed, the longer one wins
  // and swallows the user's space — and `resolve` trims it straight back to the
  // other session.
  const candidates = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))].sort(
    (a, b) => b.length - a.length
  );
  if (candidates.length === 0) return [];
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const found: FoundMention[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    if (i > 0 && !BOUNDARY.test(text[i - 1])) continue;
    if (inCode(i)) continue;
    const rest = text.slice(i + 1);
    const lower = rest.toLowerCase();
    const hit = candidates.find((name) => {
      if (!lower.startsWith(name.toLowerCase())) return false;
      const after = rest[name.length];
      return after === undefined || NAME_END.test(after);
    });
    if (!hit) continue;
    // `typed` is the span AS WRITTEN — same length as the candidate, because
    // that is how it matched, but not necessarily the same characters.
    found.push({ start: i, end: i + 1 + hit.length, name: hit, typed: rest.slice(0, hit.length) });
    i += hit.length; // non-overlapping: resume after the name
  }
  return found;
}
