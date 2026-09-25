// The clean-room bundle (P2-E13-02, §5.15) — the artifact, and DELIBERATELY
// nothing else.
//
// ── THIS MODULE IS DEFINED BY A SUBTRACTION ─────────────────────────────────
//
// §5.15's motivation is one sentence: *the missing context IS the feature.* A
// code review run in a fresh session finds things an in-session review misses,
// because the in-context reviewer inherits the author's framing and reviews the
// INTENT, while a clean session has to rebuild its understanding from the
// artifact. So the property that matters here is not what the bundle contains —
// it is what it cannot contain.
//
// That makes the obvious implementation the wrong one. Reusing #766's context
// package with a "leave the reasoning out" flag would put the withholding inside
// a generator whose entire job is carrying reasoning forward, one boolean away
// from the thing it must never do. This module therefore takes an ARTIFACT as
// its input: a diff, a task statement, and optional acceptance criteria. It is
// a pure function of those three values. It has no transcript, no blocks, no
// package, and no branch that could reach one — `dispatch-context.test.ts`
// asserts that against this file's source text, the way `queries.test.ts`
// asserts transport-freedom, because the value is not that it is true today.
//
// The ONE thing it shares with the package generator is `estimateTokens`, and
// that sharing is deliberate in the same direction: #799 refused a second
// estimator on the grounds that the day `CHARS_PER_TOKEN` moved, two surfaces
// would describe the same text differently. What is forbidden here is the
// package BUILDERS, not the arithmetic.
//
// ── WHY THE TASK STATEMENT IS ONLY THE OPENING PROMPT ───────────────────────
//
// A transcript's later user turns are real prose the user typed, so they would
// pass any "no assistant text" filter — and they are exactly the wrong thing to
// carry. "No, do it the other way", "ignore the lint error for now", "I think
// the bug is in the reducer" are the author's FRAMING, arriving in the author's
// voice. A reviewer handed those reviews the intent again. So the bundle carries
// the opening prompt and stops.
import { GOAL_CHAR_CAP, capText, estimateTokens } from './context-package';
import { cleanSenderName, stripUnsafeControls } from '../../shared/sibling-message';
import type { SessionSummary } from '../../shared/sessions';

/**
 * What the bundle knows about the change under review.
 *
 * Three states rather than a string, because they are three different facts and
 * a reviewer acts differently on each. `SessionDiff` already tells them apart
 * (`isRepo`, an empty `diff`, a refusal) and flattening them into "" here would
 * throw that away at the last step.
 */
export type CleanRoomDiff =
  | { state: 'diff'; text: string; truncated: boolean }
  /** A repository with nothing uncommitted. */
  | { state: 'clean' }
  /** The session's folder is not a git repository at all. */
  | { state: 'not-a-repo' }
  /** Git was asked and could not answer — the reason, as a sentence. */
  | { state: 'unavailable'; why: string };

export interface CleanRoomSource {
  session: SessionSummary;
  diff: CleanRoomDiff;
  /**
   * The conversation's opening prompt (`SessionQueries.taskStatement`).
   *
   * `undefined` means it is not known — a session that has not been asked
   * anything, or a head window that would not read. The document says so; see
   * `TASK_UNKNOWN`.
   */
  taskStatement?: string;
  /**
   * What "done" looks like, SUPPLIED BY THE CALLER.
   *
   * §5.15's table names acceptance criteria beside the diff and the task
   * statement, and this field is optional because **there is no mechanical
   * source for them**. Nothing in a transcript is labelled "acceptance
   * criteria"; the nearest thing an extractor could find is some prose that
   * looks like a list, and printing that under a confident heading is precisely
   * the failure #766's header spends a section refusing ("Decisions" is not
   * mechanical, so it does not ship under that name).
   *
   * So they come from the dispatch gesture (#948) — the user saying what this
   * reviewer is checking for — and when nobody said, the bundle says nobody
   * said. A reviewer that knows the criteria were not stated can ask; one handed
   * an invented list cannot tell that it was invented.
   */
  acceptanceCriteria?: string;
}

export interface CleanRoomBundle {
  session: SessionSummary;
  /** The rendered document, ready to open a session with. */
  text: string;
  /** An order-of-magnitude size, never a count — #766's `estimateTokens`. */
  tokens: number;
  /**
   * There is no artifact to review: no diff, and no task statement either.
   *
   * Reported rather than inferred from length, for `ContextOfferOption.empty`'s
   * reason: the document is never blank (every section renders a sentence), so a
   * caller comparing `text.length` against a threshold would be guessing at what
   * this flag states.
   */
  empty: boolean;
}

/**
 * The acceptance criteria's budget.
 *
 * The task statement is capped at #766's `GOAL_CHAR_CAP` — the SAME constant,
 * because it is the same fact under a different heading, and an opening prompt
 * that the package would trim at 2,000 characters should not arrive here whole.
 * Without a cap the briefing is whatever length somebody's pasted brief was, and
 * #766 spends a paragraph on why a handoff that can outweigh the transcript it
 * summarises defeats the premise. Criteria get a shorter one: they are a
 * checklist, and anything past this is a specification that belongs in the repo.
 */
export const CRITERIA_CHAR_CAP = 2_000;

/**
 * What the document says when the opening prompt is not available.
 *
 * ⚠️ IT CLAIMS ONLY WHAT IS KNOWN. An earlier wording said "no opening prompt
 * was found in this session's transcript", which asserts that a transcript was
 * read — and three different situations land here, only one of which involves a
 * successful read: a session that has not been asked anything, a session with no
 * transcript at all, and a head window that would not open. Saying the one true
 * thing costs nothing.
 */
export const TASK_UNKNOWN = '_Not known — this session\'s opening prompt is not available._';

/** What it says when nobody stated what "done" means. */
export const CRITERIA_UNKNOWN =
  '_None were given with this dispatch. If the change only makes sense against ' +
  'criteria you have not been told, say so rather than assuming them._';

/**
 * The preamble, and it is not decoration.
 *
 * A model handed a document titled "The change" and "What it was asked to do"
 * will assume it is seeing an ordinary handoff and that anything absent is
 * absent by accident. It is not: the reasoning history was withheld ON PURPOSE,
 * and a reader that knows that behaves differently — it rebuilds its
 * understanding from the diff instead of hunting for the context it thinks it is
 * missing. §5.5's honesty rule, stated to the reader that actually consumes it.
 *
 * ⚠️ IT DOES NOT SAY "REVIEW THIS", and the restraint is deliberate. Clean-room
 * is the default for review and is the case §5.15 is written about, but it is a
 * CONTEXT policy, not a role: a user template is free to pair it with any role
 * prompt, and a bundle that told a Doc Writer it was reviewing would be this
 * module overriding the instruction the template actually carries. The role
 * prompt says what to do; this document says what you have been given.
 */
const PREAMBLE = [
  'You have been handed this work **clean-room**: the artifact and nothing else.',
  'The conversation that produced it — the reasoning, the false starts, the design',
  'discussion — has been withheld deliberately, because someone who inherits the',
  'author\'s framing judges the intent rather than the work.',
  '',
  'So: rebuild your understanding from what is below. Where the change only makes',
  'sense if you assume something that is not stated here, that assumption is',
  'itself worth reporting. Your own instructions arrive separately from this',
  'document.',
].join('\n');

/**
 * What the "The change" section says about a diff it does not have.
 *
 * ⚠️ A SENTENCE, NEVER A BLANK — the item's fourth done-when, and the reason is
 * asymmetric: a reviewer told "here is the diff" and handed nothing concludes
 * the change is empty and reviews that. Each state gets its own sentence because
 * each implies a different next move: a clean tree means the work is committed
 * (look at the branch), no repository means there is no diff to be had, and a
 * git that would not answer means try again.
 */
function diffBody(diff: CleanRoomDiff): string {
  switch (diff.state) {
    case 'diff': {
      // FENCED, and the fence is the load-bearing part. A unified diff dropped
      // into markdown has lines beginning `-`, `+` and `#`, which a renderer —
      // and a model reading markdown — will take as list items and headings.
      // `diff` as the info string also tells the reader what dialect it is.
      //
      // ⚠️ AND THE FENCE IS SIZED TO THE CONTENT, which is the whole reason this
      // is not a constant. A three-backtick fence is closed by the first line of
      // the PATCH that contains three backticks — and a patch of this repo
      // touches `docs/manual/*.md`, every design doc and the test fixtures, all
      // of which are full of them. After that line the remainder of the diff is
      // parsed as markdown, so a `+## The change` or `+# Clean-room handoff
      // from @x` sitting in somebody's file FORGES a section of a document whose
      // preamble has just told the reader to trust it. Longest run in the
      // content, plus one, floor of three — CommonMark's own rule for this, and
      // complete: only a backtick fence of equal or greater length closes one,
      // tildes cannot, and the ≤3-space indent allowance affects the CLOSER
      // only, which is why a diff's one-space context lines were the real threat
      // and why +1 defeats them.
      //
      // ⚠️ **IT MUST BE MEASURED ON THE FINAL BYTES.** The first version of this
      // sized the fence here and then ran `stripUnsafeControls` over the
      // assembled document — and that call DELETES characters, so a zero-width
      // space between two two-backtick runs became a four-backtick run AFTER the
      // fence had been sized against text that did not contain one. The forgery
      // came straight back, through the fix for it. Found in review, reproduced.
      // Hence `buildCleanRoomBundle` sanitises its inputs first and this
      // function never sees unstripped text; the general rule is that a
      // structural decision taken on bytes that are about to change is not a
      // decision.
      //
      // `reduce` rather than `Math.max(0, ...runs)`: the spread is an argument
      // list, which has an engine limit, and this function is exported and takes
      // an uncapped `CleanRoomDiff` — `DIFF_CHAR_CAP` bounds the caller, not the
      // contract.
      const longest = [...diff.text.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}diff\n${diff.text}\n${fence}`;
    }
    case 'clean':
      return (
        '_No uncommitted changes. The session\'s folder is a git repository and its ' +
        'working tree is clean, so whatever was done here is already committed — ' +
        'look at the branch rather than at the working tree._'
      );
    case 'not-a-repo':
      return (
        '_No diff: the session\'s folder is not a git repository, so there is no ' +
        'working tree to compare. Review what you are pointed at directly._'
      );
    case 'unavailable':
      return `_The diff could not be read: ${diff.why}_`;
  }
}

/**
 * The diff with its untrusted text cleaned, BEFORE anything is decided about it.
 *
 * `why` is cleaned too: it is a git error message, which carries whatever the
 * subprocess wrote to stderr, and it is interpolated into a sentence.
 */
/**
 * One session field, safe to interpolate into a line of the document.
 *
 * `cleanSenderName` is the house helper for this and it does both halves:
 * `stripUnsafeControls` for the bytes, and flattening to ONE LINE — which is the
 * half a bare strip misses, since `stripUnsafeControls` deliberately keeps
 * newlines and nothing on the rename or folder-pick paths normalises whitespace.
 * A newline in any of these turns one bullet into two lines of free-floating
 * text in a document another model is being asked to trust.
 *
 * Used for all three rather than for the name alone, because "this one is the
 * user's and those two are the system's" is exactly the distinction that stopped
 * being true when a folder became something the user types.
 */
function field(value: string): string {
  return cleanSenderName(value);
}

function strippedDiff(diff: CleanRoomDiff): CleanRoomDiff {
  if (diff.state === 'diff') return { ...diff, text: stripUnsafeControls(diff.text) };
  if (diff.state === 'unavailable') return { ...diff, why: stripUnsafeControls(diff.why) };
  return diff;
}

/**
 * Assemble the bundle. Pure: same artifact in, same document out.
 *
 * Every section is rendered even when it is empty, for `emptySection`'s reason —
 * an absent heading is an ambiguity the reader resolves by guessing, and a
 * stated "not known" is a fact it can act on.
 *
 * ── WHAT IS STRUCTURALLY TRUSTWORTHY HERE, AND WHAT IS NOT ──────────────────
 *
 * The DIFF is the untrusted input — it is the contents of arbitrary files in a
 * repository, which is where a forged heading would come from if it came from
 * anywhere — and it is fenced, with the fence sized to the final bytes.
 *
 * The task statement and the acceptance criteria are interpolated as markdown,
 * raw, and **could** forge a heading. That is a stated limitation rather than an
 * oversight: both are the USER'S OWN TEXT — their opening prompt and what they
 * typed into the dispatch gesture — so the attacker and the victim are the same
 * person, and the alternatives (blockquoting a 2,000-character brief, escaping
 * every `#`) cost the reader real legibility to defend against nobody. If either
 * ever comes to carry text from somewhere else, this stops being true.
 */
export function buildCleanRoomBundle(src: CleanRoomSource): CleanRoomBundle {
  // ── SANITISE FIRST, THEN BUILD, AND THE ORDER IS THE WHOLE POINT ──────────
  //
  // `stripUnsafeControls` DELETES characters, so running it over the finished
  // document invalidates every structural decision taken while assembling one.
  // That is not theoretical: the first version of this sized the diff's code
  // fence against the raw patch and stripped afterwards, and a zero-width space
  // sitting between two two-backtick runs became a FOUR-backtick run after the
  // strip — long enough to close a fence sized for a document that did not
  // contain one, handing the forgery straight back through the fix for it.
  // Found in review, reproduced.
  //
  // So every untrusted input is cleaned at the door and the assembled document
  // is never touched again. That also makes the token estimate honest by
  // construction rather than by remembering to order two lines correctly.
  const diff = strippedDiff(src.diff);
  // CAPPED, with `capText`'s in-band `…[truncated]` marker rather than a silent
  // slice — the same helper and the same convention the package uses, so a
  // reader that has learned what that marker means anywhere in this app has
  // learned it here. Both inputs are unbounded otherwise: the task statement is
  // whatever a user pasted into their opening prompt, and the criteria arrive
  // from #948's editor.
  //
  // CAPPED AFTER STRIPPING, so the cap counts characters the reader will
  // actually receive.
  const task = capText(stripUnsafeControls(src.taskStatement ?? '').trim(), GOAL_CHAR_CAP);
  const criteria = capText(
    stripUnsafeControls(src.acceptanceCriteria ?? '').trim(),
    CRITERIA_CHAR_CAP
  );
  const lines: string[] = [];
  // `cleanSenderName` for #799's reason: a card title is the user's and nothing
  // on the rename paths normalises whitespace, so a newline in one would break
  // the heading of a document another model is asked to trust. It also turns a
  // blank title into `(unnamed)` rather than leaving a bare `@`.
  lines.push(`# Clean-room handoff from @${field(src.session.name)}`);
  lines.push('');
  lines.push(PREAMBLE);
  lines.push('');
  // ⚠️ EVERY SESSION FIELD GOES THROUGH `field`, and the reason is the mistake
  // this replaced. Round 2 dropped a `stripUnsafeControls` over the ASSEMBLED
  // document — correctly, because it invalidated the fence — and that strip had
  // been silently cleaning these three all along. So `name` appeared twice in
  // one document with two different treatments: cleaned in the heading, raw
  // here. Measured in review: a card title of `Trading<ESC>[31mApp\nNOT-A-
  // HEADING` put an escape sequence into the document and split the metadata
  // bullet into a free-floating line — the exact header-breaking failure
  // `cleanSenderName` exists for, one line below where it is used. `folder` is
  // reachable too: a POSIX filename accepts every byte but `/` and NUL.
  lines.push(`- **Author session:** ${field(src.session.name)} (${field(src.session.providerId)})`);
  lines.push(`- **Folder:** ${field(src.session.folder)}`);
  lines.push('');
  lines.push('## What it was asked to do');
  lines.push('');
  lines.push(task.text === '' ? TASK_UNKNOWN : task.text);
  lines.push('');
  lines.push('## What "done" means');
  lines.push('');
  lines.push(criteria.text === '' ? CRITERIA_UNKNOWN : criteria.text);
  lines.push('');
  lines.push('## The change');
  lines.push('');
  lines.push(diffBody(diff));
  if (diff.state === 'diff' && diff.truncated) {
    lines.push('');
    // SAID OUTSIDE THE FENCE as well as inside it. `sessionDiff` appends its own
    // `… [diff truncated]` marker to the patch text, but that line sits among
    // thousands of others and reads like part of the diff; a reviewer that
    // reports "nothing wrong in the rest of the file" needs to know there is a
    // rest it never saw.
    lines.push(
      '⚠️ _The diff above is incomplete — it was cut at a size limit. Findings about ' +
        'what is missing from it are not safe to make._'
    );
  }
  // A trailing newline, so appending this to a composer's draft never joins the
  // last line of the bundle to whatever is typed next.
  //
  // NOT STRIPPED HERE — the inputs already were, at the top. Everything joined
  // below is either one of those or a literal from this file. See the note
  // there for why a late strip is what broke the fence.
  const text = lines.join('\n') + '\n';
  return {
    session: src.session,
    text,
    tokens: estimateTokens(text),
    // Both halves absent. A bundle with a task statement and no diff is not
    // empty — "here is what it was asked to do and it has changed nothing" is a
    // real and reviewable state.
    //
    // ⚠️ `unavailable` IS NOT EMPTY, and lumping it in with the other two was a
    // real defect (found in review). "Git would not answer" and "there is
    // nothing to show" are opposite claims: the document says the diff could not
    // be read while the object would have said there was nothing to hand over,
    // and `empty` is exactly the flag a caller reaches for to suppress or warn.
    // A transient git failure would have become silence.
    empty: task.text === '' && (diff.state === 'clean' || diff.state === 'not-a-repo'),
  };
}
