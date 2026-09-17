// The arithmetic in here is the whole reason #719's instrumentation can work at
// all, so it is pinned against MEASURED values rather than invented ones: the
// numbers in the normalisation tests are the real readings from
// `spike/probes/719/` on a 32-core machine (1 pegged core = 3.1%, 4 = 12.4%).
//
// Several of these tests exist because a mutation run found the behaviour they
// cover was unpinned — the timer assertions and the MAX_NAMED/total pair in
// particular. A test named for a claim it does not actually assert is worse
// than no test, because it is read as coverage.
import { describe, it, expect, vi } from 'vitest';
import {
  CpuHeartbeat,
  HEARTBEAT_MS,
  LAG_TICK_MS,
  BUSY_CORES,
  BUSY_MACHINE_FRACTION,
  LAG_WARN_MS,
  MAX_NAMED,
  type CpuProcessSample,
} from './cpu-heartbeat';

function fakeLog() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

function harness(opts: {
  samples?: CpuProcessSample[];
  coreCount?: number;
  getMetrics?: () => CpuProcessSample[];
  counters?: () => Record<string, number>;
  now?: () => number;
}) {
  const log = fakeLog();
  const hb = new CpuHeartbeat({
    getMetrics: opts.getMetrics ?? (() => opts.samples ?? []),
    log,
    coreCount: opts.coreCount ?? 32,
    now: opts.now,
    counters: opts.counters,
  });
  return { hb, log };
}

const proc = (type: string, pid: number, percent: number): CpuProcessSample => ({
  type,
  pid,
  percent,
});

/** the percentage a machine of `coreCount` cores reports for `n` pegged cores */
const pctFor = (cores: number, coreCount: number) => (cores * 100) / coreCount;

describe('CpuHeartbeat — the unit (#719)', () => {
  it('reports a pegged core as 1.0 cores from the 3.1% a 32-core box actually shows', () => {
    const { hb } = harness({ samples: [proc('Tab', 1, 3.1)], coreCount: 32 });
    expect(hb.beat()?.busiest?.cores).toBeCloseTo(0.99, 2);
  });

  it('scales linearly, matching the 4-burner measurement', () => {
    const { hb } = harness({
      samples: [proc('Tab', 1, 3.1), proc('Tab', 2, 3.1), proc('Tab', 3, 3.1), proc('Tab', 4, 3.1)],
      coreCount: 32,
    });
    expect(hb.beat()?.totalCores).toBeCloseTo(3.97, 2);
  });

  it('calls the SAME burn the same thing on a laptop as on a 32-core desktop', () => {
    // One pegged core on each machine. This is the cross-machine comparison the
    // whole ticket turns on: the raw percentages differ by 4x, the cores figure
    // does not move. A threshold on the raw percentage would fire on one and
    // never on the other.
    const desktop = harness({ samples: [proc('Tab', 1, 3.1)], coreCount: 32 }).hb.beat();
    const laptop = harness({ samples: [proc('Tab', 1, 12.5)], coreCount: 8 }).hb.beat();
    expect(desktop?.busiest?.cores).toBeCloseTo(1.0, 1);
    expect(laptop?.busiest?.cores).toBeCloseTo(1.0, 1);
  });

  it('logs the core count under a name that cannot be read as cores-worth', () => {
    // These two meant the same word once. A reader who takes `coreCount: 8` for
    // "eight cores' worth of work" has made exactly the misreading this feature
    // exists to prevent, so the names are deliberately not interchangeable.
    const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)], coreCount: 32 });
    hb.beat();
    const fields = log.warn.mock.calls[0][1] as {
      coreCount: number;
      totalCores: number;
      procs: Array<{ cores: number }>;
    };
    expect(fields.coreCount).toBe(32);
    expect(fields.totalCores).toBeCloseTo(1.0, 1);
    expect(fields.procs[0].cores).toBeCloseTo(1.0, 1);
  });
});

describe('CpuHeartbeat — naming the burner', () => {
  it('names the busiest process first, not the first one reported', () => {
    const { hb, log } = harness({
      samples: [proc('Browser', 1, 0.1), proc('GPU', 2, 0.2), proc('Tab', 3, 6.2)],
    });
    const beat = hb.beat();
    expect(beat?.busiest?.type).toBe('Tab');
    expect(beat?.busiest?.pid).toBe(3);
    const fields = log.warn.mock.calls[0][1] as { procs: Array<{ type: string }> };
    expect(fields.procs[0].type).toBe('Tab');
  });

  it('caps the named processes but still totals ALL of them', () => {
    // The cap bounds the line; the total must not be bounded with it, or a
    // machine dying under many small processes reports a small number.
    const many = Array.from({ length: 20 }, (_, i) => proc('Tab', i, pctFor(0.3, 32)));
    const { hb, log } = harness({ samples: many, coreCount: 32 });
    const beat = hb.beat();
    // 6 cores' worth of a 32-core machine is genuinely not alarming, so this
    // lands on info — the cap and the total are the subject here, not the level.
    expect(beat?.busy).toBe(false);
    const fields = log.info.mock.calls[0][1] as { procs: unknown[] };
    expect(fields.procs).toHaveLength(MAX_NAMED);
    expect(beat?.totalCores).toBeCloseTo(6.0, 1); // 20 x 0.3, not 6 x 0.3
  });

  it('drops processes sitting at zero rather than listing them every minute', () => {
    const { hb, log } = harness({
      samples: [proc('Browser', 1, 0), proc('GPU', 2, 0), proc('Tab', 3, 3.1)],
    });
    hb.beat();
    const fields = log.warn.mock.calls[0][1] as { procs: Array<{ pid: number }> };
    expect(fields.procs).toHaveLength(1);
    expect(fields.procs[0].pid).toBe(3);
  });

  it('promotes the beat to warn once a single process passes the busy threshold', () => {
    const quiet = harness({ samples: [proc('Tab', 1, pctFor(BUSY_CORES - 0.1, 32))] });
    quiet.hb.beat();
    expect(quiet.log.info).toHaveBeenCalledTimes(1);
    expect(quiet.log.warn).not.toHaveBeenCalled();

    const hot = harness({ samples: [proc('Tab', 1, pctFor(BUSY_CORES + 0.1, 32))] });
    expect(hot.hb.beat()?.busy).toBe(true);
    expect(hot.log.warn).toHaveBeenCalledTimes(1);
  });

  it('promotes when the MACHINE is loaded even though no single process looks bad', () => {
    // The "whole laptop bogs down" shape: 8 renderers at 0.45 cores on an
    // 8-core machine. Every one is under BUSY_CORES; together they are 3.6
    // cores' worth of a machine that only has 8.
    const coreCount = 8;
    const samples = Array.from({ length: 8 }, (_, i) => proc('Tab', i, pctFor(0.45, coreCount)));
    const { hb, log } = harness({ samples, coreCount });
    const beat = hb.beat();
    expect(beat?.busiest?.cores).toBeLessThan(BUSY_CORES); // nothing individually alarming
    expect(beat?.totalCores).toBeGreaterThan(coreCount * BUSY_MACHINE_FRACTION);
    expect(beat?.busy).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('still emits a line when there are no processes at all', () => {
    const { hb, log } = harness({ samples: [] });
    const beat = hb.beat();
    expect(beat?.busiest).toBeNull();
    expect(beat?.totalCores).toBe(0);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe('CpuHeartbeat — fail-open (the diagnostic must never be the outage)', () => {
  it('survives getMetrics throwing, and says so instead of escaping into setInterval', () => {
    const { hb, log } = harness({
      getMetrics: () => {
        throw new Error('metrics gone');
      },
    });
    expect(() => hb.beat()).not.toThrow();
    expect(hb.beat()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('cpu heartbeat tick failed', {
      error: 'Error: metrics gone',
    });
  });

  it('keeps the CPU line when a counter throws — the counters are the garnish', () => {
    const { hb, log } = harness({
      // deliberately QUIET so the line lands on info; these two tests are about
      // the counters, not the level
      samples: [proc('Tab', 1, 0.3)],
      counters: () => {
        throw new Error('counter broke');
      },
    });
    hb.beat();
    const fields = log.info.mock.calls[0][1] as { countersError?: string; coreCount: number };
    expect(fields.countersError).toContain('counter broke');
    expect(fields.coreCount).toBe(32);
  });

  it('carries the counters onto the line when they work', () => {
    const { hb, log } = harness({
      samples: [proc('Tab', 1, 0.3)],
      counters: () => ({ sessions: 9, windows: 2 }),
    });
    hb.beat();
    const fields = log.info.mock.calls[0][1] as { sessions: number; windows: number };
    expect(fields.sessions).toBe(9);
    expect(fields.windows).toBe(2);
  });
});

describe('CpuHeartbeat — lifecycle', () => {
  it('arms two timers on start and clears BOTH on stop', () => {
    // Asserting the timer count, not just that logging stopped: a `stop()` that
    // sets its flag and leaks both intervals passes a log-count assertion
    // forever, and leaks a 1Hz timer for the life of the process.
    vi.useFakeTimers();
    try {
      const { hb } = harness({ samples: [proc('Tab', 1, 3.1)] });
      expect(vi.getTimerCount()).toBe(0);
      hb.start();
      expect(vi.getTimerCount()).toBe(2); // the beat and the lag gauge
      hb.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('unrefs both timers, so a diagnostic cannot hold the app open at quit', () => {
    const handles: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
      const h = { unref: vi.fn() };
      handles.push(h);
      return h as unknown as ReturnType<typeof setInterval>;
    });
    try {
      const { hb } = harness({ samples: [proc('Tab', 1, 3.1)] });
      hb.start();
      expect(handles).toHaveLength(2);
      for (const h of handles) expect(h.unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops for good, and a beat forced after stop is a no-op', () => {
    vi.useFakeTimers();
    try {
      const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)] });
      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      expect(log.info.mock.calls.length + log.warn.mock.calls.length).toBe(2);

      hb.stop();
      vi.advanceTimersByTime(HEARTBEAT_MS * 5);
      expect(log.info.mock.calls.length + log.warn.mock.calls.length).toBe(2);
      expect(hb.beat()).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('start() is idempotent, so a double-wire cannot double the log', () => {
    vi.useFakeTimers();
    try {
      const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)] });
      hb.start();
      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(log.info.mock.calls.length + log.warn.mock.calls.length).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('primes the metric at start, so the first beat covers real time', () => {
    // Without the priming call the first beat diffs against nothing and reads a
    // flat zero — losing app startup, the busiest minute of the run. Observed
    // in the real app before this was added, not theorised.
    vi.useFakeTimers();
    try {
      const getMetrics = vi.fn(() => [proc('Tab', 1, 3.1)]);
      const log = fakeLog();
      const hb = new CpuHeartbeat({ getMetrics, log, coreCount: 32 });
      hb.start();
      expect(getMetrics).toHaveBeenCalledTimes(1); // the priming call, before any beat
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(getMetrics).toHaveBeenCalledTimes(2);
      hb.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('starts anyway when the priming call throws', () => {
    const log = fakeLog();
    const hb = new CpuHeartbeat({
      getMetrics: () => {
        throw new Error('no metrics at startup');
      },
      log,
      coreCount: 32,
    });
    expect(() => hb.start()).not.toThrow();
    hb.stop();
  });
});

describe('CpuHeartbeat — the lag gauge', () => {
  it('measures a stalled event loop as lag, and promotes the beat for it', () => {
    // A clock that jumps forward without the OS reporting a resume: the loop
    // was held. That is what "the whole laptop is bogged down" looks like from
    // inside the main process.
    let t = 0;
    const { hb, log } = harness({ samples: [proc('Browser', 1, 0.1)], now: () => t });
    vi.useFakeTimers();
    try {
      hb.start();
      t += LAG_TICK_MS + 4_000;
      vi.advanceTimersByTime(LAG_TICK_MS);
      const beat = hb.beat();
      expect(beat?.lagMaxMs).toBeGreaterThanOrEqual(LAG_WARN_MS);
      expect(beat?.busy).toBe(true);
      expect(log.warn).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets lag each beat, so one bad minute does not stain the next', () => {
    let t = 0;
    const { hb } = harness({ samples: [proc('Browser', 1, 0.1)], now: () => t });
    vi.useFakeTimers();
    try {
      hb.start();
      t += LAG_TICK_MS + 4_000;
      vi.advanceTimersByTime(LAG_TICK_MS);
      expect(hb.beat()?.lagMaxMs).toBeGreaterThan(0);

      t += LAG_TICK_MS;
      vi.advanceTimersByTime(LAG_TICK_MS);
      expect(hb.beat()?.lagMaxMs).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does NOT report an overnight suspend as an eight-hour freeze', () => {
    // The laptop is the machine #719 happens on, and it sleeps every night.
    // Without this, every morning writes one warn line claiming the app hung
    // for eight hours, burying the real signal under a daily fake one.
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    let t = 0;
    const { hb } = harness({ samples: [proc('Browser', 1, 0.1)], now: () => t });
    vi.useFakeTimers();
    try {
      hb.start();
      t += EIGHT_HOURS; // lid shut; no timer fired the whole time
      hb.clockJumped(); // powerMonitor 'resume'
      t += LAG_TICK_MS;
      vi.advanceTimersByTime(LAG_TICK_MS);

      const beat = hb.beat();
      expect(beat?.lagMaxMs).toBeLessThan(LAG_WARN_MS);
      expect(beat?.resumedFromSleep).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('and the suspend guard is load-bearing: without it the same gap reads as a freeze', () => {
    // The companion to the test above. If clockJumped() were a no-op, this is
    // what the morning beat would say — so the guard is doing real work rather
    // than passing vacuously.
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    let t = 0;
    const { hb } = harness({ samples: [proc('Browser', 1, 0.1)], now: () => t });
    vi.useFakeTimers();
    try {
      hb.start();
      t += EIGHT_HOURS; // same gap, but nothing tells the gauge the OS slept
      vi.advanceTimersByTime(LAG_TICK_MS);
      const beat = hb.beat();
      expect(beat?.lagMaxMs).toBeGreaterThan(EIGHT_HOURS - LAG_TICK_MS * 2);
      expect(beat?.resumedFromSleep).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('a genuine long freeze is still reported in full, not capped away', () => {
    // Deliberately NOT guarded by a plausibility cap: a #719 freeze can last
    // minutes, and a rule that discarded long stalls would discard exactly the
    // evidence this exists to collect. Sleep is known because the OS says so.
    const FOUR_MINUTES = 4 * 60 * 1000;
    let t = 0;
    const { hb } = harness({ samples: [proc('Browser', 1, 0.1)], now: () => t });
    vi.useFakeTimers();
    try {
      hb.start();
      t += FOUR_MINUTES;
      vi.advanceTimersByTime(LAG_TICK_MS);
      expect(hb.beat()?.lagMaxMs).toBeGreaterThan(FOUR_MINUTES - LAG_TICK_MS * 2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
