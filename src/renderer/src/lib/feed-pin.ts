// Whether a scroll event should change the feed's tail pin (#967, §5.10).
//
// ── WHY THIS IS A MODULE AND NOT FORTY LINES INSIDE AN `onScroll` PROP ──────
//
// Because that is where it was, and this is the sixth bug in it: #112 (a layout
// scroll in the same frame as our own pin stranded the view mid-history), #442
// (the pin model itself), #555 and #562 (losing the tail across a panel switch
// and a restore), #740 (re-layout scrolls the feed), and now #967. Every one of
// them is a decision about a handful of booleans, and not one of them was
// reachable from a unit test while the decision lived in a JSX attribute.
//
// ── THE RULE, AND WHAT CHANGED IN #967 ──────────────────────────────────────
//
// The owner's report: *"When it's doing a lot of things — Claude is working
// constantly — it doesn't always keep the session scrolled to the bottom."*
//
// The old rule asked HOW LONG AGO the user touched the feed. Any touch opened a
// 500ms window in which a scroll event was taken as the user's, and the last
// branch then re-derived the pin from raw distance:
//
//     pinned = scrollHeight - scrollTop - clientHeight < 40
//
// `onPointerDown` is one of the things that opens that window, and it fires for
// ANY click in the conversation — expanding a tool box, pressing Copy, clicking
// to focus. Under sustained streaming the distance is ≥40 more or less
// continuously. So **one click in the feed plus one scroll the user did not make,
// within half a second, unpinned the tail** — exactly the owner's case, because
// heavy output is when he is most likely to be clicking around in it.
//
// Two things replace it, and both are needed:
//
//  1. **Did the viewport move at all?** A user scroll changes `scrollTop`.
//     Content arriving below the fold changes `scrollHeight`. So an event whose
//     `scrollTop` is where we left it cannot be the user, whatever the timestamp
//     says.
//  2. **Did it move UP?** The done-when is "unless the user makes a deliberate
//     upward scroll gesture", and that word is load-bearing. A click inside the
//     gesture window can still be followed by a scroll the user did not make —
//     Chrome's scroll anchoring adjusts `scrollTop` when content above the fold
//     reflows, which a streaming conversation does constantly — and that
//     adjustment can move the view by a few pixels in either direction. Only
//     movement AWAY from the tail may unpin. Movement toward it may re-pin, which
//     is #442's other half.
//
// The timestamp still earns its place for the case it was added for (#112): a
// scroll that DID move the viewport, with no gesture behind it, is the layout
// moving it, and a pinned feed is put back on the tail rather than stranded.
//
// ── COST ────────────────────────────────────────────────────────────────────
//
// One subtraction and two comparisons per scroll event, and nothing per appended
// block. The feed is already the typing-lag suspect (#716, #740), so a fix that
// added work to the append path would be trading one report for another.

/** What the scroller looks like right now, and what we know about how it got here. */
export interface PinInput {
  /** is the feed currently following the tail? */
  pinned: boolean;
  /** this scroll came from our OWN `scrollTop` write */
  auto: boolean;
  /**
   * `scrollTop` now, minus where we last knew it to be. Positive is toward the
   * tail.
   *
   * ⚠️ THE INPUT THE OLD RULE DID NOT HAVE, and the reason it got #967 wrong.
   * Zero means the viewport is exactly where it was and only the CONTENT changed
   * under it, which is never a user scrolling. Negative is the only thing that may
   * unpin — see the header on why "upward" is load-bearing rather than pedantic.
   */
  delta: number;
  /** px from the tail: `scrollHeight - scrollTop - clientHeight` */
  away: number;
  /** the user touched this scroller within the gesture window */
  gestureRecent: boolean;
}

export interface PinDecision {
  /** the pin after this event */
  pinned: boolean;
  /** put the scroller back on the tail */
  repin: boolean;
  /**
   * This event was the user moving the view, so where they landed is their
   * reading position and worth restoring them to later (#555, #562).
   *
   * The caller must not save a position from any other kind of event: a layout
   * scroll, a clamp during a re-show, or our own pin are all places the user never
   * chose to be.
   */
  userDriven: boolean;
}

/**
 * How close to the bottom still counts as "at the tail".
 *
 * #442's number. Exported and IMPORTED by the Jump-to-latest chip's own visibility
 * rule, so the two cannot disagree about whether the feed is at its end.
 */
export const TAIL_SLACK = 40;

export function nextPin(input: PinInput): PinDecision {
  const { pinned, auto, delta, away, gestureRecent } = input;

  // ── our own pin landing ────────────────────────────────────────────────────
  //
  // Normally nothing to do. But `auto` stays set until the next animation frame,
  // and a LAYOUT scroll arriving in that same frame used to be swallowed with it,
  // leaving the view stranded mid-history with output below the fold and no
  // further event to correct it (#112, measured: the stranded run saw exactly one
  // scroll, with `auto` already true).
  //
  // Our pin always lands ON the tail, so an event here that is nowhere near it is
  // somebody else's — correct it, unless the user is mid-gesture, who must never
  // be yanked back.
  if (auto) {
    return {
      pinned,
      repin: pinned && away >= TAIL_SLACK && !gestureRecent,
      userDriven: false,
    };
  }

  // ── the viewport did not move (#967) ──────────────────────────────────────
  //
  // The pin is untouchable here. A click in the feed within the last half second
  // used to send this case down the user branch, where the distance — large,
  // because the session is streaming — read as "they scrolled away".
  //
  // WHAT ACTUALLY FIRES THIS, said precisely because the obvious reading is wrong
  // (review): content growing fires no scroll event at all. The events that land
  // here are late-dispatched echoes of our OWN writes, and browser bounces —
  // arriving after `auto` has been cleared, so they no longer look like ours. The
  // distinguishing fact is the one the branch tests: `scrollTop` is where we left
  // it, so whatever produced the event, nobody moved the view.
  //
  // A pinned feed still gets put back on the tail, because that is what being
  // pinned MEANS while content is arriving.
  if (delta === 0) {
    return { pinned, repin: pinned, userDriven: false };
  }

  // ── the viewport moved, and nobody asked it to ────────────────────────────
  //
  // The approval bar docking, the working banner appearing, content reflowing.
  // It must never change what the user wants — and if they were following the
  // tail, put them back on it rather than leaving output below the fold.
  if (!gestureRecent) {
    return { pinned, repin: pinned, userDriven: false };
  }

  // ── the user moved it ─────────────────────────────────────────────────────
  //
  // The only branch that may change the pin, and #442's contract in two lines.
  //
  // Landing within the slack always follows the tail again, however you got
  // there — that is the "scroll all the way back down" way home, and it is why
  // the chip is not the only one.
  //
  // Leaving it only counts if you went UP. A downward adjustment that happens to
  // stop short of the tail is not a decision to stop following, and inside the
  // gesture window the adjustment need not be the user's at all (scroll
  // anchoring). #967's done-when says "a deliberate upward scroll gesture", and
  // this is that sentence.
  if (away < TAIL_SLACK) return { pinned: true, repin: false, userDriven: true };
  return { pinned: delta < 0 ? false : pinned, repin: false, userDriven: true };
}
