// #719 — a periodic per-process CPU line in the log, so the NEXT freeze names
// its own burner.
//
// Why this exists at all: #719 has been reported four times and captured zero
// times. It happens on the owner's laptop, never on the dev machine, and while
// it is happening the mouse barely moves — so "open Task Manager and look at
// which process is hot" is a request that cannot be met by the person best
// placed to meet it. The app has to answer that question on its own, before
// anyone asks.
//
// THE UNIT IS THE WHOLE POINT. `percentCPUUsage` from `app.getAppMetrics()` is
// a share of the ENTIRE MACHINE, not of one core. Measured in
// `spike/probes/719/`, three points, dead linear: on a 32-core box one fully
// pegged core reads 3.1%, two read 6.2%, four read 12.4%. So a threshold
// picked by eye on a big desktop — "warn over 50%" — would need SIXTEEN pegged
// cores and would never once fire on the laptop this ticket is about.
//
// Everything here is therefore expressed in CORES' WORTH of CPU
// (`percent * coreCount / 100`), which means the same thing on both machines.
// The raw percentage is deliberately NOT logged: it is derivable from `cores`
// and `coreCount`, it doubles the size of the line, and every reader who sees
// it is one step from reasoning in the unit this file exists to get away from.
// `spike/findings/719-cpu-metrics.md` is the record.
import { errorText } from '../../shared/error-text';
import type { Logger } from '../log/logger';

/**
 * One beat a minute.
 *
 * Measured (probe 719): a sample is an AVERAGE over the interval since the
 * previous call, not an instantaneous reading — at a 10-second gap two pegged
 * cores still read their full 6.2%. So a minute-long gap costs no fidelity: it
 * reports a true one-minute average and cannot miss a sustained burn between
 * beats. A freeze that lasts hours produces dozens of lines.
 */
export const HEARTBEAT_MS = 60_000;

/**
 * The lag gauge's own tick. Drift against it is the measurement.
 *
 * Kept at 1s rather than widened to save wakeups: the resolution of this gauge
 * is the resolution of the one number that says "how frozen was it", and this
 * ticket is about a freeze. The noise floor is ~4-16 ms (Windows timer
 * resolution is ~15.6 ms — probe 719), so 1s sits far above it while still
 * resolving a single-second stall.
 */
export const LAG_TICK_MS = 1_000;

/** cores' worth of CPU at or above which a single process is called out */
export const BUSY_CORES = 0.5;

/**
 * Fraction of the machine at or above which the beat is promoted even when no
 * SINGLE process looks bad.
 *
 * #719 is reported as "the whole laptop bogs down", and that shape can be eight
 * renderers at 0.45 cores each — every one of them under `BUSY_CORES`, the
 * machine on its knees. Judging only the busiest process would leave exactly
 * that case unmarked.
 */
export const BUSY_MACHINE_FRACTION = 0.25;

/** event-loop lag at or above which the beat is promoted; ~60x the idle floor */
export const LAG_WARN_MS = 1_000;

/**
 * How far the wall and monotonic lag figures must differ before the line carries
 * both (#1031).
 *
 * Well above the ~15.6 ms Windows timer resolution the top of this file records,
 * so ordinary jitter between two reads of two clocks never widens a line, and
 * far below the 1,000 ms that promotes a beat — a disagreement worth reading is
 * one that could change the diagnosis.
 */
export const LAG_CLOCK_DISAGREE_MS = 250;

/** how many processes the line names, busiest first, so one beat stays one line */
export const MAX_NAMED = 6;

/** the shape this needs out of `app.getAppMetrics()`, and nothing more */
export interface CpuProcessSample {
  pid: number;
  type: string;
  name?: string;
  /** share of the WHOLE MACHINE, 0-100 — see the note at the top of this file */
  percent: number;
  /**
   * Working set in KB, when the source reports it (#1031).
   *
   * `app.getAppMetrics()` already carries `memory.workingSetSize` and this file
   * already calls it, so a continuous record of renderer growth costs one more
   * field on a line we were writing anyway. #1013's headline — a renderer at
   * **1.2 GB after 21 hours** — was read off Task Manager at one instant by
   * hand; a single sighting cannot tell a leak from a working set that is simply
   * large, and a curve can.
   *
   * ⚠️ THE UNIT IS ASSUMED KILOBYTES AND IS NOT DOCUMENTED IN ELECTRON 43'S
   * TYPINGS (review): only `ProcessMemoryInfo` says so outright, while
   * `MemoryInfo.workingSetSize` says only "the amount of memory currently pinned
   * to actual physical RAM". If it were bytes, a 1.2 GB renderer would log
   * `rssMb: 1`. On the hand-off list as a one-line check against Task Manager —
   * this project's own rule is not to guess a contract, and this is the cheapest
   * place that rule still has a hole.
   */
  workingSetKb?: number;
}

export interface CpuHeartbeatDeps {
  /**
   * Injected rather than calling `app.getAppMetrics()` here, for the reason the
   * update service injects its clock: this module is then testable without an
   * Electron app, which is where the normalisation arithmetic gets pinned.
   */
  getMetrics: () => CpuProcessSample[];
  log: Logger;
  /** logical cores. Logged, because cores' worth is meaningless without it. */
  coreCount: number;
  now?: () => number;
  /**
   * A MONOTONIC clock, for the lag gauge's cross-check (#1031). Optional: the
   * gauge works without it and simply reports one number instead of two.
   *
   * ⚠️ WHY THERE ARE TWO CLOCKS NOW. `lagTick` measures drift against `now`,
   * which is wall clock — so a stall and a suspended machine are the same
   * reading. The `resumedFromSleep` flag exists for exactly that and is wired to
   * `powerMonitor`, but **#1003's 3–4 second lag beats do not carry it**, so
   * either Windows never emitted `resume` for those transitions (modern standby
   * frequently does not) or they were genuine stalls. A wall clock cannot say
   * which.
   *
   * ⚠️ IT IS ONE-SIDED EVIDENCE AND MUST BE READ THAT WAY (review). A gap means
   * wall time passed that the monotonic clock did not see. **Agreement means
   * nothing at all** — it does not establish that we were blocked. On Windows
   * this clock is `QueryPerformanceCounter`: across **S3** sleep it does not
   * advance, so the designed signal appears; across **modern standby (S0ix)**
   * the counter keeps ticking, so wall and monotonic both advance and no gap
   * appears. Signature A — 3–4s drift, no `resume` event, laptop — is more
   * consistent with modern standby than with S3, which means **the case that
   * motivated this gauge is the case it is most likely to be blind to.** It is
   * still worth having: it costs one read a second and it converts the beats
   * where it DOES fire from ambiguous to decided.
   *
   * A second producer of a gap, not accounted for anywhere else: a **wall-clock
   * STEP**. Windows corrects the clock on resume and periodically, and Electron
   * offers no time-change event, so an NTP correction of a second or two reads
   * here exactly like a suspend. A gap is "wall time we did not see", never
   * "the machine slept" — the log says the former and means only that.
   *
   * `spike/probes/1031/` settles the S3-vs-S0ix question properly and needs a
   * real sleep cycle on the owner's laptop to run.
   */
  mono?: () => number;
  /**
   * Seconds since the last user input, from `powerMonitor.getSystemIdleTime()`
   * (#1031). Optional and injected for the same reason `getMetrics` is.
   *
   * ⭐ THE FIELD THAT MAKES A LAG READING MEAN SOMETHING. `lagMaxMs: 3207` with
   * two hours of idle time is not a slowdown anyone experienced; the same number
   * with zero idle time is the entire complaint. Without it every capture mixes
   * the two and every aggregate over them is meaningless.
   */
  idleSec?: () => number;
  /**
   * Extra numbers to carry on every beat — session counts, window counts.
   * "How much work was it being asked to do?" is the first question any capture
   * raises, and a burn figure with no load beside it cannot answer it. Optional
   * and fail-open: a counter that throws must never cost us the CPU line, which
   * is the part we came for.
   *
   * Values are not only numbers: the #719 process census carries a name →
   * count map (`sysTop`) and the app's own children by kind.
   */
  counters?: () => Record<string, unknown>;
}

/** what one beat found, returned so tests assert on values rather than log text */
export interface Beat {
  coreCount: number;
  /** cores' worth of CPU across every process */
  totalCores: number;
  /** the busiest single process, or null when nothing reported */
  busiest: { type: string; pid: number; cores: number } | null;
  lagMaxMs: number;
  /** the same stall measured monotonically, or null when no mono clock was given */
  lagMonoMaxMs: number | null;
  /** worst per-tick wall-minus-monotonic gap, or null without a mono clock */
  lagClockGapMaxMs: number | null;
  busy: boolean;
  resumedFromSleep: boolean;
  /** seconds since the last user input at beat time, or null without a source */
  idleSec: number | null;
  /** ...and as it was at the worst stall of the minute, which is the useful one */
  lagIdleSec: number | null;
}

const coresWorth = (percent: number, coreCount: number): number => (percent * coreCount) / 100;

/** one decimal is the useful precision here and keeps the line readable */
const round1 = (n: number): number => Math.round(n * 10) / 10;

export class CpuHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lagMaxMs = 0;
  private lagExpectedAt = 0;
  private lagMonoMaxMs = 0;
  /**
   * The monotonic baseline, or `null` for "not armed".
   *
   * ⚠️ NULLABLE ON PURPOSE, and a test found why: when the prime in `start()`
   * threw, a plain `0` baseline made the FIRST tick measure a full tick's
   * elapsed against zero and report a one-second monotonic stall that never
   * happened. `null` means "arm on the next tick and measure nothing", so a
   * failed read costs one sample instead of inventing one.
   */
  private monoExpectedAt: number | null = null;
  /** worst per-tick `wall - monotonic`: wall time the monotonic clock missed */
  private lagClockGapMaxMs = 0;
  /** idle seconds as they were at the worst stall of this minute */
  private lagIdleSec: number | null = null;
  private resumedFromSleep = false;

  constructor(private readonly deps: CpuHeartbeatDeps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    const now = this.deps.now ?? Date.now;

    // Prime the metric, and do not skip this. `percentCPUUsage` is an average
    // SINCE THE LAST CALL, so without a throwaway call here the first beat has
    // nothing to diff against and reads a flat zero — and the minute it would
    // otherwise have covered is app startup, which is the busiest minute there
    // is. Measured: a 140-second run of the real app reported zero for beat 1
    // and the whole startup burn was simply lost. The call costs under a
    // millisecond (probe 719).
    try {
      this.deps.getMetrics();
    } catch {
      // Fail-open: a source that throws here still gets its chance at the first
      // beat, which reports the failure properly rather than dying at start-up.
    }

    this.lagExpectedAt = now() + LAG_TICK_MS;
    // Guarded for `getMetrics`'s reason just above, and the test that found this
    // was aimed at `lagTick`: a throwing clock here would take START-UP down,
    // which is a spectacular price for an optional cross-check to charge.
    if (this.deps.mono) {
      try {
        this.monoExpectedAt = this.deps.mono() + LAG_TICK_MS;
      } catch {
        this.monoExpectedAt = null; // unarmed: the next tick arms it, silently
      }
    }
    this.lagTimer = setInterval(() => this.lagTick(), LAG_TICK_MS);
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);

    // Never hold the process open for a diagnostic — the convention every other
    // timer in main follows.
    this.lagTimer.unref?.();
    this.timer.unref?.();
  }

  /** Called from `app.on('quit')`, beside the other services' stops. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.timer = null;
    this.lagTimer = null;
  }

  /**
   * The machine slept and woke. Call this from `powerMonitor`'s `resume`.
   *
   * Without it, every morning on a laptop produces one beat claiming the app
   * was unresponsive for eight hours, at `warn` — because the lag gauge cannot
   * tell "nothing ran because the machine was suspended" from "nothing ran
   * because we were wedged". On the owner's LAPTOP, the only machine that has
   * ever shown #719, that would poison the warn channel daily and bury the
   * real signal under a fake one.
   *
   * Note what this deliberately does NOT do: cap or discard a large lag reading
   * on the grounds that it looks implausible. A genuine #719 freeze can last
   * minutes, and a rule that threw away long stalls would throw away precisely
   * the evidence this whole file exists to collect. Sleep is identified because
   * the OS says so, not because the number was big.
   */
  clockJumped(): void {
    // WRAPPED, for `beat()`'s reason and not a lesser one: this is called
    // straight from a `powerMonitor` listener, so an uncaught throw here is an
    // "A JavaScript error occurred" modal on top of whatever the user was doing
    // at the moment their machine woke up (review).
    try {
      this.resumedFromSleep = true;
      this.lagExpectedAt = (this.deps.now ?? Date.now)() + LAG_TICK_MS;
      // The monotonic baseline is re-armed too. If it were left alone, the first
      // tick after a wake would report the whole suspend against the clock whose
      // entire job is to say the suspend was not our fault (#1031).
      if (this.deps.mono) this.monoExpectedAt = this.deps.mono() + LAG_TICK_MS;
    } catch {
      // Unarmed rather than left stale, for the reason on `monoExpectedAt`.
      this.monoExpectedAt = null;
      // The flag is already set, which is the part that matters: the next beat
      // will say it covered a wake even if re-arming the baselines failed.
    }
  }

  /**
   * How long something else held the event loop: the drift of a fixed-period
   * timer. Kept as a max-since-last-beat rather than an average, because one
   * four-second stall inside a quiet minute is the entire signal and a mean
   * over 60 samples would bury it.
   */
  private lagTick(): void {
    try {
      if (this.stopped) return;
      const now = (this.deps.now ?? Date.now)();
      const drift = now - this.lagExpectedAt;
      if (drift > this.lagMaxMs) {
        this.lagMaxMs = drift;
        // ⭐ IDLE TIME IS CAPTURED HERE, AT THE WORST TICK, not at beat time
        // (review). Read at beat time it could be up to 60 seconds away from the
        // stall it sits beside: one click at second 59 after an hour away would
        // report `idleSec: 1` next to a stall nobody was present for — which is
        // the exact confusion the field exists to remove. A handful of reads a
        // minute, usually none.
        this.lagIdleSec = this.readIdle();
      }

      // The same tick on a clock that does not follow the wall (#1031), and the
      // GAP BETWEEN THEM PER TICK — which is the discriminator, not the
      // difference of the two maxima (review). Those maxima can come from
      // different ticks: a minute holding a 5s suspend early and a genuine 5s
      // block later yields two equal maxima, they agree, and the suspend
      // vanishes. `wallDrift - monoDrift` is the real quantity — wall time the
      // monotonic clock did not see — and one event cannot be masked by another.
      const mono = this.deps.mono;
      let monoNow: number | null = null;
      if (mono) {
        monoNow = mono();
        // Only measure against an ARMED baseline. An unarmed one means the last
        // read failed, and measuring one tick's elapsed against a stale or zero
        // baseline is how a stall gets fabricated rather than observed.
        if (this.monoExpectedAt !== null) {
          const monoDrift = monoNow - this.monoExpectedAt;
          if (monoDrift > this.lagMonoMaxMs) this.lagMonoMaxMs = monoDrift;
          const gap = drift - monoDrift;
          if (gap > this.lagClockGapMaxMs) this.lagClockGapMaxMs = gap;
        }
      }

      // BOTH baselines are re-armed together, at the end, and that is a fix for
      // a measured fabrication (review): when the wall baseline advanced and a
      // throwing `mono()` left the monotonic one behind, the next tick measured
      // two ticks' elapsed against a one-tick baseline and logged a ~1s
      // MONOTONIC stall with a 0ms wall stall — a physically impossible reading,
      // growing without bound while the throw persisted.
      this.lagExpectedAt = now + LAG_TICK_MS;
      if (monoNow !== null) this.monoExpectedAt = monoNow + LAG_TICK_MS;
    } catch {
      // A gauge that can throw into setInterval is a modal over the user's work.
    }
  }

  /** Idle seconds, or null — never at the cost of the reading it accompanies. */
  private readIdle(): number | null {
    if (!this.deps.idleSec) return null;
    try {
      const v = this.deps.idleSec();
      return Number.isFinite(v) ? Math.round(v) : null;
    } catch {
      return null;
    }
  }

  /**
   * The timer body, wrapped so NOTHING escapes into `setInterval`. An uncaught
   * throw from an interval callback in the main process is an "A JavaScript
   * error occurred" modal on top of whatever the user was doing — which is a
   * spectacular price for a diagnostic to charge.
   */
  beat(): Beat | null {
    try {
      if (this.stopped) return null;
      return this.emit();
    } catch (err) {
      try {
        this.deps.log.warn('cpu heartbeat tick failed', { error: errorText(err) });
      } catch {
        // the logger itself is gone; there is nowhere left to say so
      }
      return null;
    }
  }

  private emit(): Beat {
    const { coreCount, log } = this.deps;
    const samples = this.deps.getMetrics();

    const ranked = samples
      .map((s) => ({
        type: s.type,
        name: s.name,
        pid: s.pid,
        cores: coresWorth(s.percent, coreCount),
        workingSetKb: s.workingSetKb,
      }))
      .sort((a, b) => b.cores - a.cores);

    // Every process counts toward the total, not just the named ones: the
    // whole-machine figure is what catches "many processes, none of them
    // individually alarming", which is a shape #719 could well take.
    const totalCores = ranked.reduce((a, p) => a + p.cores, 0);
    const top = ranked[0] ?? null;

    const lagMaxMs = this.lagMaxMs;
    const lagMonoMaxMs = this.deps.mono ? this.lagMonoMaxMs : null;
    const lagClockGapMaxMs = this.deps.mono ? this.lagClockGapMaxMs : null;
    const lagIdleSec = this.lagIdleSec;
    const resumedFromSleep = this.resumedFromSleep;
    // Max since the LAST beat, so each line describes its own minute.
    this.lagMaxMs = 0;
    this.lagMonoMaxMs = 0;
    this.lagClockGapMaxMs = 0;
    this.lagIdleSec = null;
    this.resumedFromSleep = false;

    // Idle at the moment the LINE is written, which is a different question from
    // `lagIdleSec` above and is why they are two fields rather than one: this one
    // says whether anyone was around for the minute in general.
    const idleSec = this.readIdle();

    // Compared on the ROUNDED value, so a line reading `cores: 0.5` is never
    // `info` on one beat and `warn` on the next for a difference the reader
    // cannot see.
    const busy =
      round1(top?.cores ?? 0) >= BUSY_CORES ||
      totalCores >= coreCount * BUSY_MACHINE_FRACTION ||
      lagMaxMs >= LAG_WARN_MS;

    const fields: Record<string, unknown> = {
      coreCount,
      // cores' worth: 1.0 means "one core fully pegged", on any machine
      totalCores: round1(totalCores),
      lagMaxMs: Math.round(lagMaxMs),
      // Processes at zero are dropped rather than listed: on an idle app that is
      // all of them, and a line per minute forever has to earn its bytes.
      procs: ranked
        .filter((p) => round1(p.cores) > 0)
        .slice(0, MAX_NAMED)
        .map((p) => ({
          type: p.type,
          ...(p.name ? { name: p.name } : {}),
          pid: p.pid,
          cores: round1(p.cores),
          // MB, and only when the source gave us one. Rounded to whole MB
          // because the question is "is this growing by hundreds" and a decimal
          // would widen every line for nothing (#1031).
          ...(p.workingSetKb !== undefined
            ? { rssMb: Math.round(p.workingSetKb / 1024) }
            : {}),
        })),
    };

    // ⚠️ MEMORY IS REPORTED FOR THE WHOLE APP, NOT ONLY THE NAMED PROCESSES.
    // `procs` drops anything at zero CPU, which is exactly where a leaked
    // renderer sits: idle and enormous. A beat that listed no processes would
    // otherwise carry no memory at all, and "the app was quiet" is the shape of
    // minute this field most needs to describe (#1031).
    //
    // ⚠️ IT DOUBLE-COUNTS SHARED PAGES and is therefore an UPPER BOUND, useful
    // as a trend and not as a true footprint (review): the Chromium image itself
    // is counted once per process. `privateBytes` would be the summable figure
    // on win32, and is the better field the day this stops being enough.
    const rssTotalKb = ranked.reduce((a, p) => a + (p.workingSetKb ?? 0), 0);
    if (rssTotalKb > 0) fields.rssTotalMb = Math.round(rssTotalKb / 1024);

    // Only when a source exists, and only when some tick saw the two clocks
    // disagree — see `mono`'s docblock. On the overwhelming majority of beats
    // the gap is a millisecond or two and the line stays the width it was. Both
    // numbers go out together: the gap is the evidence, the monotonic max is
    // what makes the line readable beside `lagMaxMs`.
    if (lagClockGapMaxMs !== null && lagClockGapMaxMs >= LAG_CLOCK_DISAGREE_MS) {
      fields.lagClockGapMs = Math.round(lagClockGapMaxMs);
      if (lagMonoMaxMs !== null) fields.lagMonoMaxMs = Math.round(lagMonoMaxMs);
    }
    if (idleSec !== null) fields.idleSec = idleSec;
    // Paired with the stall rather than with the line, and carried only when the
    // stall was worth promoting — otherwise every quiet minute would repeat a
    // number that differs from `idleSec` by a rounding error.
    if (lagIdleSec !== null && lagMaxMs >= LAG_WARN_MS) fields.lagIdleSec = lagIdleSec;

    // Only when true, so it is a flag a reader notices rather than noise on
    // every line: the beat covering a wake-up has a lag reading that describes
    // the suspend, not the app.
    if (resumedFromSleep) fields.resumedFromSleep = true;

    if (this.deps.counters) {
      try {
        Object.assign(fields, this.deps.counters());
      } catch (err) {
        fields.countersError = errorText(err);
      }
    }

    // Promoted, not duplicated: one line per beat either way, so the log has a
    // continuous record and `warn` still picks out the interesting minutes.
    if (busy) log.warn('cpu heartbeat', fields);
    else log.info('cpu heartbeat', fields);

    return {
      coreCount,
      totalCores,
      busiest: top ? { type: top.type, pid: top.pid, cores: top.cores } : null,
      lagMaxMs,
      lagMonoMaxMs,
      lagClockGapMaxMs,
      busy,
      resumedFromSleep,
      idleSec,
      lagIdleSec,
    };
  }
}
