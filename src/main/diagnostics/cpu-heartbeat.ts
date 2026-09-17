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

/** how many processes the line names, busiest first, so one beat stays one line */
export const MAX_NAMED = 6;

/** the shape this needs out of `app.getAppMetrics()`, and nothing more */
export interface CpuProcessSample {
  pid: number;
  type: string;
  name?: string;
  /** share of the WHOLE MACHINE, 0-100 — see the note at the top of this file */
  percent: number;
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
   * Extra numbers to carry on every beat — session counts, window counts.
   * "How much work was it being asked to do?" is the first question any capture
   * raises, and a burn figure with no load beside it cannot answer it. Optional
   * and fail-open: a counter that throws must never cost us the CPU line, which
   * is the part we came for.
   */
  counters?: () => Record<string, number>;
}

/** what one beat found, returned so tests assert on values rather than log text */
export interface Beat {
  coreCount: number;
  /** cores' worth of CPU across every process */
  totalCores: number;
  /** the busiest single process, or null when nothing reported */
  busiest: { type: string; pid: number; cores: number } | null;
  lagMaxMs: number;
  busy: boolean;
  resumedFromSleep: boolean;
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
    this.resumedFromSleep = true;
    this.lagExpectedAt = (this.deps.now ?? Date.now)() + LAG_TICK_MS;
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
      if (drift > this.lagMaxMs) this.lagMaxMs = drift;
      this.lagExpectedAt = now + LAG_TICK_MS;
    } catch {
      // A gauge that can throw into setInterval is a modal over the user's work.
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
        this.deps.log.warn('cpu heartbeat tick failed', { error: String(err) });
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
      }))
      .sort((a, b) => b.cores - a.cores);

    // Every process counts toward the total, not just the named ones: the
    // whole-machine figure is what catches "many processes, none of them
    // individually alarming", which is a shape #719 could well take.
    const totalCores = ranked.reduce((a, p) => a + p.cores, 0);
    const top = ranked[0] ?? null;

    const lagMaxMs = this.lagMaxMs;
    const resumedFromSleep = this.resumedFromSleep;
    // Max since the LAST beat, so each line describes its own minute.
    this.lagMaxMs = 0;
    this.resumedFromSleep = false;

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
        })),
    };

    // Only when true, so it is a flag a reader notices rather than noise on
    // every line: the beat covering a wake-up has a lag reading that describes
    // the suspend, not the app.
    if (resumedFromSleep) fields.resumedFromSleep = true;

    if (this.deps.counters) {
      try {
        Object.assign(fields, this.deps.counters());
      } catch (err) {
        fields.countersError = String(err);
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
      busy,
      resumedFromSleep,
    };
  }
}
