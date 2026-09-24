// WHAT THE THREE CHORD FAMILIES SAY (#581) — the words, and nothing else.
//
// `lib/live-region.ts` is the channel and `components/LiveRegion.tsx` is the DOM;
// this is the sentence. Split out so the wording is unit-testable against the real
// resource file without a store, a window, or a dockview — which matters more than
// usual here, because a sentence is the entire user-visible product of this item
// and the only way to be wrong about it is to be read.
//
// TWO RULES DECIDED THE SHAPE OF EVERY SENTENCE BELOW.
//
// 1. SAY THE OUTCOME, NOT THE GESTURE. "Moved up" is what the user asked for;
//    "is now 2 of 5 in Work" is what happened. The rail's menu path settled this
//    already (`rail.reordered`) and it is the right answer for the ladder too: a
//    rung is a state, and the state is the news.
//
// 2. A REFUSAL IS ALSO AN OUTCOME. The menu can dim an item — #559 gives an
//    unavailable step `aria-disabled` so it is still focusable and announced as
//    unavailable. A chord has no such affordance, so silence at the top of a list
//    is a keypress that produced nothing at all, and the user cannot tell that
//    from a dead keybinding. Each family therefore has a second sentence that
//    says where the session still is, in the same shape as the first.
import i18next from 'i18next';
import { sessionStore } from '../store/session-store';
import { stepDown, stepUp } from './ladder';
import { announce } from './live-region';
import type { Ladder } from './presentation';
import { bucketLabel } from './rail-order';

/** The narrow slice of `t` these builders need — the same shape
 *  `McpManagerDialog` passes down, and trivially fakeable in a test. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * `Mod+Alt+P` — §5.8's pin, whose state is the whole of the news.
 *
 * Terse on purpose. `rail.pinnedHint` spells out what pinning DOES ("sorts first,
 * and bulk actions skip it") because a tooltip is read once by somebody wondering;
 * this is read on every press by somebody who already knows, and the rail row's
 * own accessible name (`rail.rowLabelPinned`) carries the state for anyone who
 * arrives at the row later.
 */
export function pinSaid(t: Translate, title: string, pinned: boolean): string {
  return t(pinned ? 'rail.announcePinned' : 'rail.announceUnpinned', { title });
}

/** Everything a reorder announcement needs, as facts rather than a store. */
export interface ReorderSaid {
  title: string;
  /** what the bucket is called — from `bucketLabel`, so both paths agree */
  group: string;
  /** 1-based, because it is spoken: "3 of 5", never "index 2" */
  position: number;
  count: number;
  /** did the list actually change? `sessionStore.reorderSession`'s own answer */
  moved: boolean;
}

/**
 * `Mod+Alt+Arrow` — #559's manual rail order.
 *
 * The moved case reuses `rail.reordered` VERBATIM: it is the sentence the menu
 * already speaks for the same state change, and §5.32's "never a parallel path
 * that can drift" applies to the words as much as to the write.
 *
 * The refused case covers more than the two ends of a group. `stepReorder` also
 * declines a move that would carry a session across §5.8's pinned/unpinned
 * boundary, and "is still 3 of 5" is the true and useful thing to say in all of
 * them — where a "that is not allowed" would have to explain a rule the user did
 * not ask about.
 */
export function reorderSaid(t: Translate, f: ReorderSaid): string {
  const vars = { title: f.title, position: f.position, count: f.count, group: f.group };
  return t(f.moved ? 'rail.reordered' : 'rail.announceReorderUnchanged', vars);
}

/**
 * `Mod+Shift+Arrow` — §5.8's presentation ladder.
 *
 * `changed` is false only when the card is already on the rung the step would
 * reach, which is the top or the bottom of the ladder — knowable synchronously,
 * unlike a real move. See `App`'s ladder wiring for why the other case waits for
 * the store instead of predicting.
 */
export function ladderSaid(t: Translate, title: string, rung: Ladder, changed = true): string {
  const vars = { title, rung: t(`ladder.rung.${rung}`) };
  return t(changed ? 'ladder.announceRung' : 'ladder.announceRungUnchanged', vars);
}

// ── THE PLUMBING ────────────────────────────────────────────────────────────
//
// Three entry points the COMMAND deps call, and deliberately not the shared
// callbacks underneath them. `togglePin` is also handed to the rail
// (`onTogglePin`), whose menu finishes that errand its own way: it restores focus
// to the row, and the row's accessible name carries the pin state
// (`rail.rowLabelPinned`). Announcing inside the shared callback would make one
// menu click produce both, read back to back.
//
// The store is read here rather than passed in because these run from a keydown
// handler, outside React's commit, which is the same reason the pin set and the
// manual order live in a store at all (see `sessionStore`'s header).

/** the singleton's `t`, narrowed to what the builders take. Imperative code, so
 *  reading the instance at call time IS reading the current language — no
 *  subscription and no re-render of the app's largest component. */
const t: Translate = (key, vars) => String(i18next.t(key, vars));

/** A session's spoken name, or undefined when the card is gone — the rail's
 *  "the row is gone (the session ended mid-move): drop the whole errand". The
 *  store's own accessor, which exists because "a card's title is about to have
 *  more than one reader" (see `getCardTitle`); this is another reader. */
const titleOf = (cardId: string): string | undefined => sessionStore.getCardTitle(cardId);

/** `Mod+Alt+P` has landed (the store write is synchronous): say which way. */
export function sayPinToggled(cardId: string): void {
  const title = titleOf(cardId);
  if (!title) return;
  announce(pinSaid(t, title, sessionStore.isPinned(cardId)));
}

/** `Mod+Alt+Arrow` has landed (also synchronous): say where the row sits now.
 *  `moved` is `sessionStore.reorderSession`'s own answer — its doc comment says
 *  that is what the boolean is for. */
export function sayReordered(cardId: string, moved: boolean): void {
  const title = titleOf(cardId);
  if (!title) return;
  const order = sessionStore.getRailOrder();
  const bucket = order.bucketOf.get(cardId);
  if (!bucket) return; // no bucket, no position to name
  const ids = order.buckets.get(bucket) ?? [];
  const position = ids.indexOf(cardId) + 1;
  if (position === 0) return; // derived order hasn't caught up; better silent than wrong
  announce(
    reorderSaid(t, {
      title,
      group: bucketLabel(bucket, sessionStore.getState().groups, t('rail.ungrouped')),
      position,
      count: ids.length,
      moved,
    })
  );
}

/**
 * Run a `Mod+Shift+Arrow` step and say what rung it reached — the one family
 * whose outcome is not knowable when the command returns.
 *
 * SAY WHAT THE STORE COMMITTED TO, NEVER WHAT THE KEY ASKED FOR. A predicted
 * rung is a lie in cases that really happen: `moveCardToRung` refuses a step
 * fired while a transition is still in flight (`laddering`), and `toTabbed`
 * abandons the move when the card's record vanishes under it. §5.32's own note is
 * that a live region which lies is worse than a silent one.
 *
 * SO IT WAITS ON THE COMMAND'S OWN PROMISE, and that is a correction worth
 * recording, because the first version of this waited on the STORE instead — a
 * subscription that announced as soon as the rung changed, on the model of
 * `SessionsRail`'s `pendingMove`. Review found what that cannot do: a transition
 * that bails WITHOUT writing a rung never satisfies the condition, so the
 * listener stays armed, and the next rung change from anywhere at all — the strip
 * row, the card header, an E9-07 layout sweep moving a dozen cards — gets
 * announced as this keypress's outcome. `stepCardLadder` resolves when the
 * transition is OVER rather than when it succeeded, which is exactly the
 * difference, and it needs no listener, no deadline and no bookkeeping.
 *
 * The one thing still answered up front is the END of the ladder: `stepUp` and
 * `stepDown` are pure, so a step that reaches the rung it started on is known to
 * be a no-op before the command runs.
 *
 * TWO PRESSES INSIDE ONE TRANSITION each get their own promise, and no supersede
 * logic replaces the one the store watch needed. The second press is refused by
 * `laddering` and resolves at once with the rung unchanged, so it says "is already
 * tabbed" — true of that press, which really did nothing — and then the first
 * press lands and says where the card went. Slightly chatty, never false, and the
 * alternative (silence for the second press) is the thing this item exists to
 * remove. Note that only the ASYNC rungs can be in flight at all: collapsing and
 * hiding write synchronously, and a card below `expanded` has no panel, which
 * makes every card-scoped chord inert until a reveal brings it back.
 *
 * @param run the command itself, awaited for its completion rather than its
 *   success. The starting rung is captured first so the two cannot drift.
 */
export function stepLadderAloud(
  cardId: string,
  dir: 'up' | 'down',
  run: () => Promise<void> | void
): void {
  const from = sessionStore.getPresentation(cardId).ladder;
  const want = dir === 'up' ? stepUp(from) : stepDown(from);

  // A COMMAND THAT THREW IS TREATED AS ONE THAT FINISHED, and the rung is read
  // either way. That is the same argument that made this wait at all: only the
  // store knows where the card ended up, and that is as true of a failed
  // transition as of a successful one — a throw AFTER the rung was written still
  // moved the card, and one before it did not. So there is no case where a
  // rejection tells us something the store does not, and reporting the state we
  // find is right in both.
  //
  // It also has to be swallowed HERE rather than at the end of the chain: without
  // a catch the announcer would turn a failed layout command into an unhandled
  // rejection, which is our breakage making a session's problem worse
  // (PHILOSOPHY §3, fail-open) — and attaching it after the end-of-ladder return
  // below would leave that one path uncovered. `moveCardToRung` happens to answer
  // that case with a resolved promise today, but that is an invariant in another
  // file and this is not the place to depend on it.
  const settled = Promise.resolve(run()).catch(() => undefined);

  // the top or the bottom of the ladder: nothing is coming, so say so now
  if (want === from) {
    const title = titleOf(cardId);
    if (title) announce(ladderSaid(t, title, from, false));
    return;
  }

  void settled
    .then(() => {
      // the title is read HERE and not before the move: a session renamed during
      // the round trip is announced under the name it has now
      const title = titleOf(cardId);
      if (!title) return; // gone mid-move: drop the errand rather than name a ghost
      const now = sessionStore.getPresentation(cardId).ladder;
      // `now`, not `want`. A transition that ended somewhere else says where it
      // ended; one that moved nothing says the card is still where it was, which
      // is the same shape as the end-of-ladder answer and for the same reason —
      // silence is indistinguishable from a binding that has stopped working.
      announce(ladderSaid(t, title, now, now !== from));
    })
    .catch(() => {
      // The command's own failure is already handled above; this covers a throw
      // from the SENTENCE — a malformed ICU string in the catalog would otherwise
      // become an unhandled rejection out of a keydown handler. Nothing left to
      // say, and saying nothing is not allowed to be loud (PHILOSOPHY §3).
    });
}
