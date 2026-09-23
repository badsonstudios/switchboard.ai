/**
 * Main-process event-loop delay — E21 tier 1 (#923).
 *
 * A blocked MAIN process makes every window feel sluggish at once, which is a
 * different symptom from a slow renderer and has to be told apart from it. The
 * renderer can only ever report on itself; if the owner's laptop stalls in all
 * three session cards simultaneously, the answer is here and nowhere else.
 *
 * ## Why this is free enough to be always on
 *
 * `monitorEventLoopDelay` is a libuv-level timer sampling the loop at a fixed
 * resolution and accumulating into a native histogram. It does no work per task
 * and allocates nothing per sample, which is what earns it a place in tier 1
 * rather than behind the switch.
 *
 * ## Why it has no timer of its own
 *
 * It rides the CPU heartbeat (#719), which already wakes once a minute and
 * already writes one line per process. Adding a second minute-timer to report
 * on scheduling would be a diagnostic that costs a wakeup to say the machine is
 * busy. `fields()` is the seam `CpuHeartbeat`'s `counters` thunk was documented
 * for — "build on what exists" is the item's instruction and this is the place
 * it pays off most.
 *
 * ## Read-and-reset, deliberately
 *
 * Every read resets the histogram, so each heartbeat line describes THAT
 * minute. A since-boot histogram is useless for the thing E21 is chasing: one
 * bad minute at 09:14 is invisible inside eight hours of good ones, and the
 * whole complaint is bursts.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import type { PerfLoopDelay } from '../../shared/perf';

/**
 * Sampling resolution. 10ms matches the granularity of the thing we are
 * looking for — a block worth reporting is one a human notices, and the budget
 * E21-03 will measure against is 16ms for typing and 100ms for a click. A
 * finer resolution would cost more wakeups to resolve differences nobody feels.
 */
export const LOOP_RESOLUTION_MS = 10;

/** nanoseconds, as the histogram reports, to milliseconds, as everyone reads. */
function ms(nanos: number): number {
  // `Math.round` to one decimal: the resolution is 10ms, so more precision than
  // this would be inventing detail the sampler never had.
  return Math.round((nanos / 1e6) * 10) / 10;
}

/** What joins the CPU heartbeat's line. */
export interface LoopFields {
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
}

export interface EventLoopDelayDeps {
  /** injectable so a test can drive a histogram without waiting a real minute */
  monitor?: () => IntervalHistogram;
}

export class EventLoopDelay {
  private readonly make: () => IntervalHistogram;
  private histogram: IntervalHistogram | null = null;
  /**
   * The most recently completed window. The summary dialog reads THIS rather
   * than the live histogram, so opening the dialog cannot reset the counters
   * the next heartbeat line is about to report — a diagnostic that changes what
   * it measures by being looked at is worse than no diagnostic.
   */
  private last: PerfLoopDelay | null = null;

  constructor(deps: EventLoopDelayDeps = {}) {
    this.make = deps.monitor ?? (() => monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS }));
  }

  start(): void {
    if (this.histogram) return;
    this.histogram = this.make();
    this.histogram.enable();
  }

  stop(): void {
    if (!this.histogram) return;
    this.histogram.disable();
    this.histogram = null;
  }

  /**
   * Read the window that just ended and start a new one.
   *
   * Never throws: this runs inside the heartbeat's `counters` thunk, and a
   * thrown error there would cost the CPU line that #719 exists to write. The
   * heartbeat catches it too — belt and braces, because losing the heartbeat to
   * a diagnostic about performance would be its own small joke.
   */
  fields(): LoopFields | null {
    const h = this.histogram;
    if (!h) return null;
    try {
      const snapshot: PerfLoopDelay = {
        p50: ms(h.percentile(50)),
        p99: ms(h.percentile(99)),
        maxMs: ms(h.max),
      };
      h.reset();
      // A window in which the loop never ran long enough to sample reports its
      // floor, not zero; keep it anyway. "The loop was fine this minute" is a
      // fact worth having beside a minute where it was not.
      this.last = snapshot;
      return { loopP50Ms: snapshot.p50, loopP99Ms: snapshot.p99, loopMaxMs: snapshot.maxMs };
    } catch {
      return null;
    }
  }

  /**
   * The last completed window, for the summary screen.
   *
   * `null` before the first heartbeat — the dialog says "not yet measured"
   * rather than showing zeros, because a fresh launch and a quiet loop must not
   * look the same.
   */
  latest(): PerfLoopDelay | null {
    return this.last;
  }
}
