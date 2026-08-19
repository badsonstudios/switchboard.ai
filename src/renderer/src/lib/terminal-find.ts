// Searching a terminal's scrollback with `@xterm/addon-search` (P2-E17-03, §5.31).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VERSION QUESTION, ANSWERED BY RUNNING IT (the item's first instruction).
//
// `@xterm/addon-search@0.16.0` is the `latest` tag and declares NO peer
// dependency, so npm installs it happily against our `@xterm/xterm@6.0.0` even
// though it predates xterm 6 (the 0.17 line is beta-only and pins
// `^6.1.0-beta`). "Installs" is not "works", so it was driven against a REAL
// xterm 6 terminal before a line of this file was written, and the result is
// pinned by `terminal-find.test.ts` — which builds an actual `Terminal` +
// `SearchAddon` in jsdom rather than a mock, so the day an upgrade breaks the
// pairing, that test is what goes red.
//
// VERDICT: it works, with ONE condition that is not in its README.
//
//   `findNext`/`findPrevious` search the whole buffer including scrollback,
//   return false on a miss, select the match, and wrap. `findPrevious` from no
//   selection lands on the LAST match. `getSelectionPosition()` reports
//   ABSOLUTE buffer coordinates (`buffer.active` indices, scrollback included),
//   which is what makes a match addressable after the fact.
//
//   ONE UPSTREAM DEFECT, characterised rather than worked around: with
//   `wholeWord`, a row is ABANDONED at the first non-whole-word candidate on
//   it, so `aa needles bb needle cc` finds nothing at all. It does not cross
//   rows and it does not touch plain or case-sensitive search. The toggle
//   still ships — a whole-word button that quietly did nothing on the Terminal
//   would be the bigger lie — and `terminal-find.test.ts` pins the behaviour
//   so an upgrade that fixes it announces itself.
//
//   THE CONDITION: the `decorations` option — the thing that highlights every
//   match and the only thing that makes `onDidChangeResults` fire at all —
//   goes through `Terminal.registerDecoration`, which is PROPOSED API in
//   xterm 6. Without `allowProposedApi: true` on the terminal, `findNext` does
//   not degrade: it THROWS ("You must set the allowProposedApi option to true
//   to use proposed API"). `TerminalPane` sets the flag; every call in here is
//   still wrapped, because a throw out of find must never take the window with
//   it (fail-open), and because `^6.0.0` lets a future minor move that API.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS MODULE EXISTS AT ALL — i.e. why the bar does not just call
// `findNext` on Enter. The bar's model is a LIST of hits with snippets that it
// steps through and that §5.31's results list renders. The addon has no "give
// me every match" call; it only walks. So this module walks it ONCE per query,
// records where each match landed, and hands back an addressable list. The
// addon remains the only thing that decides WHAT a match is — no second search
// implementation lives here, which is the whole reason we took the dependency.
//
// SCROLLBACK ONLY, and the bar says so out loud. xterm holds `scrollback: 5000`
// lines behind a byte cap; the transcript holds the session. One number over
// those two depths would be a small lie, so the two are separate groups with
// separate labels (§5.31, and the `find.group.terminal` string).
import type { Terminal } from '@xterm/xterm';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';

/** One match, addressable after the walk that found it. */
export interface TerminalMatch {
  /** absolute `buffer.active` row — scrollback included */
  row: number;
  /** cell column the match starts at */
  col: number;
  /** how many cells it spans */
  length: number;
  /** that row's text, for the snippet */
  line: string;
  /** where the match starts INSIDE `line` (a string index, not a cell index) */
  offset: number;
}

export interface TerminalSearchOutcome {
  matches: TerminalMatch[];
  /** matches in the scrollback; `matches` may be capped below this */
  total: number;
  truncated: boolean;
  /**
   * `total` is a FLOOR, not a count — we stopped walking before the end.
   *
   * The addon's own tally is hard-capped at its `highlightLimit` (1000), and
   * so is our walk, so past that point neither of us knows the answer.
   * Reporting the cap as the total would be a wrong number told confidently,
   * which is the one thing §5.31 says find must never do — so the bar renders
   * it as "1000+" instead.
   */
  totalIsFloor: boolean;
}

export interface TerminalSearchQuery {
  term: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/**
 * How many matches we collect POSITIONS for.
 *
 * Not the same limit as `WALK_CEILING`, and the difference is the point: the
 * walk keeps counting past this, so a capped list still carries an honest
 * total and the bar says "showing the first 200 of 640". Only when the WALK
 * stops (`WALK_CEILING`) does the total stop being a count.
 */
export const TERMINAL_MATCH_LIMIT = 200;

/** Longest snippet we hand the results list, in characters. */
const SNIPPET_MAX = 240;

/**
 * Highlight colours for the addon's decorations, read off the live theme.
 *
 * xterm cannot resolve CSS custom properties (the same constraint that makes
 * `TerminalPane` name a concrete font stack) and the addon demands `#RRGGBB`,
 * so the token is read from the DOM and checked. **No hardcoded fallback**: a
 * literal hex here would be one theme's colour frozen into code, and every
 * built-in theme declares `--chip` as a six-digit hex (`theme/tokens.css`,
 * pinned by `tokens.drift.test.ts`). If it ever is not one, we search WITHOUT
 * decorations — the current match is still marked by the terminal's own
 * selection, so find degrades to "no extra highlights", never to "no find".
 *
 * One colour for every match, including the current one, on purpose: the
 * current match is the SELECTION, which `findNext` sets and which sits under
 * the decoration. Two washes over one cell would be decoration and selection
 * fighting for the same job.
 *
 * This does not cross §5.20's "xterm is constructed with no theme" boundary:
 * the CLI still owns every colour it prints. A find highlight is our chrome
 * drawn over its output, not a remap of it.
 */
function hexToken(host: Element | null, name: string): string | null {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  for (const el of [host, root]) {
    if (!el) continue;
    try {
      const v = getComputedStyle(el).getPropertyValue(name).trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    } catch {
      /* fail-open: try the next one, then go without decorations */
    }
  }
  return null;
}

function decorations(host: Element | null): ISearchOptions['decorations'] | undefined {
  const chip = hexToken(host, '--chip');
  if (!chip) return undefined;
  return {
    matchBackground: chip,
    activeMatchBackground: chip,
    matchOverviewRuler: chip,
    activeMatchColorOverviewRuler: chip,
  };
}

/**
 * Where the match starts inside the row's TEXT.
 *
 * `col` is a cell index and `line` is a JS string; the two diverge on wide and
 * combining characters, and the snippet's `<mark>` is sliced with the string
 * index. So find the occurrences of the term in the row and take the one
 * nearest the cell the addon reported — which disambiguates several matches on
 * one row without needing a cell↔character map.
 *
 * This is NOT a second search: the addon has already decided that a match
 * exists and where; this only converts its coordinate. When the conversion
 * fails (a regex-ish edge, an exotic cell), `col` clamped is a good-enough
 * offset and the snippet is still readable.
 */
export function offsetInLine(line: string, term: string, col: number, caseSensitive?: boolean): number {
  if (!term) return 0;
  const hay = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const d = Math.abs(i - col);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best >= 0 ? best : Math.max(0, Math.min(col, line.length));
}

/** A window of the row around the match, so one 500-column line is not the list. */
export function snippetAround(line: string, offset: number, length: number): { snippet: string; matchStart: number } {
  if (line.length <= SNIPPET_MAX) return { snippet: line, matchStart: offset };
  const room = Math.max(0, SNIPPET_MAX - length);
  const start = Math.max(0, Math.min(offset - Math.floor(room / 2), line.length - SNIPPET_MAX));
  const end = Math.min(line.length, start + SNIPPET_MAX);
  const head = start > 0 ? '…' : '';
  const tail = end < line.length ? '…' : '';
  return { snippet: `${head}${line.slice(start, end)}${tail}`, matchStart: offset - start + head.length };
}

function toMatch(term: Terminal, q: TerminalSearchQuery): TerminalMatch | null {
  const pos = term.getSelectionPosition();
  if (!pos) return null;
  const row = pos.start.y;
  const line = term.buffer.active.getLine(row)?.translateToString(true) ?? '';
  // a match that wrapped onto the next row has no single-row length; the term's
  // own length is the honest approximation, and only affects the selection we
  // draw when the user steps back onto it
  const length = pos.end.y === pos.start.y ? pos.end.x - pos.start.x : [...q.term].length;
  return { row, col: pos.start.x, length, line, offset: offsetInLine(line, q.term, pos.start.x, q.caseSensitive) };
}

/**
 * How far the walk will go before it stops counting.
 *
 * The addon's own `highlightLimit` is 1000 and it reports `resultIndex: -1`
 * past that, so counting further would be counting past the point the addon
 * can index anyway.
 */
const WALK_CEILING = 1000;

/**
 * Every match in the scrollback, in buffer order, plus the honest total.
 *
 * Leaves the terminal on the FIRST match with every match highlighted — which
 * is the browser rhythm the bar already implements for the session view ("land
 * on the first match as you type").
 *
 * COST, MEASURED rather than assumed (jsdom, 5,000 rows × 120 cols, 200
 * matches, 2026-08-13): the FIRST `findNext` for a term is ~17 ms — it is the
 * one that scans the whole buffer and builds the decorations — and every
 * subsequent call for the same term and options is ~0.06 ms, because the addon
 * re-highlights only when the term or the options CHANGED and otherwise just
 * runs its engine forward from the current selection to the next match. So
 * walking 200 matches costs about 30 ms in total, not 200 buffer scans.
 *
 * That measurement is what makes an eager list affordable at all. Two caveats
 * recorded rather than hidden: it was taken in jsdom, where `--chip` does not
 * resolve and the walk therefore ran UNDECORATED, so the cost of up to 1,000
 * `registerDecoration` calls in Chromium is on top of it; and if a future
 * version re-highlights on every call, this walk becomes O(N × buffer) and the
 * design has to change with it.
 */
export function searchTerminal(
  term: Terminal,
  addon: SearchAddon,
  q: TerminalSearchQuery,
  limit: number = TERMINAL_MATCH_LIMIT,
  /** exposed for the test that drives the ceiling; production never passes it */
  ceiling: number = WALK_CEILING,
  /**
   * Paint the match decorations? (#517)
   *
   * True for the terminal the user is LOOKING at — highlighting every match is
   * most of what find is for. False for the OFF-SCREEN replay of main's ring
   * buffer (`lib/terminal-shadow.ts`), where up to 1,000 `registerDecoration`
   * calls would draw a highlight on a terminal that has no viewport and is
   * about to be thrown away. The matches and the count are identical either
   * way — `walk(false)` is the same walk, and it is already the path this
   * function falls back to when the proposed API is unavailable.
   */
  decorate: boolean = true,
): TerminalSearchOutcome {
  const empty: TerminalSearchOutcome = { matches: [], total: 0, truncated: false, totalIsFloor: false };
  if (!q.term) return empty;
  const base: ISearchOptions = {
    caseSensitive: !!q.caseSensitive,
    wholeWord: !!q.wholeWord,
    // §5.31 v1 ships case + whole word only; the bar has no regex toggle, and
    // handing a user pattern to the addon would reintroduce the backtracking
    // hazard E17-01 refused for the transcript engine.
    regex: false,
    incremental: false,
  };

  /**
   * One walk of the buffer.
   *
   * `decorations` on EVERY step, not just the first — read off the shipped
   * bundle rather than assumed: the addon only enters `_highlightAllMatches`
   * (and only fires `onDidChangeResults`) when the call CARRIES the option, so
   * an undecorated step neither repaints nor reports. Passing it every time is
   * what keeps the highlights on the screen for the whole walk. It measures the
   * same either way (see above).
   */
  const walk = (decorated: boolean): TerminalSearchOutcome => {
    const deco = decorated ? decorations(term.element ?? null) : undefined;
    const opts: ISearchOptions = deco ? { ...base, decorations: deco } : base;
    const matches: TerminalMatch[] = [];
    const seen = new Set<string>();
    let counted = -1;
    const sub = addon.onDidChangeResults((e) => {
      // fires on the first search for a term (later ones are served from the
      // addon's cache and stay quiet), which is exactly when we need it
      if (e.resultCount >= 0) counted = e.resultCount;
    });
    let wrapped = false;
    try {
      term.clearSelection();
      for (let i = 0; i < ceiling; i += 1) {
        if (!addon.findNext(q.term, opts)) break;
        const m = toMatch(term, q);
        if (!m) break;
        const key = `${m.row}:${m.col}`;
        // the addon wraps at the end of the buffer, so meeting a position we
        // already have IS the end of the list — and the guard doubles as the
        // net that stops a pathological zero-width step spinning forever
        if (seen.has(key)) {
          wrapped = true;
          break;
        }
        seen.add(key);
        if (matches.length < limit) matches.push(m);
      }
    } finally {
      sub.dispose();
    }
    if (matches.length === 0) return { ...empty, total: Math.max(counted, 0) };

    // back to the first match, which is where the user expects to be standing
    term.clearSelection();
    addon.findNext(q.term, opts);

    // Our own count when the walk closed the loop — that is exact and owes
    // nothing to an event that may not have fired. A walk that hit the ceiling
    // has no exact answer available to it AT ALL: `resultCount` comes from
    // `updateResults(s, highlightLimit)`, which slices at the same 1000, so the
    // addon's tally is capped too. That is reported as a FLOOR ("1000+"), never
    // as a total.
    const total = wrapped ? seen.size : Math.max(counted, seen.size);
    return { matches, total, truncated: total > matches.length, totalIsFloor: !wrapped };
  };

  if (!decorate) {
    try {
      return walk(false);
    } catch (err) {
      console.warn('[find] terminal search failed', err);
      return empty;
    }
  }

  try {
    return walk(true);
  } catch (err) {
    // `allowProposedApi` off, or a future xterm moved `registerDecoration`:
    // the addon THROWS rather than degrading, so degrade here — no highlights,
    // but the same matches and the same honest count.
    console.warn('[find] terminal highlighting unavailable, searching without it', err);
    try {
      return walk(false);
    } catch (err2) {
      console.warn('[find] terminal search failed', err2);
      return empty;
    }
  }
}

/**
 * Scroll a collected match into view and select it. Returns whether it moved.
 *
 * A `row` is an ABSOLUTE buffer index and the buffer is a RING: once the
 * scrollback is full, new output evicts the oldest lines and every row already
 * recorded now names different text. So the row is re-read and the match
 * re-checked before we move — otherwise a busy session would have find select
 * and scroll to text that is not the match, while the results list still showed
 * the old snippet. Refusing is safe: the bar treats `false` the same way it
 * treats any hit it cannot reach, and opens the results list instead.
 */
export function revealTerminalMatch(term: Terminal, m: TerminalMatch): boolean {
  try {
    if (m.row < 0 || m.row >= term.buffer.active.length) return false;
    const now = term.buffer.active.getLine(m.row)?.translateToString(true) ?? '';
    const was = m.line.slice(m.offset, m.offset + m.length);
    if (was && now.slice(m.offset, m.offset + was.length) !== was) return false;
    term.select(m.col, m.row, Math.max(1, m.length));
    term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    return true;
  } catch (err) {
    console.warn('[find] terminal reveal failed', err);
    return false;
  }
}

/** Drop the highlights and the selection — the terminal as find found it. */
export function clearTerminalSearch(term: Terminal, addon: SearchAddon): void {
  try {
    addon.clearDecorations();
  } catch {
    /* fail-open */
  }
  try {
    term.clearSelection();
  } catch {
    /* fail-open */
  }
}
