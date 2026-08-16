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
// §5.31's find bar was E17-02, and #533 joined the two: this module IS the
// body of the `find-document` provider now (`extensibility/find-providers.ts`),
// and the private bar the viewer used to draw above it is gone. The prediction
// in the paragraph above held — what changed on the way in is only what a
// match has to REPORT, because the shared bar shows a results list and the
// private one only ever showed a count.
//
// The DOM is the index: matches are wrapped in `<mark>`, which is what a
// screen reader announces as a match and what a stylesheet can highlight
// without a second coordinate system to keep in sync.

/** The attribute a wrapped match carries, so unwrapping finds only ours. */
const MATCH_ATTR = 'data-doc-match';
const CURRENT_ATTR = 'data-doc-match-current';

/**
 * How many matches we will mark.
 *
 * §5.30 budgets for a 2 MiB document, and a one-letter term over one of those
 * is tens of thousands of `<mark>` elements — enough DOM to make the pane stop
 * responding, which is the "never 'the app froze'" line this file already
 * respects with its debounce. Stopping at a cap and SAYING so (the bar prints
 * "showing the first N") is the honest version of the same protection.
 */
export const MATCH_CAP = 2000;

/** One match, in the vocabulary a `FindHit` is built from. */
export interface DocumentMatch {
  /** the whole text node the match sits in — the provider windows it */
  text: string;
  /** where the match starts inside `text`, and how long it is */
  offset: number;
  length: number;
}

export interface DocumentSearchResult {
  matches: DocumentMatch[];
  /** we stopped at `MATCH_CAP`; there are more, and `matches` is not all */
  truncated: boolean;
}

/** Options a query carries down from the bar's two chips. */
export interface DocumentSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

const EMPTY: DocumentSearchResult = { matches: [], truncated: false };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The term as a regex, or null when there is nothing to search for.
 *
 * LOOKAROUNDS RATHER THAN `\b` for whole-word: `\b` is a boundary between a
 * word character and a non-word one, so `--force` or `x)` — both ordinary
 * things to search a document for — have no boundary at the end that carries
 * the flag, and `\b--force\b` matches nothing at all. Asserting "no letter,
 * digit or underscore on either side" is what a user means by whole word, and
 * it degrades to the same answer as `\b` for an ordinary word.
 */
function matcher(term: string, opts?: DocumentSearchOptions): RegExp | null {
  if (term.trim().length === 0) return null;
  const body = escapeRegExp(term);
  const source = opts?.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  try {
    return new RegExp(source, opts?.caseSensitive ? 'gu' : 'giu');
  } catch {
    // fail-open: a term we cannot compile searches nothing rather than
    // throwing out of the provider and taking the bar with it
    return null;
  }
}

/** Remove every mark this module added, leaving the text exactly as it was. */
export function clearMatches(root: HTMLElement): void {
  for (const mark of [...root.querySelectorAll(`mark[${MATCH_ATTR}]`)]) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  // Adjacent text nodes left by the unwrap would make the NEXT search miss a
  // match that straddles the join. One call, and the tree is as it started.
  root.normalize();
}

/**
 * Wrap every occurrence of `query` in a `<mark>`, and describe them.
 *
 * An empty or whitespace-only query clears and matches nothing — searching for
 * "" would otherwise wrap every character in the document, which is both
 * useless and slow.
 *
 * The returned matches are in DOCUMENT ORDER, which is the contract `focusMatch`
 * relies on: the provider hands the bar an index into this array and gets back
 * the same index into `querySelectorAll`'s node order.
 *
 * ONE LIMIT WORTH KNOWING: a match cannot straddle two text nodes, so a term
 * broken by inline markup (`**find**ing`) is not found. That was true of this
 * function before the bar reached it and is inherent to marking the DOM in
 * place; the alternative is a flattened text index and a second coordinate
 * system to keep in sync, which is the thing the header refuses.
 */
export function applyMatches(
  root: HTMLElement,
  query: string,
  opts?: DocumentSearchOptions
): DocumentSearchResult {
  clearMatches(root);
  const re = matcher(query, opts);
  if (!re) return EMPTY;

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // A `<pre>` is searchable; a `<script>` cannot exist here (DOMPurify) but
      // costs nothing to name, and our own chrome must not match itself.
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  // Collected first, mutated after: splitting a text node while the walker is
  // standing on it is how you get a walker that visits its own output.
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);

  const matches: DocumentMatch[] = [];
  let truncated = false;
  for (const node of texts) {
    if (truncated) break;
    const value = node.nodeValue ?? '';
    re.lastIndex = 0;
    let from = 0;
    let hit = re.exec(value);
    if (!hit) continue;
    const frag = doc.createDocumentFragment();
    while (hit) {
      // A zero-length match cannot happen with a literal term, but a regex that
      // matched empty would spin here forever — one guard is cheaper than the
      // reasoning about why it cannot.
      if (hit[0].length === 0) break;
      const at = hit.index;
      if (at > from) frag.append(doc.createTextNode(value.slice(from, at)));
      const mark = doc.createElement('mark');
      mark.setAttribute(MATCH_ATTR, String(matches.length));
      mark.textContent = hit[0];
      frag.append(mark);
      matches.push({ text: value, offset: at, length: hit[0].length });
      from = at + hit[0].length;
      if (matches.length >= MATCH_CAP) {
        truncated = true;
        break;
      }
      re.lastIndex = from;
      hit = re.exec(value);
    }
    if (from < value.length) frag.append(doc.createTextNode(value.slice(from)));
    node.replaceWith(frag);
  }
  return { matches, truncated };
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
