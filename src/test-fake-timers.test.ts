// The fake-timer net in `test-setup.ts`, pinned (#441).
//
// The invariant it buys: no test ever starts under the previous test's clock,
// and nothing the previous test left armed can fire inside it. That is not a
// style rule — it is the bug from #439, where a delayed CR scheduled by one
// `composer.test.ts` case fired into another case's assertions, because
// `vi.useFakeTimers()` re-uses an already-installed clock instead of replacing
// it.
//
// This file is deliberately ORDER-DEPENDENT: the first test arms a timer and
// walks away, the second one proves the arming could not reach it. Vitest runs
// the cases of one file in order, so the coupling is the point, not a hazard.
import { describe, expect, it, vi } from 'vitest';

/** set by the timer the first case abandons — must never become true */
let strayFired = false;

describe('the fake-timer net (#441)', () => {
  it('leaves a timer armed under a fake clock, and hands nothing back', () => {
    vi.useFakeTimers();
    setTimeout(() => {
      strayFired = true;
    }, 100);

    expect(vi.getTimerCount()).toBe(1);
    expect(vi.isFakeTimers()).toBe(true);
    // …and no teardown of its own. Exactly what a real test does when an
    // assertion fails before the line that would have flushed the clock.
  });

  it('starts on a real clock, with an empty queue, and the stray never fires', () => {
    // 1. the clock was handed back between the two cases
    expect(vi.isFakeTimers()).toBe(false);
    expect(strayFired).toBe(false);

    // 2. a fresh fake clock here inherits nothing — pre-#441 this was 1, and
    //    advancing past 100ms ran the other test's callback inside this one
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(strayFired).toBe(false);
  });
});
