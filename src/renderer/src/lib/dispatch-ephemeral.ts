// EPHEMERAL BY DEFAULT (#951, §5.15 "Lifecycle & lineage") — when a dispatched
// session goes away on its own.
//
// §5.15: *"are ephemeral by default (auto-archive after result delivery;
// linger/pin options like watchers)"*.
//
// ── "AUTO-ARCHIVE" IS AUTO-RETIRE IN v1, AND THE MANUAL SAYS SO ─────────────
//
// Session archive is Phase 3 (§5.25): browsable, searchable history of a session
// that is no longer open. It does not exist, so v1 uses the existing CLOSE path
// (`forgetClosedCard`) and the manual says "closed" rather than implying history
// is kept. When §5.25 lands, this policy is what it inherits — the decision of
// WHEN is here; WHERE the session goes is the close path's.
//
// ── THE TRIGGER IS THE ANSWER TO #950'S WARNING ─────────────────────────────
//
// `main/sessions/dispatch-results.ts` ends with a warning addressed to this item
// by name: a held report deliberately outlives the reviewer that wrote it, and
// what a departed reviewer costs is ATTRIBUTION — `SiblingDelivery` resolves the
// sender from the live id and falls back to "(unknown session)" rather than
// guessing, because *"attribution is the one thing here that must not be
// approximate"*. Auto-archiving the reviewer turns that rare case into the normal
// one.
//
// **It is settled by the trigger, not by a new attribution mechanism.** A retire
// fires on the `delivered` outcome, which `DispatchResults.inject` raises only
// after `send()` has returned — i.e. after `sender(callerId)` has already resolved
// the reviewer's name off its live id. The reviewer is alive at the one moment
// attribution is taken. Ephemerality and exact attribution are **ordered**, not in
// tension, and nothing has to be captured or approximated to make it so.
//
// Generalised, that is one rule with no special cases:
//
//   ⭐ A DISPATCHED SESSION RETIRES WHEN IT OWES NOTHING.
//
// and "owes" is exactly the predicate the row's Inject button is drawn from —
// `offersInject`, i.e. `chars > 0`. `delivered` sets `chars: 0`; so does `silent`;
// so does an `ended` run that wrote nothing. A `reported` or `ended` row that
// still holds text is OWED and its reviewer stays.
//
// The consequence is worth stating rather than discovering: **a report the user
// never injects never retires its reviewer.** That is correct. "Ephemeral" must
// not be able to mean "threw away a finding you had not read yet", and the row
// that is still offering a button is the user's own outstanding to-do.
//
// It is also what keeps the other #950 seam safe — with one condition that has to
// be checked rather than assumed, and that the first draft of this module got
// wrong. The retire closes the CHILD, so `DispatchResults.forget(child)` matches
// no `held` entry (those are keyed by `author`) and `EventFeed.forget(child)` drops
// no `dispatch-result` row (those are filed under the author).
//
// ⚠️ BUT A CHILD CAN ITSELF BE AN AUTHOR. §5.15's chain is *authored → reviewed →
// fixed*, and `MAX_RAIL_DEPTH` exists precisely because a reviewer can dispatch its
// own reviewer. A dispatches B, B dispatches C; B's report is injected, so B owes
// nothing *as a reviewer* and becomes a candidate — while C's report sits held
// under author **B**, with an injectable row on B's card. Closing B runs
// `DispatchResults.forget(B)`, which deletes exactly that report, and
// `EventFeed.forget(B)`, which drops exactly that row. C's review would be gone,
// unread, with nothing anywhere saying so.
//
// So "owes nothing" is asked in BOTH directions: `mayRetire` refuses a card that
// still owes a finding as an author. At fire time and not as a candidate filter,
// because the grandchild can finish INSIDE the linger.
//
// ── §5.6'S WORDS, REUSED; §5.6'S CODE, NOT ─────────────────────────────────
//
// The issue asks for watcher-window vocabulary — `auto-close | linger 10s | pin`
// — and says "reuse the words, not necessarily the code". Two departures, both
// deliberate:
//
//   * **`keep`, not `pin`.** The per-card PIN already means "exempt from every
//     bulk operation" (§5.8), and it is the override a user reaches for here. A
//     *setting value* also called `pin`, which pins nothing, would be one word
//     meaning two things — the drift §5.32 rule (a) is about, one field over. So
//     the third value is `keep` and the pin stays the pin. It is also why there is
//     deliberately NO per-session override: the pin is it, it is one gesture, and
//     a second per-card way to say "not this one" is a second answer.
//
//   * **30 seconds, not 10.** A watcher is a read-only mini panel whose content
//     the user has been watching stream; ten seconds after it stops is a long time
//     in that surface. A reviewer's card is a DOCUMENT — the full review, which
//     the author's Feed row has just invited the user to go and read — and the
//     click that triggers the retire is the same click that put a block in
//     another card's composer, very often a card that is not the visible one.
//     Thirty seconds is the time to notice the card is about to go and pin it.
import { closableCards, type PinSet } from './pinning';
import { offersInject } from '../../../shared/dispatch-result';
import type { RailCardStatus } from '../../../shared/sessions';
import type { EventDto } from '../model/types';
import type { LineageMap } from './dispatch-lineage';

/**
 * What happens to a dispatched session that owes nothing.
 *
 * In §5.6's order — loudest change first — so the radio group reads the way the
 * watcher one will.
 */
export const DISPATCH_RETIRE_POLICIES = ['auto-close', 'linger', 'keep'] as const;
export type DispatchRetirePolicy = (typeof DISPATCH_RETIRE_POLICIES)[number];

/**
 * `linger`, because "ephemeral by default" has to actually retire — a default of
 * `keep` would ship the setting and not the feature — and because `auto-close` is
 * the one of the three that can surprise: a card vanishing in the same frame as
 * the click that spent it looks like the click closed the wrong thing.
 */
export const DEFAULT_DISPATCH_RETIRE: DispatchRetirePolicy = 'linger';

/** ui-blob key (§5.25: the choice survives relaunch). */
export const DISPATCH_RETIRE_KEY = 'dispatchRetire';

/** How long `linger` lingers. See the header for why it is not §5.6's 10 s. */
export const DISPATCH_LINGER_MS = 30_000;

/** Is this a policy we offer? §5.29's rule for a value out of a blob a human can
 *  edit: check the vocabulary at runtime rather than casting. */
export function isDispatchRetirePolicy(v: unknown): v is DispatchRetirePolicy {
  return typeof v === 'string' && (DISPATCH_RETIRE_POLICIES as readonly string[]).includes(v);
}

/**
 * The policy for a stored value, falling back to the default.
 *
 * Fail-open in the direction that KEEPS the card: an unreadable value is a value
 * nobody chose, so it gets the default rather than the most destructive member of
 * the union.
 */
export function dispatchRetireOf(v: unknown): DispatchRetirePolicy {
  return isDispatchRetirePolicy(v) ? v : DEFAULT_DISPATCH_RETIRE;
}

/**
 * How long to wait before retiring, or `null` for "never".
 *
 * `0` and `null` are different answers and the caller must not collapse them: one
 * is "now", the other is "no timer at all". A `?? 0` on this return value is the
 * bug it is shaped to prevent.
 */
export function retireDelayMs(policy: DispatchRetirePolicy): number | null {
  switch (policy) {
    case 'auto-close':
      return 0;
    case 'linger':
      return DISPATCH_LINGER_MS;
    case 'keep':
      return null;
  }
}

/**
 * Statuses that mean somebody is using this card right now.
 *
 * §5.6's *"stay pinned if the user interacted with it"*, expressed in the only
 * terms the rail actually has. A dispatched session whose report has been spent
 * and which is WORKING again is a session someone typed at — the report was the
 * end of the dispatch, not the end of the conversation — and closing it would
 * throw away a turn in flight.
 *
 * `needs-input` and `needs-permission` are in for a second reason on top of that:
 * both are the session asking the user a question, and retiring a card mid-question
 * would answer it by closing it.
 */
const BUSY: ReadonlySet<RailCardStatus> = new Set<RailCardStatus>([
  'starting',
  'working',
  'needs-input',
  'needs-permission',
  // ⚠️ `crashed` IS IN THIS LIST, and it is the one member that is not about a
  // person being there. A crash raises `completed(…, 'ended')` with nothing to
  // inject, so the card would otherwise be a candidate the moment it died — and
  // the card is the ONLY place the reason is: its terminal, its transcript, its
  // last frames. The author's row says "ended", which is enough to stop waiting
  // and not enough to act on. Closing the evidence thirty seconds after the
  // failure is exactly the surprise §4's fail-open rule exists to prevent, so a
  // crashed reviewer stays until a person closes it.
  'crashed',
]);

/**
 * May this card be retired right now?
 *
 * ⚠️ ASKED AT FIRE TIME, NEVER AT SCHEDULE TIME, and that is the whole value of
 * splitting it out: during a 30-second linger the user can pin the card, close it
 * by hand, or type at it, and every one of those has to spare it. A decision taken
 * when the timer was set would ignore all three.
 *
 * ⚠️ AND THE PIN EXEMPTION GOES THROUGH `closableCards`, which is `lib/pinning`'s
 * own auto-eviction seam — its header names "any future auto-eviction" as the case
 * it is waiting for and says, in as many words: *"Route the candidate list through
 * it and the exemption arrives already written, already unit-tested. Do not add a
 * second `if (pinned)` beside the new policy."* This is that policy. A pinned
 * dispatched session survives its own ephemerality, which is the done-when bullet
 * and is also just what pinning means everywhere else in the app.
 *
 * `known` is the cards that still exist: a reviewer the user already closed, or one
 * `ended` because its card went away, must not be "retired" a second time — that
 * would put a close breadcrumb in the log for a card nobody has.
 */
export function mayRetire(opts: {
  cardId: string;
  pins: PinSet;
  /**
   * Does this card still owe a finding **as an author**? See the header — a
   * dispatched session can have dispatched one of its own, and closing it would
   * delete a held report and its row together.
   *
   * Passed in rather than computed here so this stays a pure decision over three
   * lists; `owesAsAuthor` below is the question, and the caller asks it at the same
   * moment it asks this.
   */
  owesAsAuthor: boolean;
  /**
   * Has the user typed something into this card and not sent it?
   *
   * §5.6's *"stay if the user interacted with it"* has a second half that status
   * cannot see: an unsent draft is somebody halfway through a sentence. Closing the
   * card takes the draft with it (`forgetClosedCard` prunes it), so the keystrokes
   * are gone as well as the session.
   */
  hasDraft?: boolean;
  /**
   * The policy AS IT IS NOW.
   *
   * ⚠️ RE-READ HERE AND NOT ONLY AT SCHEDULE TIME, and this is the case that makes
   * the fire-time rule worth stating: the card counting down is exactly the card a
   * user is looking at when they go and find this setting, so switching to `keep`
   * inside the linger has to spare the one in flight. A policy read only when the
   * timer was armed would close it anyway — seconds after being told not to.
   */
  policy: DispatchRetirePolicy;
  status?: RailCardStatus;
  known: ReadonlySet<string>;
}): boolean {
  if (retireDelayMs(opts.policy) === null) return false;
  if (!opts.cardId || !opts.known.has(opts.cardId)) return false;
  if (closableCards([opts.cardId], opts.pins).length === 0) return false;
  if (opts.owesAsAuthor) return false;
  if (opts.hasDraft === true) return false;
  return !(opts.status !== undefined && BUSY.has(opts.status));
}

/**
 * Does this live session still have a finding waiting for it as an AUTHOR?
 *
 * The same walk `retirableReviewerCards` does, asked from the other end and about
 * one session: a `dispatch-result` row is filed under its author, so a row on this
 * session that still offers its button is a report only this card can take. See the
 * header for the A → B → C sequence this closes.
 *
 * A card with no live session owes nothing by construction — nothing can have been
 * dispatched by a session that is not running.
 */
export function owesAsAuthor(events: readonly EventDto[], liveId: string | undefined): boolean {
  if (!liveId) return false;
  return events.some(
    (e) => e.kind === 'dispatch-result' && e.sessionId === liveId && !!e.dispatch && offersInject(e.dispatch)
  );
}

/**
 * Which CARDS a retire should be scheduled for, from what the store holds.
 *
 * Three conditions, and each one is a separate mistake it prevents:
 *
 *  1. **The row owes nothing** — `!offersInject`. That is the rule; see the header.
 *     A `reported` row with text in it is the user's outstanding to-do and its
 *     reviewer stays.
 *  2. **The card is a session this workspace knows was dispatched** — it has a
 *     lineage record. `DispatchResultDto.reviewer` is a LIVE session id, and live
 *     ids are recycled by nothing we control; requiring the parentage as well means
 *     a coincidence cannot close an ordinary card. It also keeps the two halves of
 *     §5.15's lifecycle paragraph tied to one fact: the card that nests is the card
 *     that is ephemeral.
 *  3. **Its card is still there** — a reviewer whose card the user already closed
 *     (which is one of the ways an `ended` row is raised in the first place) has
 *     nothing left to retire.
 *
 * Deliberately NOT a decision about pins or busyness: those are re-asked at fire
 * time by `mayRetire`, because anything asked here is asked up to thirty seconds
 * early. Pure, and takes the three lists rather than the store, so the whole rule
 * is a unit test.
 */
export function retirableReviewerCards(opts: {
  events: readonly EventDto[];
  sessions: readonly { id: string; liveId?: string }[];
  lineage: LineageMap;
}): RetireCandidate[] {
  const cardOf = new Map<string, string>();
  for (const s of opts.sessions) if (s.liveId) cardOf.set(s.liveId, s.id);
  const out: RetireCandidate[] = [];
  for (const e of opts.events) {
    const d = e.dispatch;
    if (e.kind !== 'dispatch-result' || !d || offersInject(d)) continue;
    const cardId = cardOf.get(d.reviewer);
    // A card can own two dispatch-result rows (#950's Dismiss-by-event-id note),
    // so the same card can be named twice in one pass.
    if (!cardId || !opts.lineage.has(cardId) || out.some((c) => c.cardId === cardId)) continue;
    out.push({ cardId, eventId: e.id });
  }
  return out;
}

/**
 * A card a retire should be considered for, and the ROW that says so.
 *
 * ⚠️ THE EVENT ID IS THE HALF THAT MATTERS, and review is why it is here. Without
 * it the caller's only idempotency guard is "is a timer pending", and the
 * `delivered` row lives in main's feed for as long as the author's card does — so a
 * card that was SPARED at fire time (pinned, busy, typed at) re-enters this list on
 * the very next store notification and is armed again. A user who deliberately
 * carried on the conversation would have watched the card close thirty seconds
 * after their turn finished, taking an unsent draft with it.
 *
 * Keyed by the row rather than by the card because "spared" must not be permanent
 * either: re-raising a dispatch result mints a NEW event id (`EventFeed.add`), so a
 * genuinely new report re-opens the question while the one already judged stays
 * judged. That is the same property #950 relied on for the row's own remount, read
 * from the other side.
 */
export interface RetireCandidate {
  cardId: string;
  /** the `dispatch-result` row that made it a candidate — the verdict's key */
  eventId: number;
}
