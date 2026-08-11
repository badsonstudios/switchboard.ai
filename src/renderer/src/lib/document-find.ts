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

/** The attribute a wrapped match carries, so unwrapping finds only ours. */
const MATCH_ATTR = 'data-doc-match';
const CURRENT_ATTR = 'data-doc-match-current';

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

  let count = 0;
  for (const node of texts) {
    const value = node.nodeValue ?? '';
    const hay = value.toLowerCase();
    let from = 0;
    let at = hay.indexOf(needle, from);
    if (at < 0) continue;
    const frag = doc.createDocumentFragment();
    while (at >= 0) {
      if (at > from) frag.append(doc.createTextNode(value.slice(from, at)));
      const mark = doc.createElement('mark');
      mark.setAttribute(MATCH_ATTR, String(count));
      mark.textContent = value.slice(at, at + needle.length);
      frag.append(mark);
      count += 1;
      from = at + needle.length;
      at = hay.indexOf(needle, from);
    }
    if (from < value.length) frag.append(doc.createTextNode(value.slice(from)));
    node.replaceWith(frag);
  }
  return count;
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
