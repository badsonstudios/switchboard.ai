// DiscoverySchedule (P2-E15-11 / AR-P1-8): decides WHEN transcript discovery
// is allowed to touch the disk.
//
// The problem it exists to solve, measured on Dan's machine 2026-08-01:
// `~/.claude/projects` holds 43 directories, 1,128 transcripts, 2,090 entries.
// `poll()` runs every 100ms, and any session unbound past 10s triggered a FULL
// recursive scan of that tree — a `readdirSync` per directory plus a `statSync`
// per entry, ten times a second, per unbound session. ~21,000 syscalls/sec on
// the one thread that also pumps every PTY, serves every IPC call and answers
// every hook. Three unbound cards tripled it.
//
// THE CONTRACT, and the reason this is safe:
//
//   `fs.watch` is an ACCELERATOR, never the authority.
//
// That is the same rule this module already applies to slug math ("a PREFILTER,
// never the authority" — watcher.ts), and it is deliberate. Recursive `fs.watch`
// is the flakiest API in Node's standard library: unsupported on older Linux,
// unreliable over network and UNC home directories, and coalescing-happy on
// macOS. So every guarantee in this item's done-when list is met by the BACKOFF
// alone, and the watch only makes it fast. If the watch never fires a single
// event, discovery still runs — just on the slower ladder. Fail-open (a hard
// constraint) means our cleverness breaking must not leave a session unbound.
import fs from 'fs';
import { Logger } from '../log/logger';

/** Sweep ladder used while nothing is happening, in ms. Capped at 2s so that
 *  even with the watch completely dead, discovery stays inside the S-04 ~4s
 *  budget — the done-when says a session must bind NO SLOWER than today, and
 *  that has to hold on the degraded path too, not just the happy one. */
const BACKOFF_MS = [250, 500, 1000, 2000] as const;

/** Used instead of the ladder once we know the watch is not delivering. Flat,
 *  not decaying: there is no signal coming, so backing off further would only
 *  add latency with nothing to gain. Still 20x less I/O than the 100ms poll. */
const WATCH_FAILED_MS = 500;

/** How long a failed watch stays failed before we try to open it again.
 *  `markWatchFailed` used to be one-way, which is easy to trip by accident: a
 *  ReadDirectoryChangesW buffer overflow (plausible on a root holding 1,128
 *  transcripts during a burst) surfaces as an `error` on the FSWatcher, and one
 *  transient burst would have pinned the process to flat sweeps for the rest of
 *  its life. */
const WATCH_REARM_MS = 60_000;

/** Closeable handle — `fs.FSWatcher` in production, a stub in tests. */
export interface WatchHandle {
  close(): void;
}

export interface DiscoveryScheduleOptions {
  log: Logger;
  /** Injectable so tests can drive events and simulate an unusable watch
   *  without touching a real filesystem. Return null to mean "cannot watch". */
  watchFactory?: (root: string, onChange: () => void, onError: (err: unknown) => void) => WatchHandle | null;
  backoffMs?: readonly number[];
  watchFailedMs?: number;
  watchRearmMs?: number;
}

interface RootState {
  /** something appeared or moved — sweep on the next tick regardless of clock */
  dirty: boolean;
  lastSweepAt: number;
  backoffIdx: number;
  handle: WatchHandle | null;
  watchFailed: boolean;
  /** when the watch was declared dead, so it can be retried (never one-way) */
  failedAt: number;
  /** how many sessions are on this root — the last one out closes the watch */
  refs: number;
  /** counters, for the log line and for tests that assert we stopped scanning */
  sweeps: number;
  events: number;
}

function defaultWatchFactory(
  root: string,
  onChange: () => void,
  onError: (err: unknown) => void
): WatchHandle | null {
  try {
    const w = fs.watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      // ONLY file appearance/disappearance matters here.
      //
      // This filter is load-bearing, not an optimization. A recursive watch on
      // the projects root sees every APPEND to every transcript, and the CLI
      // appends constantly during a turn — so without it the root would be
      // dirty on essentially every tick and we would have rebuilt the 100ms
      // scan firehose with extra steps. Discovery cares about files APPEARING;
      // content changes are the tail drain's business and it has its own path.
      //
      // Node maps FILE_ACTION_ADDED/REMOVED/RENAMED to 'rename' and MODIFIED to
      // 'change' on Windows. macOS FSEvents is coarser and MAY report a
      // creation as 'change' — which is precisely why the backoff is the
      // guarantee and this is only the accelerator. A missed create costs at
      // most one ladder step, never a session that never binds.
      if (eventType === 'rename' || filename == null) onChange();
    });
    w.on('error', onError);
    w.unref?.();
    return w;
  } catch (err) {
    onError(err);
    return null;
  }
}

export class DiscoverySchedule {
  private readonly roots = new Map<string, RootState>();
  private readonly backoff: readonly number[];
  private readonly failedMs: number;

  constructor(private readonly opts: DiscoveryScheduleOptions) {
    this.backoff = opts.backoffMs?.length ? opts.backoffMs : BACKOFF_MS;
    this.failedMs = opts.watchFailedMs ?? WATCH_FAILED_MS;
  }

  /** Begin watching a root (idempotent) and ask for an immediate first sweep.
   *  A newly watched session must not wait out a ladder step before anyone
   *  looks for its transcript — that would make binding SLOWER than today,
   *  which the done-when forbids. */
  register(root: string): void {
    const key = this.key(root);
    let st = this.roots.get(key);
    if (!st) {
      st = {
        dirty: true,
        lastSweepAt: 0,
        backoffIdx: 0,
        handle: null,
        watchFailed: false,
        failedAt: 0,
        refs: 0,
        sweeps: 0,
        events: 0,
      };
      this.roots.set(key, st);
      this.openWatch(root, st, 0);
    } else {
      this.markDirty(root);
    }
    st.refs++;
  }

  /** One session stopped watching this root. The LAST one out closes the
   *  handle: a recursive watch on the projects root is an OS-level resource
   *  that keeps delivering callbacks, so leaving it open after every card is
   *  closed leaks it for the life of the process. */
  release(root: string): void {
    const key = this.key(root);
    const st = this.roots.get(key);
    if (!st) return;
    st.refs--;
    if (st.refs > 0) return;
    try {
      st.handle?.close();
    } catch (err) {
      this.opts.log.debug('transcript discovery watch close failed', { root, err: String(err) });
    }
    this.roots.delete(key);
  }

  /** Force a sweep on the next tick. Called for anything that changes what a
   *  sweep would conclude but that no filesystem event describes: a session
   *  starting, binding, or having its binding reset. The bind case matters for
   *  correctness, not speed — P2-E15-10's `candidateSeen` can RETRACT, and a
   *  sibling only learns that the file troubling it found its rightful owner by
   *  sweeping again. */
  markDirty(root: string): void {
    const st = this.roots.get(this.key(root));
    if (!st) return;
    st.dirty = true;
    st.backoffIdx = 0; // something really happened — be fast again
  }

  /** May discovery touch the disk for this root on this tick? Pure: it reads
   *  state and answers. `noteSwept` is what mutates, and it is called ONCE per
   *  root per tick so that two sessions sharing a root cannot starve each
   *  other — the first one to sweep must not consume the second one's turn. */
  shouldSweep(root: string, now: number): boolean {
    const st = this.roots.get(this.key(root));
    if (!st) return true; // unknown root: never block discovery on bookkeeping
    if (st.dirty) return true;
    // A wall clock that steps BACKWARDS (NTP correction, VM resume, the user
    // changing the clock) would otherwise make this subtraction negative and
    // stall discovery until real time caught up — for an hour-sized jump, an
    // hour with no discovery at all, and worst on the watch-failed path that
    // exists precisely so nothing else can stall it.
    if (now < st.lastSweepAt) return true;
    return now - st.lastSweepAt >= this.intervalFor(st);
  }

  /** Record that this root was swept on this tick. */
  noteSwept(root: string, now: number): void {
    const st = this.roots.get(this.key(root));
    if (!st) return;
    st.dirty = false;
    st.lastSweepAt = now;
    st.sweeps++;
    if (st.backoffIdx < this.backoff.length - 1) st.backoffIdx++;
    // Cheapest place to retry a dead watch: once per root per swept tick, and
    // only after the re-arm delay.
    if (st.watchFailed && now - st.failedAt >= (this.opts.watchRearmMs ?? WATCH_REARM_MS)) {
      this.openWatch(root, st, now);
    }
  }

  stop(): void {
    for (const [root, st] of this.roots) {
      try {
        st.handle?.close();
      } catch (err) {
        this.opts.log.debug('transcript discovery watch close failed', { root, err: String(err) });
      }
      st.handle = null;
    }
    this.roots.clear();
  }

  /** Test/diagnostic view. */
  stats(
    root: string
  ): { sweeps: number; events: number; watchFailed: boolean; backoffMs: number; refs: number } | null {
    const st = this.roots.get(this.key(root));
    return st
      ? {
          sweeps: st.sweeps,
          events: st.events,
          watchFailed: st.watchFailed,
          backoffMs: this.intervalFor(st),
          refs: st.refs,
        }
      : null;
  }

  /** Two spellings of one directory must not open two recursive watches on the
   *  same tree — a watch handle is a far costlier duplicate than a Set entry. */
  private key(root: string): string {
    return process.platform === 'win32' ? root.toLowerCase() : root;
  }

  private openWatch(root: string, st: RootState, now: number): void {
    const factory = this.opts.watchFactory ?? defaultWatchFactory;
    let handle: WatchHandle | null = null;
    try {
      handle = factory(
        root,
        () => this.onWatchEvent(root),
        (err) => this.onWatchError(root, err)
      );
    } catch (err) {
      handle = null;
      this.opts.log.debug('transcript discovery watch factory threw', { root, err: String(err) });
    }
    if (!handle) {
      this.markWatchFailed(root, 'watch could not be created', now);
      return;
    }
    st.handle = handle;
    if (st.watchFailed) {
      st.watchFailed = false;
      this.opts.log.info('transcript discovery watch restored', { root });
    }
  }

  private intervalFor(st: RootState): number {
    return st.watchFailed ? this.failedMs : this.backoff[Math.min(st.backoffIdx, this.backoff.length - 1)];
  }

  private onWatchEvent(root: string): void {
    const st = this.roots.get(this.key(root));
    if (!st) return;
    st.events++;
    st.dirty = true;
    st.backoffIdx = 0;
  }

  private onWatchError(root: string, err: unknown): void {
    // No monotonic source here — the error arrives on the watcher's own
    // callback, not on a poll tick — and `failedAt` only gates the re-arm, so
    // wall time is good enough. A clock jump costs at most one extra retry.
    this.markWatchFailed(root, String(err), Date.now());
  }

  /** Downgrade to the flat fallback. Logged once per root: a watch that dies
   *  mid-run can emit errors repeatedly, and this is a degradation, not an
   *  outage — discovery still works, just on the clock. */
  private markWatchFailed(root: string, reason: string, now: number): void {
    const st = this.roots.get(this.key(root));
    if (!st) return;
    st.failedAt = now;
    // Release the dead handle BEFORE dropping the reference to it — nulling
    // first would leak the very thing we are trying to let go of.
    const dead = st.handle;
    st.handle = null;
    try {
      dead?.close();
    } catch {
      /* already gone */
    }
    if (st.watchFailed) return; // already degraded: re-arm timing only
    st.watchFailed = true;
    st.dirty = true;
    this.opts.log.info('transcript discovery watch unavailable — falling back to timed sweeps', {
      root,
      reason,
      everyMs: this.failedMs,
      note: 'discovery still runs; only its latency changes',
    });
  }
}
