// #967 — a busy session must keep following its own output.
//
// The owner, dogfooding: *"When it's doing a lot of things — Claude is working
// constantly — it doesn't always keep the session scrolled to the bottom."*
//
// The first describe below is that report, as four numbers. It is red against the
// rule this replaced, which is written out in `oldRule` so the difference is
// demonstrable rather than asserted — the point of the change is not that a new
// branch exists, it is that the old one got this case wrong.
import { describe, expect, it } from 'vitest';
import {
  canScrollUp,
  keyGesture,
  nextPin,
  TAIL_SLACK,
  wheelGesture,
  type PinInput,
} from './feed-pin';

const base: PinInput = {
  pinned: true,
  auto: false,
  delta: -100,
  away: 0,
  gestureRecent: false,
  // every case below that turns `gestureRecent` on means "the user scrolled", so
  // the gesture behind it is one that can — #1111's cases say otherwise out loud
  canScrollUp: true,
};

/**
 * The rule as it stood before #967, in the same signature.
 *
 * Kept so the regression tests can show the old answer rather than claim it. It
 * had no notion of the viewport moving at all: a recent gesture sent every scroll
 * down the last branch, where the pin was re-derived from raw distance.
 */
function oldRule(i: PinInput): { pinned: boolean; repin: boolean } {
  if (i.auto) return { pinned: i.pinned, repin: i.pinned && i.away >= 40 && !i.gestureRecent };
  if (!i.gestureRecent) return { pinned: i.pinned, repin: i.pinned };
  return { pinned: i.away < 40, repin: false };
}

describe('#967 — heavy streaming plus a click in the feed', () => {
  // A tool box expanded, a Copy button pressed, a click to focus: all of them go
  // through `onPointerDown` on the scroller and open the gesture window. None of
  // them is a scroll.
  const clickedNotScrolled: PinInput = {
    pinned: true,
    auto: false,
    delta: 0, // the whole point: they clicked, they did not SCROLL
    away: 900, // sustained output puts the tail far below the fold, continuously
    gestureRecent: true,
    canScrollUp: false, // a click
  };

  it('keeps the tail pinned, and follows it', () => {
    expect(nextPin(clickedNotScrolled)).toEqual({
      pinned: true,
      repin: true,
      userDriven: false,
    });
  });

  it('is the case the OLD rule got wrong — this is the regression', () => {
    expect(oldRule(clickedNotScrolled).pinned).toBe(false);
    expect(nextPin(clickedNotScrolled).pinned).toBe(true);
  });

  it('does not re-pin a feed the user had already scrolled away from', () => {
    // Content arriving under a stationary viewport is not a reason to drag
    // somebody back to a bottom they deliberately left.
    expect(nextPin({ ...clickedNotScrolled, pinned: false })).toEqual({
      pinned: false,
      repin: false,
      userDriven: false,
    });
  });

  it('ignores the gesture window entirely when the viewport did not move', () => {
    // The old rule asked HOW LONG AGO something was touched. This one asks whether
    // the view moved, and the timestamp cannot override that answer.
    for (const gestureRecent of [true, false]) {
      expect(nextPin({ ...base, delta: 0, away: 5_000, gestureRecent })).toEqual({
        pinned: true,
        repin: true,
        userDriven: false,
      });
    }
  });
});

describe('#967 — a scroll the user did not make, inside their gesture window', () => {
  // ⚠️ THE SECOND HALF, and the reason `delta` is a number rather than a boolean
  // (found in review). Closing the "scrollTop did not change" case is not enough:
  // a click opens the window, and Chrome's SCROLL ANCHORING then adjusts
  // `scrollTop` whenever content above the fold reflows — which a streaming
  // conversation does constantly. That adjustment is a real `scrollTop` change
  // with a real recent gesture behind it, and the old rule would unpin on it.
  //
  // The done-when says "unless the user makes a deliberate UPWARD scroll gesture".
  // Only movement away from the tail may unpin.
  //
  // ⚠️ THE GESTURE HERE IS ONE THAT CAN SCROLL UP — a wheel toward the top. These
  // cases used to be written for a CLICK, and the middle one asserted that a
  // click followed by a downward nudge of `scrollTop` unpins. That assertion was
  // #1111, pinned in place by its own test: see the describe below.
  const anchorNudge = (delta: number): PinInput => ({
    pinned: true,
    auto: false,
    delta,
    away: 900,
    gestureRecent: true,
    canScrollUp: true,
  });

  it('stays pinned when the adjustment moved the view TOWARD the tail', () => {
    expect(nextPin(anchorNudge(12)).pinned).toBe(true);
    // …and the old rule did not
    expect(oldRule(anchorNudge(12)).pinned).toBe(false);
  });

  it('unpins only when the movement was away from the tail', () => {
    expect(nextPin(anchorNudge(-12)).pinned).toBe(false);
  });

  it('is the difference between a nudge and a decision', () => {
    // Same distance, same gesture window, opposite directions — and only one of
    // them is somebody choosing to stop following.
    expect(nextPin(anchorNudge(-1)).pinned).toBe(false);
    expect(nextPin(anchorNudge(1)).pinned).toBe(true);
  });
});

describe('#1111 — at the block cap, `scrollTop` goes down without anybody scrolling', () => {
  // The owner, on a build with #967 in it: *"The session window is not scrolling
  // down all the time. I thought we fixed that."*
  //
  // REPRODUCED before it was fixed (`spike/probes/1111/`). At 1,000 blocks every
  // arriving block evicts the oldest from the top, and scroll anchoring lowers
  // `scrollTop` by the evicted block's height to hold the view still. So this is
  // the event a long session produces after EVERY block: moved "up", by a block's
  // height, with the new block below the fold.
  const evicted = (canScrollUp: boolean, gestureRecent = true): PinInput => ({
    pinned: true,
    auto: false,
    delta: -78, // the evicted block's height — measured, one of the probe's events
    away: 53, // …and the block that replaced it, not yet pinned to
    gestureRecent,
    canScrollUp,
  });

  /** #967's rule, which shipped in v0.8.100 and is what the owner was running */
  function ruleOf983(i: PinInput): boolean {
    if (i.auto || i.delta === 0 || !i.gestureRecent) return i.pinned;
    if (i.away < TAIL_SLACK) return true;
    return i.delta < 0 ? false : i.pinned;
  }

  it('keeps following after a click, and puts the view back on the tail', () => {
    expect(nextPin(evicted(false))).toEqual({ pinned: true, repin: true, userDriven: false });
  });

  it('is the case the #967 rule got wrong — this is the regression', () => {
    expect(ruleOf983(evicted(false))).toBe(false);
    expect(nextPin(evicted(false)).pinned).toBe(true);
  });

  it('still lets go when the gesture was one that scrolls up', () => {
    // The same numbers behind a wheel toward the top are a person leaving.
    expect(nextPin(evicted(true))).toEqual({ pinned: false, repin: false, userDriven: true });
  });

  it('does not save the shifted position as somewhere the user chose to read', () => {
    // `userDriven` is what writes the reading position (#555, #562). A reader
    // parked mid-history who clicks must not have an eviction recorded as theirs.
    expect(nextPin({ ...evicted(false), pinned: false, away: 4_000 })).toEqual({
      pinned: false,
      repin: false,
      userDriven: false,
    });
  });

  it('still counts a wheel toward the tail as the user arriving home', () => {
    // Downward movement was never the problem, and the way back that is not the
    // chip has to keep working behind a gesture that cannot scroll up.
    expect(
      nextPin({ ...evicted(false), pinned: false, delta: 300, away: TAIL_SLACK - 1 })
    ).toEqual({ pinned: true, repin: false, userDriven: true });
  });
});

describe('#1111 — which gestures can move the view away from the tail', () => {
  it('says no for everything that is not a scroll', () => {
    for (const g of ['press', 'wheel-down', 'key'] as const) expect(canScrollUp(g)).toBe(false);
    expect(canScrollUp(null)).toBe(false);
  });

  it('says yes for everything that can be one', () => {
    for (const g of [
      'wheel-up',
      'touch',
      'scrollbar',
      'drag',
      'middle-button',
      'key-up',
      'walk',
      'jump',
    ] as const) {
      expect(canScrollUp(g)).toBe(true);
    }
  });

  it('reads a wheel by its vertical direction, and a horizontal one as not up', () => {
    expect(wheelGesture(-1)).toBe('wheel-up');
    expect(wheelGesture(120)).toBe('wheel-down');
    expect(wheelGesture(0)).toBe('wheel-down');
  });

  it('reads a key by what it does to a focused scroller', () => {
    for (const key of ['ArrowUp', 'PageUp', 'Home']) expect(keyGesture(key, false, false)).toBe('key-up');
    expect(keyGesture(' ', true, false)).toBe('key-up');
    // Space alone pages DOWN, and the rest scroll nothing or scroll toward the tail
    for (const key of [' ', 'Shift', 'Control', 'c', 'ArrowDown', 'PageDown', 'End']) {
      expect(keyGesture(key, false, false)).toBe('key');
    }
  });

  it('counts every step of the keyboard walk, whichever key took it', () => {
    // `End` inside the walk goes to the last EXPANDER, which can be far above the
    // tail — the browser scrolls focus into view in either direction.
    for (const key of ['ArrowDown', 'End', 'ArrowUp']) expect(keyGesture(key, false, true)).toBe('walk');
  });
});

describe('#442 — the user is still in charge of where they read', () => {
  it('unpins on an upward gesture that takes them away from the tail', () => {
    expect(nextPin({ ...base, away: TAIL_SLACK, gestureRecent: true })).toEqual({
      pinned: false,
      repin: false,
      userDriven: true,
    });
  });

  it('re-pins on a gesture that lands them back on it, in either direction', () => {
    // Scrolling all the way down is the way home that is not the chip, and it
    // works whichever way the last few pixels went.
    for (const delta of [-300, 300]) {
      expect(nextPin({ ...base, pinned: false, delta, away: TAIL_SLACK - 1, gestureRecent: true })).toEqual(
        { pinned: true, repin: false, userDriven: true }
      );
    }
  });

  it('never yanks a user who is mid-gesture', () => {
    // `repin: false` is the assertion. Somebody dragging the scrollbar upward
    // through a streaming conversation must not be pulled back down by it.
    expect(nextPin({ ...base, away: 800, gestureRecent: true }).repin).toBe(false);
  });

  it('treats the slack as the boundary it is, on both sides', () => {
    const at = (away: number): boolean => nextPin({ ...base, away, gestureRecent: true }).pinned;
    expect(at(TAIL_SLACK - 1)).toBe(true);
    expect(at(TAIL_SLACK)).toBe(false);
  });

  it('does not count a wheel that moved nothing as scrolling away', () => {
    // Wheeling DOWN while already at the tail fires a gesture and a scroll, and
    // moves the viewport nowhere.
    expect(nextPin({ ...base, delta: 0, away: 0, gestureRecent: true })).toEqual({
      pinned: true,
      repin: true,
      userDriven: false,
    });
  });
});

describe('#112 — a layout scroll must not strand the view', () => {
  it('puts a pinned feed back when something else moved the viewport', () => {
    expect(nextPin({ ...base, away: 300 })).toEqual({
      pinned: true,
      repin: true,
      userDriven: false,
    });
  });

  it('leaves an unpinned feed where it is', () => {
    expect(nextPin({ ...base, pinned: false, away: 300 })).toEqual({
      pinned: false,
      repin: false,
      userDriven: false,
    });
  });

  it('corrects our OWN pin when it landed nowhere near the tail', () => {
    // `auto` stays set until the next animation frame, so a layout scroll landing
    // in that frame used to be swallowed with it — one scroll, view stranded
    // mid-history, nothing left to correct it. Measured in #112.
    expect(nextPin({ ...base, auto: true, away: 300 })).toEqual({
      pinned: true,
      repin: true,
      userDriven: false,
    });
  });

  it('does not correct its own pin over a user who is mid-gesture', () => {
    expect(nextPin({ ...base, auto: true, away: 300, gestureRecent: true }).repin).toBe(false);
  });

  it('still corrects it behind a CLICK, which is not anybody leaving (#1111)', () => {
    expect(
      nextPin({ ...base, auto: true, away: 300, gestureRecent: true, canScrollUp: false }).repin
    ).toBe(true);
  });

  it('does nothing when our own pin landed where it meant to', () => {
    expect(nextPin({ ...base, auto: true, away: 0 })).toEqual({
      pinned: true,
      repin: false,
      userDriven: false,
    });
  });
});

describe('userDriven marks the events worth saving as a reading position', () => {
  // #555 / #562: the saved position is what a panel switch or a relaunch puts the
  // user back at. Saving one from a layout scroll, a clamp or our own pin would
  // restore them to somewhere they never chose — which is why the caller keys off
  // this flag and not off "a scroll happened".
  it('is true only for a gesture that actually moved the view', () => {
    expect(nextPin({ ...base, away: 500, gestureRecent: true }).userDriven).toBe(true);
    expect(nextPin({ ...base, away: 500, gestureRecent: false }).userDriven).toBe(false);
    expect(nextPin({ ...base, delta: 0, gestureRecent: true }).userDriven).toBe(false);
    expect(nextPin({ ...base, auto: true, gestureRecent: true }).userDriven).toBe(false);
  });
});
