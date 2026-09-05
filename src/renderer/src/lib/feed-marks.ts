// The Session view's find marks (#520, §5.31).
//
// THE BUG THIS EXISTS FOR, in the owner's words: "stepping through matches
// scrolls the session up and down, but I just don't see where the word is that
// I'm searching for." Jumping revealed the block, forced open whatever
// verbosity or folding covered it, and scrolled it under the top of the
// viewport — and stopped. The Terminal group had real decorations from the
// search addon (#516) all along, which made the feed's bareness read as broken
// rather than as bounded.
//
// So the feed marks the term, in the SAME idiom as the document viewer
// (`document-find.ts`): a `<mark>` around the occurrence, an attribute in the
// surface's own namespace, a second attribute on the current one, and one CSS
// pair per state in `tokens.css`. The walk itself is shared (`text-marks.ts`).
// What is specific to the feed is here, and it is two things — which text nodes
// may be split, and how the term matches.
//
// ── 1. WHICH TEXT NODES, AND WHY IT IS NOT "ALL OF THEM" ────────────────────
//
// The viewer's content is one `dangerouslySetInnerHTML` blob: React holds no
// reference to a single node inside it, so the viewer can split anything. The
// feed is JSX, and React DOES hold references to text nodes it created as
// separate children. Splitting one of those detaches React's reference, and the
// next update either writes to a node that is no longer on the page (a lost
// update, silently) or removes it (`removeChild` on a detached node — a thrown
// exception in the middle of a streaming conversation). Neither is worth a
// highlight.
//
// Two shapes are safe, and between them they cover every place feed text
// actually lives:
//
//   • an element whose ONLY child is this text node. React renders a lone
//     string child as the `children` PROP and sets it with `textContent` — it
//     creates no child fiber and keeps no node reference, so a re-render
//     overwrites our marks wholesale instead of colliding with them. That is
//     every `<pre>{text}</pre>` and `<div>{b.text}</div>` in
//     `extensibility/feed-blocks.tsx`.
//   • anything BELOW `.feed-md` — rendered markdown, set with
//     `dangerouslySetInnerHTML`, which React does not own child-wise at all.
//
// "Below", not "inside", and the difference USED TO BE a crash. `<Markdown>`
// had a SECOND branch: while text was still arriving it rendered the raw string
// plus a caret — `<div class="feed-md">{text}<span>▌</span></div>` — which is
// real JSX with a tracked text node, in a container wearing the same class.
// Splitting that one detached the node React wrote every token to (the reply
// froze mid-sentence) and then removed when the stream completed and the branch
// flipped to HTML (`removeChild` on a detached node — a thrown exception in a
// live conversation).
//
// #635 DELETED THAT BRANCH. A streaming block is now the same
// `dangerouslySetInnerHTML` as a finished one, updated about once a frame, and
// the caret is a CSS `::after` rather than an element — so there is no
// React-owned text node in a `.feed-md` container any more, and no glyph in the
// DOM for a search to count either.
//
// THE RULE STAYS, and it is now a boundary rather than live coverage — said
// plainly so the next reader does not mistake a passing test for a hazard that
// still exists. Rendered markdown always wraps its text in a block element, so
// "the parent IS the container" describes nothing markdown emits; what it costs
// is one `closest` call, and what it buys is that re-introducing JSX text into a
// markdown container cannot silently re-open the crash. The test that pins it
// builds the old shape BY HAND for exactly that reason.
//
// What that leaves unmarked is text composed of SEVERAL React children in one
// element — an expander's `{icon} {label}` line, for instance. A missing mark
// there is a boundary; a crash in a live session is not.
//
// ── 2. HOW THE TERM MATCHES ─────────────────────────────────────────────────
//
// The same two toggles the bar ships, built from the SAME two clauses the
// engine builds its regex from (`shared/find-matching.ts`, imported by
// `main/transcripts/search.ts` too). The marks and the count must agree about
// what a match IS — a bar reading "3" over two marks is a worse answer than no
// marks — and "agree" is a shared module rather than two comments asking to be
// kept in step.
//
// What the marks CANNOT see is the difference between the engine's text and the
// screen's: the engine reads the transcript file and counts matches in fields
// the view may render differently or not at all. The count is the honest number
// and the marks are a decoration over the part that is on screen — which is why
// a block with no visible occurrence still falls back to the first mark rather
// than claiming there is nothing to point at.
//
// ── WHAT MARKS ARE NOT ──────────────────────────────────────────────────────
//
//   • not a tab stop and not focusable — the #174 arrow-key walk collects
//     `[data-feed-expander]` and `[data-feed-copy]` by name, and a `<mark>` is
//     neither;
//   • not text. `#477`'s copy path reads `pre.textContent`, and an element
//     wrapped around text contributes nothing to `textContent` — so a mark
//     inside a code fence cannot change what lands on the clipboard, and the
//     same holds for a plain selection copy;
//   • not forgeable. `data-feed-match*` is inside `FEED_DECORATION`'s
//     `data-feed` prefix, so `decorateFeedMarkdown`'s guard-first pass takes it
//     back off assistant prose before anything of ours is written (#465/#500).
import type { FindQuery } from '../extensibility/contributions';
import { escapeLiteral, wholeWordBody } from '../../../shared/find-matching';
import { FEED_COPY_ATTR } from './feed-keys';
import { FEED_SEQ_ATTR } from './feed-reveal';
import { unwrapMarks, wrapMatches } from './text-marks';

/** The attribute a marked occurrence carries — the feed's own namespace. */
export const FEED_MATCH_ATTR = 'data-feed-match';
/** ...and the one that says which of them find is sitting on. */
export const FEED_MATCH_CURRENT_ATTR = 'data-feed-match-current';

/**
 * The ceiling on one pass. A one-character term over a long conversation is
 * tens of thousands of wraps on the layout path; the mark that matters is the
 * current one, and it is found long before this. Fail-open: a partial paint
 * beats a frozen window.
 */
const MARK_LIMIT = 2000;

/**
 * The matcher, or null when there is nothing to look for.
 *
 * The term is always a LITERAL — the bar ships no regex mode (§5.31), so `.`
 * and friends are the characters the user typed.
 */
export function feedMarkMatcher(query: FindQuery | null): RegExp | null {
  const term = typeof query?.term === 'string' ? query.term : '';
  if (term === '') return null;
  const body = query?.wholeWord ? wholeWordBody(escapeLiteral(term)) : escapeLiteral(term);
  try {
    return new RegExp(body, query?.caseSensitive ? 'g' : 'gi');
  } catch {
    // unreachable with an escaped literal; a mark is never worth a throw on the
    // layout path
    return null;
  }
}

/** Are these the same question? Used to keep a re-jump from re-marking. */
export function sameFindQuery(a: FindQuery | null, b: FindQuery | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.term === b.term && !!a.caseSensitive === !!b.caseSensitive && !!a.wholeWord === !!b.wholeWord;
}

/** Drop every mark this module wrote — the feed as find found it. */
export function clearFeedMarks(root: ParentNode): void {
  unwrapMarks(root, FEED_MATCH_ATTR);
}

/**
 * Mark `query` everywhere it occurs in the feed's blocks, and return the mark
 * find is sitting on.
 *
 * `currentBlock` is the block the jump landed in. Its FIRST occurrence is the
 * current mark — per-hit resolution is #496, and until it lands a hit names a
 * block rather than an offset, so claiming a particular occurrence further down
 * a long tool output would be a guess dressed as a fact. With no landed block
 * (or no match inside it) the first mark in the feed is current, so the bar's
 * position always has something on screen answering to it.
 *
 * Scoped to `[data-feed-seq]` blocks rather than the whole scroller: the feed's
 * own chrome (the cleared marker, the empty state, the off-tail button) is not
 * conversation, and marking our own words would be the surface matching itself.
 *
 * The attribute VALUE is a per-block ordinal, not a feed-wide one — the wrap is
 * done a block at a time. Nothing reads it today; #496 (per-hit resolution) is
 * the item that will want an index, and it will want it feed-wide.
 */
export function markFeedMatches(
  root: ParentNode,
  query: FindQuery | null,
  currentBlock: Element | null,
): HTMLElement | null {
  clearFeedMarks(root);
  const re = feedMarkMatcher(query);
  if (!re) return null;

  const marks: HTMLElement[] = [];
  for (const block of root.querySelectorAll(`[${FEED_SEQ_ATTR}]`)) {
    if (marks.length >= MARK_LIMIT) break;
    marks.push(
      ...wrapMatches(block, {
        attr: FEED_MATCH_ATTR,
        accept: acceptsMark,
        limit: MARK_LIMIT - marks.length,
        ranges: (text) => rangesOf(re, text),
      }),
    );
  }
  return setCurrentMark(marks, currentBlock);
}

/**
 * Move the current mark WITHOUT re-walking — the step case.
 *
 * Enter and Shift+Enter change which match find is on and nothing else, so
 * re-wrapping the whole buffer on every press is a tree walk per keystroke on
 * the layout path. This is the same choice of current mark over the marks
 * already on the page. Returns null when there are none, which is the caller's
 * signal that a full pass is needed after all (a block that was hidden when the
 * last pass ran has no marks in it yet).
 */
export function moveCurrentMark(root: ParentNode, currentBlock: Element | null): HTMLElement | null {
  const marks = [...root.querySelectorAll<HTMLElement>(`mark[${FEED_MATCH_ATTR}]`)];
  if (currentBlock && !marks.some((m) => currentBlock.contains(m))) return null;
  for (const m of marks) m.removeAttribute(FEED_MATCH_CURRENT_ATTR);
  return setCurrentMark(marks, currentBlock);
}

function setCurrentMark(marks: HTMLElement[], currentBlock: Element | null): HTMLElement | null {
  if (marks.length === 0) return null;
  const current = (currentBlock && marks.find((m) => currentBlock.contains(m))) || marks[0];
  current.setAttribute(FEED_MATCH_CURRENT_ATTR, '');
  return current;
}

/** Every match in one text node, as offset pairs. */
function rangesOf(re: RegExp, text: string): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A zero-length match cannot happen with an escaped non-empty literal, but
    // it would spin `exec` forever if it did.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * Chrome the feed INJECTS into a block — a code fence's language label and its
 * Copy button (#477).
 *
 * `[data-feed-seq]` scopes the pass to conversation and not to the app's own
 * furniture, and this is the same rule one level down: the fence header lives
 * INSIDE the block, so without it a search for `sh`, `json` or `copy` paints
 * marks on words the session never said. Three things go wrong at once — the
 * count (which comes from the transcript, where this chrome does not exist)
 * stops matching what is on screen; the current mark can land on the label
 * ABOVE the fence rather than on the match inside it, taking the scroll with
 * it; and `runCopy` restores `button.textContent` after its flash, silently
 * eating a mark it had wrapped.
 */
const FEED_CHROME_SELECTOR = `.feed-code-head, [${FEED_COPY_ATTR}]`;

/** The React-ownership rule — see this file's header, section 1. */
function acceptsMark(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest(FEED_CHROME_SELECTOR)) return false;
  if (parent.childNodes.length === 1) return true;
  const md = parent.closest('.feed-md');
  // `md !== parent`: a text node sitting DIRECTLY in the markdown container
  // alongside a sibling is JSX, not rendered markdown — see the header. #635
  // removed the branch that produced one, so this now describes a shape nothing
  // emits; it is kept as the boundary, not as live coverage.
  return !!md && md !== parent;
}
