// The attention queue (P2-E9-03, DESIGN §5.8 + §5.12).
//
// §5.12 draws the line: "the feed is the log, the queue is the to-do list".
// The main-process EventFeed already keeps ONE item per session (its latest
// attention state); this module is the ORDERING over that list, and it is the
// single authority — the Events panel renders this order and Ctrl+Space walks
// it, so the eye and the keyboard can never disagree about what's next.
//
// Pure by construction (no React, no DOM, no IPC) so every rule below is a
// unit test rather than an e2e guess.
import { outcomeNeedsYou, type DispatchOutcome } from '../../../shared/dispatch-result';

/** The subset of a feed event the queue orders on. */
export interface AttentionEvent {
  /** minted fresh by EventFeed on EVERY ingest — see visited-id note below */
  id: number;
  sessionId: string;
  kind: 'done' | 'ready' | 'needs-input' | 'needs-permission' | 'crashed' | 'dispatch-result';
  /** ISO timestamp of the status change */
  at: string;
  /**
   * THE ONE PAYLOAD THIS MODULE READS, and only for one question.
   *
   * `dispatch-result` is the only kind whose "does this still need a human"
   * answer is not settled by the kind alone: a report that has been injected is
   * a record, not a demand. That is `ready`'s relationship to `done` one family
   * over, and `ready` gets to be a KIND because `EventFeed` mints it; a delivered
   * report keeps its own kind because the row still has to say what it was.
   *
   * Structural and optional, so the queue's tests still hand it plain objects.
   */
  dispatch?: { outcome: DispatchOutcome };
}

/**
 * Priority order, straight from the plan (§5.8): a blocked agent outranks a
 * waiting one, a waiting one outranks a dead one, and finished-but-unreviewed
 * work is the tail. Lower sorts first.
 *
 * `ready` is absent on purpose and that absence is the whole
 * completed-unreviewed contract: `done` means "finished, nobody has looked",
 * and acknowledging it (EventFeed.acknowledge) rewrites it to `ready`, which
 * keeps it visible in the panel but takes it out of the to-do list.
 *
 * `dispatch-result` sits just ABOVE `done` (P2-E13-05), and the half-step is
 * argued rather than arbitrary: both are finished work nobody has looked at, but
 * a returned review has a BUTTON on it — something the user can do from the row
 * itself — while a `done` is only an invitation to go and look. §5.8 orders the
 * queue by what it costs to leave a row alone, and leaving an un-injected
 * finding alone costs the author the whole point of having dispatched.
 *
 * ⚠️ IT IS QUEUEABLE HERE AND DELIBERATELY NOT AUDIBLE. `main/events/notifier.ts`
 * leaves it out of `isAttention`, so it beeps and toasts nothing — the reviewer's
 * own `done` fired the local signal a moment earlier, on its own card, and a
 * second one for the same fact is the duplicate #948's review argued against.
 * That split is §5.12's own line: the feed is the log, the queue is the to-do
 * list, and the beep is neither.
 */
const PRIORITY: Readonly<Record<AttentionEvent['kind'], number>> = {
  'needs-permission': 0,
  'needs-input': 1,
  crashed: 2,
  'dispatch-result': 3,
  done: 4,
  ready: -1, // never queued; see queueable()
};

/**
 * Is this event an OUTSTANDING DEMAND — something still waiting on a human?
 *
 * Exported since #621, because it is also the rule the "N need you" counters
 * read (see `needingCards`). One predicate, so the queue, the panel's reviewed
 * tail and every counter cannot disagree about what "still needs me" means.
 */
export function queueable(e: AttentionEvent): boolean {
  // A DELIVERED REPORT IS NOT A DEMAND. Its row stays — it is how the user knows
  // where the findings went — but there is nothing left to do from it, which is
  // exactly what `ready` means for a `done`. Consulted through
  // `outcomeNeedsYou` rather than compared here, so the queue and the row's own
  // copy cannot drift.
  if (e.kind === 'dispatch-result' && e.dispatch && !outcomeNeedsYou(e.dispatch.outcome)) {
    return false;
  }
  return (PRIORITY[e.kind] ?? -1) >= 0;
}

/**
 * The CARDS with an outstanding demand on them (#621) — the set every
 * "N need you" readout counts.
 *
 * ── WHY THE FEED AND NOT THE STATUS ─────────────────────────────────────────
 *
 * The counters used to be `sessions.filter(s => presentStatus(s.status).needsYou)`,
 * which asks a different question from the one the Events window answers, and
 * the two disagreed the moment the user acted: dismissing an event calls
 * `EventFeed.forget` and acknowledging a finished one rewrites `done` -> `ready`
 * — neither of which moves the session's STATUS, because neither of them is a
 * thing the session did. So "3 need you" sat there over an empty Events list.
 *
 * The feed is the authority for "is this still calling for eyes": it is the
 * list the user is looking at when they dismiss, `ready` is a kind that exists
 * only in it (a `done` that has been looked at), and "resolved means gone"
 * (§5.12) is already how a granted permission leaves. The counters therefore
 * count exactly what the Events window lists, and dismissal decrements them by
 * construction rather than by a second rule that has to be kept in step.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT TOUCH ───────────────────────────────────
 *
 * The rail row's tint, the lamp's hue and `data-needs-you` still paint the
 * session's real STATUS, for the reason `lib/focus-policy` gives when `none`
 * silences a session: "§4's fail-open rule does not let a preference of ours
 * make a session's true state unknowable." A dismissal says "stop counting
 * this", not "the session is no longer blocked" — the CLI may well still be
 * waiting, and the row is where you find that out.
 *
 * ⚠️ **THE "SAFE DIRECTION" CLAIM HELD UNTIL P2-E13-05 AND NO LONGER DOES.** It
 * used to read: *a queued event exists only for a session in an attention status,
 * so the count is never larger than the number of rows painted needy — there is
 * no "1 need you" over a calm rail.* That was true while every kind was a status.
 * A `dispatch-result` is filed on the AUTHOR, whose own status is usually `idle`,
 * so a calm-looking rail row can now carry a count.
 *
 * **Kept deliberately, rather than excluded from the count.** The claim was never
 * the point — the point is the paragraph above it: the tint answers "what is this
 * session doing", the count answers "what still needs me", and a finished review
 * nobody has injected genuinely needs somebody. Dropping it from the count to
 * preserve a coincidence would make the counter disagree with the list the user is
 * looking at, which is the whole defect #621 fixed. What the user sees is a count
 * that leads them to a row with a button on it — which is where they were going.
 *
 * Keyed by CARD, not by live session: the counters count rail rows, and a card
 * outlives the live sessions bound to it. `cardIdFor` is the store's map.
 */
export function needingCards(
  events: readonly AttentionEvent[],
  cardIdFor: (sessionId: string) => string
): ReadonlySet<string> {
  const cards = new Set<string>();
  for (const e of events) if (queueable(e)) cards.add(cardIdFor(e.sessionId));
  return cards;
}

/**
 * The ordered work list: attention-worthy events by priority, and within a
 * priority band OLDEST FIRST — the session that has been blocked longest is
 * the one you owe an answer to. (The Events panel used to render newest-first;
 * that is a log's order, not a queue's.)
 *
 * Ties on an identical timestamp fall back to event id, so the order is total
 * and stable rather than dependent on the input array's order.
 */
export function attentionQueue<T extends AttentionEvent>(events: readonly T[]): T[] {
  return events
    .filter(queueable)
    .slice()
    .sort((a, b) => {
      const p = PRIORITY[a.kind] - PRIORITY[b.kind];
      if (p !== 0) return p;
      const t = Date.parse(a.at) - Date.parse(b.at);
      // an unparseable timestamp must not poison the sort into NaN
      if (t) return t;
      return a.id - b.id;
    });
}

export interface NextResult<T extends AttentionEvent = AttentionEvent> {
  /** where Ctrl+Space goes, or null when nothing needs a human */
  next: T | null;
  /** visited set to carry forward — replaced wholesale on a wrap */
  visited: ReadonlySet<number>;
  /** true when the walk ran off the end and started over (E9-04 may flash it) */
  wrapped: boolean;
}

/**
 * Advance the walk: the highest-priority item you have not already been sent
 * to. When every queued item has been visited, WRAP — forget the visits and
 * return to the head — so the hotkey is a round-trip through the list rather
 * than a dead end (the item's spec: "wraps at the end").
 *
 * VISITED IS KEYED BY EVENT ID, NOT SESSION ID, and that is load-bearing.
 * EventFeed mints a new id on every ingest, so a session that goes quiet and
 * then calls again arrives as an id nobody has visited and re-enters the walk
 * on its own. Keying by session would suppress the second call for as long as
 * the app ran.
 *
 * This exists because acknowledging is not enough on its own: EventFeed's
 * acknowledge() only relaxes `done` -> `ready`. A held permission stays held
 * until the human answers it, so without a visited set the walk would hand you
 * the same blocked session forever and "three sessions clear in priority order
 * under repeated Ctrl+Space" would be impossible.
 */
export function nextInQueue<T extends AttentionEvent>(
  events: readonly T[],
  visited: ReadonlySet<number>,
): NextResult<T> {
  const queue = attentionQueue(events);
  if (queue.length === 0) return { next: null, visited: new Set(), wrapped: false };

  const unvisited = queue.find((e) => !visited.has(e.id));
  if (unvisited) {
    return { next: unvisited, visited: withVisit(visited, events, unvisited.id), wrapped: false };
  }

  // every item seen — start the round again from the top
  const head = queue[0];
  return { next: head, visited: new Set([head.id]), wrapped: true };
}

/**
 * Record a visit, dropping ids that are no longer queued. Both entry points go
 * through here — the hotkey walk and the panel's click-is-a-visit — so the
 * prune rule cannot drift between them.
 *
 * Without the prune the set would grow for the life of the process and, worse,
 * an id that left and came back (a feed replay after a reconnect) would arrive
 * pre-visited and be silently skipped.
 */
export function withVisit(
  visited: ReadonlySet<number>,
  events: readonly AttentionEvent[],
  id: number,
): ReadonlySet<number> {
  const live = new Set(attentionQueue(events).map((e) => e.id));
  const next = new Set<number>();
  for (const v of visited) if (live.has(v)) next.add(v);
  next.add(id);
  return next;
}

/**
 * Panel order: the queue first, then the reviewed/`ready` tail it excludes —
 * so the panel still shows everything the feed holds while the top of the list
 * is exactly what Ctrl+Space will walk.
 */
export function panelOrder<T extends AttentionEvent>(events: readonly T[]): T[] {
  const queued = attentionQueue(events);
  const rest = events.filter((e) => !queueable(e)).slice();
  // newest first among the already-reviewed: they are a log again down there
  rest.sort((a, b) => {
    const t = Date.parse(b.at) - Date.parse(a.at);
    if (t) return t; // same guard as attentionQueue: an unparseable date is not NaN-poison
    return b.id - a.id;
  });
  return [...queued, ...rest];
}
