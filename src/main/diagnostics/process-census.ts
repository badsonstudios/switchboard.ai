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
import { execFile } from 'child_process';

/** How often to count. Matches the heartbeat, so each beat carries a fresh one. */
export const CENSUS_MS = 60_000;

/** A count that has not finished by now is abandoned and reported as failed. */
export const CENSUS_TIMEOUT_MS = 30_000;

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
    this.timer = setInterval(() => this.sample(), CENSUS_MS);
    this.timer.unref?.();
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
            ? { sysEnumError: String(err).slice(0, 200), sysEnumMs: Math.round(enumMs) }
            : summarize(this.parse(stdout), enumMs);
        } catch (e) {
          this.last = { sysEnumError: String(e).slice(0, 200) };
        } finally {
          this.inFlightSince = null;
        }
      });
    } catch (e) {
      // execFile THROWS some failures instead of calling back (see
      // `git/git-service.ts`, #785), so this path is real.
      this.inFlightSince = null;
      this.last = { sysEnumError: String(e).slice(0, 200) };
    }
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
    return out;
  }
}
