// @vitest-environment jsdom
/**
 * #1031 — what a long task says about the app it happened in.
 *
 * #1007 captured **2000 long tasks totalling 638,389 ms** and not one word about
 * what any of them were doing, because a long task recorded a duration and
 * nothing else. The fix is deliberately NOT instrumentation in the hot path —
 * owner decision 2 forbids that, and `perf.absent.test.ts` enforces it. The
 * context is sampled inside the observer callback instead, which by definition
 * only runs once the platform has already finished timing a block of 50 ms or
 * more.
 *
 * jsdom reports no `longtask` entries of its own, so the observer is stubbed and
 * the callback is called by hand. That is the honest shape for this file: the
 * question here is what we RECORD when the platform tells us, and the platform
 * telling us is not ours to test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  flushPerf,
  installPerf,
  resetPerfForTests,
  uninstallPerf,
  type PerfHost,
} from './perf';
import type { PerfBatch } from '../../../shared/perf';

/** every observer tier 1 registers, by the type it asked for */
let callbacks: Map<string, (list: { getEntries: () => unknown[] }) => void>;
let batches: PerfBatch[];
let realObserver: typeof PerformanceObserver;

/** one long task, in the shape `PerformanceObserver` hands over */
const entry = (startTime: number, duration: number): PerformanceEntry =>
  ({ startTime, duration, name: 'self', entryType: 'longtask' }) as PerformanceEntry;

function fire(startTime: number, duration: number): void {
  callbacks.get('longtask')?.({ getEntries: () => [entry(startTime, duration)] });
}

/** the context recorded for the first long task of the last flush */
function recordedCtx(): Record<string, number> | undefined {
  flushPerf();
  const all = batches.flatMap((b) => b.longTasks);
  return all[0]?.ctx as Record<string, number> | undefined;
}

function feed(blocks: string, rendered: string): void {
  const root = document.createElement('div');
  root.setAttribute('data-perf-blocks', blocks);
  root.setAttribute('data-perf-rendered', rendered);
  document.body.append(root);
}

function install(host: Partial<PerfHost> = {}): void {
  installPerf({
    record: (b) => batches.push(b),
    mainStats: () => Promise.resolve(null),
    ...host,
  });
}

beforeEach(() => {
  callbacks = new Map();
  batches = [];
  document.body.innerHTML = '';
  realObserver = globalThis.PerformanceObserver;
  globalThis.PerformanceObserver = class {
    constructor(private readonly cb: (list: { getEntries: () => unknown[] }) => void) {}
    observe(opts: { type: string }): void {
      callbacks.set(opts.type, this.cb);
    }
    disconnect(): void {}
  } as unknown as typeof PerformanceObserver;
  resetPerfForTests();
});

afterEach(() => {
  uninstallPerf();
  resetPerfForTests();
  globalThis.PerformanceObserver = realObserver;
});

describe('a long task records what the renderer was holding (#1031)', () => {
  it('sums the blocks across every mounted feed, and how many were on screen', () => {
    // Several cards share one main thread, so the question the line answers is
    // what the WINDOW was holding, not what one card was.
    feed('4000', '80');
    feed('200', '40');
    install();
    fire(performance.now(), 5_900);
    expect(recordedCtx()).toMatchObject({ feeds: 2, blocks: 4_200, rendered: 120 });
  });

  it('carries the mid-reply count, which is #1013\'s whole claim', () => {
    // "CPU and lag follow streaming activity, not the number of open sessions."
    // This is the field that confirms or refutes it.
    feed('10', '10');
    install({ replyingCount: () => 3 });
    fire(performance.now(), 120);
    expect(recordedCtx()?.replying).toBe(3);
  });

  it('omits the mid-reply count rather than inventing a zero when no source is given', () => {
    feed('10', '10');
    install();
    fire(performance.now(), 120);
    expect(recordedCtx()).not.toHaveProperty('replying');
  });

  it('a throwing reply counter costs that field, never the sample', () => {
    feed('10', '10');
    install({
      replyingCount: () => {
        throw new Error('store is gone');
      },
    });
    fire(performance.now(), 120);
    const ctx = recordedCtx();
    expect(ctx).not.toHaveProperty('replying');
    expect(ctx).toMatchObject({ blocks: 10 }); // the rest of the sample survived
  });

  it('reports no feeds as zero feeds and no block counts at all', () => {
    // A window with nothing mounted is a real state — a popped-out viewer, or a
    // long task during start-up — and `blocks: 0` would be a measurement nobody
    // took.
    install();
    fire(performance.now(), 120);
    const ctx = recordedCtx();
    expect(ctx?.feeds).toBe(0);
    expect(ctx).not.toHaveProperty('blocks');
  });

  it('⭐ does not let a MISSING attribute become a zero it never measured', () => {
    // `Number(null) === 0`, which is finite and non-negative — so a root that
    // matches `[data-perf-blocks]` with no `data-perf-rendered` would have
    // contributed a silent 0 to the on-screen total. The raw attribute is tested
    // instead (review found the first draft's comment blamed a `-1` sentinel the
    // feed never publishes).
    const bare = document.createElement('div');
    bare.setAttribute('data-perf-blocks', '40');
    document.body.append(bare); // no `data-perf-rendered` at all
    feed('300', '60');
    install();
    fire(performance.now(), 120);
    expect(recordedCtx()).toMatchObject({ feeds: 2, blocks: 340, rendered: 60 });
  });

  it('ignores a negative or unparseable count rather than subtracting it', () => {
    feed('-1', 'nonsense');
    feed('300', '60');
    install();
    fire(performance.now(), 120);
    expect(recordedCtx()).toMatchObject({ feeds: 2, blocks: 300, rendered: 60 });
  });

  it('⭐ samples ONCE for a batch of long tasks, not once per task', () => {
    // A batch is likeliest under exactly the load this diagnoses, and walking the
    // document once per entry would be N identical answers for N times the cost.
    feed('4000', '80');
    install();
    const walks = vi.spyOn(document, 'querySelectorAll');
    callbacks.get('longtask')?.({
      getEntries: () => [entry(performance.now(), 120), entry(performance.now(), 130), entry(performance.now(), 140)],
    });
    expect(walks).toHaveBeenCalledTimes(1);
    walks.mockRestore();
    flushPerf();
    const all = batches.flatMap((b) => b.longTasks);
    expect(all).toHaveLength(3);
    // ...and all three carry it
    for (const t of all) expect(t.ctx).toMatchObject({ blocks: 4_000 });
  });

  it('⭐ gives no context to a task REPLAYED from before tier 1 existed', () => {
    // `buffered: true` replays earlier long tasks. Sampling those would stamp
    // the present onto the past: a block from start-up would be reported as
    // having happened with whatever is mounted now.
    feed('4000', '80');
    install();
    fire(-10_000, 50); // ended long before install
    const all = (flushPerf(), batches.flatMap((b) => b.longTasks));
    expect(all).toHaveLength(1);
    expect(all[0]).not.toHaveProperty('ctx');
  });

  it('records the duration even when every context source is unavailable', () => {
    // The duration is the part we came for; context is the bonus. A recorder
    // that dropped the sample because one optional read threw would have turned
    // a diagnostic into a way to lose evidence.
    const spy = vi.spyOn(document, 'querySelectorAll').mockImplementation(() => {
      throw new Error('document is detached');
    });
    try {
      install();
      fire(performance.now(), 5_900);
      flushPerf();
      expect(batches.flatMap((b) => b.longTasks)[0]?.ms).toBe(5_900);
    } finally {
      spy.mockRestore();
    }
  });
});
