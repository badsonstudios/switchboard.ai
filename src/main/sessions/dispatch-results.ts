// The round-trip (P2-E13-05, §5.15) — a dispatched session's result, coming
// back to the author. **Phase 2's exit criterion 5.**
//
// §5.15's sentence is: *"Dispatched session's result returns as a Feed event on
// the parent ('Review of @X complete — 3 findings') with one-click 'inject
// findings into author session' (normal sibling-message delivery, §5.4 policy
// applies)."* Three things in that sentence are decisions this module makes, and
// one of them the sentence gets wrong.
//
// ── 1. WHAT "THE RESULT" IS. MEASURED, NOT DESIGNED ─────────────────────────
//
// A dispatched session ends with a transcript, not a structured object. The
// issue lists three candidate extractions and warns: do not design the delimiter
// first and hope the model honours it. So `spike/probes/950/` drove the real
// dispatch prompt through the PATH CLI four times
// (`spike/findings/e13-950-review-last-turn.md`):
//
//   * **the last assistant turn is the findings, 4/4** — including the run whose
//     `ExitPlanMode` was refused at 60.4 s, which is the case that could have
//     broken this. #948 reported a denial "costs the findings nothing", but it
//     measured a TOTAL over every assistant frame; a shape of *review → ask to
//     exit → refused → "understood, I'll stop"* would have produced the same
//     total and made this surface deliver an apology to the author. The model
//     answers a refusal by reporting anyway, in the same turn;
//   * **it is the LAST turn, not all of them.** Every run opened with 63–94
//     characters of throat-clearing ("The working tree matches the diff. Here's
//     the review.") before a tool call. Joining every turn would put that at the
//     top of the author's composer;
//   * and the last turn was **byte-identical to the `result` frame's own
//     `result` string** in all four runs — so this extraction agrees with the
//     CLI's own answer to "what came of this", which is a cross-check rather
//     than a reason to plumb that frame (`stream-feed.ts` reads no text off it,
//     and a second source for one fact is the drift #947 refused).
//
// ── 2. THE EVENT COUNTS NOTHING, AND §5.15's EXAMPLE IS WHY IT CANNOT ───────
//
// See `DispatchResultDto.headline` in `shared/dispatch-result.ts`: four runs
// enumerated four different ways, and the one self-reported count that existed
// pointed at the wrong thing. The row shows the first line the reviewer wrote.
//
// ── 3. IN MEMORY, AND KEYED BY LIVE SESSION ─────────────────────────────────
//
// Like `SiblingDelivery`'s own loop-breaker, and for the same reason stated from
// the other end: a restart ends both sessions, so there is no outstanding
// round-trip for a restart to lose — only a pair that are no longer running.
// Persisting it would put another session's review text into `workspace.json`,
// which is the objection `dispatch-ipc.ts` already makes about the briefing
// going the other way.
//
// **Everything here is fail-open (P4/P6).** A harvest that throws must not cost
// the reviewer its `done`, and an inject that refuses says why. Nothing in this
// module can stop a session.
import type { Logger } from '../log/logger';
import type { FeedBlock } from '../feed/blocks';
import {
  HEADLINE_CHAR_CAP,
  REPORT_CHAR_CAP,
  type DispatchInjectResult,
  type DispatchOutcome,
  type DispatchResultDto,
} from '../../shared/dispatch-result';
import { capText, TRUNCATION_MARKER_LEN } from './context-package';
import { stripUnsafeControls } from '../../shared/sibling-message';
import type { QueryResult } from './queries';
import type { DeliveryReceipt } from './delivery';

/**
 * How many finished dispatches may be held at once.
 *
 * `MAX_PENDING_DISPATCHES`'s reasoning one step later in the same story: a
 * report is a whole review, and nothing bounds how many sessions a user
 * dispatches. Oldest out first — the newest is the one still on screen.
 */
export const MAX_HELD_RESULTS = 32;

/** The author a dispatched session owes its result to. */
interface DispatchLink {
  /** the AUTHOR's live session id — where the event lands, and the inject's target */
  author: string;
  /**
   * The dispatched card's title, captured at dispatch.
   *
   * CAPTURED rather than looked up when the result lands, because the row has to
   * be able to name a session that may by then have been closed — and because
   * looking it up would make the row's sentence depend on whether the user has
   * renamed the card since, which is a different fact from "who reviewed this".
   */
  reviewerName: string;
  /** `RoleTemplate.name`, for the row's sentence */
  templateName: string;
  at: number;
}

/** A finished dispatch, with the report main is holding for it. */
interface HeldResult {
  dto: DispatchResultDto;
  author: string;
  /** the report, already capped. `''` when there is nothing to inject. */
  text: string;
  at: number;
}

export interface DispatchResultsDeps {
  /**
   * The reviewer's Feed blocks — `StreamFeed.blocks`.
   *
   * THE SAME BLOCKS THE USER IS LOOKING AT, which is the property worth having:
   * what gets injected is what is on the reviewer's card, so a user who reads
   * the review and then clicks Inject gets the thing they read. Reading the
   * transcript instead would be a second derivation of one conversation.
   *
   * Safe to assume present: #948 refuses a dispatch whose spawn transport is not
   * `stream`, and the stream transport is what builds a `StreamFeed`.
   */
  blocks: (sessionId: string) => readonly FeedBlock[];
  /**
   * `EventFeed.dispatchResult` — raise the row on the AUTHOR's session.
   *
   * ALSO HOW THE ROW IS UPDATED. `dispatchResult` replaces any existing row for
   * the same reviewer, so "the report has been delivered" is this same call with
   * a `delivered` outcome rather than a second dep — and it has to go through the
   * FEED rather than through the component, because a button whose used-state
   * lived in one `useState` would still be armed in a popped-out Events window
   * showing the same list.
   */
  raise: (authorSessionId: string, dispatch: DispatchResultDto) => void;
  /**
   * `SiblingDelivery.send`, bound.
   *
   * ⚠️ ORDINARY SIBLING DELIVERY, NOT A PATH OF OUR OWN — the done-when says the
   * inject *"lands in the author's composer as an attributed block and does not
   * submit (the toggle from #765 still governs)"*, and every clause of that is
   * something `delivery.ts` already does: the hold/submit split, the auto-accept
   * toggle, the loop breaker, and the forgery-proof `[Message <ref> …]` header
   * whose reference the sender is never told. A second delivery path here would
   * be a second answer to §5.4's one non-negotiable rule.
   */
  send: (from: string, to: string, text: string) => Promise<QueryResult<DeliveryReceipt>>;
  log: Logger;
  /** Absent = `Date.now`. A test seam. */
  now?: () => number;
}

/**
 * The last thing the session said, as a report.
 *
 * THE LAST CONTIGUOUS RUN OF ASSISTANT PROSE, walked backwards from the end:
 *
 *  * `assistant` blocks are collected. A RUN rather than one block because
 *    `assistantIntents` emits **one block per content item**, so a final turn
 *    written as two text items is two blocks and taking only the last would cut
 *    the report in half at a boundary nothing about the text reveals;
 *  * `thinking` is TRANSPARENT — skipped without ending the run. Extended
 *    thinking precedes the text it produced, so a trailing one is not a
 *    separator; and thinking is not the report either way, which is why it is
 *    skipped rather than collected;
 *  * `tool`, `user`, `todos` and `notice` END the run. Each is something other
 *    than the model talking to the author: a tool call is the work, a `user`
 *    turn is a person or the harness interrupting, and a `notice` is the CLI
 *    re-invoking the model (#704). On the probe's four transcripts the run this
 *    rule selects is exactly the final turn.
 *
 * Pure, so the rule above is a unit test rather than an e2e guess.
 */
export function finalReport(blocks: readonly FeedBlock[]): {
  text: string;
  truncated: boolean;
  headline?: string;
} {
  const collected: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    // A SIDECHAIN IS A SUBAGENT TALKING TO ITSELF, not the reviewer reporting —
    // the same filter `promptText` applies, for the same reason it gives ("a
    // `Task` brief reported as something the human asked for is a misattribution
    // the reader cannot detect"). A subagent's closing summary injected into the
    // author's composer as "the review" is that misattribution one step worse,
    // because the author would act on it. Skipped rather than treated as a break:
    // it is not the model addressing the author either way.
    if (b.sidechain === true) continue;
    if (b.kind === 'thinking') continue;
    if (b.kind !== 'assistant') break;
    const text = (b.text ?? '').trim();
    // An `assistant` block with no text cannot end the run — it is not a
    // separator, it is nothing. `assistantIntents` does not emit one, so this
    // only guards a hydrated or hand-built block.
    if (text !== '') collected.unshift(text);
  }
  if (collected.length === 0) return { text: '', truncated: false };
  // STRIPPED, NOT REFUSED — `stripUnsafeControls`' own rule, and this text is the
  // case it was written for one step along (#950 review). A sibling's message is
  // refused for a control character because the sender is an agent that can be
  // told "send plain text"; a REPORT has no such sender. It is our mechanical
  // lift of another session's prose, and the reviewer that quoted an ANSI escape
  // while explaining a bug is not going to be asked to try again. Refusing here
  // would produce a finding the user can see, cannot edit and cannot send, with
  // a message addressed to nobody. Done at extraction because that is where the
  // bytes are built, and before a surface a human will press Enter on — which is
  // the property `UNSAFE` actually protects.
  //
  // CUT FROM THE HEAD, keeping the START — the opposite of `sessionOutput`'s
  // rule and for the opposite reason. A review leads with its summary and
  // descends into detail; a reader handed the tail of one gets the floating-point
  // footnote and not the sentence saying the change is wrong. `capText` appends
  // the in-band `…[truncated]` marker every other document in this app uses.
  //
  // ⚠️ AND THE BUDGET IS THE CAP MINUS THAT MARKER. `capText` slices to its limit
  // and then adds thirteen characters, so cutting at `REPORT_CHAR_CAP` produces a
  // report thirteen over it — which `delivery.ts` REFUSES, telling the user to
  // shorten text they did not write. Found in review, and it is the failure this
  // cap exists to prevent, so the arithmetic is the whole point of it.
  const body = stripUnsafeControls(collected.join('\n\n'));
  const capped = capText(body, REPORT_CHAR_CAP - TRUNCATION_MARKER_LEN);
  const headline = firstLine(capped.text);
  return {
    text: capped.text,
    truncated: capped.truncated,
    ...(headline === undefined ? {} : { headline }),
  };
}

/**
 * The first line worth showing on a one-line row.
 *
 * Markdown decoration is taken off rather than rendered: the row is plain text
 * in a 300 px drawer, and `**Summary:** This change does not work.` reads worse
 * there than the sentence does. Leading `#` and list markers go for the same
 * reason. What is NOT done is any attempt to find "the important line" — the
 * first line is the first line, which is the only claim about it that is true by
 * construction.
 */
function firstLine(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}[-*+]\s+/, '')
      .replace(/^\s{0,3}\d+[.)]\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (line !== '') return capText(line, HEADLINE_CHAR_CAP).text;
  }
  return undefined;
}

export class DispatchResults {
  /** dispatched live id → the author it owes a result to */
  private readonly links = new Map<string, DispatchLink>();
  /** dispatched live id → the report main is holding */
  private readonly held = new Map<string, HeldResult>();
  /** reports being delivered right now — see `inject`'s single-flight note */
  private readonly injecting = new Set<string>();

  constructor(private readonly deps: DispatchResultsDeps) {}

  /**
   * A dispatched session has been briefed and is running.
   *
   * Called from the spawn path, beside `setDispatched` — the same moment, and
   * for a related reason: both record "nobody is sitting in front of this".
   */
  dispatched(reviewer: string, author: string, about: { reviewerName: string; templateName: string }): void {
    if (reviewer === '' || author === '' || reviewer === author) return;
    // ⚠️ AN EVICTED LINK IS A ROUND-TRIP THAT WILL NEVER BE MADE, and the author
    // is not told — which sits awkwardly beside this module's "never silence"
    // stance. It is a warn rather than an `ended` row on purpose: the evicted
    // dispatch is still RUNNING, so a row saying "stopped before it finished"
    // would be a lie, and the cap means thirty-two dispatches in flight at once
    // on one machine. If that ever becomes a real shape, the answer is a bigger
    // cap, not a fabricated outcome.
    while (this.links.size >= MAX_HELD_RESULTS) {
      const oldest = this.links.keys().next();
      if (oldest.done) break;
      this.links.delete(oldest.value);
      this.deps.log.warn('dropped the oldest dispatch link to stay under the cap', {
        cap: MAX_HELD_RESULTS,
      });
    }
    this.links.set(reviewer, { author, ...about, at: this.now() });
  }

  /**
   * A dispatched session's run ended. Harvest, and tell the author.
   *
   * ⚠️ SINGLE USE, like the briefing that started it, and the hazard is the
   * mirror image. `done` is a TURN ending, not a session ending — a user who
   * opens the reviewer and types at it produces another one, and without
   * spending the link every subsequent turn would raise a fresh "your review is
   * ready" on a card the user is actively working in.
   *
   * Never throws: called from the status-change fan-out that also drives the
   * Feed and the AI labeller.
   */
  completed(reviewer: string, how: 'done' | 'ended'): void {
    const link = this.links.get(reviewer);
    if (!link) return;
    this.links.delete(reviewer);
    try {
      this.harvest(reviewer, link, how);
    } catch (err) {
      // P4: our bookkeeping must not be able to cost a session anything. The
      // author loses the round-trip and the log says so, which is the honest
      // failure — the review itself is still on the reviewer's card.
      this.deps.log.error('harvesting a dispatch result threw', {
        sessionId: reviewer,
        error: String(err),
      });
    }
  }

  private harvest(reviewer: string, link: DispatchLink, how: 'done' | 'ended'): void {
    // A SESSION THAT DIED HAS ITS FEED READ ANYWAY. `manager.onSessionExit`
    // drains what the transcript watch had left (`sessions/ipc.ts` spends a
    // paragraph on that ordering), so a reviewer that wrote its findings and
    // then fell over has them in its blocks — and discarding them because of
    // what happened afterwards would lose them at the one moment they are most
    // worth having.
    const report = this.read(reviewer);
    // `ended` outranks `silent`: a run that stopped and a run that finished with
    // nothing to say are different facts, and the author acts differently on
    // each. `silent` is not an error — see `DISPATCH_OUTCOMES`.
    const outcome: DispatchOutcome =
      how === 'ended' ? 'ended' : report.text === '' ? 'silent' : 'reported';
    const dto: DispatchResultDto = {
      reviewer,
      reviewerName: link.reviewerName,
      templateName: link.templateName,
      outcome,
      ...(report.headline === undefined ? {} : { headline: report.headline }),
      chars: report.text.length,
      truncated: report.truncated,
    };
    while (this.held.size >= MAX_HELD_RESULTS) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
      this.deps.log.warn('dropped the oldest held dispatch result to stay under the cap', {
        cap: MAX_HELD_RESULTS,
      });
    }
    this.held.set(reviewer, { dto, author: link.author, text: report.text, at: this.now() });
    this.deps.log.info('dispatch result', {
      sessionId: reviewer,
      author: link.author,
      templateName: link.templateName,
      outcome,
      chars: report.text.length,
    });
    // THE EVENT IS RAISED WHATEVER THE OUTCOME — the third done-when bullet. A
    // reviewer that crashed or said nothing still reaches the author, because
    // the alternative is an author waiting for a review that is never coming.
    this.deps.raise(link.author, dto);
  }

  private read(reviewer: string): { text: string; truncated: boolean; headline?: string } {
    // Isolated from the harvest's own try/catch so a Feed that cannot answer
    // still produces a `silent` result rather than no result at all.
    try {
      return finalReport(this.deps.blocks(reviewer));
    } catch (err) {
      this.deps.log.warn('could not read a dispatched session’s feed', {
        sessionId: reviewer,
        error: String(err),
      });
      return { text: '', truncated: false };
    }
  }

  /**
   * Hand the report to the author's composer — the one-click inject.
   *
   * Every refusal carries a catalogue key the row renders, which is #765's rule
   * applied to the same delivery it applied it to: the author must be able to
   * tell "waiting in your composer" from "went nowhere".
   *
   * ⚠️ THE RESULT IS NOT SPENT ON A REFUSAL, only on a delivery. A card that was
   * momentarily full, or a window that did not confirm in time, must leave the
   * button working — the alternative is a finding that vanishes because the
   * first click landed badly.
   *
   * ⚠️ AND IT IS SINGLE-FLIGHT IN MAIN, not in the row (#950 review). `send`
   * awaits a window acknowledgement with an 8-second ceiling, so a second call
   * arriving inside that window would find the entry still there and deliver the
   * report TWICE. The renderer disarms its button, but that guards one component:
   * the Events drawer and a popped-out Events window can show the same row, and
   * the channel guards nothing at all. Reserved here, released on refusal.
   */
  async inject(reviewer: unknown): Promise<DispatchInjectResult> {
    if (typeof reviewer !== 'string' || reviewer === '') {
      return { ok: false, reasonKey: 'gone' };
    }
    if (this.injecting.has(reviewer)) return { ok: false, reasonKey: 'inFlight' };
    const found = this.held.get(reviewer);
    if (!found) {
      // Reachable: a result already injected from another surface, one dropped
      // by the cap, or a row left on screen across a reload that emptied the
      // map. Said out loud rather than ignored.
      return { ok: false, reasonKey: 'gone' };
    }
    if (found.text === '') {
      // The row offers no button in this case, so this is the belt: a caller
      // that asked anyway is told the truth rather than handing `delivery.ts` an
      // empty message for it to refuse with a sentence about sending text.
      return { ok: false, reasonKey: 'empty' };
    }
    this.injecting.add(reviewer);
    let sent;
    try {
      sent = await this.deps.send(reviewer, found.author, found.text);
    } finally {
      // In a `finally` because a throw out of `send` must not wedge the button
      // for the life of the process — the send itself is documented never to
      // reject, and this is the belt on that.
      this.injecting.delete(reviewer);
    }
    if (!sent.ok) {
      // The SENTENCE is carried as detail, never rendered as the row's own words:
      // delivery writes for the agent that called it ("send it again as plain
      // text"), which is the right instruction addressed to the wrong reader.
      this.deps.log.info('dispatch result not delivered', {
        sessionId: reviewer,
        author: found.author,
        reason: sent.reason,
      });
      return { ok: false, reasonKey: 'undelivered', detail: sent.reason };
    }
    this.held.delete(reviewer);
    // AND THE ROW SAYS SO (#950 review). The button's "already used" state used
    // to live only in the component, so re-opening the drawer — or looking at the
    // same row in a popped-out Events window — offered a button that would now
    // answer "no longer being held", an error for something that worked.
    //
    // ⚠️ MARKED, NOT REMOVED, and the difference cost a red e2e to learn. Taking
    // the row down took the confirmation with it: the user clicked Inject and
    // watched the row vanish, with nothing anywhere saying where the findings had
    // gone — and the composer they went to is very often on a card that is not
    // the visible one. `delivered` with `chars: 0` is the row still being there
    // and still being honest, with no button on any surface. It is what `ready`
    // is to `done`, which is why `outcomeNeedsYou` takes it out of the queue.
    const submitted = sent.value.outcome === 'submitted';
    try {
      this.deps.raise(found.author, { ...found.dto, outcome: 'delivered', chars: 0, submitted });
    } catch (err) {
      // The delivery HAPPENED. A feed that cannot update its row must not turn a
      // success into a failure (P4) — the worst case is a stale row whose button
      // answers `gone`, which is the state this call exists to improve on.
      this.deps.log.warn('could not mark a dispatch result delivered', {
        sessionId: reviewer,
        error: String(err),
      });
    }
    this.deps.log.info('dispatch result injected', {
      sessionId: reviewer,
      author: found.author,
      outcome: sent.value.outcome,
    });
    // `submitted` rather than a boolean called `held`: the author's card may have
    // auto-accept on (#765), in which case the block went in as a turn and the
    // row should not claim it is waiting in a composer it is not in. Returned as
    // well as put on the row, for a caller that is not a row.
    return { ok: true, submitted };
  }

  /**
   * A session went away. Forget what can no longer happen.
   *
   * ⚠️ ASYMMETRIC, and the asymmetry is the decision. A **link** dies with
   * either end — there is no round-trip left to make. A **held report** dies
   * only with its AUTHOR: it is main's copy of another session's words, the
   * author's Feed row is what offers it, and `EventFeed.forget` takes that row
   * down on the same teardown. A reviewer going away must NOT take its report
   * with it, because a user who closes a finished reviewer's card has not said
   * anything about the finding — and the whole point of holding it here is that
   * it outlives the session that produced it.
   *
   * What a departed reviewer DOES cost is attribution: `SiblingDelivery` resolves
   * the sender from the live id and falls back to "(unknown session)" rather than
   * guessing, which is its own stated rule. Call `completed` before this if the
   * session is going away mid-review — the author is owed the news either way.
   */
  forget(sessionId: string): void {
    this.links.delete(sessionId);
    for (const [reviewer, link] of this.links) {
      if (link.author !== sessionId) continue;
      this.links.delete(reviewer);
      this.deps.log.info('an author session ended while its dispatch was still running', {
        sessionId,
        reviewer,
      });
    }
    for (const [reviewer, r] of this.held) {
      if (r.author !== sessionId) continue;
      this.held.delete(reviewer);
      this.deps.log.info('an author session ended before its dispatch result was read', {
        sessionId,
        reviewer,
      });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
