// ONE way to put a `<mark>` on found text, for every surface that finds text
// (#520).
//
// The document viewer had the only one (`document-find.ts`, P2-E16-02): walk
// the text nodes, split them around each occurrence, wrap the occurrence in a
// `<mark>` carrying the surface's own attribute so the unwrap finds only ours.
// The DOM is the index — no second coordinate system to keep in step with the
// text, and a `<mark>` is what a screen reader announces as a match and what a
// stylesheet can paint.
//
// The Session view needed the same thing and would otherwise have grown a
// second copy of that walk (#520: find jumped you to the block and marked
// NOTHING, so the eye had to re-read the block to find the word). Two copies of
// a tree walk that splits text nodes is two places to get `normalize()` wrong,
// so the walk lives here and each surface brings the three things that actually
// differ:
//
//   • `attr` — its OWN namespace's attribute (`data-doc-match`,
//     `data-feed-match`), which is what makes the unwrap surgical and what puts
//     the mark inside the surface's decoration guard (`decoration-guard.ts`).
//   • `ranges` — how it matches. The viewer's find is a case-insensitive
//     substring; the feed's honours the bar's case and whole-word toggles, so
//     it hands over a regex's spans.
//   • `accept` — which text nodes it may split at all. The viewer's content is
//     one `dangerouslySetInnerHTML` blob React does not own; the feed's is JSX,
//     and splitting a text node React TRACKS is how you get a lost update or a
//     `removeChild` on a detached node. See `feed-marks.ts` for that rule.

/** What one surface's marking pass needs to say. */
export interface MarkSpec {
  /** the attribute a wrap carries — the surface's own namespace */
  attr: string;
  /**
   * The occurrences inside one text node, as `[start, end)` offsets, in order
   * and non-overlapping. An empty array means "nothing here".
   */
  ranges(text: string): Array<readonly [start: number, end: number]>;
  /**
   * May this text node be split? `SCRIPT`/`STYLE` and empty nodes are refused
   * before this is asked, so a surface with no extra rule can leave it out.
   */
  accept?(node: Text): boolean;
  /**
   * Stop after this many marks. A guard rather than a feature: a one-character
   * term over a long conversation is thousands of wraps on the layout path, and
   * a partial paint beats a frozen window (fail-open).
   */
  limit?: number;
}

/**
 * Remove every mark `attr` names, leaving the text exactly as it was.
 *
 * Normalizes only the parents it actually touched, NOT `root` — an unwrap
 * anywhere would otherwise reach every text node in the surface.
 *
 * READ THIS BEFORE RELAXING `accept`. `Node.normalize()` is recursive over the
 * whole subtree, so "per-parent" narrows WHICH subtrees, not how deep it goes —
 * and merging two adjacent text nodes React tracks is the same hazard as
 * splitting one (a detached node it later writes to or removes). What makes it
 * safe is not the scoping: it is that a parent only lands in this set because
 * `accept` let us split it, and `accept`'s whole job is to say React is not
 * holding that node. Widen one and you have widened the other.
 */
export function unwrapMarks(root: ParentNode, attr: string): void {
  const parents = new Set<Node>();
  for (const mark of [...root.querySelectorAll(`mark[${attr}]`)]) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parents.add(parent);
  }
  // Adjacent text nodes left by the unwrap would make the NEXT search miss a
  // match that straddles the join.
  for (const parent of parents) parent.normalize();
}

/**
 * Wrap every range `spec` finds under `root`, and return the marks in document
 * order.
 *
 * The attribute's VALUE is the mark's index, which is what `document-find`'s
 * `focusMatch` has always written; nothing reads it, and a surface that does
 * not care can ignore it.
 */
export function wrapMatches(root: ParentNode, spec: MarkSpec): HTMLElement[] {
  const doc = ownerDocumentOf(root);
  if (!doc) return [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // A `<pre>` is searchable; a `<script>` cannot exist here (DOMPurify) but
      // costs nothing to name, and our own chrome must not match itself.
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
      return spec.accept && !spec.accept(node as Text)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collected first, mutated after: splitting a text node while the walker is
  // standing on it is how you get a walker that visits its own output.
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);

  const limit = spec.limit ?? Number.POSITIVE_INFINITY;
  const marks: HTMLElement[] = [];
  for (const node of texts) {
    if (marks.length >= limit) break;
    const value = node.nodeValue ?? '';
    const ranges = spec.ranges(value);
    if (ranges.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let from = 0;
    for (const [at, end] of ranges) {
      if (marks.length >= limit) break;
      // defensive: an out-of-order or overlapping range would otherwise
      // silently drop or duplicate text out of the user's conversation
      if (at < from || end <= at || end > value.length) continue;
      if (at > from) frag.append(doc.createTextNode(value.slice(from, at)));
      const mark = doc.createElement('mark');
      mark.setAttribute(spec.attr, String(marks.length));
      mark.textContent = value.slice(at, end);
      frag.append(mark);
      marks.push(mark);
      from = end;
    }
    if (from === 0) continue; // nothing usable in this node — leave it alone
    if (from < value.length) frag.append(doc.createTextNode(value.slice(from)));
    node.replaceWith(frag);
  }
  return marks;
}

function ownerDocumentOf(root: ParentNode): Document | null {
  const node = root as Node;
  return node.nodeType === 9 ? (node as Document) : node.ownerDocument;
}
