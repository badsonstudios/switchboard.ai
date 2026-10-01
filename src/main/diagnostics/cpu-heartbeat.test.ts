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
  LAG_CLOCK_DISAGREE_MS,
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
  mono?: () => number;
  idleSec?: () => number;
}) {
  const log = fakeLog();
  const hb = new CpuHeartbeat({
    getMetrics: opts.getMetrics ?? (() => opts.samples ?? []),
    log,
    coreCount: opts.coreCount ?? 32,
    now: opts.now,
    counters: opts.counters,
    mono: opts.mono,
    idleSec: opts.idleSec,
  });
  return { hb, log };
}

/**
 * The fields of the most recent line, whatever level it went out at.
 *
 * Ordered by `invocationCallOrder` rather than by concatenating the two mocks,
 * which is not chronological: a test that emits an `info` beat and then a `warn`
 * one would otherwise be handed the `info` (review).
 */
function lastFields(log: ReturnType<typeof fakeLog>): Record<string, unknown> {
  const calls = [...log.warn.mock.calls, ...log.info.mock.calls];
  const orders = [...log.warn.mock.invocationCallOrder, ...log.info.mock.invocationCallOrder];
  let best = -1;
  let found: unknown = undefined;
  orders.forEach((order, i) => {
    if (order > best) {
      best = order;
      found = calls[i]?.[1];
    }
  });
  return (found ?? {}) as Record<string, unknown>;
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


// ── #1031: the three fields that make a lag reading mean something ──────────
//
// #1003's beats read `totalCores: 0`, `procs: []` and `lagMaxMs: 3207` — the app
// using no CPU and still missing its timer by three seconds. Nothing on that
// line says whether anybody was at the keyboard, whether the machine was even
// running, or how big the renderer had grown. These do.

describe('CpuHeartbeat — was anyone there? (#1031)', () => {
  it('carries system idle time, which is what separates a felt stall from arithmetic', () => {
    const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)], idleSec: () => 7_201.4 });
    expect(hb.beat()?.idleSec).toBe(7201);
    expect(lastFields(log).idleSec).toBe(7201);
  });

  it('omits the field entirely when no source was given — never a fabricated zero', () => {
    const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)] });
    expect(hb.beat()?.idleSec).toBeNull();
    expect(lastFields(log)).not.toHaveProperty('idleSec');
  });

  it('a throwing idle source costs the field, never the beat', () => {
    const { hb, log } = harness({
      samples: [proc('Tab', 1, 3.1)],
      idleSec: () => {
        throw new Error('powerMonitor is unavailable');
      },
    });
    const beat = hb.beat();
    expect(beat).not.toBeNull();
    expect(beat?.idleSec).toBeNull();
    // the CPU line is the part we came for and it still went out
    expect(lastFields(log).totalCores).toBeDefined();
  });
});

describe('CpuHeartbeat — two clocks (#1031)', () => {
  /** drive `LAG_TICK_MS` ticks with wall and monotonic clocks moving apart */
  function run(opts: { wallStep: number; monoStep: number; ticks?: number }) {
    let wall = 0;
    let mono = 0;
    const h = harness({
      samples: [proc('Tab', 1, 3.1)],
      now: () => wall,
      mono: () => mono,
    });
    try {
      vi.useFakeTimers();
      h.hb.start();
      for (let i = 0; i < (opts.ticks ?? 1); i += 1) {
        wall += opts.wallStep;
        mono += opts.monoStep;
        vi.advanceTimersByTime(LAG_TICK_MS);
      }
      const beat = h.hb.beat();
      return { beat, fields: lastFields(h.log) };
    } finally {
      // The rest of this file does the same: a throw inside would otherwise leak
      // fake timers into every test after it.
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }

  it('stays silent when the two clocks agree — the ordinary beat does not widen', () => {
    // A stall both clocks saw: genuinely blocked, and one number says it.
    const { beat, fields } = run({ wallStep: 3_000, monoStep: 3_000 });
    expect(beat?.lagMaxMs).toBeGreaterThanOrEqual(1_900);
    expect(beat?.lagMonoMaxMs).toBeGreaterThanOrEqual(1_900);
    expect(fields).not.toHaveProperty('lagMonoMaxMs');
  });

  it('logs BOTH when they disagree — wall jumped, monotonic did not', () => {
    // The shape a suspend makes: real time passed, the counter did not. Before
    // this the line was indistinguishable from a three-second freeze.
    const { beat, fields } = run({ wallStep: 3_000, monoStep: 1_000 });
    expect(beat?.lagMaxMs).toBeGreaterThanOrEqual(1_900);
    expect(beat?.lagMonoMaxMs).toBeLessThan(LAG_CLOCK_DISAGREE_MS);
    expect(fields.lagMonoMaxMs).toBe(Math.round(beat!.lagMonoMaxMs!));
  });

  it('reports null, and logs nothing, when no monotonic source was given', () => {
    const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)] });
    expect(hb.beat()?.lagMonoMaxMs).toBeNull();
    expect(lastFields(log)).not.toHaveProperty('lagMonoMaxMs');
  });

  it('re-arms the monotonic baseline on a wake, not just the wall one', () => {
    // Otherwise the first tick after a resume reports the whole suspend against
    // the very clock whose job is to say the suspend was not our fault.
    let wall = 0;
    let mono = 0;
    const { hb } = harness({ samples: [proc('Tab', 1, 3.1)], now: () => wall, mono: () => mono });
    try {
      vi.useFakeTimers();
      hb.start();
      wall += 8 * 3_600_000; // a night asleep
      mono += 8 * 3_600_000;
      hb.clockJumped();
      vi.advanceTimersByTime(LAG_TICK_MS);
      wall += LAG_TICK_MS;
      mono += LAG_TICK_MS;
      vi.advanceTimersByTime(LAG_TICK_MS);
      const beat = hb.beat();
      expect(beat?.resumedFromSleep).toBe(true);
      expect(beat?.lagMonoMaxMs).toBeLessThan(LAG_CLOCK_DISAGREE_MS);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('⭐ compares the clocks PER TICK — one event cannot mask another', () => {
    // The first draft compared the two MAXIMA (review): a minute holding a 5s
    // suspend early and a genuine 5s block later produced two equal maxima, they
    // "agreed", and the suspend vanished from the line. The gap is per tick.
    let wall = 0;
    let mono = 0;
    const h = harness({ samples: [proc('Tab', 1, 3.1)], now: () => wall, mono: () => mono });
    try {
      vi.useFakeTimers();
      h.hb.start();
      // tick 1: wall jumps 5s, monotonic does not — the suspend
      wall += 5_000;
      mono += 1_000;
      vi.advanceTimersByTime(LAG_TICK_MS);
      // tick 2: both jump 5s — a genuine block, and the SAME magnitude
      wall += 5_000;
      mono += 5_000;
      vi.advanceTimersByTime(LAG_TICK_MS);
      const beat = h.hb.beat();
      // the two maxima are now equal, which is exactly the masking case...
      expect(Math.abs((beat?.lagMonoMaxMs ?? 0) - (beat?.lagMaxMs ?? 0))).toBeLessThan(
        LAG_CLOCK_DISAGREE_MS
      );
      // ...and the per-tick gap still reports the suspend
      expect(beat?.lagClockGapMaxMs).toBeGreaterThanOrEqual(3_900);
      expect(lastFields(h.log).lagClockGapMs).toBeDefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('⭐ a THROWING monotonic clock does not fabricate a monotonic-only stall', () => {
    // Measured in review: when the wall baseline advanced and a throwing `mono()`
    // left the monotonic one behind, the next tick measured two ticks against a
    // one-tick baseline and logged a ~1s MONOTONIC stall beside a 0ms wall stall
    // — physically impossible, and growing while the throw persisted.
    let wall = 0;
    let mono = 0;
    let throwNext = true;
    const h = harness({
      samples: [proc('Tab', 1, 3.1)],
      now: () => wall,
      mono: () => {
        if (throwNext) {
          throwNext = false;
          throw new Error('hrtime is unavailable');
        }
        return mono;
      },
    });
    try {
      vi.useFakeTimers();
      h.hb.start();
      for (let i = 0; i < 5; i += 1) {
        wall += LAG_TICK_MS;
        mono += LAG_TICK_MS;
        vi.advanceTimersByTime(LAG_TICK_MS);
      }
      const beat = h.hb.beat();
      expect(beat?.lagMaxMs).toBeLessThan(LAG_CLOCK_DISAGREE_MS);
      expect(beat?.lagMonoMaxMs ?? 0).toBeLessThan(LAG_CLOCK_DISAGREE_MS);
      expect(lastFields(h.log)).not.toHaveProperty('lagMonoMaxMs');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('logs the pair at the threshold and stays silent one below it', () => {
    // Pins `LAG_CLOCK_DISAGREE_MS` itself: without a boundary pair any value in
    // (0, the test's gap] kept every other clock test green.
    const at = run({ wallStep: LAG_TICK_MS + LAG_CLOCK_DISAGREE_MS, monoStep: LAG_TICK_MS });
    expect(at.fields.lagClockGapMs).toBeDefined();
    const below = run({ wallStep: LAG_TICK_MS + LAG_CLOCK_DISAGREE_MS - 2, monoStep: LAG_TICK_MS });
    expect(below.fields).not.toHaveProperty('lagClockGapMs');
  });

  it('never throws out of a powerMonitor listener', () => {
    // `clockJumped` is wired straight to `powerMonitor.on('resume')`, where an
    // uncaught throw is an "A JavaScript error occurred" modal on top of whatever
    // the user was doing when their machine woke up.
    const { hb } = harness({
      samples: [],
      mono: () => {
        throw new Error('hrtime is unavailable');
      },
    });
    expect(() => hb.clockJumped()).not.toThrow();
    expect(hb.beat()?.resumedFromSleep).toBe(true); // and the flag still landed
  });
});

describe('CpuHeartbeat — idle time is paired with the STALL (#1031)', () => {
  it('reports the idle reading from the worst tick, not from beat time', () => {
    // Read at beat time it could be a minute away from the stall it sits beside:
    // one click at second 59 after an hour away would report `idleSec: 1` next to
    // a stall nobody was present for, which is the confusion the field exists to
    // remove (review).
    let wall = 0;
    let idle = 3_600; // an hour away...
    const h = harness({
      samples: [proc('Tab', 1, 3.1)],
      now: () => wall,
      idleSec: () => idle,
    });
    try {
      vi.useFakeTimers();
      h.hb.start();
      wall += 4_000; // ...and THIS is when it stalled
      vi.advanceTimersByTime(LAG_TICK_MS);
      idle = 1; // the user came back just before the line was written
      const beat = h.hb.beat();
      expect(beat?.lagIdleSec).toBe(3_600);
      expect(beat?.idleSec).toBe(1);
      expect(lastFields(h.log).lagIdleSec).toBe(3_600);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps the stall reading off a quiet line', () => {
    // Drift is a few milliseconds on nearly every tick, so carrying this field
    // unconditionally would repeat `idleSec` on every quiet beat for ever.
    const { hb, log } = harness({ samples: [proc('Tab', 1, 3.1)], idleSec: () => 42 });
    hb.beat();
    expect(lastFields(log)).not.toHaveProperty('lagIdleSec');
  });
});

describe('CpuHeartbeat — how big had it got? (#1031)', () => {
  const withMem = (type: string, pid: number, percent: number, kb: number): CpuProcessSample => ({
    type,
    pid,
    percent,
    workingSetKb: kb,
  });

  it('names each busy process with its working set, in MB', () => {
    const h = harness({ samples: [withMem('Tab', 1, 3.1, 1_258_291)] });
    h.hb.beat();
    const procs = lastFields(h.log).procs as Array<Record<string, unknown>>;
    // #1013's headline number — a renderer at 1.2 GB — as a field on a line we
    // were already writing, so the next one is a curve instead of a sighting.
    expect(procs[0].rssMb).toBe(1229);
  });

  it('⭐ totals memory across EVERY process, including the ones at zero CPU', () => {
    // `procs` drops anything idle, which is exactly where a leaked renderer
    // sits: quiet and enormous. A beat that named no processes would otherwise
    // carry no memory at all, and that is the minute this field most needs to
    // describe.
    const h = harness({
      samples: [withMem('Tab', 1, 0, 1_048_576), withMem('Browser', 2, 0, 524_288)],
    });
    const fields = (h.hb.beat(), lastFields(h.log));
    expect(fields.procs).toEqual([]); // nothing busy enough to name
    expect(fields.rssTotalMb).toBe(1536); // ...and 1.5 GB of it all the same
  });

  it('omits memory entirely when the source does not report it', () => {
    const h = harness({ samples: [proc('Tab', 1, 3.1)] });
    h.hb.beat();
    const fields = lastFields(h.log);
    expect(fields).not.toHaveProperty('rssTotalMb');
    expect((fields.procs as Array<Record<string, unknown>>)[0]).not.toHaveProperty('rssMb');
  });
});
