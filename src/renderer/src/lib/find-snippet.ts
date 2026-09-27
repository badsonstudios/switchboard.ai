// A readable window of one long line, centred on the match (§5.31).
//
// WHY THIS IS ITS OWN MODULE (#952). It lived in `lib/terminal-find.ts`, which
// went with the PTY transport — but it was never a terminal concept. Its only
// surviving caller is the §5.30 DOCUMENT provider, which hits the same problem
// for a different reason: a match inside a code fence sits in a text node that is
// the whole fence, so without a window a single hit renders as a twelve-line row
// and the results list stops being scannable.
//
// Moved rather than inlined into `find-providers.ts` so it keeps its own tests.
// The two below came across from `terminal-find.test.ts` unchanged; they were
// never about a terminal either, which is the tell that this function was in the
// wrong file all along.

/**
 * Longest snippet we will put in a results row.
 *
 * 240 characters is about two wrapped lines in the bar at its default width —
 * enough to judge a match by, short enough that twenty of them still scan.
 */
const SNIPPET_MAX = 240;

/**
 * A window of `line` around the match, so one 500-column line is not the list.
 *
 * Returns the snippet AND a corrected `matchStart`, and the pair is the whole
 * point: the offset the caller has is into the full line, and the bar highlights
 * into the snippet. Returning the text without re-basing the offset would
 * highlight the wrong characters on exactly the long lines this exists for.
 *
 * A short line is returned untouched, offset included — so a caller can run
 * everything through this without testing the length first.
 */
export function snippetAround(
  line: string,
  offset: number,
  length: number
): { snippet: string; matchStart: number } {
  if (line.length <= SNIPPET_MAX) return { snippet: line, matchStart: offset };
  const room = Math.max(0, SNIPPET_MAX - length);
  const start = Math.max(0, Math.min(offset - Math.floor(room / 2), line.length - SNIPPET_MAX));
  const end = Math.min(line.length, start + SNIPPET_MAX);
  const head = start > 0 ? '…' : '';
  const tail = end < line.length ? '…' : '';
  return {
    snippet: `${head}${line.slice(start, end)}${tail}`,
    matchStart: offset - start + head.length,
  };
}
