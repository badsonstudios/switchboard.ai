// Following ONE open file, for the document viewer (P2-E16-04, §5.30).
//
// This is the differentiator, not the polish: §5.30's whole attention-ROI case
// for the viewer is reading `PROGRESS.md` while an agent rewrites it, which is
// the one thing an external editor does badly. Everything here exists to make
// that feel like watching, and nothing here reads a byte of the file.
//
// THE APPROACH IS `transcripts/discovery-scheduler.ts`'s, not a second watcher
// invented beside it. Three rules carried over verbatim, each because it was
// paid for once already:
//
//   1. **`fs.watch` is an ACCELERATOR, never the authority.** Every guarantee
//      below is met by the `FILE_WATCH_POLL_MS` stat floor alone; the watch only
//      makes it instant. If it never fires — a network share, an old kernel, a
//      mount that silently drops events — the viewer still follows the file.
//   2. **Coalesce, because the writer is not writing once.** An agent's "write"
//      is a truncate plus several appends, or a temp file and a rename. The
//      debounce is here, in main, so a burst costs one IPC message.
//   3. **Fail-open.** A watch that cannot be created, a stat that throws, a
//      directory that vanishes — none of them may throw at the caller. The worst
//      case is a viewer that does not update, which is exactly what the viewer
//      did before this item existed.
//
// WHAT IS WATCHED IS THE DIRECTORY, NOT THE FILE, and that is load-bearing.
// `fs.watch` on a file follows the INODE on Linux: the moment anything rewrites
// it by the write-temp-then-rename route — which is what most editors and a
// number of agent tools do — the watch is left holding the old inode and never
// reports another thing. It is also how a delete becomes invisible. The
// directory outlives all of that, and the events it delivers name the file, so
// one non-recursive handle answers "changed", "replaced" and "deleted" alike.
// Every event for any other name is dropped here and never leaves main — the
// scope grants a FILE, and nothing about its neighbours is ever reported.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';
import { HOST_STYLE, type ReadScope } from './read-scope';
import {
  FILE_WATCH_DEBOUNCE_MS,
  FILE_WATCH_MAX_WAIT_MS,
  FILE_WATCH_POLL_MS,
  FileWatchNotice,
  FileWatchResult,
} from '../../shared/ipc/fs';

/** Closeable handle — `fs.FSWatcher` in production, a stub in tests. Declared
 *  here rather than imported from the transcript scheduler: `main/fs` reaching
 *  into `main/transcripts` for a one-method interface would be a dependency
 *  between two subsystems that have nothing else to say to each other. */
export interface FileWatchHandle {
  close(): void;
}

/** What a `stat` tells us that decides whether a file MOVED. */
export interface FileSignature {
  readonly mtimeMs: number;
  readonly size: number;
  /** the inode / file index — a replaced file is a different file */
  readonly ino: number;
}

export interface FileWatchDeps {
  log: Logger;
  /** the same scope object `fs:read` uses — one rule, one enforcer */
  scope: ReadScope;
  /** deliver a notice to the caller that asked for it */
  push: (callerId: number, notice: FileWatchNotice) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  /** injectable so tests drive events without a real filesystem, exactly as
   *  `DiscoveryScheduleOptions.watchFactory` is. Return null for "cannot". */
  watchFactory?: (
    dir: string,
    onChange: (filename?: string | null) => void,
    onError: (err: unknown) => void
  ) => FileWatchHandle | null;
  /** stat, injectable for the same reason. Null means "not there". */
  probe?: (file: string) => FileSignature | null;
}

/** One viewer's interest in one file. */
interface Viewer {
  readonly callerId: number;
  readonly token: string;
  readonly file: WatchedFile;
}

interface WatchedFile {
  /** the REAL path, as `ReadScope.resolve` answered it */
  readonly path: string;
  readonly dir: string;
  readonly base: string;
  /** viewer keys holding this file open — the last one out closes the handle */
  readonly refs: Set<string>;
  handle: FileWatchHandle | null;
  poll: NodeJS.Timeout | null;
  timer: NodeJS.Timeout | null;
  /** when the current run of events began, for the max-wait ceiling */
  dirtySince: number | null;
  /** an event NAMED this file, so re-read it whether or not the stat moved */
  force: boolean;
  /** the watch is gone and the stat floor is carrying it — latched, so one
   *  `FSWatcher` erroring repeatedly is one log line and not a stream of them
   *  (`DiscoverySchedule.markWatchFailed`'s rule, same reason) */
  degraded: boolean;
  /** the signature as of the last settle, or null while the file is gone */
  sig: string | null;
  gone: boolean;
}

function defaultWatchFactory(
  dir: string,
  onChange: (filename?: string | null) => void,
  onError: (err: unknown) => void
): FileWatchHandle | null {
  try {
    // NOT recursive: one directory, and the file we care about is directly in
    // it. `persistent: false` plus `unref` so a watch never keeps the app alive
    // — the same pair the transcript scheduler uses.
    //
    // No event-type filter, deliberately, and this is where this module differs
    // from its sibling: discovery only cares about files APPEARING, so it can
    // afford to drop `change`. We care about every byte written to one named
    // file, and the platforms disagree about which type that arrives as (macOS
    // FSEvents reports an append as `rename`; Windows maps a truncate-in-place
    // to `change`). The NAME is the filter, and it is portable.
    const w = fs.watch(dir, { persistent: false }, (_eventType, filename) => onChange(filename));
    w.on('error', onError);
    w.unref?.();
    return w;
  } catch (err) {
    onError(err);
    return null;
  }
}

function defaultProbe(file: string): FileSignature | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size, ino: Number(st.ino) };
  } catch {
    // Missing, mid-rename, locked, on an unplugged drive. All of them are "we
    // cannot see it right now", and the caller treats that as gone — which it
    // corrects the moment a stat succeeds again.
    return null;
  }
}

/**
 * Two spellings of one path are one file on the filesystems that say so — and
 * an event names THIS file under the same rule.
 *
 * ONE rule for both, taken from `read-scope.ts`'s `HOST_STYLE`, which is where
 * this project already decided the question (win32 always, macOS by default,
 * Linux never). Two helpers three lines apart disagreeing about macOS is how one
 * file ends up with two `WatchedFile` entries — two directory watches and two
 * stat timers for one document — while the other half of the pair happily
 * matches events for a neighbour that differs only in case.
 */
function fold(s: string): string {
  return HOST_STYLE.caseInsensitive ? s.toLowerCase() : s;
}

function fileKey(p: string): string {
  return fold(p);
}

function sameName(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/**
 * Every file some viewer currently has open, and one handle per file.
 *
 * REFCOUNTED PER FILE rather than per viewer: two viewers on `PROGRESS.md` —
 * a docked tab and one in a popped-out window, say — share one directory watch
 * and one stat timer, and the second one closing releases nothing. "A leaked
 * watcher per opened file is exactly the kind of thing that only shows up at
 * session 12" is the done-when's own wording, and `stats()` exists so a test
 * can say it rather than assume it.
 *
 * #530 REMOVED WHAT USED TO BOUND THE FILE COUNT, recorded here rather than
 * only in that issue. Under the peek slot there was ONE replaceable viewer, so
 * the ordinary number of watched files was about one; every file now opens its
 * own tab and thirty is an ordinary afternoon. Thirty files means thirty
 * handles and thirty poll timers — and because the refcount keys on the FILE,
 * ten documents from one repo take ten separate watches on one DIRECTORY.
 * Nothing here is wrong today and nothing leaks; the ceiling simply moved.
 * Sharing one handle per directory (a `Map<dirKey, {handle, files}>` under
 * `WatchedFile`) is the fix when it is worth doing — a follow-up, not a rider
 * on the change that raised the ceiling.
 */
export class FileWatchService {
  /** `<callerId>:<token>` -> viewer. The id is a number, so the colon can never
   *  be ambiguous however the renderer spells its token. */
  private readonly viewers = new Map<string, Viewer>();
  /** `fileKey(path)` -> the one watch behind it */
  private readonly files = new Map<string, WatchedFile>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly probe: (file: string) => FileSignature | null;

  constructor(private readonly deps: FileWatchDeps) {
    this.debounceMs = deps.debounceMs ?? FILE_WATCH_DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? FILE_WATCH_MAX_WAIT_MS;
    this.pollMs = deps.pollMs ?? FILE_WATCH_POLL_MS;
    this.probe = deps.probe ?? defaultProbe;
  }

  /**
   * Follow `target` for one viewer, or say why not.
   *
   * The scope check is `fs:read`'s, called on the same object — a watch is not
   * a weaker ask than a read and must not be a weaker check. Re-watching a
   * token REPLACES its previous watch, because a viewer that FOLLOWS A LINK
   * sends exactly that: the same viewer, a new path. (Until #530 a re-pointed
   * peek slot sent it too; link navigation is now the only source, and it is
   * enough on its own — `DESIGN.md` → `00-process.md` inside one panel must
   * stop watching the file you left.)
   */
  watch(callerId: number, token: unknown, target: unknown): FileWatchResult {
    if (typeof token !== 'string' || token.length === 0) {
      this.deps.log.warn('fs:watch refused: invalid-path', { reason: 'no token' });
      return { ok: false, reason: 'invalid-path' };
    }
    const decision = this.deps.scope.resolve(target);
    if (!decision.ok) {
      this.deps.log.warn(`fs:watch refused: ${decision.reason}`, {
        path: typeof target === 'string' ? target : String(target),
      });
      return decision;
    }
    // A FILE, and only a file. `resolve` succeeded, so the path exists — which
    // makes a null probe here "it is not a regular file", i.e. a directory (or a
    // device, or a socket). Refusing matters beyond tidiness: `fileFor` watches
    // the target's PARENT, so a caller that named a session folder would have
    // main open an OS watch handle on the folder ABOVE a granted root — a
    // directory nobody granted anything about. Nothing would ever be reported
    // from it, and it would still be a handle a renderer could ask for at will.
    //
    // Deliberately not "the probe returned null", said as a rule: a MISSING path
    // never reaches here (`resolve` answers `not-found` for it), and the
    // deleted-then-recreated case this feature exists to report happens after
    // the watch is established, where this check is long past.
    if (this.probe(decision.path) === null) {
      this.deps.log.warn('fs:watch refused: not-a-file', { path: decision.path });
      return { ok: false, reason: 'not-a-file' };
    }
    // Re-point before registering, so a viewer that moves from A to B never
    // holds both — the leak this whole item's done-when is about.
    this.unwatch(callerId, token);

    const key = viewerKey(callerId, token);
    const file = this.fileFor(decision.path);
    file.refs.add(key);
    this.viewers.set(key, { callerId, token, file });
    return { ok: true, path: decision.path };
  }

  /** This viewer is done with its file. The last one out closes the handle. */
  unwatch(callerId: number, token: unknown): void {
    if (typeof token !== 'string') return;
    const key = viewerKey(callerId, token);
    const viewer = this.viewers.get(key);
    if (!viewer) return;
    this.viewers.delete(key);
    viewer.file.refs.delete(key);
    if (viewer.file.refs.size === 0) this.closeFile(viewer.file, 'the last viewer closed');
  }

  /**
   * A window went away — drop everything it held (#200's shape, one level down).
   *
   * The renderer unwatches on unmount, which covers a closed panel. This covers
   * the panel that never got to unmount: a window destroyed, a renderer that
   * crashed, a reload during development. Without it those watches would run for
   * the life of the process with nobody left to tell.
   */
  releaseCaller(callerId: number): void {
    for (const [key, viewer] of [...this.viewers]) {
      if (viewer.callerId !== callerId) continue;
      this.viewers.delete(key);
      viewer.file.refs.delete(key);
      if (viewer.file.refs.size === 0) this.closeFile(viewer.file, 'the window closed');
    }
  }

  /** Everything, at quit. */
  stop(): void {
    for (const file of [...this.files.values()]) {
      file.refs.clear();
      this.closeFile(file, 'the app is quitting');
    }
    this.viewers.clear();
  }

  /** What is actually open right now — the observable the teardown test needs. */
  stats(): { files: number; viewers: number; watched: string[] } {
    return {
      files: this.files.size,
      viewers: this.viewers.size,
      watched: [...this.files.values()].map((f) => f.path),
    };
  }

  // --- internals -----------------------------------------------------------

  private fileFor(real: string): WatchedFile {
    const key = fileKey(real);
    const existing = this.files.get(key);
    if (existing) return existing;
    const sig = this.probe(real);
    const file: WatchedFile = {
      path: real,
      dir: path.dirname(real),
      base: path.basename(real),
      refs: new Set(),
      handle: null,
      poll: null,
      timer: null,
      dirtySince: null,
      force: false,
      degraded: false,
      // Seeded from the file as it is NOW, so the first floor tick does not
      // report a change nobody made. The viewer has just read it.
      sig: sig ? signature(sig) : null,
      gone: sig === null,
    };
    this.files.set(key, file);
    this.openWatch(file);
    file.poll = setInterval(() => this.schedule(file, false), this.pollMs);
    file.poll.unref?.();
    return file;
  }

  private openWatch(file: WatchedFile): void {
    const factory = this.deps.watchFactory ?? defaultWatchFactory;
    let handle: FileWatchHandle | null = null;
    try {
      handle = factory(
        file.dir,
        (filename) => this.onEvent(file, filename),
        (err) => this.onWatchError(file, err)
      );
    } catch (err) {
      handle = null;
      this.deps.log.debug('fs watch factory threw', { dir: file.dir, error: String(err) });
    }
    file.handle = handle;
    if (!handle) this.degrade(file, 'the watch could not be created');
  }

  /**
   * A filesystem event. The NAME decides what it means (see the header).
   *
   * A named hit is FORCED — re-read it even if the stat looks unmoved — because
   * the event is the more reliable witness of the two: `mtime` resolution is a
   * filesystem's business, and a rewrite that keeps the same length inside one
   * timestamp tick is exactly the case where trusting the stat would show the
   * reader a document that has already changed. An event with no name at all
   * (some platforms decline to say) is treated as a hint and gated on the stat,
   * because the alternative is re-rendering on every write to every neighbour in
   * a busy project folder.
   */
  private onEvent(file: WatchedFile, filename?: string | null): void {
    if (filename == null) {
      this.schedule(file, false);
      return;
    }
    if (sameName(String(filename), file.base)) this.schedule(file, true);
  }

  private onWatchError(file: WatchedFile, err: unknown): void {
    const dead = file.handle;
    file.handle = null;
    try {
      dead?.close();
    } catch {
      /* already gone */
    }
    this.degrade(file, String(err));
  }

  /**
   * The watch is unavailable; the floor carries the feature.
   *
   * Deliberately NOT re-armed on a timer the way `DiscoverySchedule` re-arms
   * its root watch, and the difference is what is at stake: there, a dead watch
   * pins the process to 500ms full-tree scans forever, so getting it back is
   * worth the retry loop. Here the fallback is ONE stat every two seconds on
   * ONE file for as long as a panel is open, and re-arming would mean an
   * `fs.watch` attempt every two seconds against a directory that has already
   * refused. Latency degrades from 150ms to 2s and nothing else does.
   */
  private degrade(file: WatchedFile, reason: string): void {
    if (file.degraded) return;
    file.degraded = true;
    this.deps.log.info('fs watch unavailable — following the file on the stat floor', {
      path: file.path,
      reason,
      everyMs: this.pollMs,
      note: 'the viewer still updates; only its latency changes',
    });
  }

  /** Coalesce: trailing debounce, with a ceiling so a continuous writer still
   *  reaches the reader (`FILE_WATCH_MAX_WAIT_MS`). */
  private schedule(file: WatchedFile, force: boolean): void {
    if (force) file.force = true;
    const now = Date.now();
    // A wall clock that steps BACKWARDS (NTP, VM resume, the user changing it)
    // would otherwise put the ceiling in the future by the size of the jump and
    // hold the debounce off for that long — an hour of a stale document for an
    // hour-sized jump. Re-anchor and lose nothing: the ceiling is about how long
    // we have been waiting, not about when the waiting began.
    if (file.dirtySince === null || now < file.dirtySince) file.dirtySince = now;
    if (file.timer) clearTimeout(file.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, file.dirtySince + this.maxWaitMs - now));
    file.timer = setTimeout(() => this.settle(file), wait);
    file.timer.unref?.();
  }

  /** The debounce expired: decide what actually happened, and say it once. */
  private settle(file: WatchedFile): void {
    file.timer = null;
    file.dirtySince = null;
    const forced = file.force;
    file.force = false;
    // Torn down while the timer was in flight. Nothing to tell, nobody to tell.
    if (file.refs.size === 0) return;

    const sig = this.probe(file.path);
    if (!sig) {
      // Gone is a STATE, announced on the transition. Without that, the stat
      // floor would re-announce a deleted file every two seconds for as long as
      // the panel stayed open.
      //
      // ANSWERED BEFORE THE SCOPE CHECK BELOW, deliberately. `ReadScope.resolve`
      // cannot resolve a path that is not there, so it answers about the nearest
      // ancestor that IS — and for a file the user picked through the dialog the
      // grant is the FILE, not its folder, so a deleted pick reads as
      // `out-of-scope` rather than as missing. Checking scope first would
      // therefore swallow the deletion of exactly the files §5.30 lets a user
      // reach outside a session, and the reader would be left with a document
      // that had silently stopped updating. Telling a caller that a file it was
      // already watching has gone reveals nothing it did not put there.
      //
      // The watch is NOT closed here, deliberately: a deleted file comes back —
      // a `git checkout`, a rename that lands, the agent writing it again — and
      // the panel is still open on it. So the handle and the stat floor outlive
      // the deletion for the life of the viewer, and the return goes through the
      // scope check below like any other change.
      if (!file.gone) {
        file.gone = true;
        file.sig = null;
        this.notify(file, 'gone');
      }
      return;
    }

    // THE SCOPE CAN NARROW UNDER US: the roots are the folders of the sessions
    // that are OPEN, and closing that card takes the folder out of scope while
    // the viewer is still on screen (a viewer outlives its session — §5.30).
    // Re-checking here costs one resolve per change and closes the gap where we
    // would keep reporting activity on a path the caller may no longer read —
    // `fs.probe` smuggled through the back door of `fs.read`. The read that
    // would follow is refused anyway, so the viewer freezes on its last content
    // either way; this just stops us talking about it.
    if (!this.deps.scope.resolve(file.path).ok) {
      this.closeFile(file, 'the path left the read scope');
      return;
    }

    const next = signature(sig);
    const moved = next !== file.sig;
    const returned = file.gone;
    file.sig = next;
    file.gone = false;
    if (moved || forced || returned) this.notify(file, 'changed');
  }

  private notify(file: WatchedFile, state: FileWatchNotice['state']): void {
    for (const key of file.refs) {
      const viewer = this.viewers.get(key);
      if (!viewer) continue;
      try {
        this.deps.push(viewer.callerId, { token: viewer.token, state });
      } catch (err) {
        // A push that throws must not take the other viewers of the same file
        // with it — the `emit` rule from `transcripts/watcher.ts`.
        this.deps.log.warn('fs watch push failed', { path: file.path, error: String(err) });
      }
    }
  }

  /** Release one file's OS resources. Idempotent; logged, because "the watch is
   *  torn down when the panel closes" is a done-when and a log line is how it is
   *  read back in a real session rather than only in a test. */
  private closeFile(file: WatchedFile, why: string): void {
    if (!this.files.delete(fileKey(file.path))) return;
    for (const key of file.refs) this.viewers.delete(key);
    file.refs.clear();
    if (file.timer) clearTimeout(file.timer);
    file.timer = null;
    if (file.poll) clearInterval(file.poll);
    file.poll = null;
    const handle = file.handle;
    file.handle = null;
    try {
      handle?.close();
    } catch (err) {
      this.deps.log.debug('fs watch close failed', { path: file.path, error: String(err) });
    }
    this.deps.log.info('fs watch closed', { path: file.path, reason: why });
  }
}

function viewerKey(callerId: number, token: string): string {
  return `${callerId}:${token}`;
}

function signature(sig: FileSignature): string {
  return `${sig.mtimeMs}:${sig.size}:${sig.ino}`;
}
