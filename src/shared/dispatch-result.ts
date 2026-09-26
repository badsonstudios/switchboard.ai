// What a dispatched session sends BACK (P2-E13-05, §5.15 "Round-trip").
//
// Phase 2's exit criterion 5 is one sentence — *a dispatched clean-room review
// round-trips its findings back to the author* — and this is the shape of the
// half that comes back.
//
// ── "THE RESULT" IS A TRANSCRIPT, AND WHICH PART OF IT WAS MEASURED ─────────
//
// The issue lists three candidate extractions and says, in as many words: do not
// design the delimiter first and hope the model honours it. So it was measured:
// `spike/probes/950/probe-review-last-turn.mjs`, written up in
// `spike/findings/e13-950-review-last-turn.md`. Four runs of the real dispatch
// prompt against the PATH CLI on the stream transport.
//
//  * **The last assistant turn is the findings, 4/4** — including the run whose
//    `ExitPlanMode` was refused at 60.4 s. That was the question worth asking:
//    #948 reported that a denial "costs the findings nothing", but it measured a
//    TOTAL across every assistant frame, so a shape of *review → ask to exit →
//    refused → "understood, I'll stop"* would have looked identical to it and
//    would have made this whole surface deliver an apology. It does not happen:
//    the model answers a refusal by reporting anyway, in the same turn.
//  * **The last turn is byte-identical to the `result` frame's own `result`
//    string, 4/4.** The CLI agrees with us about what came of the session. That
//    is a cross-check rather than a plumbing plan: `feed/stream-feed.ts` reads no
//    text off that frame, and teaching it to would be a second source for one
//    fact with no caller for the second copy.
//  * **⚠️ AND THE FINDINGS ARE NOT COUNTABLE** — see `DispatchResultDto.headline`.
import { SIBLING_MESSAGE_CHAR_CAP } from './sibling-message';

/**
 * How a dispatched session's run ended, from the AUTHOR's point of view.
 *
 * Three values because three different things are true about what to do next,
 * and the third done-when bullet is that none of them may be silence:
 *
 * - `reported` — it finished and left prose. There is something to inject.
 * - `silent` — it finished and left nothing this module could read as a report.
 *   Not an error: a session that was closed before its first turn, or one whose
 *   last word was a tool call, honestly has no findings. The event says so and
 *   offers no inject, because `delivery.ts` REFUSES an empty message and a
 *   button that cannot work must not be offered.
 * - `ended` — the session stopped before it finished: it crashed, or the user
 *   closed its card. The author is told, rather than waiting for a review that
 *   is never coming. **It can still carry a report**: a reviewer that wrote its
 *   findings and then fell over has them in its Feed, and throwing those away
 *   because of what happened afterwards would lose them at the one moment they
 *   are most worth having. The outcome says the run did not complete; the
 *   `chars` beside it says whether there is anything to inject.
 *
 * - `delivered` — the report has been handed to the author's composer. **The
 *   `ready` of this family**, and it exists for the same reason: the row stays
 *   listed and stops calling for eyes. Adding it was the answer to two problems
 *   at once (#950 review). Retiring the row outright — the first fix — took the
 *   confirmation with it, so the user clicked Inject and watched the row vanish
 *   with nothing to say where the findings went; leaving the row untouched meant
 *   a second Events surface, or the same one re-opened, offered a button whose
 *   report had already been spent. This is the row saying what happened, with
 *   `chars: 0` so no surface offers the button again.
 *
 * ONE VALUE FOR CRASHED-AND-CLOSED, deliberately: to the author they are the
 * same fact ("it is not coming back"), and the difference — whether a person
 * closed it — is on the reviewer's own card, which is where a user would look
 * for it.
 */
export const DISPATCH_OUTCOMES = ['reported', 'silent', 'ended', 'delivered'] as const;

/**
 * Outcomes that still want a human. The `queueable` question, per outcome.
 *
 * `delivered` is out for `ready`'s reason and no other: the finding is in the
 * composer now, so the row is a record rather than a to-do. `silent` and `ended`
 * stay IN even though neither has a button — "your reviewer died" is news a user
 * has to see, and the queue is what walks them to it.
 */
export function outcomeNeedsYou(outcome: DispatchOutcome): boolean {
  return outcome !== 'delivered';
}
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

/** Is this stored/IPC value an outcome we still recognise? */
export function isDispatchOutcome(v: unknown): v is DispatchOutcome {
  return typeof v === 'string' && (DISPATCH_OUTCOMES as readonly string[]).includes(v);
}

/**
 * The longest headline a row will show, in characters.
 *
 * A LINE, not a summary. The row is one line tall and ellipsises; this bound
 * exists so a reviewer that opens with a 3,000-character paragraph does not put
 * 3,000 characters into the event list main pushes on every change.
 */
export const HEADLINE_CHAR_CAP = 160;

/**
 * A finished dispatch, as the author's Feed row needs it.
 *
 * ⚠️ THE REPORT TEXT IS NOT HERE, and that is the same rule `dispatch-wire.ts`
 * states for the briefing going the other way: the document stays in main and
 * the renderer carries a handle. The reasons are the same two. A briefing is
 * defined by what it withholds; a report is the other session's words, and a
 * renderer that held them could alter what the author is shown before they press
 * Enter on it. And the Feed's whole list is pushed to the window on EVERY change
 * (`events:changed`) — putting a multi-kilobyte review in it would re-serialize
 * that review every time any session anywhere changed status.
 */
export interface DispatchResultDto {
  /**
   * The dispatched session that produced it — and the inject's handle.
   *
   * Its LIVE session id, which is what `SiblingDelivery.send` wants as the
   * sender. A separate opaque id would be a second name for one thing; there is
   * at most one outstanding result per dispatched session, so the session is the
   * key.
   */
  reviewer: string;
  /** what the reviewer's card is called, for the row's sentence */
  reviewerName: string;
  /**
   * The role it wore (`RoleTemplate.name`).
   *
   * USER DATA that happens to be words — a template name comes out of
   * `workspace.json` — so it is shown as-is and never looked up in the
   * catalogue, exactly as the rail shows a card's title.
   */
  templateName: string;
  outcome: DispatchOutcome;
  /**
   * The report's first line, or absent when there is none.
   *
   * ⚠️ THIS IS WHERE §5.15's *"Review of @X complete — 3 findings"* WENT, AND THE
   * REASON IS A MEASUREMENT. Four runs of the same prompt on the same diff
   * enumerated four different ways — numbered items 0/0/4/0, bullets 7/9/4/10,
   * headings 3/0/3/2 — and the bullet count is not a finding count in any of
   * them (one run's nine bullets are three findings, three unstated assumptions
   * and three costs). Worse, a regex for a self-reported "N findings/issues/
   * problems" fired on exactly one run and matched **"the first two problems"** —
   * a back-reference inside a maintenance bullet — which would have printed "2"
   * for a review that made four.
   *
   * So the row does not count. It shows the first line the reviewer actually
   * wrote, which is true by construction and, on every run measured, was the
   * sentence a person would want ("This change does not work…").
   */
  headline?: string;
  /**
   * How much report is held, in characters. `0` means there is nothing to
   * inject and the row offers no button.
   */
  chars: number;
  /** the report was longer than `SIBLING_MESSAGE_CHAR_CAP` and was cut */
  truncated: boolean;
  /**
   * On a `delivered` row: did the block go straight in, or is it waiting?
   *
   * §5.4's whole point is that it WAITS unless the author's card has #765's
   * auto-accept toggle on, and "sent" and "sent, and your session has already
   * run it" are different things to have just done. On the ROW rather than in
   * the clicking component, and that placement is the lesson: re-raising the row
   * mints a new event id, React remounts the component on its `key`, and a
   * confirmation held in `useState` is gone the instant it is earned. Absent on
   * every other outcome.
   */
  submitted?: boolean;
}

/**
 * The longest report that will ever be offered, in characters.
 *
 * The sibling cap, reused rather than re-chosen, because the inject IS an
 * ordinary sibling message (§5.4's policy applies unchanged) — and `delivery.ts`
 * REFUSES an over-cap message rather than cutting it. An uncapped report would
 * therefore fail at the click, with a message about shortening text the user did
 * not write and cannot edit.
 *
 * ⚠️ **THIS IS THE FINISHED LENGTH, INCLUDING THE TRUNCATION MARKER** — which is
 * the distinction #950's review caught. `capText` slices to its limit and THEN
 * appends ` …[truncated]`, so a report cut at this number comes out thirteen
 * characters over it and hits precisely the refusal described above: the row
 * would say "shortened to fit", offer the button, and the button would never
 * work. The cutter subtracts `TRUNCATION_MARKER_LEN` from its own budget; this
 * constant is what the RESULT is measured against.
 *
 * Measured headroom: the probe's reviews ran 1,663–3,289 characters on a
 * ten-line diff. A review of a real branch is the case that will not have it,
 * which is why the off-by-thirteen was a blocker and not a curiosity.
 */
export const REPORT_CHAR_CAP = SIBLING_MESSAGE_CHAR_CAP;

/**
 * What became of an inject, as the row needs to report it.
 *
 * ⚠️ A REFUSAL CARRIES A KEY, NOT A SENTENCE — `DispatchPrepared`'s shape one
 * channel over, and #950's review is why it is here too. §5.21's first rule is
 * that no user-visible string is hardcoded, and this channel's refusals had two
 * ways of breaking it: literals written in main, and — worse — sentences
 * forwarded verbatim out of `delivery.ts`, which are written as **tool content
 * for a model** ("Its earlier output can still be read with get_session_output",
 * "send it again as plain text"). Those are correct instructions addressed to
 * the wrong reader.
 *
 * So the row renders `reasonKey`. `detail` is the raw sentence, kept because it
 * is the only place a delivery refusal says WHICH refusal it was — it rides
 * along as the row's tooltip and into the log, never as the row's own words.
 */
export type DispatchInjectResult =
  | { ok: true; submitted: boolean }
  | { ok: false; reasonKey: DispatchInjectRefusal; detail?: string };

/**
 * Why an inject did not happen, as a catalogue key suffix.
 *
 * Four, because four things can be true and the user's next move differs for
 * each: nothing is held any more (the row is stale — dismiss it), there was
 * never anything to send (the reviewer said nothing), the other card would not
 * take it (try again, or go and look), or the click is already in flight.
 */
export const DISPATCH_INJECT_REFUSALS = ['gone', 'empty', 'undelivered', 'inFlight'] as const;
export type DispatchInjectRefusal = (typeof DISPATCH_INJECT_REFUSALS)[number];
