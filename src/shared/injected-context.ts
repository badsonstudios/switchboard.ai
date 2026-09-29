// The envelope around context this app injected into a sent prompt (#830).
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
//
// When a draft's `@Name` mentions are resolved at send, the mentioned session's
// recent output is injected AHEAD of the prompt text. The Feed then shows the
// whole thing as one `kind: 'user'` block, because that is honestly what was
// sent — but it is long, and the user's actual question sits underneath up to
// 40,000 characters of somebody else's transcript. #830 asks for the injected
// part to render as a collapsed "Context from <Session>" row, the way a tool
// call does, with the user's own prose expanded below it.
//
// ── WHY THAT IS NOT A RENDERER CHANGE: FORGERY ─────────────────────────────
//
// A user can type these markers themselves, and a transcript pasted into the
// composer can contain them. So "anything that looks like the envelope" cannot
// be trusted to be ours — collapsing on shape alone would let any text hide
// itself behind a row labelled with a session name of its choosing, which is a
// worse bug than the length it set out to fix.
//
// THE PRECEDENT IS `sibling-message.ts` (#765) and this follows it deliberately:
// a random `ref` minted by MAIN per section, carried by the opening marker and
// repeated by the matching closing one. Only a section whose ref this app
// actually minted collapses (`main/feed/context-refs.ts` is the register);
// everything else renders as the plain text it is.
//
// ⚠️ **WHAT THE REF ACTUALLY BUYS, stated precisely, because the #765 sentence
// does not transfer.** There, the ref is withheld from the SENDER. Here it
// cannot be: the marker is in the prompt, so the receiving agent reads it. What
// the ref stops is *guessing* — a user typing a fence, or a transcript pasted
// into the composer, cannot produce eight hex characters this app minted for
// this session. What it does NOT stop on its own is the one party that has seen
// one, which is why `defuseContextMarkers` exists below: any text that arrives
// from somewhere else has its marker LINES broken on the way in, so a model that
// read a live ref still cannot get a section wearing it back into a user turn.
// Two halves of one guard — the ref against guessing, the defusing against
// replay — and neither is a cryptographic guarantee.
//
// ⚠️ **KNOWN LIMIT, STATED RATHER THAN HIDDEN: the register is in memory, and
// keyed by the LIVE session id.** So folding lasts for the current run of the
// session and no longer — an app restart, or a resume (which churns the live
// id), re-derives that history under refs nothing minted, and those turns render
// EXPANDED: the full text, exactly as it was sent, which is today's behaviour
// and the fail-closed direction. Persisting the register would mean writing the
// secret half of a forgery guard to a file the very agents it guards against can
// read, so "survives a restart" and "cannot be forged" were never available at
// the same time. The guard is what matters; a fold state is not.

import { neutraliseAtMentions, atEscapeNote } from './at-mentions';
import { cleanSenderName } from './sibling-message';

/** How long a minted ref is, in hex characters — `markerRef`'s length, for `markerRef`'s reason. */
export const CONTEXT_REF_LENGTH = 8;

/**
 * A name fit to sit inside the marker, whatever the card is called.
 *
 * THREE THINGS HAPPEN TO IT, and each one closes a hole review found:
 *
 *  - `cleanSenderName` flattens whitespace and strips controls. The marker is
 *    a LINE, matched anchored at both ends — a title carrying a newline would
 *    split it in two, the parse would match neither half, and the fold would
 *    silently stop working while arbitrary attacker-chosen lines sat in the
 *    prompt. `renderPackage` applies it to its own heading for the same reason.
 *  - Quotes become apostrophes. The marker delimits the name with `"`, so a
 *    title containing one would end the field early and the parse would read a
 *    different name than the one we wrote.
 *  - `@`-words are escaped, which `cleanSenderName` now does for every caller
 *    that puts a name in a prompt (#832 review). The name is a card TITLE, and
 *    titles here are often auto-labelled from the user's own first prompt —
 *    "Bump @types/node" is a realistic one. Un-escaped, our own marker line
 *    would be the very file mention #832 exists to stop, in the sentence
 *    announcing that we stopped it.
 *
 * IDEMPOTENT, which `findContextSections` relies on: it rebuilds the expected
 * closing marker from the name it PARSED out of the opening one, so
 * `markerName(markerName(x))` has to equal `markerName(x)`.
 */
export function markerName(name: string): string {
  return cleanSenderName(name).replace(/"/g, "'");
}

/** The line that opens an injected section. */
export function contextOpenMarker(ref: string, name: string, sessionId: string): string {
  return (
    `[Context ${ref} from another switchboard session, "${markerName(name)}" ` +
    `(session id ${sessionId}). It ends at the matching "End of context ${ref}" line.]`
  );
}

/** The line that closes it — carries the ref, which is what makes it matchable. */
export function contextCloseMarker(ref: string, name: string): string {
  return `[End of context ${ref} from "${markerName(name)}".]`;
}

/**
 * Break any marker LINE inside text that came from somewhere else.
 *
 * ── THE REPLAY HALF OF THE GUARD ───────────────────────────────────────────
 *
 * The ref stops a marker being GUESSED. It cannot stop one being COPIED,
 * because the marker sits in the prompt and the receiving agent reads it — so
 * an agent that has seen a live ref could otherwise put a section wearing it
 * back into a user turn (a `send_to_session` to its own card is enough), and
 * fold away words the user pressed Enter on.
 *
 * So: text arriving from anywhere else may not wear our markers. A space after
 * the bracket is enough — the pattern is anchored and matches the sentence
 * exactly — and it is VISIBLE, the same rule the `@` escape follows: what the
 * user reviews must be what the agent reads.
 *
 * Idempotent: a defused line no longer matches, so a second pass changes
 * nothing. Line-anchored, so a marker QUOTED mid-sentence is left alone — it
 * was never a marker.
 */
const MARKER_LINE_OPEN = /^\[(Context |End of context )/gm;

export function defuseContextMarkers(text: string): string {
  return text.replace(MARKER_LINE_OPEN, '[ $1');
}

/** Everything one injected section needs to be built. */
export interface InjectedContext {
  /** the rendered block — `renderOutput`'s text, fence and all */
  body: string;
  /** the mentioned session's name, as the row will label it */
  name: string;
  /** the mentioned session's id, for the reader that wants to address it */
  sessionId: string;
  /** the ref main minted for this send, or `undefined` to send an un-marked block */
  ref?: string;
}

/**
 * One injected section, defused and (when there is a ref) enveloped.
 *
 * THE TWO HALVES OF THIS ITEM MEET HERE, and that is why they were done
 * together: #832's escape and #830's envelope both wrap the same text on the
 * same path, and building the marker twice would have been the way they drifted.
 *
 * An absent `ref` is a wiring without the register — the unit tests, and any
 * future caller that has no Feed to collapse in. It degrades to today's shape:
 * escaped text with its note, no envelope, nothing to collapse.
 */
export function wrapInjectedContext({ body, name, sessionId, ref }: InjectedContext): string {
  const safe = neutraliseAtMentions(defuseContextMarkers(body));
  const note = atEscapeNote(safe.count);
  const inner = note === '' ? safe.text : `${note}\n\n${safe.text}`;
  if (ref === undefined) return inner;
  return [contextOpenMarker(ref, name, sessionId), inner, contextCloseMarker(ref, name)].join('\n');
}

/** Where one injected section sits inside a user turn's text. */
export interface ContextSection {
  ref: string;
  /** the label the collapsed row shows — the source session's name */
  name: string;
  /** index of the first character of the opening marker, in `text` */
  start: number;
  /** index one past the last character of the closing marker, in `text` */
  end: number;
}

/**
 * The opening marker, as a pattern.
 *
 * ANCHORED TO A LINE at both ends (`m`), because a marker quoted mid-sentence is
 * someone TALKING about one — the same rule, and the same reasoning, as
 * `injected.ts`'s `looksInjected`. The backreference is what makes the sentence
 * self-consistent: a line naming two different refs never opens a section.
 */
const OPEN_MARKER = new RegExp(
  // Exactly the minted length. `+` would have been an unbounded run to
  // backtrack over at every line start, for a value that is never any other
  // size — and one more thing a forgery has to get right.
  `^\\[Context ([0-9a-f]{${CONTEXT_REF_LENGTH}}) from another switchboard session, ` +
    `"([^"]*)" \\(session id ([^)]*)\\)\\. It ends at the matching ` +
    `"End of context \\1" line\\.\\]$`,
  'gm'
);

/**
 * Find the injected sections in a sent user turn — and ONLY the real ones.
 *
 * `isMinted` is the forgery guard and it is not optional: a caller with no
 * register passes a predicate that says no, and nothing collapses. That is the
 * fail-closed default every consumer of this function gets for free
 * (`deriveIntents` builds no sections at all unless it is handed one).
 *
 * Tolerant by construction, like everything else that reads text we did not
 * write: an opening marker with no matching close is not a section, overlapping
 * claims resolve by scanning forward past the one already taken, and nothing
 * here throws.
 */
export function findContextSections(
  text: string,
  isMinted: (ref: string) => boolean
): ContextSection[] {
  const out: ContextSection[] = [];
  // Fresh per call: a module-level `g` regex carries `lastIndex` between calls,
  // which is the classic way a second invocation silently skips the first match.
  const open = new RegExp(OPEN_MARKER.source, OPEN_MARKER.flags);
  let m: RegExpExecArray | null;
  let scanFrom = 0;
  while ((m = open.exec(text)) !== null) {
    const start = m.index;
    // A section already claimed this stretch — keep looking after it, never
    // inside it. (`exec` cannot be told to skip, so this is the test.)
    if (start < scanFrom) continue;
    const [, ref, name] = m;
    if (ref === undefined || name === undefined || !isMinted(ref)) continue;
    const close = `\n${contextCloseMarker(ref, name)}`;
    // ITS OWN LINE AT BOTH ENDS, like the opening marker: a close marker with
    // text after it on the same line is part of a sentence, and swallowing that
    // sentence into the folded range would hide words nobody marked.
    let at = text.indexOf(close, start + m[0].length);
    while (at >= 0 && !endsLine(text, at + close.length)) {
      at = text.indexOf(close, at + 1);
    }
    if (at < 0) continue;
    const end = at + close.length;
    out.push({ ref, name, start, end });
    scanFrom = end;
    open.lastIndex = end;
  }
  return out;
}

/** Is `at` the end of the string or the end of a line? */
function endsLine(text: string, at: number): boolean {
  return at >= text.length || text[at] === '\n' || text[at] === '\r';
}

/** Said inside a section the Feed's own budget had to shorten. */
export const SECTION_CUT_NOTE = '[… the rest of this context is not shown here …]';

/** A user turn cut to fit a Feed block, with its sections still foldable. */
export interface FittedTurn {
  text: string;
  sections: ContextSection[];
}

/**
 * Fit a turn carrying injected context into a Feed block's text budget —
 * SPENDING IT ON THE USER'S OWN WORDS FIRST.
 *
 * ⚠️ **WITHOUT THIS, #830 DOES NOTHING IN THE CASE IT WAS BUILT FOR, and review
 * caught it.** `queries.ts` caps one session's output at 20,000 characters and
 * `blocks.ts` caps a block's text at 20,000 — so a mention of a BUSY session, the
 * exact case the issue opens with, produced a turn just over the block cap. The
 * plain `slice` then cut the closing marker off, `findContextSections` correctly
 * refused a section with no close, and the result was one unfoldable 20,000-
 * character pill **with the user's question truncated off the end**. Fail-safe,
 * and useless.
 *
 * The order is the whole fix: the prose is what the user typed and it is short,
 * so it is kept whole; what is left is shared between the sections; a section
 * that does not fit its share keeps its markers and loses the middle of its
 * body, and SAYS SO in-band. The Feed is a view, not an archive — the transcript
 * still holds every byte, and a find searches the uncapped text.
 *
 * Shares are equal and are not redistributed, deliberately: `n` is almost always
 * 1, and a bin-packing pass here would be cleverness nobody can check.
 *
 * DEGRADES TO A PLAIN SLICE when even the prose does not fit, which is a
 * genuinely enormous typed message rather than an injected one. There is no
 * budget to fold anything into at that point, and a section rebuilt from nothing
 * would be a row promising content the block does not hold.
 */
export function fitContextSections(
  text: string,
  sections: readonly ContextSection[],
  cap: number
): FittedTurn {
  if (text.length <= cap) return { text, sections: [...sections] };
  const plain = { text: text.slice(0, cap), sections: [] };
  if (sections.length === 0) return plain;
  const proseLength = sections.reduce((n, s) => n - (s.end - s.start), text.length);
  const share = Math.floor((cap - proseLength) / sections.length);
  // A cut section still has to BE one: its opening marker whole (it is the line
  // the ref and the name live on), a line saying it was cut, and its closing
  // marker. Below that there is nothing worth folding, and a half-written marker
  // on screen would be worse than the honest slice.
  const needed = sections.reduce((n, s) => Math.max(n, minimumSection(text, s)), 0);
  if (proseLength >= cap || share < needed) return plain;
  const parts: string[] = [];
  const fitted: ContextSection[] = [];
  let at = 0;
  let out = 0;
  for (const s of sections) {
    const lead = text.slice(at, s.start);
    parts.push(lead);
    out += lead.length;
    const span = text.slice(s.start, s.end);
    const start = out;
    const kept = span.length <= share ? span : cutSection(span, s, share);
    parts.push(kept);
    out += kept.length;
    fitted.push({ ...s, start, end: out });
    at = s.end;
  }
  parts.push(text.slice(at));
  return { text: parts.join(''), sections: fitted };
}

/**
 * One section's span, shortened to `share`, still closed by its own marker.
 *
 * The closing marker is rebuilt rather than sliced out of the span, because the
 * parse that produced `ref` and `name` is the thing that says what the close
 * line must be — reading it back off the text would be trusting the text again.
 */
function cutSection(span: string, s: ContextSection, share: number): string {
  const head = openLineLength(span);
  return span.slice(0, Math.max(head, share - cutTail(s).length)) + cutTail(s);
}

/** The smallest this section can be cut to and still read as one. */
function minimumSection(text: string, s: ContextSection): number {
  return openLineLength(text.slice(s.start, s.end)) + cutTail(s).length;
}

function cutTail(s: ContextSection): string {
  return `\n${SECTION_CUT_NOTE}\n${contextCloseMarker(s.ref, s.name)}`;
}

/** How much of a span the opening marker's line takes — never cut inside it. */
function openLineLength(span: string): number {
  const nl = span.indexOf('\n');
  return nl < 0 ? span.length : nl;
}
