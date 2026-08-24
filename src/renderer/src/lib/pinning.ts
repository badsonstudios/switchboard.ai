// §5.8's PINNING CONTRACT (P2-E9-09), verbatim:
//
//   "a pinned session sorts first in the rail, never scrolls out of view under
//    overflow, and is exempt from EVERY bulk operation — bulk-close, idle
//    aggregation, auto-collapse sweeps, and any future auto-eviction. Pin/unpin
//    is one gesture. Pinned ≠ always-expanded: a pinned session may still be a
//    strip — pinning protects existence and position, not size."
//
// PINNING IS A PROTECTION CONTRACT, NOT A RUNG. That sentence is the whole
// design and it is worth being precise about, because the obvious reading —
// "pinned means always expanded" — is the one §5.8 explicitly rules out:
//
//   • EXISTENCE. A pinned session is not closed by anything that closes
//     sessions in bulk, and will not be evicted by any future policy that
//     retires sessions on its own initiative.
//   • POSITION. A pinned session sorts first among its peers and is never
//     folded away into a summary row, so the place you look for it is the place
//     it is.
//   • NOT SIZE. Every rung of the ladder stays available to a pinned session,
//     BY HAND. Collapse it, tab it, hide it — pinning does not argue. What it
//     stops is the MACHINE doing any of that unasked.
//
// The last distinction is what makes "exempt from auto-collapse sweeps" and
// "pinned ≠ always-expanded" consistent rather than contradictory, and it is
// the rule every exemption below is derived from: the exemption fires when
// something happens TO the session (a sweep on submit, a fold, a bulk close),
// never when the user does something WITH it.
//
// ── WHERE THE EXEMPTIONS LIVE, AND WHY NOT HERE ─────────────────────────────
//
// This module owns the STATE and the two rules that are purely about pinning
// (sort-first, and which cards a bulk operation may take). The exemptions
// themselves live in the rule they exempt from, one line each, because that is
// the only place a future reader of THAT rule will look:
//
//   sort first          lib/groups          `railOrder` pre-sorts its input
//   idle aggregation    lib/ladder          `foldableRow` — a pinned row never folds
//   auto-collapse       lib/presentation-policy  `submitTarget` returns null
//   bulk-close          `closableCards` below, applied by the close-all command
//
// AND ONE DELIBERATE NON-EXEMPTION: lib/layout-mode's `plan`. A layout mode is
// the user asking, in one gesture, for a whole arrangement — and it only ever
// changes a card's RUNG, which is exactly the thing §5.8 says pinning does not
// protect. Exempting pinned cards there would break focus mode outright ("one
// large + slim strips" with two large cards is not focus mode) and would make
// pinning mean always-expanded through the back door. The contract still holds
// end to end: a pinned card that a mode collapses lands in the strip and keeps
// its own row there, because the fold exemption is what protects position.
//
// ── "NEVER SCROLLS OUT OF VIEW UNDER OVERFLOW" — SHIPPED, WITH ONE LIMIT ────
//
// §5.8 lists that alongside "sorts first". #78 shipped the sort and said
// plainly that this clause was the unfinished half; #295 finished it, and this
// paragraph is that note being replaced rather than left to mislead.
//
// It lives in the COMPONENT, not here, because it is geometry rather than a
// rule about which cards a policy may take: `SessionsRail`'s `bucketRows` lifts
// a bucket's pinned prefix into one `position: sticky` block, so scrolling
// slides the unpinned rows underneath them. The four design decisions it makes
// — sticky rows over a hoisted shelf, one block per bucket, a group header that
// is NOT sticky, and a keyboard guard so nothing is focused under the block —
// are written out there.
//
// THE ONE LIMIT, because a contract you believe is complete is the thing this
// header exists to prevent: a sticky box cannot leave its containing block. On
// a workspace with no groups the loose list IS the scroll content, so the
// guarantee is unconditional. Inside a GROUP card it reads "while that card is
// on screen" — scroll past the entire group and its pins go with it. Closing
// that would mean hoisting pins out of the group the user filed them under,
// which is the trade `lib/groups`' `railOrder` already refused.
//
// ── THE AUTO-EVICTION SEAM ──────────────────────────────────────────────────
//
// §5.8 names "any future auto-eviction" among the bulk operations pinning is
// exempt from. NOTHING EVICTS SESSIONS TODAY — there is no LRU, no session cap,
// no idle reaper — so there is nothing here to exempt from, and inventing the
// policy in order to be exempt from it would be building the feature backwards.
//
// The seam is `closableCards`: it is the one function that answers "which of
// these cards may a bulk operation take?", and an eviction policy is by
// definition a bulk operation. Route the candidate list through it and the
// exemption arrives already written, already unit-tested. Do not add a second
// `if (pinned)` beside the new policy.

/** Pinned CARD ids. Cards and not live session ids: a live id churns on every
 *  resume, and a pin that vanished the first time a session restarted would
 *  protect nothing. Same durable key as presentation, policy and layout. */
export type PinSet = ReadonlySet<string>;

/**
 * The empty set — SHARED, because the store's initial value must be ONE stable
 * object or every useSyncExternalStore snapshot over it re-renders forever.
 *
 * `ReadonlySet` is the whole of the protection, and it is a compile-time one:
 * `Object.freeze` does nothing to a Set's internal slots, so freezing this
 * would only look like a guarantee. Every edit in this module returns a new
 * set rather than touching one, which is what actually keeps it empty.
 */
export const NO_PINS: PinSet = new Set<string>();

/** ui-blob key (§5.25: a pin survives relaunch). */
export const PIN_KEY = 'pinned';

export function isPinned(pins: PinSet, cardId: string | undefined): boolean {
  return !!cardId && pins.has(cardId);
}

/**
 * Pin or unpin one card.
 *
 * Returns the SAME set when nothing changed — identity is the store's change
 * signal, and a no-op write would re-derive rail order and re-render every row.
 */
export function withPin(pins: PinSet, cardId: string, pinned: boolean): PinSet {
  if (!cardId || pins.has(cardId) === pinned) return pins;
  const next = new Set(pins);
  if (pinned) next.add(cardId);
  else next.delete(cardId);
  return next;
}

/** §5.8's "pin/unpin is ONE gesture" — the same control both ways. */
export function togglePin(pins: PinSet, cardId: string): PinSet {
  return withPin(pins, cardId, !pins.has(cardId));
}

/**
 * Drop pins for cards that no longer exist.
 *
 * Returns null when there is nothing to drop, so the caller can skip a pointless
 * write and re-render — the same contract `prunePresentation`, `prunePolicies`
 * and `pruneLayout` use, and for the same reason: a workspace must not accrete a
 * record per session it ever opened.
 */
export function prunePins(pins: PinSet, knownCardIds: Iterable<string>): PinSet | null {
  const known = new Set(knownCardIds);
  const stale = [...pins].filter((id) => !known.has(id));
  if (stale.length === 0) return null;
  const next = new Set(pins);
  for (const id of stale) next.delete(id);
  return next;
}

/**
 * Pinned first, everything else in the order it arrived.
 *
 * STABLE ON BOTH SIDES, which is the entire requirement: the rail is the
 * numbering authority for Ctrl+1..9 and what the urgency strip and the collapsed
 * strip both paint, so pinning may promote a session but must never shuffle the
 * ones around it. A partition does that; `Array.prototype.sort` is stable in
 * every engine we ship on and would too, but it would also invite a comparator
 * that grows a second sort key later.
 *
 * Applied to ONE BUCKET at a time by its caller — see lib/groups' `railOrder`
 * for why sorting the whole list up front would break the promise above.
 */
export function sortPinnedFirst<T extends { id: string }>(items: T[], pins: PinSet): T[] {
  // the common case is no pins at all: hand back the very same array so the
  // caller's identity checks (and React's) see nothing to do
  if (pins.size === 0 || !items.some((i) => pins.has(i.id))) return items;
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) (pins.has(item.id) ? pinned : rest).push(item);
  return [...pinned, ...rest];
}

/**
 * Which of these cards a BULK operation may take — the exemption itself.
 *
 * The one function every bulk operation asks, so the protection cannot be
 * implemented once per operation and forgotten by the next one. Today that is
 * close-all; §5.8's "any future auto-eviction" is meant to arrive through here
 * too (see the seam note in the header).
 *
 * Order is preserved, so a caller that closes in rail order still does.
 */
export function closableCards(cardIds: readonly string[], pins: PinSet): string[] {
  return cardIds.filter((id) => !pins.has(id));
}

/** What a bulk operation is about to do, and what it is sparing. */
export interface BulkPlan {
  /** the cards it may take, in the order it was given them */
  doomed: string[];
  /** how many it is leaving alone because they are pinned */
  spared: number;
}

/**
 * `closableCards` plus the number it spared — the whole ANSWER a bulk operation
 * needs before it opens a dialog.
 *
 * A separate function because `spared` is the part a caller gets wrong: it is
 * the count it has to put in front of the user ("closing 6, keeping 2"), and
 * deriving it at the call site means a second walk of the same list and a second
 * chance to walk the wrong one. `doomed.length === 0` with `spared > 0` is the
 * case worth naming — every card is pinned, and the caller must SAY so rather
 * than open a confirm over an empty list, which reads as the command being
 * broken.
 *
 * It lives here and not in the component for the reason `runMoves` lives in
 * lib/layout-sweep and not in SessionGrid: the decision is a rule, the dialog is
 * an effect, and only one of the two can be a unit test.
 */
export function bulkClose(cardIds: readonly string[], pins: PinSet): BulkPlan {
  const doomed = closableCards(cardIds, pins);
  return { doomed, spared: cardIds.length - doomed.length };
}

// ── persistence ─────────────────────────────────────────────────────────────

/** One ui-blob record -> a pin set. Anything unrecognised is skipped rather
 *  than throwing: a blob outlives the code that wrote it, and a stale value
 *  must never cost the user their workspace. */
export function loadPins(raw: unknown): PinSet {
  if (!Array.isArray(raw)) return NO_PINS;
  const out = new Set<string>();
  for (const id of raw) if (typeof id === 'string' && id) out.add(id);
  return out.size > 0 ? out : NO_PINS;
}

/** The set, reduced to what goes in the blob. A workspace with nothing pinned
 *  writes nothing at all — `null` means "delete the key". Sorted, so an
 *  unchanged set does not rewrite the file in a different order each launch. */
export function persistablePins(pins: PinSet): string[] | null {
  if (pins.size === 0) return null;
  return [...pins].sort();
}
