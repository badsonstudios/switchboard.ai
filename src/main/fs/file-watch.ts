// Following the open files, for the document viewer (P2-E16-04, §5.30).
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
//
// AND BECAUSE THE DIRECTORY IS WHAT IS WATCHED, ONE HANDLE SERVES ALL OF IT
// (#544). The first version refcounted per FILE, which was right while the peek
// slot meant roughly one document was open at a time; with always-new-tab
// (#530) ten documents out of one repo took ten OS watches on one folder and
// ten stat timers. So the structure here is two levels — `WatchedDir` owns the
// single `fs.watch` handle and fans its events out by NAME to the `WatchedFile`
// entries under it, and one interval per service (the "floor wheel") walks every
// watched file every `FILE_WATCH_POLL_MS`. M tabs over one folder are one
// handle; the standing timer count is one, whatever M is. Nothing above this
// line changed: the same 150ms/1s coalesce, the same stat-floor authority, the
// same refcounted teardown, now with a bound that does not move with the tabs.
//
// AND THE WHEEL IS SLICED, because one timer for the service is not the same
// thing as one BURST for the service (#682). Consolidating the per-file
// intervals did not change the total floor work per `FILE_WATCH_POLL_MS` — the
// per-file version stat'd and re-resolved every open file on every tick too —
// but it did take away the staggering that M timers created at M different
// moments got for free, and landed the lot in one synchronous run on main.
// Thirty tabs on a local disk is single-digit milliseconds; thirty tabs on a
// slow SMB share is 100–300ms of a main process that is also pumping PTY data,
// every two seconds. So the wheel runs at `pollMs / FILE_WATCH_POLL_SLICES` and
// each sub-tick walks the files in ONE slot: still one timer, still one full
// pass per `pollMs`, at a quarter of the peak. The slot is assigned round-robin
// as files open, so ten tabs opened together are spread across the slots rather
// than piled into whichever one was next.
//
// WHAT THE SLICING DOES NOT DO is weaken the floor. Every file is still checked
// exactly once per `pollMs`, so `FILE_WATCH_POLL_MS` remains the worst-case
// latency of the whole feature — a slot is a phase, not a sampling rate. What
// moves is only WHEN inside the period a given file's turn falls, which is why
// the sub-tick period is `floor`ed rather than `round`ed: a full revolution must
// never come out longer than `pollMs`. And the answer to a slow share is still
// not to skip the scope re-resolve, which `read-scope.ts` has already explained
// once cannot be replaced by a cheap string pre-check.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';
import { HOST_STYLE, type PathStyle, type ReadScope } from './read-scope';
import {
  FILE_WATCH_DEBOUNCE_MS,
  FILE_WATCH_MAX_WAIT_MS,
  FILE_WATCH_POLL_MS,
  FileWatchNotice,
  FileWatchResult,
} from '../../shared/ipc/fs';

/**
 * How many sub-ticks one `FILE_WATCH_POLL_MS` period is cut into (#682).
 *
 * Four, and the two directions bound each other. Fewer means a bigger burst,
 * which is the thing being fixed: the peak main-thread stall is the slowest
 * slot's stats, so K is the divisor on it. More means more wake-ups for the
 * same total work — a wheel that only runs while a document panel is open, but
 * still a timer on a laptop, and past a point it is dividing a burst that is
 * already under a millisecond. Four takes 300ms of worst-case SMB stall to
 * ~75ms while leaving the wheel at two wake-ups a second.
 *
 * NOT in `shared/ipc/fs.ts` beside `FILE_WATCH_POLL_MS`, deliberately: the poll
 * period is part of the contract the renderer's tests reason in ("the viewer is
 * at worst two seconds behind"), and this is main's private business of how it
 * spends those two seconds. Exported only so a test can derive the sub-tick
 * period rather than hard-code 500.
 */
export const FILE_WATCH_POLL_SLICES = 4;

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
  /**
   * How paths compare on the filesystem being watched (#683).
   *
   * A parameter rather than a `HOST_STYLE` read inside `fold`, for exactly
   * `read-scope.ts`'s reason and now with more riding on it: since #544 the
   * fold decides THREE keys — the file entry, the directory entry, and the name
   * an event is fanned out by — and a rule that can only be exercised against
   * the host's own table is a rule half the CI matrix never checks. A fold that
   * disagreed with the platform would not fail loudly; it would silently stop
   * delivering events for a whole folder. Defaults to `HOST_STYLE`, which is
   * what production always wants.
   *
   * Only `caseInsensitive` is read here — `sep` belongs to the path COMPARISONS
   * in `read-scope.ts`, and nothing in this file compares path prefixes.
   */
  pathStyle?: PathStyle;
}

/** One viewer's interest in one file. */
interface Viewer {
  readonly callerId: number;
  readonly token: string;
  readonly file: WatchedFile;
}

/**
 * One directory, one OS watch handle, however many files are open under it.
 *
 * The handle is the scarce thing and the ONLY thing this level owns: no timer
 * lives here (the floor is one wheel for the whole service) and no state that a
 * file could disagree with. `degraded` is here rather than on the file because
 * a watch that cannot be created is a fact about the DIRECTORY — latching it
 * here is what makes ten tabs over a folder `fs.watch` refuses log one line
 * instead of ten.
 */
interface WatchedDir {
  /** the directory, as `path.dirname` answered it for the files under it */
  readonly dir: string;
  /** `fold(basename)` -> the file. Keyed by the NAME an event carries, so
   *  fanning one event out to its file is a lookup and not a scan of the folder
   *  — the difference between O(1) and O(open tabs) on every write. */
  readonly files: Map<string, WatchedFile>;
  handle: FileWatchHandle | null;
  /** the watch is gone and the stat floor is carrying every file under this
   *  directory — latched, so one `FSWatcher` erroring repeatedly is one log line
   *  and not a stream of them (`DiscoverySchedule.markWatchFailed`'s rule, same
   *  reason) */
  degraded: boolean;
}

interface WatchedFile {
  /** the REAL path, as `ReadScope.resolve` answered it */
  readonly path: string;
  readonly base: string;
  /** the directory watch this file's events arrive through */
  readonly owner: WatchedDir;
  /** viewer keys holding this file open — the last one out releases it */
  readonly refs: Set<string>;
  /** which sub-tick of the floor wheel stats this file (#682). Fixed for the
   *  life of the entry, so "checked once per `pollMs`" holds whatever else
   *  opens and closes around it — a cursor into a live map would skip a file
   *  whose neighbour was released mid-revolution. */
  readonly slot: number;
  timer: NodeJS.Timeout | null;
  /** when the current run of events began, for the max-wait ceiling */
  dirtySince: number | null;
  /** an event NAMED this file, so re-read it whether or not the stat moved */
  force: boolean;
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
    // NOT recursive: one directory, and the files we care about are directly in
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
 * Every file some viewer currently has open, one handle per DIRECTORY, and one
 * timer for the whole service.
 *
 * REFCOUNTED PER FILE rather than per viewer: two viewers on `PROGRESS.md` —
 * a docked tab and one in a popped-out window, say — share one entry, and the
 * second one closing releases nothing. "A leaked watcher per opened file is
 * exactly the kind of thing that only shows up at session 12" is the done-when's
 * own wording, and `stats()` exists so a test can say it rather than assume it.
 *
 * SHARED PER DIRECTORY on top of that (#544), because the refcount alone stopped
 * bounding anything once #530 gave every document its own tab: the peek slot had
 * kept the live count near one, and thirty tabs meant thirty OS handles and
 * thirty stat timers — ten of those handles on the SAME folder when the ten
 * documents came out of one repo. Nothing leaked; the ceiling had simply moved.
 * So the handle belongs to the `WatchedDir` and the floor is one wheel over
 * `files`: M tabs across one folder are ONE `fs.watch`, and the standing timer
 * count is one whatever M is. `stats()` reports `dirs` for the same reason it
 * reports `files` — so a test can assert the sharing rather than trust it.
 */
export class FileWatchService {
  /** `<callerId>:<token>` -> viewer. The id is a number, so the colon can never
   *  be ambiguous however the renderer spells its token. */
  private readonly viewers = new Map<string, Viewer>();
  /** `fileKey(path)` -> the one entry behind it */
  private readonly files = new Map<string, WatchedFile>();
  /** `fold(dir)` -> the one OS watch behind every file in it */
  private readonly dirs = new Map<string, WatchedDir>();
  /** the stat floor, for every watched file at once. Null when nothing is
   *  watched — an idle service holds no timer at all, which is what makes
   *  "nothing survives the panel closing" a statement about the process and not
   *  just about one file. */
  private floor: NodeJS.Timeout | null = null;
  /** which slot the next sub-tick stats (#682) */
  private slice = 0;
  /** the slot the next file opened gets — round-robin, so a burst of tabs is
   *  spread over the wheel rather than piled into one sub-tick */
  private nextSlot = 0;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  /** the wheel's period: one slot's turn, `FILE_WATCH_POLL_SLICES` of them to a
   *  full pass over every watched file */
  private readonly sliceMs: number;
  private readonly probe: (file: string) => FileSignature | null;
  private readonly style: PathStyle;

  constructor(private readonly deps: FileWatchDeps) {
    this.debounceMs = deps.debounceMs ?? FILE_WATCH_DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? FILE_WATCH_MAX_WAIT_MS;
    this.pollMs = deps.pollMs ?? FILE_WATCH_POLL_MS;
    // FLOOR, not round: `pollMs` is a promise about the worst case, so a full
    // revolution rounding UP would quietly make the floor slower than the
    // constant every caller reasons in. At least 1ms, because a caller is free
    // to pass a `pollMs` smaller than the slice count and `setInterval(0)` is a
    // busy loop.
    this.sliceMs = Math.max(1, Math.floor(this.pollMs / FILE_WATCH_POLL_SLICES));
    this.probe = deps.probe ?? defaultProbe;
    this.style = deps.pathStyle ?? HOST_STYLE;
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
    // holds both — the leak this whole item's done-when is about. Taking B's
    // directory FIRST to save a same-folder re-point one close/open pair is not
    // worth what it costs: when A and B are the same path, `fileFor` would hand
    // back the very entry the `unwatch` below then tears down, and the ref would
    // land on an object no longer in `files`.
    this.unwatch(callerId, token);

    const key = viewerKey(callerId, token);
    const file = this.fileFor(decision.path);
    file.refs.add(key);
    this.viewers.set(key, { callerId, token, file });
    return { ok: true, path: decision.path };
  }

  /** This viewer is done with its file. The last one out releases it. */
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
    // Belt and braces. Emptying `files` releases every directory and stops the
    // wheel on the way through; these two say so rather than rely on it, because
    // "nothing is left running after quit" is the one claim in this file that no
    // later bug gets to quietly falsify.
    for (const entry of [...this.dirs.values()]) this.closeDir(entry);
    this.stopFloor();
  }

  /** What is actually open right now — the observable the teardown and the
   *  sharing tests both need. `dirs` is one entry per folder being followed,
   *  which is the OS handle count except where a watch was refused and the floor
   *  is carrying that folder; it is what #544 is about, and it is not derivable
   *  from `watched` without knowing this platform's case rules. */
  stats(): { files: number; dirs: number; viewers: number; watched: string[] } {
    return {
      files: this.files.size,
      dirs: this.dirs.size,
      viewers: this.viewers.size,
      watched: [...this.files.values()].map((f) => f.path),
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Two spellings of one path are one file on the filesystems that say so — and
   * an event names THIS file under the same rule.
   *
   * ONE rule for all three keys here (file, directory, event name), from the
   * injected `PathStyle` — which is where `read-scope.ts` already decided the
   * question (win32 always, macOS by default, Linux never) and now also where a
   * test can ask BOTH answers on one machine. Two helpers three lines apart
   * disagreeing about macOS is how one file ends up with two `WatchedFile`
   * entries — or one folder with two `WatchedDir` entries, two directory
   * watches for one directory — while the other half of the pair happily
   * matches events for a neighbour that differs only in case.
   */
  private fold(s: string): string {
    return this.style.caseInsensitive ? s.toLowerCase() : s;
  }

  private fileKey(p: string): string {
    return this.fold(p);
  }

  private fileFor(real: string): WatchedFile {
    const key = this.fileKey(real);
    const existing = this.files.get(key);
    if (existing) return existing;
    const sig = this.probe(real);
    const owner = this.dirFor(path.dirname(real));
    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % FILE_WATCH_POLL_SLICES;
    const file: WatchedFile = {
      path: real,
      base: path.basename(real),
      owner,
      refs: new Set(),
      slot,
      timer: null,
      dirtySince: null,
      force: false,
      // Seeded from the file as it is NOW, so the first floor tick does not
      // report a change nobody made. The viewer has just read it.
      sig: sig ? signature(sig) : null,
      gone: sig === null,
    };
    this.files.set(key, file);
    owner.files.set(this.fold(file.base), file);
    this.startFloor();
    return file;
  }

  /**
   * The one watch behind a directory, opened on the first file under it.
   *
   * A DEGRADED ENTRY GETS ONE FRESH ATTEMPT PER NEWLY-OPENED FILE, which is
   * what the per-file version gave away for free and would be the one real
   * behaviour change in #544 if it were dropped. The failures that land here are
   * transient by nature — `EMFILE`, inotify's `ENOSPC`, a share that was
   * unreachable for a moment — and `ENOSPC` in particular arrives when a lot of
   * watches are open, i.e. precisely in the folder with a lot of tabs. Latching
   * the first failure for the life of the directory would pin that folder to the
   * 2s floor until its last tab closed. Retrying is bounded by tab opens rather
   * than by a timer, so it cannot become the retry loop `degrade` argues against.
   */
  private dirFor(dir: string): WatchedDir {
    const key = this.fold(dir);
    const existing = this.dirs.get(key);
    if (existing) {
      if (!existing.handle) this.openWatch(existing);
      return existing;
    }
    const entry: WatchedDir = { dir, files: new Map(), handle: null, degraded: false };
    this.dirs.set(key, entry);
    this.openWatch(entry);
    return entry;
  }

  private openWatch(entry: WatchedDir): void {
    const factory = this.deps.watchFactory ?? defaultWatchFactory;
    let handle: FileWatchHandle | null = null;
    try {
      handle = factory(
        entry.dir,
        (filename) => this.onEvent(entry, filename),
        (err) => this.onWatchError(entry, err)
      );
    } catch (err) {
      handle = null;
      this.deps.log.debug('fs watch factory threw', { dir: entry.dir, error: String(err) });
    }
    entry.handle = handle;
    if (handle) {
      // A retry that LANDED un-latches the log, so a folder that degrades again
      // later says so again. One line per episode, not one line ever.
      entry.degraded = false;
      return;
    }
    this.degrade(entry, 'the watch could not be created');
  }

  /**
   * A filesystem event on a directory. The NAME decides which file it is about
   * (see the header), and now also WHETHER it is about one of ours at all.
   *
   * A named hit is FORCED — re-read it even if the stat looks unmoved — because
   * the event is the more reliable witness of the two: `mtime` resolution is a
   * filesystem's business, and a rewrite that keeps the same length inside one
   * timestamp tick is exactly the case where trusting the stat would show the
   * reader a document that has already changed. An event with no name at all
   * (some platforms decline to say) is a hint for EVERY file under this
   * directory and is gated on the stat for each of them, because the alternative
   * is re-rendering on every write to every neighbour in a busy project folder.
   */
  private onEvent(entry: WatchedDir, filename?: string | null): void {
    if (filename == null) {
      for (const file of [...entry.files.values()]) this.schedule(file, false);
      return;
    }
    const file = entry.files.get(this.fold(String(filename)));
    if (file) this.schedule(file, true);
  }

  private onWatchError(entry: WatchedDir, err: unknown): void {
    const dead = entry.handle;
    entry.handle = null;
    try {
      dead?.close();
    } catch {
      /* already gone */
    }
    this.degrade(entry, String(err));
  }

  /**
   * The watch is unavailable; the floor carries the feature.
   *
   * Deliberately NOT re-armed on a timer the way `DiscoverySchedule` re-arms
   * its root watch, and the difference is what is at stake: there, a dead watch
   * pins the process to 500ms full-tree scans forever, so getting it back is
   * worth the retry loop. Here the fallback is ONE stat every two seconds per
   * open file for as long as a panel is open, and re-arming would mean an
   * `fs.watch` attempt every two seconds against a directory that has already
   * refused. Latency degrades from 150ms to 2s and nothing else does.
   */
  private degrade(entry: WatchedDir, reason: string): void {
    if (entry.degraded) return;
    entry.degraded = true;
    this.deps.log.info('fs watch unavailable — following the file on the stat floor', {
      dir: entry.dir,
      reason,
      everyMs: this.pollMs,
      note: 'every viewer in this folder still updates; only its latency changes',
    });
  }

  // --- the floor wheel -----------------------------------------------------

  /**
   * One interval for the whole service, armed by the first watched file and
   * running at one SLOT's period rather than the whole poll period (#682).
   *
   * A file opened later inherits the wheel's PHASE, so its first floor check
   * lands anywhere in `(0, pollMs]` rather than at exactly `pollMs` — it waits
   * for its own slot to come round, which is at worst a full revolution away.
   * Harmless in both directions, and for the reasons it always was: `fileFor`
   * seeds `sig` from a fresh probe, so an early check is a no-op, and the scope
   * resolve on a path granted a moment ago passes. The floor is a ceiling on
   * latency, not a schedule.
   *
   * The slice cursor is reset here rather than left where the last teardown put
   * it. `startFloor` runs when the service goes from zero watched files to one,
   * so there is no phase left to preserve, and starting at slot 0 next to a
   * `nextSlot` that also starts at 0 is what makes the FIRST file opened the
   * first one checked — the shape a test can state without reaching inside.
   */
  private startFloor(): void {
    if (this.floor) return;
    this.slice = 0;
    this.floor = setInterval(() => this.floorTick(), this.sliceMs);
    this.floor.unref?.();
  }

  private stopFloor(): void {
    if (!this.floor) return;
    clearInterval(this.floor);
    this.floor = null;
    // So the next wheel starts where `startFloor` says it does, whatever the
    // last one was mid-way through.
    this.nextSlot = 0;
  }

  /**
   * One slot's turn: stat the files in it, and nothing else.
   *
   * Gathered into a list before any of them is checked, for the reason the
   * whole-map copy was there before slicing: a check can close its own file (a
   * path that left the scope), and that mutates `files` underneath the walk.
   * Only the DUE files are collected, so the burst this exists to cut is cut in
   * the only place it costs anything — the stat and the scope resolve inside
   * `floorCheck`. Filtering by walking the map is deliberate: `files` is bounded
   * by open tabs and the walk is a pointer comparison per entry, while a second
   * index keyed by slot would be a fourth structure `closeFile` has to keep in
   * step with the other three — the exact bug class its by-identity deletes are
   * already guarding against.
   */
  private floorTick(): void {
    const slot = this.slice;
    this.slice = (this.slice + 1) % FILE_WATCH_POLL_SLICES;
    const due: WatchedFile[] = [];
    for (const file of this.files.values()) if (file.slot === slot) due.push(file);
    for (const file of due) this.floorCheck(file);
  }

  /**
   * One file's turn on the floor: stat it, and wake it only if that said
   * something.
   *
   * The stat is taken HERE rather than by handing every file to `schedule` and
   * letting `settle` do it two hundred milliseconds later, and the difference is
   * the whole point of the wheel. Waking unconditionally would arm one debounce
   * timeout per open file per tick — thirty tabs, thirty timers every two
   * seconds — which is the per-file timer cost #544 exists to remove, merely
   * moved from `setInterval` to `setTimeout`. It is also strictly less work:
   * `settle` would stat and re-resolve the scope anyway, so a quiet file pays
   * the same stat-plus-resolve here that it used to pay there, and saves the
   * timer and the second wake-up that used to sit between them.
   *
   * A file whose signature MOVED goes through the normal path — `schedule`, the
   * debounce, `settle` — so the floor and an `fs.watch` event are indistinguish-
   * able downstream, which is what keeps the coalescing rules in one place.
   */
  private floorCheck(file: WatchedFile): void {
    const sig = this.probe(file.path);
    if (!sig) {
      // Gone. Announced once, by `settle`, on the transition only — so a file
      // that is already known-gone costs one stat a tick and says nothing. The
      // scope is deliberately NOT re-checked for it: `settle` does not either,
      // and for a file the user picked through the dialog a deletion makes the
      // grant unresolvable, so checking would tear down the watch that is there
      // to notice the file coming back.
      if (!file.gone) this.schedule(file, false);
      return;
    }
    if (signature(sig) !== file.sig) {
      this.schedule(file, false);
      return;
    }
    // Unmoved. The only thing that can still have changed under a quiet file is
    // the SCOPE — the roots are the folders of the sessions that are OPEN, and
    // closing that card takes the folder out of scope while the viewer is still
    // on screen. `settle` makes the same check on the change path; this is the
    // half of it that a file nobody is writing to would otherwise never reach,
    // and it is why a closed session's watches do not outlive it.
    if (!this.deps.scope.resolve(file.path).ok) {
      this.closeFile(file, 'the path left the read scope');
    }
  }

  // --- coalescing ----------------------------------------------------------

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
      // the panel is still open on it. So the directory handle and the stat
      // floor outlive the deletion for the life of the viewer, and the return
      // goes through the scope check below like any other change.
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

  // --- teardown ------------------------------------------------------------

  /** Release one file. Idempotent; logged, because "the watch is torn down when
   *  the panel closes" is a done-when and a log line is how it is read back in a
   *  real session rather than only in a test. The OS handle goes with the LAST
   *  file under its directory, and the wheel with the last file anywhere. */
  private closeFile(file: WatchedFile, why: string): void {
    // BY IDENTITY, not by key, in all three maps below. Today nothing can put a
    // second live entry under one key — `watch()` unwatches before it calls
    // `fileFor`, deliberately (see there) — so this is a guard on that ORDERING
    // INVARIANT rather than on a reachable state. It is worth the four extra
    // characters because of what breaks if the invariant ever slips: deleting by
    // key would drop the LIVE replacement instead, leaving a `WatchedDir` whose
    // handle nobody holds and a `WatchedFile.owner` pointing at an entry no
    // longer in `dirs` — so the next file in that folder opens a second handle,
    // which is the exact bug this item exists to remove, reintroduced silently.
    if (this.files.get(this.fileKey(file.path)) !== file) return;
    this.files.delete(this.fileKey(file.path));
    for (const key of file.refs) this.viewers.delete(key);
    file.refs.clear();
    if (file.timer) clearTimeout(file.timer);
    file.timer = null;
    const owner = file.owner;
    const nameKey = this.fold(file.base);
    if (owner.files.get(nameKey) === file) owner.files.delete(nameKey);
    if (owner.files.size === 0) this.closeDir(owner);
    if (this.files.size === 0) this.stopFloor();
    this.deps.log.info('fs watch closed', { path: file.path, reason: why });
  }

  /** The last file under a directory went: give the OS its handle back. Logged
   *  separately from `fs watch closed`, because that line now fires per FILE and
   *  the handle can outlive several of them — the release of the OS resource is
   *  the thing a real session needs to be able to read back. */
  private closeDir(entry: WatchedDir): void {
    if (this.dirs.get(this.fold(entry.dir)) !== entry) return;
    this.dirs.delete(this.fold(entry.dir));
    const handle = entry.handle;
    entry.handle = null;
    try {
      handle?.close();
    } catch (err) {
      this.deps.log.debug('fs watch close failed', { dir: entry.dir, error: String(err) });
    }
    this.deps.log.info('fs directory watch closed', { dir: entry.dir });
  }
}

function viewerKey(callerId: number, token: string): string {
  return `${callerId}:${token}`;
}

function signature(sig: FileSignature): string {
  return `${sig.mtimeMs}:${sig.size}:${sig.ino}`;
}
