// The rule the card's held-permission queue applies when a session ends (#239).
//
// A held request is a question the CLI is BLOCKED on, and it belongs to the
// live session that asked it — an ephemeral id that churns on every restart and
// resume. The card that shows the review bar outlives that id, and the queue is
// React state inside a component that Restart and the popout-close suspend both
// leave MOUNTED. So the queue has to be told when a session stops existing, or
// the next session's bar opens holding the corpse's question: Allow decides a
// request that has already been released, and "Allow all" writes a grant keyed
// by an id no map holds — the #224 leak, one user click at a time.
//
// Here rather than inline in the effect, for the reason `pruneLit` and
// `prunePresentation` are here: the trigger belongs to React, the RULE does
// not, and a rule with no test is a rule nothing stops from drifting. Two
// triggers share it — the store's live-retired signal (a renderer-side
// teardown) and the session's own exit — and they must not be able to disagree
// about what "belongs to that session" means.

/**
 * Drop everything the retired session raised, and nothing else.
 *
 * Returns the SAME array when nothing matched, so a card that has never queued
 * anything does not take a state change per teardown — the overwhelmingly
 * common case, since the store's retirement signal reaches every mounted card
 * and only one of them can own the dead session's questions.
 *
 * Keyed on the dead id and never on "not the current live id": a fresh mount
 * replays `pendingPermissions` and can land those holds before the lazy spawn
 * has bound `live` at all, and "I have not learned this card's session yet" must
 * not read as "every held request is stale" (E10-04 review P0#3 — a missed push
 * must never park the CLI).
 */
export function dropRetired<T extends { sessionId: string }>(queue: T[], retiredLiveId: string): T[] {
  const next = queue.filter((held) => held.sessionId !== retiredLiveId);
  return next.length === queue.length ? queue : next;
}
