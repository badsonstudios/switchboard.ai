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
import { nextPin, TAIL_SLACK, type PinInput } from './feed-pin';

const base: PinInput = {
  pinned: true,
  auto: false,
  delta: -100,
  away: 0,
  gestureRecent: false,
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
  const anchorNudge = (delta: number): PinInput => ({
    pinned: true,
    auto: false,
    delta,
    away: 900,
    gestureRecent: true,
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
