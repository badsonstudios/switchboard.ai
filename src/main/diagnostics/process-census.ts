// #719 — count every process on the machine once a minute, and time the count.
//
// Owner directive, 2026-09-22. The laptop incident that day ended with 122
// `node.exe` at idle (53 of them stranded copies of one MCP server), and the
// census that found them had to be typed by hand into a terminal the machine
// would barely open. The heartbeat now takes it on its own:
//
//   - `sysProcs`: how many processes, machine-wide. A pileup shows as a climb.
//   - `sysTop`: the most common image names. "node.exe: 122" is what named the
//     leak, so the line carries that shape rather than a bare total.
//   - `sysEnumMs`: how long the count took. That is itself a measurement: tens
//     of ms on a healthy box, and on the laptop mid-incident the owner could not
//     start a shell at all. The spawn-and-AV tax shows up here directly.
//
// One `tasklist` (Windows) or `ps` (elsewhere) a minute, async, never more than
// one in flight. A count still running when the next is due is NOT stacked
// behind it (stacking spawns is how an incident feeds itself). It is reported
// as `sysEnumPendingMs`, which is the loudest datum this file can produce.
// Every failure is logged as a field and swallowed: this is a diagnostic, and
// a diagnostic must never be why the app misbehaves (P6).
import { errorText } from '../../shared/error-text';
import { execFile } from 'child_process';

/** How often to count. Matches the heartbeat, so each beat carries a fresh one. */
export const CENSUS_MS = 60_000;

/** A count that has not finished by now is abandoned and reported as failed. */
export const CENSUS_TIMEOUT_MS = 30_000;

/**
 * A count slower than this means the machine is struggling to spawn at all, and
 * the next one is deferred (#1031).
 *
 * In #1007 this census reported `sysEnumMs` of 3,458–30,477 ms and **repeatedly
 * hit the 30-second timeout** — on a 12-core laptop, with ~630 processes and an
 * endpoint-security agent that taxes every spawn. A second's worth of `tasklist`
 * is a healthy reading on that machine; four is the machine telling us to stop
 * asking so often.
 */
export const CENSUS_SLOW_MS = 4_000;

/**
 * How far the interval may stretch while counts stay slow, and the step it grows
 * by.
 *
 * ⚠️ WHY BACK OFF RATHER THAN NARROW THE QUERY. #1013 proposed enumerating only
 * our own process tree instead of the machine. **Rejected, with a reason:** the
 * machine-wide count is what this file was built for and what earned its keep —
 * the 2026-09-22 incident ended with 122 `node.exe` at idle, 53 of them stranded
 * copies of one MCP server, and `sysTop` naming them is how that was found. In
 * #1007 the same field reads `conhost.exe: 56, node.exe: 42, cmd.exe: 41`, which
 * is the orphan problem #1013 confirmed from the other side. Scoping the query to
 * our own children would delete that evidence to save one spawn a minute.
 *
 * Backing off keeps every field and cuts the rate precisely when the cost is
 * real, which is the trade worth making.
 */
export const CENSUS_MAX_MS = 600_000;
export const CENSUS_BACKOFF_STEP = 2;

/** how many image names `sysTop` carries, most common first */
export const CENSUS_TOP = 5;

export type CensusFields = Record<string, unknown>;

/** Runs the platform's process lister and hands back its raw stdout. */
export type Enumerate = (cb: (err: Error | null, stdout: string) => void) => void;

/**
 * Image names out of `tasklist /fo csv /nh`: one row per process, with the
 * image name as the first quoted field. `"node.exe","1234","Console",...`
 */
export function namesFromTasklist(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/** Image names out of `ps -A -o comm=`: one per line, sometimes a full path. */
export function namesFromPs(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(l.lastIndexOf('/') + 1));
}

/** The line's fields for one finished count. */
export function summarize(names: string[], enumMs: number, top = CENSUS_TOP): CensusFields {
  const byName = new Map<string, number>();
  for (const n of names) {
    // Windows image names are case-insensitive, and `Node.exe` and `node.exe`
    // are one population, not two.
    const k = n.toLowerCase();
    byName.set(k, (byName.get(k) ?? 0) + 1);
  }
  const ranked = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    sysProcs: names.length,
    sysEnumMs: Math.round(enumMs),
    sysTop: Object.fromEntries(ranked.slice(0, top)),
  };
}

const defaultEnumerate: Enumerate = (cb) => {
  const win = process.platform === 'win32';
  const [file, args] = win ? ['tasklist', ['/fo', 'csv', '/nh']] : ['ps', ['-A', '-o', 'comm=']];
  // `tasklist` and `ps` are real binaries, not launchers, so execFile's own
  // timeout genuinely ends them. `killTree` exists for launchers (see
  // `transport/kill-tree.ts`).
  execFile(
    file,
    args,
    { windowsHide: true, timeout: CENSUS_TIMEOUT_MS, maxBuffer: 8 << 20, encoding: 'utf8' },
    (err, stdout) => cb(err, stdout ?? '')
  );
};

export interface ProcessCensusDeps {
  enumerate?: Enumerate;
  parse?: (out: string) => string[];
  now?: () => number;
}

export class ProcessCensus {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlightSince: number | null = null;
  private last: CensusFields = {};
  /** current cadence; grows while counts are slow, snaps back when one is fast */
  private everyMs = CENSUS_MS;
  /**
   * Ticks still to skip before the next count.
   *
   * ⚠️ COUNTED, NOT CLOCKED, AND THE FIRST DRAFT OF THIS WAS A CLOCK COMPARISON
   * THAT HALVED THE HEALTHY RATE (review). It set a due-time from the moment a
   * count FINISHED, while the timer fires on fixed 60s boundaries from `start()`
   * — and `setInterval` fires a hair late, never early. So the due-time always
   * landed a few hundred milliseconds past the next tick, every other tick was
   * skipped, and a healthy machine counted every TWO minutes while
   * `sysEnumEveryMs` stayed absent insisting it was one. Reproduced before it was
   * believed: three counts in six minutes, no field.
   *
   * A tick count cannot drift, cannot be fooled by jitter, and makes the cadence
   * exactly `everyMs / CENSUS_MS` ticks rather than approximately that.
   */
  private skipTicks = 0;
  private readonly enumerate: Enumerate;
  private readonly parse: (out: string) => string[];
  private readonly now: () => number;

  constructor(deps: ProcessCensusDeps = {}) {
    this.enumerate = deps.enumerate ?? defaultEnumerate;
    this.parse = deps.parse ?? (process.platform === 'win32' ? namesFromTasklist : namesFromPs);
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.sample(); // now, so the first beat has a count rather than nothing
    // The TIMER still ticks every minute; how often a tick actually counts is
    // `everyMs`, checked in `tick()`. Keeping one fixed interval and skipping
    // ticks is deliberately duller than rescheduling a timer per backoff step:
    // there is one timer to unref, one to clear, and no window in which a
    // reschedule could lose the chain and stop counting for ever (#1031).
    this.timer = setInterval(() => this.tick(), CENSUS_MS);
    this.timer.unref?.();
  }

  /**
   * The timer body: count, but only if the current cadence says it is due.
   *
   * Public for the reason `CpuHeartbeat.beat()` is — a test drives the cadence
   * directly rather than through a timer it would have to fake. `sample()` stays
   * the unconditional "count now" that `start()` uses, so the first count after
   * launch is never deferred by a backoff inherited from nowhere.
   */
  tick(): void {
    if (this.stopped) return;
    if (this.skipTicks > 0) {
      this.skipTicks -= 1;
      return;
    }
    this.sample();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start one count, unless one is already running. Never throws. */
  sample(): void {
    if (this.stopped || this.inFlightSince !== null) return;
    const t0 = this.now();
    this.inFlightSince = t0;
    try {
      this.enumerate((err, stdout) => {
        try {
          const enumMs = this.now() - t0;
          this.last = err
            ? { sysEnumError: errorText(err).slice(0, 200), sysEnumMs: Math.round(enumMs) }
            : summarize(this.parse(stdout), enumMs);
          // A failure counts as slow whatever it says. The failure this guards
          // against IS the 30-second timeout, and a timeout that reset the
          // cadence to a minute would keep asking a wedged machine to spawn
          // every minute for ever (#1031).
          this.pace(err !== null || enumMs >= CENSUS_SLOW_MS);
        } catch (e) {
          this.last = { sysEnumError: errorText(e).slice(0, 200) };
          this.pace(true);
        } finally {
          this.inFlightSince = null;
        }
      });
    } catch (e) {
      // execFile THROWS some failures instead of calling back (see
      // `git/git-service.ts`, #785), so this path is real.
      this.inFlightSince = null;
      this.last = { sysEnumError: errorText(e).slice(0, 200) };
      this.pace(true);
    }
  }

  /**
   * Set the cadence for the next count: wider while they are slow, straight back
   * to one a minute as soon as one is fast (#1031).
   *
   * RECOVERY IS IMMEDIATE AND BACKOFF IS GRADUAL, not symmetric, and that is the
   * point. A fast count is positive evidence that spawning is cheap again, so
   * there is nothing to be cautious about; a slow one is evidence the machine is
   * in trouble, and the cost of asking again too soon is paid by the user.
   */
  private pace(slow: boolean): void {
    this.everyMs = slow
      ? Math.min(this.everyMs * CENSUS_BACKOFF_STEP, CENSUS_MAX_MS)
      : CENSUS_MS;
    // `- 1` because the tick that triggers the NEXT count is itself one of the
    // interval's ticks: a cadence of 60s skips nothing, 120s skips one.
    this.skipTicks = Math.max(0, Math.round(this.everyMs / CENSUS_MS) - 1);
  }

  /**
   * The most recent finished count, as heartbeat fields, plus how long the
   * current one has been running if it is overdue.
   */
  fields(): CensusFields {
    const out: CensusFields = { ...this.last };
    if (this.inFlightSince !== null) {
      const pending = this.now() - this.inFlightSince;
      // Only when it is actually late. Every beat that lands mid-count would
      // otherwise carry a meaningless few-ms figure.
      if (pending >= 1_000) out.sysEnumPendingMs = Math.round(pending);
    }
    // Only while backed off, so the field's PRESENCE is the signal (#1031). A
    // reader who sees `sysProcs` unchanged across six beats needs to know
    // whether the machine is steady or whether we stopped asking — and without
    // this they would read a stale count as a fresh one.
    if (this.everyMs !== CENSUS_MS) out.sysEnumEveryMs = this.everyMs;
    return out;
  }
}
