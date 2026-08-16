// Find-in-page for the rendered body (P2-E16-02, §5.30 as corrected).
//
// WHY THIS IS OURS AND NOT `webContents.findInPage`. The plan line says
// "`webContents.findInPage` wired for Ctrl+F", and DESIGN §5.30 corrects it in
// the same section: "`findInPage` is right for a viewer in its OWN WINDOW and
// wrong everywhere else, because it searches the entire webContents — in the
// main window it would cheerfully match text in three other sessions' panes. A
// docked viewer registers a §5.31 find provider like every other panel; only
// the popped-out case may use `findInPage`."
//
// §5.31's find bar is E17-02 and does not exist yet, and a docked viewer is
// the only viewer this item ships (the popped-out one is P2-E16-03). So the
// viewer brings its own, scoped to its own container — which is the behaviour
// the §5.31 provider will have to implement anyway. When E17-02 lands, this
// becomes the body of the viewer's provider and the bar above it is deleted.
//
// The DOM is the index: matches are wrapped in `<mark>`, which is what a
// screen reader announces as a match and what a stylesheet can highlight
// without a second coordinate system to keep in sync.
//
// THE WALK ITSELF IS SHARED (`text-marks.ts`, #520). It was written here first
// and the Session view then needed the same thing — same `<mark>`, same
// attribute-in-my-own-namespace, same current-vs-other pair in `tokens.css` —
// so the tree walk that splits text nodes moved out and this file kept what is
// the viewer's: its attributes, its substring matching, and `focusMatch`.
import { unwrapMarks, wrapMatches } from './text-marks';

/** The attribute a wrapped match carries, so unwrapping finds only ours. */
const MATCH_ATTR = 'data-doc-match';
const CURRENT_ATTR = 'data-doc-match-current';

/**
 * Remove every mark this module added, leaving the text exactly as it was.
 *
 * The shared unwrap normalizes the parents it touched rather than the whole
 * body, which this used to do. Identical for the viewer as it stands — the body
 * is set by `innerHTML` and HTML parsing never yields adjacent text nodes, and
 * `document-render.ts` only ever WRAPS elements — but worth knowing: if that
 * pass ever removed an element from between two text nodes, a match straddling
 * the join would have been found before and would not be now.
 */
export function clearMatches(root: HTMLElement): void {
  unwrapMarks(root, MATCH_ATTR);
}

/**
 * Wrap every case-insensitive occurrence of `query` in a `<mark>`.
 *
 * Returns the number of matches. An empty or whitespace-only query clears and
 * matches nothing — searching for "" would otherwise wrap every character in
 * the document, which is both useless and slow.
 */
export function applyMatches(root: HTMLElement, query: string): number {
  clearMatches(root);
  const needle = query.toLowerCase();
  if (needle.trim().length === 0) return 0;
  return wrapMatches(root, {
    attr: MATCH_ATTR,
    ranges: (value) => {
      const hay = value.toLowerCase();
      const out: Array<readonly [number, number]> = [];
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        out.push([at, at + needle.length]);
      }
      return out;
    },
  }).length;
}

/**
 * Mark the `index`-th match as current and scroll it into view.
 *
 * Returns the index actually used — it wraps, so "next" from the last match is
 * the first one, which is what every find bar in every editor does.
 */
export function focusMatch(root: HTMLElement, index: number): number {
  const marks = [...root.querySelectorAll<HTMLElement>(`mark[${MATCH_ATTR}]`)];
  if (marks.length === 0) return -1;
  const at = ((index % marks.length) + marks.length) % marks.length;
  for (const m of marks) m.removeAttribute(CURRENT_ATTR);
  const current = marks[at];
  current.setAttribute(CURRENT_ATTR, '');
  // `scrollIntoView` does not exist in jsdom; the highlight is the assertion
  // there, and the scroll is the part only a real browser can do.
  current.scrollIntoView?.({ block: 'center' });
  return at;
}
