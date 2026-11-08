// "Is this still linear?" without a stopwatch budget (#651).
//
// A wall-clock budget in a unit test (`expect(Date.now() - t0).toBeLessThan(200)`)
// fails when the MACHINE is busy, not when the code is slow: a full `npm test`
// beside a build or an e2e run spends the budget for it. What those budgets
// were guarding is a complexity regression (a trim that went quadratic, a walk
// that went quadratic), and that shows up as GROWTH: eight times the input
// costing about eight times as much, or sixty-four. Load slows both
// measurements alike, so the ratio survives it where an absolute number does
// not. Medians of a few runs, so one slow moment does not decide it.
import { performance } from 'node:perf_hooks';

/** The median wall time of `fn` over `runs` calls, in milliseconds. */
export function medianMs(fn: () => unknown, runs = 5): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * How many times more the larger input cost. The smaller cost is floored at
 * 1 ms: below that a timer's own noise is the measurement, and a 0.02 ms run
 * next to a 0.5 ms one would read as 25x growth for a linear function.
 */
export function growth(smallMs: number, largeMs: number): number {
  return largeMs / Math.max(smallMs, 1);
}
