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
//
// ONE qualifier, added by #129: that promise is made to a session that is still
// LOOKING. A root where nobody is looking any more drops to `GIVEN_UP_MS`, and
// there the watch stops being only an accelerator: with it dead too, a
// transcript that turns up late is found on the slow rung rather than the
// ladder. Nothing is left unbound, and every evidence site puts the root back on
// the ladder at once.
//
// #388 makes the same qualifier apply PER SESSION, because the throttle above is
// per root and the scan cost is per session: `poll()` walks the tree once for
// every unbound session on a swept tick, so one live card kept every session
// that had stopped looking paying full price. The rung is the same
// (`GIVEN_UP_MS`) and so is the reprieve — see `noteSwept`'s return value and
// `quietRungDue`, which are this module's half of it. The watcher still owns the
// question of which sessions have stopped looking; this module only owns when.
import fs from 'fs';
import { Logger } from '../log/logger';

/** Sweep ladder used while nothing is happening, in ms. Capped at 2s so that
 *  even with the watch completely dead, discovery stays inside the S-04 ~4s
 *  budget — the done-when says a session must bind NO SLOWER than today, and
 *  that has to hold on the degraded path too, not just the happy one. The cap
 *  is the guarantee for as long as ANYONE on the root is still searching; see
 *  `GIVEN_UP_MS` for what happens when nobody is. */
const BACKOFF_MS = [250, 500, 1000, 2000] as const;

/** Used instead of the ladder once we know the watch is not delivering. Flat,
 *  not decaying: there is no signal coming, so backing off further would only
 *  add latency with nothing to gain. Still 20x less I/O than the 100ms poll. */
const WATCH_FAILED_MS = 500;

/**
 * The rung a root drops to once EVERY session on it has stopped looking (#129),
 * and — since #388 — the rung an individual session that has stopped looking
 * scans on even while its root is still fast for somebody else.
 *
 * The ladder above caps at 2s because a session that is still searching must
 * bind no slower than it used to. A session the watcher has already declared
 * `unbound` is not searching any more — the UI said so 45 seconds ago — and it
 * kept walking the whole tree anyway: ~2,100 syscalls per sweep, so ~1,050/sec
 * per card at the 2s cap and ~4,200/sec on the watch-failed 500ms rung, for the
 * rest of the run. Announced failure plus permanent full scans is the worst of
 * both: we pay the price of looking and get none of the credit.
 *
 * Flat, for `WATCH_FAILED_MS`'s reason: nothing is expected here, and every
 * event that could change the answer prods the root back to the fast ladder
 * (see `fastSweepsLeft`). 30s is chosen against the DEGRADED path rather than
 * the happy one — with the recursive watch alive a transcript appearing is an
 * immediate sweep, so this interval is only ever felt when the watch AND the
 * hooks are both silent, and there it is the difference between binding a
 * surprise transcript half a minute late and burning a thread forever.
 */
const GIVEN_UP_MS = 30_000;

/** How long a failed watch stays failed before we try to open it again.
 *  `markWatchFailed` used to be one-way, which is easy to trip by accident: a
 *  ReadDirectoryChangesW buffer overflow (plausible on a root holding 1,128
 *  transcripts during a burst) surfaces as an `error` on the FSWatcher, and one
 *  transient burst would have pinned the process to flat sweeps for the rest of
 *  its life. */
const WATCH_REARM_MS = 60_000;

/**
 * Two spellings of one directory are ONE root — a watch handle is a far
 * costlier duplicate than a Set entry, and on win32 case is not identity.
 *
 * Exported because a caller that GROUPS sessions by root has to group them the
 * way this module does (#129): the give-up quorum is one answer per root, and
 * computing it under a second notion of identity would let a session spelling
 * the root one way overwrite the answer for a session spelling it another.
 */
export function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** Closeable handle — `fs.FSWatcher` in production, a stub in tests. */
export interface WatchHandle {
  close(): void;
}

export interface DiscoveryScheduleOptions {
  log: Logger;
  /** Injectable so tests can drive events and simulate an unusable watch
   *  without touching a real filesystem. Return null to mean "cannot watch". */
  watchFactory?: (
    root: string,
    onChange: (filename?: string | null) => void,
    onError: (err: unknown) => void
  ) => WatchHandle | null;
  backoffMs?: readonly number[];
  watchFailedMs?: number;
  watchRearmMs?: number;
  givenUpMs?: number;
}

interface RootState {
  /** OUR OWN state changed (a session started, bound, reset, learned its native
   *  id). Immediate: no filesystem event describes these, and they are rare. */
  dirty: boolean;
  /** the filesystem said something about a path we have ALREADY seen — almost
   *  always an append. Subject to a floor; see `shouldSweep`. */
  fsDirty: boolean;
  /** every path this root's watch has ever named. A path we have not seen is a
   *  file APPEARING, which is the only thing discovery cares about. */
  seenNames: Set<string>;
  lastSweepAt: number;
  backoffIdx: number;
  handle: WatchHandle | null;
  watchFailed: boolean;
  /** when the watch was declared dead, so it can be retried (never one-way) */
  failedAt: number;
  /** Nobody on this root is looking for a transcript any more (#129, widened by
   *  #388 to include a card nobody has prompted for `UNPROMPTED_FAST_MS` — not
   *  every unprompted card, only one past that window). Level-driven by the
   *  watcher on every tick and never latched here: a session binding, being
   *  replaced, or a new card opening on this root puts it back to false without
   *  this module having to know what any of those things are. */
  givenUp: boolean;
  /** Swept ticks still owed to the FAST ladder while `givenUp` (#129).
   *
   *  A give-up is not a death sentence — a transcript can still turn up, and
   *  the item that made this rung slow is also the item that has to guarantee
   *  it is not a session that can NEVER bind. So every evidence site
   *  (`markDirty`, a new path on the watch) buys the root one full pass back
   *  down the ladder — an immediate sweep and then 500/1000/2000, ~3.5s of
   *  looking properly — before it goes quiet again.
   *
   *  #388 spends the SAME counter on a second question: which sessions take
   *  part in a sweep. That is deliberate rather than a second reprieve of its
   *  own — a root is either inside a post-evidence pass or it is not, and two
   *  counters could disagree about it. `noteSwept` reports the answer for the
   *  sweep it consumes, so no caller can read it on the wrong side of the
   *  decrement. Counted in sweeps rather
   *  than derived from `backoffIdx` deliberately: an append to a KNOWN path
   *  also resets that index, so a busy neighbouring session under the same root
   *  could otherwise hold a given-up root on the fast ladder for ever.
   *
   *  One reprieve is one pass down the ladder, so a test injecting a
   *  single-rung `backoffMs` gets exactly the immediate sweep and nothing
   *  after it. */
  fastSweepsLeft: number;
  /** how many sessions are on this root — the last one out closes the watch */
  refs: number;
  /** counters, for the log line and for tests that assert we stopped scanning */
  sweeps: number;
  events: number;
}

function defaultWatchFactory(
  root: string,
  onChange: (filename?: string | null) => void,
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
      // 'change' on Windows, and Linux inotify maps IN_CREATE/IN_MOVED_TO to
      // 'rename'. macOS FSEvents does NOT honour the distinction — CI proved it
      // reports an append as 'rename' too — so this filter is a per-platform
      // OPTIMISATION and nothing may depend on it. What actually separates a
      // new file from an append is the PATH, which `onWatchEvent` decides.
      if (eventType === 'rename' || filename == null) onChange(filename);
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
  private readonly givenUpMs: number;

  constructor(private readonly opts: DiscoveryScheduleOptions) {
    this.backoff = opts.backoffMs?.length ? opts.backoffMs : BACKOFF_MS;
    this.failedMs = opts.watchFailedMs ?? WATCH_FAILED_MS;
    this.givenUpMs = opts.givenUpMs ?? GIVEN_UP_MS;
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
        fsDirty: false,
        seenNames: new Set(),
        lastSweepAt: 0,
        backoffIdx: 0,
        handle: null,
        watchFailed: false,
        failedAt: 0,
        givenUp: false,
        fastSweepsLeft: this.backoff.length,
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
    this.goFast(st);
  }

  /**
   * Has every session on this root stopped looking (#129, #388)?
   *
   * Level-driven, and asked on every tick: the watcher owns the question (only
   * it knows what a session is, or what "stopped looking" means for one) and
   * this module owns the consequence. `true` drops the root to `GIVEN_UP_MS` —
   * a failure that has already been announced to the user is not made worse by
   * finding out about its reprieve half a minute late — but only once any
   * outstanding fast sweeps are spent, so the LAST evidence still gets a full
   * look.
   *
   * Three populations answer `true`, and the watcher's `stillLooking` is where
   * each is argued: a frozen session whose process died (#200), a session
   * declared `unbound` (#129), and a card nobody has prompted for longer than a
   * first prompt is plausibly still coming (#388). None of the three is a state
   * this module can see, which is why it only ever receives the verdict.
   *
   * A root nobody has registered is ignored, like every other call here:
   * bookkeeping never blocks discovery.
   */
  setGivenUp(root: string, givenUp: boolean): void {
    const st = this.roots.get(this.key(root));
    if (!st || st.givenUp === givenUp) return;
    st.givenUp = givenUp;
    if (givenUp) {
      this.opts.log.info('transcript discovery quiet — nobody on this root is looking any more', {
        root,
        everyMs: this.givenUpMs,
        note: 'any evidence — a new transcript, a turn, a native id — puts it back on the fast ladder',
      });
    } else {
      this.opts.log.info('transcript discovery back on the fast ladder', { root });
    }
  }

  /**
   * Has a session that has STOPPED LOOKING waited out its own quiet rung (#388)?
   *
   * The per-session half of #129. The throttle that item built is per root, but
   * the scan cost is per session — `poll()` walks the tree once for EVERY
   * unbound session on a swept tick — so a single live card kept every session
   * beside it that had already stopped looking paying the full ~2,100-syscall
   * price at the root's fast rung. This is that session's own floor, and it is
   * deliberately the SAME interval the root drops to: a session that has stopped
   * looking is worth one look every `GIVEN_UP_MS`, and whether the card next to
   * it is busy has nothing to do with that.
   *
   * A FLOOR, not a schedule — the sweep still has to happen, and the root
   * decides when, so the answer here is when a session becomes ELIGIBLE and not
   * when it looks. `sessionMaySweep` states the composed bound and the one
   * corner where it exceeds this interval.
   *
   * Pure arithmetic, and the state it reads lives on the caller's session — the
   * watcher owns what a session is, and a map keyed by session id here would be
   * a second lifecycle to keep in step with `unwatch`. Public so the interval
   * and the clock-backwards rule are pinned where every other rung's are.
   */
  quietRungDue(lastSweptAt: number, now: number): boolean {
    // A wall clock that steps BACKWARDS (NTP correction, VM resume, the user
    // changing it) would otherwise make this subtraction negative and stop a
    // session taking part in ANY sweep until real time caught up — for an
    // hour-sized jump, an hour in which it cannot bind. `shouldSweep` guards the
    // root's own clock the same way, and a session skipping the sweeps its root
    // is still running would be that guard defeated one level down.
    if (now < lastSweptAt) return true;
    return now - lastSweptAt >= this.givenUpMs;
  }

  /** May discovery touch the disk for this root on this tick? Pure: it reads
   *  state and answers. `noteSwept` is what mutates, and it is called ONCE per
   *  root per tick so that two sessions sharing a root cannot starve each
   *  other — the first one to sweep must not consume the second one's turn. */
  shouldSweep(root: string, now: number): boolean {
    const st = this.roots.get(this.key(root));
    if (!st) return true; // unknown root: never block discovery on bookkeeping
    // Our own state changing is immediate: rare, and binding correctness
    // depends on siblings re-sweeping on the very next tick.
    if (st.dirty) return true;
    // A filesystem event may never sweep faster than the ladder's fastest rung.
    //
    // This floor is what makes "the watch is an ACCELERATOR" true rather than
    // aspirational. The `rename`-only filter was supposed to keep appends from
    // dirtying the root — and on Windows and Linux it does — but macOS CI
    // proved it does NOT there: FSEvents reported an append as a second event,
    // so on macOS every write during a turn would mark the root dirty and we
    // would have rebuilt the 100ms firehose on one platform while believing we
    // had not. An accelerator that can outrun the thing it accelerates is not
    // an accelerator. The filter is still worth keeping — it makes Windows and
    // Linux quiet rather than merely bounded — but the GUARANTEE lives here,
    // where no platform's event semantics can reach it.
    //
    // The floor is the SLOW rung on a given-up root (#129). A known path is,
    // by this module's own reckoning, the CLI appending to a transcript it
    // already owns — the tail drain's business, not ours. Leaving the floor at
    // the fastest rung would have let one busy session anywhere under the root
    // hold every given-up card at 250ms sweeps on any platform that reports
    // appends (macOS does), which is this item's defect with extra steps.
    if (st.fsDirty && now - st.lastSweepAt >= (this.slowRung(st) ?? this.backoff[0])) return true;
    // A wall clock that steps BACKWARDS (NTP correction, VM resume, the user
    // changing the clock) would otherwise make this subtraction negative and
    // stall discovery until real time caught up — for an hour-sized jump, an
    // hour with no discovery at all, and worst on the watch-failed path that
    // exists precisely so nothing else can stall it.
    if (now < st.lastSweepAt) return true;
    return now - st.lastSweepAt >= this.intervalFor(st);
  }

  /**
   * Record that this root was swept on this tick.
   *
   * Returns whether the sweep it just consumed was a REPRIEVE sweep — one the
   * root still owed to its last piece of evidence (#388). The watcher spends
   * that answer on WHICH sessions take part: a session that has stopped looking
   * skips an ordinary sweep and takes every reprieve sweep, which is how every
   * evidence site — `markDirty`, a new path on the watch, an event with no
   * filename — restores its participation at once rather than leaving it to
   * wait out `quietRungDue`.
   *
   * Returned from the call that CONSUMES the reprieve rather than offered as a
   * separate query, deliberately: a reader on the wrong side of the decrement
   * would be off by one sweep, and nothing about that is visible enough for a
   * test to catch.
   *
   * An unregistered root reports a reprieve, like every other answer here:
   * bookkeeping never narrows discovery.
   */
  noteSwept(root: string, now: number): boolean {
    const st = this.roots.get(this.key(root));
    if (!st) return true;
    st.dirty = false;
    st.fsDirty = false;
    st.lastSweepAt = now;
    st.sweeps++;
    if (st.backoffIdx < this.backoff.length - 1) st.backoffIdx++;
    // Spend one of the fast sweeps the last evidence bought (#129). Counted on
    // every root, given-up or not, so the count is simply "sweeps since the
    // last evidence, capped" and a root that gives up long after its last prod
    // goes slow on the very tick the watcher says so.
    const reprieve = st.fastSweepsLeft > 0;
    if (st.fastSweepsLeft > 0) st.fastSweepsLeft--;
    // Cheapest place to retry a dead watch: once per root per swept tick, and
    // only after the re-arm delay. On a given-up root that means the retry can
    // land up to `GIVEN_UP_MS` late (#129) — which is the right trade in the
    // one direction it can go wrong: the watch is an accelerator, and a root
    // nobody is waiting on can afford to get it back half a minute late.
    if (st.watchFailed && now - st.failedAt >= (this.opts.watchRearmMs ?? WATCH_REARM_MS)) {
      this.openWatch(root, st, now);
    }
    return reprieve;
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
  stats(root: string): {
    sweeps: number;
    events: number;
    watchFailed: boolean;
    givenUp: boolean;
    backoffMs: number;
    refs: number;
  } | null {
    const st = this.roots.get(this.key(root));
    return st
      ? {
          sweeps: st.sweeps,
          events: st.events,
          watchFailed: st.watchFailed,
          givenUp: st.givenUp,
          backoffMs: this.intervalFor(st),
          refs: st.refs,
        }
      : null;
  }

  private key(root: string): string {
    return rootKey(root);
  }

  private openWatch(root: string, st: RootState, now: number): void {
    const factory = this.opts.watchFactory ?? defaultWatchFactory;
    let handle: WatchHandle | null = null;
    try {
      handle = factory(
        root,
        (filename) => this.onWatchEvent(root, filename),
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

  /** Be fast again: something happened that a sweep would conclude differently
   *  about. The reprieve is the #129 half — see `fastSweepsLeft`. */
  private goFast(st: RootState): void {
    st.dirty = true;
    st.backoffIdx = 0;
    st.fastSweepsLeft = this.backoff.length;
  }

  /** The slow rung, or null if this root is not on it (#129). One predicate,
   *  because the sweep interval and the filesystem-event floor must agree:
   *  either would otherwise be a way around the other. */
  private slowRung(st: RootState): number | null {
    return st.givenUp && st.fastSweepsLeft <= 0 ? this.givenUpMs : null;
  }

  private intervalFor(st: RootState): number {
    // Give-up outranks the watch-failed rung deliberately. That rung is the
    // expensive one (500ms flat, ~4,200 syscalls/sec on Dan's tree) and it
    // exists to keep a session that is still LOOKING bound-able with no events
    // to help it — which is exactly what a given-up session has stopped doing.
    const slow = this.slowRung(st);
    if (slow !== null) return slow;
    return st.watchFailed ? this.failedMs : this.backoff[Math.min(st.backoffIdx, this.backoff.length - 1)];
  }

  /**
   * A filesystem event. Whether it is URGENT is decided by the PATH, not by the
   * event type — because event types are not portable and we got burned trusting
   * them (macOS CI reported an append as a `rename`, which the type filter was
   * supposed to exclude).
   *
   * A path we have never seen is a file APPEARING, which is the entire point of
   * discovery: treat it exactly like our own state changing and sweep on the
   * next tick. A path we have seen before is, overwhelmingly, the CLI appending
   * to a transcript it already owns — the tail drain's business, not ours — so
   * it only gets a floored sweep. That keeps "a transcript appears, we bind on
   * the next tick" true on every platform, while an append storm during a busy
   * turn cannot sweep faster than the ladder's fastest rung on any of them.
   */
  private onWatchEvent(root: string, filename?: string | null): void {
    const st = this.roots.get(this.key(root));
    if (!st) return;
    st.events++;
    st.backoffIdx = 0;

    const name = filename == null ? null : String(filename);
    if (name === null) {
      // The platform did not tell us WHICH path moved. Assume the worst — it
      // could be the transcript we are waiting for.
      this.goFast(st);
      return;
    }
    if (st.seenNames.has(name)) {
      st.fsDirty = true;
      return;
    }
    // Unbounded growth would be a slow leak on a long-lived root; the set is
    // only a novelty filter, so forgetting everything costs one extra
    // immediate sweep per path, not correctness.
    if (st.seenNames.size > 5000) st.seenNames.clear();
    st.seenNames.add(name);
    // A transcript APPEARING is the one thing that can still rescue a root
    // every session gave up on, so it buys the fast ladder back (#129) — the
    // known-path branch above deliberately does not.
    this.goFast(st);
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
