// §5.8's presentation ladder — the RULES (P2-E9-05).
//
// P2-E15-08 built the home: a per-card `ladder` rung that outlives the panel,
// persisted in the ui blob, plus the hidden↔expanded transitions. This module
// is the rest of the ladder — what each rung MEANS, how you step between them,
// and which events bring a session back up on their own.
//
// Pure by construction (no React, no dockview, no IPC): every rule below is a
// unit test rather than an e2e guess. SessionGrid owns the dockview verbs;
// nothing here knows dockview exists.
//
// ── WHAT THE FOUR RUNGS ARE ─────────────────────────────────────────────────
//
//   expanded   the full card, in its dock slot. Today's default.
//   collapsed  NO dockview panel; the session shows as a slim status row in the
//              collapsed strip. It gives its slot back to its neighbours.
//   tabbed     a dockview panel, but stacked with every other tabbed card in
//              ONE shared group — so all of them together cost one slot, and
//              only the selected one is on screen.
//   hidden     no panel and no row. The session lives on in the rail, its lamp
//              and the events list, and nowhere else (§5.8, verbatim).
//
// The ordering is decreasing screen cost, which is what makes it a ladder:
// a collapsed card always shows one status line; a tabbed card usually shows
// nothing at all but its tab label.
//
// ── WHY `collapsed` LEAVES THE GRID ─────────────────────────────────────────
//
// It is tempting to keep the panel and just render a short body inside it —
// far less code. That was rejected because it makes the rung cosmetic: a card
// collapsed inside a 2×2 dock leaves its whole quadrant empty, so nothing is
// actually given back. It also breaks the two items that compose on this one:
// E9-07's focus mode is specified as "one large + slim strips" AND as "a
// COMPOSITION of ladder states", which only works if collapsing the other seven
// sessions hands the screen to the eighth; and E9-08 aggregates "more than ~3
// idle" into a single row, which needs the collapsed sessions to be rows
// somewhere in the first place.
//
// Removing the panel is exactly what `hidden` already does, slot capture and
// all — so collapsed is the same mechanism with a row left behind, and the
// reveal contract ("restores it to EXACTLY its prior dock slot") is the one
// P2-E15-08 already proved.
import type { Ladder } from './presentation';
import type { AttentionEvent } from './queue';
import { type AttentionResponse, revealsCard, takesFocus } from './focus-policy';

/** Top (most screen) to bottom (none). The order IS the ladder. */
export const LADDER_ORDER: readonly Ladder[] = ['expanded', 'collapsed', 'tabbed', 'hidden'];

/** Step one rung down the ladder; the bottom rung stays put (never wraps —
 *  "collapse again" turning a hidden session back into a full card would be a
 *  gesture that silently undoes itself). */
export function stepDown(rung: Ladder): Ladder {
  const i = LADDER_ORDER.indexOf(rung);
  return LADDER_ORDER[Math.min(i + 1, LADDER_ORDER.length - 1)] ?? 'expanded';
}

/** Step one rung up. The top rung stays put, same reasoning as stepDown. */
export function stepUp(rung: Ladder): Ladder {
  const i = LADDER_ORDER.indexOf(rung);
  return LADDER_ORDER[Math.max(i - 1, 0)] ?? 'expanded';
}

/**
 * Does this rung have a dockview panel?
 *
 * The single source of truth for the hide-vs-show half of every transition:
 * SessionGrid adds a panel when it becomes true and removes one when it becomes
 * false, so a new rung cannot be added without answering this question.
 */
export function hasPanel(rung: Ladder): boolean {
  return rung === 'expanded' || rung === 'tabbed';
}

/**
 * Is this rung's dock slot its HOME, or where it currently sits?
 *
 * A tabbed card has a panel, but that panel has been moved into the shared tab
 * group — which is not where it came from and not where stepping back up should
 * put it. So the slot recorder must leave tabbed cards alone or the first layout
 * change after tabbing would overwrite home with the tab stack.
 */
export function slotIsLive(rung: Ladder): boolean {
  return rung === 'expanded';
}

// ── reveal triggers (§5.8) ──────────────────────────────────────────────────
//
// "Reveal triggers: needs-attention (permission / input / done) or user click
// anywhere (sidebar, event, lamp)."
//
// The click half has worked since P2-E15-08 — every click path funnels through
// GridController.focusSession, which reveals a card that has no panel. This is
// the other half: the session comes back on its own when it needs a human.

/**
 * The event kinds that bring a session back up, straight from §5.8's
 * parenthetical. `crashed` is NOT among them and that is deliberate rather than
 * an oversight: §5.8 enumerates three, a crashed session is not waiting on an
 * answer, and it still reaches you through the attention queue, its lamp and
 * the events list.
 *
 * E9-10 was named here as the item that would decide whether to widen it, and
 * it decided NOT to. The focus-stealing policy governs what a session that
 * "finishes or needs attention" may do — §5.8's own words, and the same three
 * kinds. A crash is neither; it is a session that has stopped, and pulling the
 * screen (or the cursor) to a dead terminal ahead of two live ones waiting on
 * an answer would invert the queue's own priority order.
 */
export const REVEAL_KINDS: readonly AttentionEvent['kind'][] = [
  'needs-permission',
  'needs-input',
  'done',
];

/** The subset of a feed event this module reads. Structural on purpose — the
 *  tests hand it plain objects, and it stays independent of EventDto's growth.
 *  `kind` is the QUEUE's union, not a bare string, so renaming a feed kind is a
 *  compile error here rather than a trigger that silently stops firing. */
export interface RevealEvent {
  /** minted fresh by EventFeed on EVERY ingest — see `seen` below */
  id: number;
  /** the LIVE session id; the caller maps it to a card */
  sessionId: string;
  kind: AttentionEvent['kind'];
}

export interface RevealPlan {
  /** cards to bring back to `expanded`, in event order */
  cardIds: string[];
  /**
   * Cards the focus-stealing policy lets take the cursor, in event order
   * (P2-E9-10). NOT a subset of `cardIds`: a card that is already on screen is
   * focused without being placed, which is the whole of what `smart` does for a
   * card you can see.
   */
  focusIds: string[];
  /** the event ids now accounted for — carry this forward */
  seen: ReadonlySet<number>;
}

/**
 * Which cards a fresh event list should reveal.
 *
 * SEEN IS KEYED BY EVENT ID, exactly as lib/queue's visited set is, and for the
 * same reason: EventFeed mints a new id on every ingest, so a session that is
 * answered, collapsed again and then blocks a second time arrives as an id
 * nobody has seen and reveals itself again. Keying by session would reveal it
 * once and never again for the life of the process.
 *
 * Ids that have left the list are dropped, so the set tracks the feed rather
 * than growing forever — and a replayed event (a feed refresh after a reconnect)
 * cannot arrive pre-seen and be silently skipped.
 *
 * The FIRST list is seeded, not acted on. At boot the feed hands over whatever
 * was already there, and §5.25 says the workspace comes back as the user left
 * it — a launch that instantly un-collapses every session that was waiting when
 * you quit yesterday is not that.
 */
export function revealTargets(
  events: readonly RevealEvent[],
  seen: ReadonlySet<number>,
  opts: {
    /** live session id -> durable card id */
    cardIdFor: (sessionId: string) => string;
    /**
     * Is this card's panel actually ON SCREEN right now?
     *
     * dockview's truth, not a rung: a card can be `expanded` and still be the
     * unselected tab of a stack, showing nothing but its label. This used to be
     * `rungOf` and a `=== 'expanded'` test, which got both halves subtly wrong —
     * it would have re-placed a panel that was merely behind a tab, and it made
     * "visible" (E9-10's word) mean something the user cannot see.
     */
    onScreen: (cardId: string) => boolean;
    /** false for the first list after boot: seed `seen`, reveal nothing */
    act: boolean;
    /**
     * §5.8's focus-stealing policy for this card (P2-E9-10) — what its owner
     * said an attention event may do to the workspace.
     *
     * REQUIRED, and deliberately not defaulted. A default would be the one
     * thing this module must not own: which of four settings a user is on. A
     * new call site that forgot it would get someone's preference by accident,
     * which is precisely the "answered by accident" §5.8 wrote this item to
     * stop. lib/focus-policy's `attentionResponse` is the answer; nothing here
     * knows how it was reached.
     */
    respond: (cardId: string, onScreen: boolean) => AttentionResponse;
  }
): RevealPlan {
  const live = new Set<number>();
  const cardIds: string[] = [];
  const focusIds: string[] = [];
  for (const e of events) {
    live.add(e.id);
    if (!opts.act) continue;
    if (seen.has(e.id)) continue;
    if (!REVEAL_KINDS.includes(e.kind)) continue;
    const cardId = opts.cardIdFor(e.sessionId);
    if (!cardId) continue;
    const onScreen = opts.onScreen(cardId);
    const response = opts.respond(cardId, onScreen);
    // `mark` and `ignore` change nothing about the workspace — the lamp and the
    // queue are the whole of their answer, and neither is ours to place here.
    if (!revealsCard(response)) continue;
    if (takesFocus(response) && !focusIds.includes(cardId)) focusIds.push(cardId);
    // A card you can already see has nothing to place, whatever rung it is on.
    // Placing it anyway would be a move for nothing at best — and at worst it
    // would drag a `tabbed` card out of the stack it was deliberately put in,
    // which is a rearrangement of the workspace, not a focus.
    if (onScreen) continue;
    if (!cardIds.includes(cardId)) cardIds.push(cardId);
  }
  // prune first, then admit: an id that is no longer in the feed must be
  // forgettable, or a session that blocks again after a quiet spell stays seen
  const next = new Set<number>();
  for (const id of seen) if (live.has(id)) next.add(id);
  for (const id of live) next.add(id);
  return { cardIds, focusIds, seen: next };
}

