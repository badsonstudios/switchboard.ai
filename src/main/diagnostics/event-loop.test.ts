import { describe, it, expect, vi } from 'vitest';
import type { IntervalHistogram } from 'perf_hooks';
import { EventLoopDelay } from './event-loop';

/**
 * A histogram we drive by hand. The real one needs a real blocked loop and a
 * real minute to say anything, and a test that waits a minute to learn that
 * nanoseconds divide by a million is a test nobody will keep running.
 */
function fakeHistogram(values: { p50: number; p99: number; max: number }): IntervalHistogram & {
  resets: number;
  enabled: boolean;
} {
  const h = {
    resets: 0,
    enabled: false,
    enable: (): boolean => {
      h.enabled = true;
      return true;
    },
    disable: (): boolean => {
      h.enabled = false;
      return true;
    },
    reset: (): void => {
      h.resets += 1;
    },
    percentile: (p: number): number => (p === 50 ? values.p50 : values.p99),
    get max(): number {
      return values.max;
    },
  };
  return h as unknown as IntervalHistogram & { resets: number; enabled: boolean };
}

const NS = 1e6; // one millisecond

describe('EventLoopDelay (#923)', () => {
  it('reports milliseconds, not the nanoseconds the histogram speaks', () => {
    const h = fakeHistogram({ p50: 1.2 * NS, p99: 48 * NS, max: 310 * NS });
    const loop = new EventLoopDelay({ monitor: () => h });
    loop.start();
    expect(loop.fields()).toEqual({ loopP50Ms: 1.2, loopP99Ms: 48, loopMaxMs: 310 });
  });

  it('rounds to one decimal — the sampler resolves 10ms, so more would be invented', () => {
    const h = fakeHistogram({ p50: 1.23456 * NS, p99: 2 * NS, max: 3 * NS });
    const loop = new EventLoopDelay({ monitor: () => h });
    loop.start();
    expect(loop.fields()?.loopP50Ms).toBe(1.2);
  });

  it('resets on every read, so each line describes ITS minute and not the day', () => {
    // The point of the whole design. A since-boot histogram buries one bad
    // minute at 09:14 inside eight good hours, and bursts are the complaint.
    const h = fakeHistogram({ p50: 1 * NS, p99: 2 * NS, max: 3 * NS });
    const loop = new EventLoopDelay({ monitor: () => h });
    loop.start();
    loop.fields();
    loop.fields();
    expect(h.resets).toBe(2);
  });

  it('enables on start and disables on stop', () => {
    const h = fakeHistogram({ p50: 0, p99: 0, max: 0 });
    const loop = new EventLoopDelay({ monitor: () => h });
    expect(h.enabled).toBe(false);
    loop.start();
    expect(h.enabled).toBe(true);
    loop.stop();
    expect(h.enabled).toBe(false);
  });

  it('a second start does not replace a running histogram', () => {
    const make = vi.fn(() => fakeHistogram({ p50: 0, p99: 0, max: 0 }));
    const loop = new EventLoopDelay({ monitor: make });
    loop.start();
    loop.start();
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('answers null before it is started rather than zeros', () => {
    const loop = new EventLoopDelay({ monitor: () => fakeHistogram({ p50: 0, p99: 0, max: 0 }) });
    expect(loop.fields()).toBeNull();
    expect(loop.latest()).toBeNull();
  });

  it('never throws out into the heartbeat, even if the histogram does', () => {
    // It runs inside `CpuHeartbeat`'s counters thunk. Losing the per-minute CPU
    // line (#719) to a diagnostic ABOUT performance would be a poor trade.
    const broken = {
      enable: () => true,
      disable: () => true,
      reset: () => undefined,
      percentile: () => {
        throw new Error('nope');
      },
      max: 0,
    } as unknown as IntervalHistogram;
    const loop = new EventLoopDelay({ monitor: () => broken });
    loop.start();
    expect(() => loop.fields()).not.toThrow();
    expect(loop.fields()).toBeNull();
  });

  describe('latest() — what the summary screen reads', () => {
    it('is null until a window has completed, so a fresh launch says "not measured"', () => {
      // A fresh launch and a quiet loop must not look the same on screen.
      const h = fakeHistogram({ p50: 1 * NS, p99: 2 * NS, max: 3 * NS });
      const loop = new EventLoopDelay({ monitor: () => h });
      loop.start();
      expect(loop.latest()).toBeNull();
      loop.fields();
      expect(loop.latest()).toEqual({ p50: 1, p99: 2, maxMs: 3 });
    });

    it('does NOT reset — opening the dialog cannot steal the next heartbeat line', () => {
      // A diagnostic that changes what it measures by being looked at is worse
      // than no diagnostic.
      const h = fakeHistogram({ p50: 1 * NS, p99: 2 * NS, max: 3 * NS });
      const loop = new EventLoopDelay({ monitor: () => h });
      loop.start();
      loop.fields();
      const before = h.resets;
      loop.latest();
      loop.latest();
      expect(h.resets).toBe(before);
    });
  });
});
