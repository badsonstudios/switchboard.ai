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
// ── #1111: AN UPWARD NUMBER IS NOT AN UPWARD SCROLL ─────────────────────────
//
// The owner again, on a build with all of the above: *"The session window is not
// scrolling down all the time. I thought we fixed that."*
//
// Rule 2 was right that only upward movement may unpin, and wrong about who can
// produce it. REPRODUCED before anything was changed (`spike/probes/1111/`: real
// blocks replayed into the running app, with a fuzzer that never scrolls up):
//
//     input while streaming            conversation         false unpins
//     none                             at the 1,000 cap     0
//     clicks on empty gutter           at the 1,000 cap     23 of 44, 28 of 74
//     clicks on empty gutter           ~470 blocks          0 of 169, 0 of 246
//     wheel DOWN only                  at the 1,000 cap     11 of 109
//
// `upsertBlock` caps the view at 1,000 blocks, so in a long session every new
// block EVICTS the oldest one from the top. Scroll anchoring holds the view still
// by moving `scrollTop` down by the evicted block's height: nothing moves on
// screen, and `delta` is negative. A click or a wheel-down opened the gesture
// window, and the next evicting block closed the pin. It needs 1,000 blocks, which
// is why two rounds of tests on 260 could not see it — and it is exactly "Claude
// is working constantly".
//
// So the question is no longer only "did it move up" but **could THAT gesture
// have moved it up**. A wheel toward the top can. A drag, a press on the
// scrollbar, a touch, an upward key can. A click cannot, a wheel toward the tail
// cannot, Shift cannot — and upward movement behind one of those is the layout's,
// whatever the clock says. `FeedGesture` is the vocabulary; `canScrollUp` is the
// one place it is decided.
//
// What was NOT done, each because it trades this report for another one:
// `overflow-anchor: none` (a reader parked mid-history at the cap would have the
// text slide under them on every block); re-reading `scrollTop` after each
// evicting commit (a forced layout per block, in the long sessions #716 and #1013
// are about); a "content shifted" flag (it swallows real upward scrolls while
// blocks arrive every frame).
//
// ⚠️ KNOWN RESIDUAL: a drag with the button held — selecting text — at the cap can
// still be read as scrolling up, because a drag genuinely can scroll.
//
// ── COST ────────────────────────────────────────────────────────────────────
//
// One subtraction and two comparisons per scroll event, and nothing per appended
// block. The feed is already the typing-lag suspect (#716, #740), so a fix that
// added work to the append path would be trading one report for another.

/**
 * What the user last did to the conversation (#1111).
 *
 * Named for the PHYSICAL gesture rather than for an intent, because the intent is
 * what is being inferred: the component reports what it saw, and `canScrollUp`
 * below is the single place that says what each one is capable of.
 */
export type FeedGesture =
  /** a wheel toward the top of the conversation */
  | 'wheel-up'
  /** a wheel toward the tail, or one with no vertical component at all */
  | 'wheel-down'
  /** a finger on the conversation — direction is not worth the per-move cost */
  | 'touch'
  /** a button went down on the conversation and has not travelled: a click */
  | 'press'
  /** a button went down on the scrollbar itself — the thumb or the track */
  | 'scrollbar'
  /** a press that travelled with the button held: a selection, an autoscroll */
  | 'drag'
  /** the middle button, which starts an autoscroll that outlives the release */
  | 'middle-button'
  /** a key that scrolls the region toward the top by itself */
  | 'key-up'
  /** any other key with focus in the conversation */
  | 'key'
  /** the #174 keyboard walk moved focus, and the browser scrolls focus into view */
  | 'walk'
  /** a find jump, which unpins on purpose */
  | 'jump';

const CAN_SCROLL_UP: ReadonlySet<FeedGesture> = new Set<FeedGesture>([
  'wheel-up',
  'touch',
  'scrollbar',
  'drag',
  'middle-button',
  'key-up',
  'walk',
  'jump',
]);

/**
 * Could this gesture have moved the view AWAY from the tail?
 *
 * `null` — nothing has touched the conversation yet — cannot.
 */
export function canScrollUp(gesture: FeedGesture | null): boolean {
  return gesture !== null && CAN_SCROLL_UP.has(gesture);
}

/** Which way a wheel event points. Zero is horizontal, and horizontal is not up. */
export function wheelGesture(deltaY: number): FeedGesture {
  return deltaY < 0 ? 'wheel-up' : 'wheel-down';
}

/**
 * What a key press in the conversation is.
 *
 * `walked` is "the #174 walk took this key and moved focus": the browser scrolls
 * the newly focused control into view, in either direction, so every walk step
 * counts — `End` goes to the last EXPANDER, which can be far above the tail.
 * Otherwise only the keys that scroll a focused region upward by themselves do.
 */
export function keyGesture(key: string, shiftKey: boolean, walked: boolean): FeedGesture {
  if (walked) return 'walk';
  if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') return 'key-up';
  if (key === ' ' && shiftKey) return 'key-up';
  return 'key';
}

/**
 * How far a press must travel, button held, before it is a drag.
 *
 * A click is rarely perfectly still — a pixel or two of travel between down and
 * up is ordinary — and a click must never be promoted to something that can
 * scroll, or #1111 is back for anyone with a twitchy mouse.
 */
export const DRAG_SLOP_PX = 6;

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
  /**
   * That touch was one that can move the view away from the tail (#1111) —
   * `canScrollUp` of the last gesture.
   *
   * ⚠️ WITHOUT THIS, `delta < 0` IS NOT EVIDENCE OF ANYTHING. At the 1,000-block
   * cap every arriving block evicts one from the top and scroll anchoring lowers
   * `scrollTop` to compensate, so a negative delta arrives after every click.
   */
  canScrollUp: boolean;
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
  const { pinned, auto, delta, away, gestureRecent, canScrollUp: upward } = input;

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
      // "mid-gesture" means one that can take them away (#1111): a click must not
      // switch this repair off for half a second
      repin: pinned && away >= TAIL_SLACK && !(gestureRecent && upward),
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

  // ── it moved UP, behind a gesture that cannot move it up (#1111) ───────────
  //
  // A click, a wheel toward the tail, a modifier key. The window is open and the
  // number went down, and until #1111 that was enough to stop following — but
  // none of those can scroll a conversation upward, so something else did: an
  // evicted block and the anchoring that compensated for it, most of the time.
  //
  // Handled exactly like the no-gesture case above, because it IS that case with
  // an irrelevant timestamp attached. Only beyond the slack: a few pixels inside
  // it is still the user arriving home, below.
  if (delta < 0 && !upward && away >= TAIL_SLACK) {
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
