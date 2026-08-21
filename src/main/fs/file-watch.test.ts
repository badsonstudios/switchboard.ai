// Following one open file: the done-when of P2-E16-04, in main.
//
// Everything the viewer promises is decided here — one re-render per burst, a
// deletion that is news rather than an error, and a watch that is GONE when the
// panel closes. The filesystem is injected (`watchFactory`, `probe`) for the
// reason `discovery-scheduler.test.ts` injects it: a test that waits on real
// `fs.watch` events is a test that is flaky on one platform and slow on all
// three, and none of the rules below are rules about `fs.watch`. That the real
// factory and the real stat work is `document-live.spec.ts`'s job, against a
// real file in a real window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../log/logger';
import { HOST_STYLE, POSIX_STYLE, WIN32_STYLE, type PathStyle, type ReadScope } from './read-scope';
import type { FileWatchNotice } from '../../shared/ipc/fs';
import { FILE_WATCH_POLL_SLICES, FileSignature, FileWatchService } from './file-watch';

const DIR = '/proj';
const FILE = '/proj/PROGRESS.md';
const OTHER = '/proj/notes.md';

/** A logger that keeps its lines, so "and logged" is assertable. */
function recordingLog(): { log: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const at =
    (level: string) =>
    (msg: string): void => {
      lines.push({ level, msg });
    };
  const log = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => log,
  } as unknown as Logger;
  return { log, lines };
}

/**
 * The filesystem, as far as this module is concerned.
 *
 * Watchers are a LIST, not a map keyed by directory: `fs.watch` called twice on
 * one folder really does hand back two independent handles, and a fake that
 * collapsed them would quietly report a leak as a pass (and the reverse). Since
 * #544 that is also the only way the sharing is observable — `live()` counting
 * ONE handle behind ten open files is the assertion, and it means nothing unless
 * the fake was capable of counting ten.
 */
function fakeFs() {
  const sigs = new Map<string, FileSignature>([
    [FILE, { mtimeMs: 1000, size: 10, ino: 7 }],
    // Both files EXIST, because `ReadScope.resolve` never says `ok` about a path
    // that does not — a fake in which an in-scope path can be missing would put
    // the service in a state the real one cannot reach.
    [OTHER, { mtimeMs: 1000, size: 10, ino: 8 }],
  ]);
  const watchers: Array<{
    dir: string;
    onChange: (f?: string | null) => void;
    onError: (e: unknown) => void;
    closed: boolean;
  }> = [];
  const at = (dir: string) => watchers.filter((w) => !w.closed && w.dir === dir);
  let refuseWatch = false;
  return {
    sigs,
    watchers,
    refuse: (on: boolean) => {
      refuseWatch = on;
    },
    /** the file was written: a new mtime, and whatever length the caller says */
    write: (path = FILE, size = 20) => {
      const prev = sigs.get(path);
      sigs.set(path, { mtimeMs: (prev?.mtimeMs ?? 0) + 5, size, ino: prev?.ino ?? 7 });
    },
    remove: (path = FILE) => sigs.delete(path),
    open: () => watchers.length,
    live: () => watchers.filter((w) => !w.closed).length,
    fire: (filename: string | null, dir = DIR) => at(dir).forEach((w) => w.onChange(filename)),
    fail: (err: unknown, dir = DIR) => at(dir)[0]?.onError(err),
    factory: (dir: string, onChange: (f?: string | null) => void, onError: (e: unknown) => void) => {
      if (refuseWatch) return null;
      const entry = { dir, onChange, onError, closed: false };
      watchers.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
    probe: (file: string): FileSignature | null => sigs.get(file) ?? null,
  };
}

/** Only `resolve` is ever called; a real scope needs a real filesystem. */
function fakeScope(allowed: () => string[]): ReadScope {
  return {
    resolve: (target: unknown) =>
      typeof target === 'string' && allowed().includes(target)
        ? { ok: true as const, path: target }
        : { ok: false as const, reason: 'out-of-scope' as const },
  } as unknown as ReadScope;
}

const DEBOUNCE = 150;
const MAX_WAIT = 1000;
const POLL = 2000;

describe('FileWatchService (P2-E16-04)', () => {
  let fs: ReturnType<typeof fakeFs>;
  let rec: ReturnType<typeof recordingLog>;
  let notices: Array<{ callerId: number; notice: FileWatchNotice }>;
  let allowed: string[];
  let svc: FileWatchService;

  beforeEach(() => {
    vi.useFakeTimers();
    fs = fakeFs();
    rec = recordingLog();
    notices = [];
    allowed = [FILE, OTHER];
    svc = new FileWatchService({
      log: rec.log,
      scope: fakeScope(() => allowed),
      push: (callerId, notice) => notices.push({ callerId, notice }),
      debounceMs: DEBOUNCE,
      maxWaitMs: MAX_WAIT,
      pollMs: POLL,
      watchFactory: fs.factory,
      probe: fs.probe,
    });
  });

  afterEach(() => {
    svc.stop();
    vi.useRealTimers();
  });

  const states = (): string[] => notices.map((n) => n.notice.state);

  it('refuses a path the read scope refuses, and opens nothing', () => {
    const r = svc.watch(1, 'tok', '/etc/shadow');
    expect(r).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(svc.stats()).toMatchObject({ files: 0, viewers: 0 });
    expect(fs.open()).toBe(0);
    expect(rec.lines.some((l) => l.msg === 'fs:watch refused: out-of-scope')).toBe(true);
  });

  it('refuses a DIRECTORY, rather than watching the folder above a granted root', () => {
    // `fileFor` watches the target's PARENT, so a caller naming a session folder
    // would have main open a handle on the directory above it — one nobody
    // granted anything about. `resolve` says yes to a folder; this is the check
    // that does not.
    allowed = ['/proj'];
    expect(svc.watch(1, 'tok', '/proj')).toEqual({ ok: false, reason: 'not-a-file' });
    expect(svc.stats().files).toBe(0);
    expect(fs.open()).toBe(0);
    expect(rec.lines.some((l) => l.msg === 'fs:watch refused: not-a-file')).toBe(true);
  });

  it('refuses a call with no token rather than watching for nobody', () => {
    expect(svc.watch(1, undefined, FILE)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(svc.stats().files).toBe(0);
  });

  it('a rapid BURST of writes produces one notice, not ten', () => {
    expect(svc.watch(1, 'tok', FILE)).toEqual({ ok: true, path: FILE });
    for (let i = 0; i < 10; i += 1) {
      fs.write(FILE, 20 + i);
      fs.fire('PROGRESS.md');
      vi.advanceTimersByTime(10);
    }
    expect(states()).toEqual([]); // nothing yet — still inside the debounce
    vi.advanceTimersByTime(DEBOUNCE);
    expect(states()).toEqual(['changed']);
    expect(notices[0].notice.token).toBe('tok');
  });

  it('a CONTINUOUS writer still reaches the reader, at the ceiling', () => {
    svc.watch(1, 'tok', FILE);
    // an event every 100ms — inside the 150ms debounce, for ever
    for (let i = 0; i < 30; i += 1) {
      fs.write(FILE, 20 + i);
      fs.fire('PROGRESS.md');
      vi.advanceTimersByTime(100);
    }
    // 3 seconds of writing at a 1s ceiling: the reader saw it about three
    // times, not thirty and not never.
    expect(states().length).toBeGreaterThanOrEqual(2);
    expect(states().length).toBeLessThanOrEqual(4);
    expect(new Set(states())).toEqual(new Set(['changed']));
  });

  it('an event naming ANOTHER file in the folder is ignored', () => {
    svc.watch(1, 'tok', FILE);
    fs.write(OTHER);
    fs.fire('notes.md');
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(states()).toEqual([]);
  });

  it('an event with no filename is a hint: it re-reads only if the file moved', () => {
    svc.watch(1, 'tok', FILE);
    fs.fire(null);
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(states()).toEqual([]);

    fs.write();
    fs.fire(null);
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(states()).toEqual(['changed']);
  });

  it('an event NAMING the file re-reads even when the stat has not moved', () => {
    // The case the stat cannot see: a rewrite of the same length inside one
    // mtime tick. The event is the better witness and wins.
    svc.watch(1, 'tok', FILE);
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(states()).toEqual(['changed']);
  });

  it('follows the file on the stat floor when the watch cannot be created', () => {
    fs.refuse(true);
    expect(svc.watch(1, 'tok', FILE)).toEqual({ ok: true, path: FILE });
    expect(fs.open()).toBe(0);
    expect(
      rec.lines.some((l) => l.msg === 'fs watch unavailable — following the file on the stat floor')
    ).toBe(true);

    // a quiet floor tick says nothing…
    vi.advanceTimersByTime(POLL + DEBOUNCE);
    expect(states()).toEqual([]);
    // …and a real change is found without a single event
    fs.write();
    vi.advanceTimersByTime(POLL + DEBOUNCE);
    expect(states()).toEqual(['changed']);
  });

  it('a watch that dies mid-run degrades to the floor rather than going quiet', () => {
    svc.watch(1, 'tok', FILE);
    fs.fail(new Error('EPERM'));
    expect(fs.live()).toBe(0);
    fs.write();
    vi.advanceTimersByTime(POLL + DEBOUNCE);
    expect(states()).toEqual(['changed']);
  });

  it('a deleted file is announced ONCE, and its return is announced too', () => {
    svc.watch(1, 'tok', FILE);
    fs.remove();
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(states()).toEqual(['gone']);

    // the floor keeps ticking over a file that is still not there — and says
    // nothing more about it
    vi.advanceTimersByTime(POLL * 3);
    expect(states()).toEqual(['gone']);

    fs.write();
    vi.advanceTimersByTime(POLL + DEBOUNCE);
    expect(states()).toEqual(['gone', 'changed']);
  });

  it('two viewers of one file share one watch; the LAST one out closes it', () => {
    svc.watch(1, 'a', FILE);
    svc.watch(1, 'b', FILE);
    expect(svc.stats()).toMatchObject({ files: 1, viewers: 2 });
    expect(fs.live()).toBe(1);

    fs.write();
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(notices.map((n) => n.notice.token).sort()).toEqual(['a', 'b']);

    svc.unwatch(1, 'a');
    expect(svc.stats()).toMatchObject({ files: 1, viewers: 1 });
    expect(fs.live()).toBe(1);

    svc.unwatch(1, 'b');
    expect(svc.stats()).toMatchObject({ files: 0, viewers: 0 });
    expect(fs.live()).toBe(0);
    expect(rec.lines.some((l) => l.msg === 'fs watch closed')).toBe(true);
  });

  it('nothing survives the panel closing — no timer, no handle, no notice', () => {
    svc.watch(1, 'tok', FILE);
    fs.write();
    fs.fire('PROGRESS.md'); // a change already in flight…
    svc.unwatch(1, 'tok'); // …and the panel closes before it settles
    vi.advanceTimersByTime(POLL * 5);
    expect(states()).toEqual([]);
    expect(svc.stats()).toMatchObject({ files: 0, viewers: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-pointing a viewer moves its watch and leaves nothing behind', () => {
    svc.watch(1, 'tok', FILE);
    svc.watch(1, 'tok', OTHER);
    expect(svc.stats()).toMatchObject({ files: 1, viewers: 1, watched: [OTHER] });
    expect(fs.live()).toBe(1);
  });

  it('a destroyed window releases everything it held, and only its own', () => {
    svc.watch(1, 'a', FILE);
    svc.watch(2, 'b', FILE);
    svc.watch(1, 'c', OTHER);
    expect(svc.stats()).toMatchObject({ files: 2, viewers: 3 });

    svc.releaseCaller(1);
    expect(svc.stats()).toMatchObject({ files: 1, viewers: 1, watched: [FILE] });
    fs.write();
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(notices).toEqual([{ callerId: 2, notice: { token: 'b', state: 'changed' } }]);
  });

  it('a DELETED file is still announced, even when the scope can no longer place it', () => {
    // A file the user picked through the dialog grants that FILE and not its
    // folder, so once it is deleted `ReadScope.resolve` has only the folder to
    // answer about and says `out-of-scope`. The deletion is the news, and the
    // reader must not be left with a document that silently stopped updating.
    svc.watch(1, 'tok', FILE);
    fs.remove();
    allowed = [];
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(states()).toEqual(['gone']);
  });

  it('a path that LEAVES the read scope stops being reported on at all', () => {
    svc.watch(1, 'tok', FILE);
    allowed = []; // the card this folder belonged to was closed
    fs.write();
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(states()).toEqual([]);
    expect(svc.stats()).toMatchObject({ files: 0, viewers: 0 });
    expect(fs.live()).toBe(0);
  });

  it('stop() releases every file, whoever was holding it', () => {
    svc.watch(1, 'a', FILE);
    svc.watch(2, 'b', OTHER);
    svc.stop();
    expect(svc.stats()).toMatchObject({ files: 0, viewers: 0 });
    expect(fs.live()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a push that throws does not cost the other viewers their notice', () => {
    const boom = new FileWatchService({
      log: rec.log,
      scope: fakeScope(() => allowed),
      push: (_id, notice) => {
        if (notice.token === 'a') throw new Error('window went away');
        notices.push({ callerId: _id, notice });
      },
      debounceMs: DEBOUNCE,
      pollMs: POLL,
      watchFactory: fs.factory,
      probe: fs.probe,
    });
    boom.watch(1, 'a', FILE);
    boom.watch(1, 'b', FILE);
    fs.write();
    fs.fire('PROGRESS.md');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(notices.map((n) => n.notice.token)).toEqual(['b']);
    boom.stop();
  });

  /**
   * #544: the bound the peek slot used to provide, put back into the plumbing.
   *
   * Nothing above this block changed when these were written, which is the
   * claim: this is consolidation, not new behaviour. What these pin is the cost
   * — one OS handle per FOLDER rather than per file, and one interval for the
   * whole service rather than one per file — plus the two things that get
   * subtler once a handle is shared: an event must still reach exactly the file
   * it names, and a folder must still be released the moment its last file goes.
   */
  describe('one handle per DIRECTORY, one timer for the service (#544)', () => {
    /** More documents out of one repo than the peek slot ever allowed. */
    const many = (n: number, dir = DIR): string[] => {
      const paths: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const p = `${dir}/doc-${i}.md`;
        fs.sigs.set(p, { mtimeMs: 1000, size: 10, ino: 100 + i });
        allowed.push(p);
        paths.push(p);
      }
      return paths;
    };

    const openAll = (paths: string[]): void => {
      paths.forEach((p, i) => {
        expect(svc.watch(1, `t${i}`, p)).toMatchObject({ ok: true });
      });
    };

    it('ten tabs across one folder hold ONE watch and ONE timer', () => {
      openAll(many(10));
      expect(svc.stats()).toMatchObject({ files: 10, dirs: 1, viewers: 10 });
      expect(fs.live()).toBe(1);
      // …and it was opened once, not opened and closed nine times on the way.
      expect(fs.open()).toBe(1);
      // The floor wheel, and not one stat timer per file.
      expect(vi.getTimerCount()).toBe(1);
    });

    it('a quiet floor tick arms nothing per file', () => {
      // The trap this closes: moving the per-file cost from `setInterval` to a
      // `setTimeout` armed by every tick would look identical at rest and be the
      // same ten timers a moment later.
      openAll(many(10));
      vi.advanceTimersByTime(POLL);
      expect(vi.getTimerCount()).toBe(1);
      expect(states()).toEqual([]);
    });

    it('the shared floor still finds a change on every file, with no events at all', () => {
      const paths = many(3);
      openAll(paths);
      paths.forEach((p) => fs.write(p, 33));
      vi.advanceTimersByTime(POLL + DEBOUNCE);
      expect(states()).toEqual(['changed', 'changed', 'changed']);
      expect(notices.map((n) => n.notice.token).sort()).toEqual(['t0', 't1', 't2']);
    });

    it('one shared handle fans an event out by NAME, and only to that file', () => {
      svc.watch(1, 'a', FILE);
      svc.watch(1, 'b', OTHER);
      expect(fs.live()).toBe(1);
      fs.write(OTHER, 40);
      fs.fire('notes.md');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices).toEqual([{ callerId: 1, notice: { token: 'b', state: 'changed' } }]);
    });

    it('an event with NO name is a hint for every file under the folder', () => {
      svc.watch(1, 'a', FILE);
      svc.watch(1, 'b', OTHER);
      fs.write(FILE, 40); // only this one actually moved
      fs.fire(null);
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['a']);
    });

    it('the handle survives one tab closing and goes with the last', () => {
      svc.watch(1, 'a', FILE);
      svc.watch(1, 'b', OTHER);
      expect(svc.stats()).toMatchObject({ files: 2, dirs: 1 });

      svc.unwatch(1, 'a');
      expect(svc.stats()).toMatchObject({ files: 1, dirs: 1 });
      expect(fs.live()).toBe(1);

      // …and the SURVIVOR still hears its own events through it. Counts alone
      // would look identical if the closing file had taken its neighbour's
      // entry out of the folder's name index with it.
      fs.write(OTHER, 40);
      fs.fire('notes.md');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['b']);

      svc.unwatch(1, 'b');
      expect(svc.stats()).toMatchObject({ files: 0, dirs: 0, viewers: 0 });
      expect(fs.live()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('two FOLDERS are two watches — sharing is not a global collapse', () => {
      const elsewhere = '/other/README.md';
      fs.sigs.set(elsewhere, { mtimeMs: 1000, size: 10, ino: 99 });
      allowed.push(elsewhere);
      svc.watch(1, 'a', FILE);
      svc.watch(1, 'b', OTHER);
      svc.watch(1, 'c', elsewhere);
      expect(svc.stats()).toMatchObject({ files: 3, dirs: 2 });
      expect(fs.live()).toBe(2);
      expect(vi.getTimerCount()).toBe(1);

      // A name that exists in the OTHER folder, delivered on this one, is a
      // neighbour's event and nothing more.
      fs.write(elsewhere, 40);
      fs.fire('README.md', DIR);
      vi.advanceTimersByTime(DEBOUNCE);
      expect(states()).toEqual([]);

      fs.fire('README.md', '/other');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['c']);
    });

    it('a folder whose watch is refused degrades ONCE, and every file follows', () => {
      fs.refuse(true);
      svc.watch(1, 'a', FILE);
      svc.watch(1, 'b', OTHER);
      expect(
        rec.lines.filter(
          (l) => l.msg === 'fs watch unavailable — following the file on the stat floor'
        ).length
      ).toBe(1);

      fs.write(FILE, 40);
      fs.write(OTHER, 40);
      vi.advanceTimersByTime(POLL + DEBOUNCE);
      expect(notices.map((n) => n.notice.token).sort()).toEqual(['a', 'b']);
    });

    it('a degraded folder gets a fresh attempt when the next tab opens', () => {
      // The one thing sharing a handle could quietly take away: with a watch per
      // FILE, a transient EMFILE cost that file its accelerator and the next tab
      // tried again. Latching it on the directory would pin the whole folder to
      // the floor until its last tab closed — and inotify's ENOSPC arrives
      // exactly in the folder with a lot of tabs.
      fs.refuse(true);
      svc.watch(1, 'a', FILE);
      expect(fs.live()).toBe(0);

      fs.refuse(false);
      svc.watch(1, 'b', OTHER);
      expect(fs.live()).toBe(1);
      expect(svc.stats()).toMatchObject({ files: 2, dirs: 1 });

      // …and the file that opened while it was refused is on the accelerator
      // too, because the handle it was always going to use is the folder's.
      fs.write(FILE, 40);
      fs.fire('PROGRESS.md');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['a']);
    });

    it('re-pointing a viewer at the SAME path leaves exactly one of everything', () => {
      // The case `watch()`'s unwatch-before-register comment reasons about: A
      // and B are the same file, so `fileFor` would hand back the very entry the
      // unwatch is about to tear down if the order were reversed.
      svc.watch(1, 'tok', FILE);
      svc.watch(1, 'tok', FILE);
      expect(svc.stats()).toMatchObject({ files: 1, dirs: 1, viewers: 1, watched: [FILE] });
      expect(fs.live()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      fs.write();
      fs.fire('PROGRESS.md');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(states()).toEqual(['changed']);
    });

    it('a QUIET file whose folder left the scope is still released, by the floor', () => {
      // Nobody is writing to it, so no event and no moved stat will ever wake
      // it — the wheel is the only thing that can notice the session card
      // closed, and it has to notice without arming a debounce to do it.
      svc.watch(1, 'tok', FILE);
      allowed = [];
      vi.advanceTimersByTime(POLL);
      expect(svc.stats()).toMatchObject({ files: 0, dirs: 0, viewers: 0 });
      expect(fs.live()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(states()).toEqual([]);
    });
  });

  /**
   * #682: one timer for the service was never the same claim as one BURST.
   *
   * #544 removed M standing intervals and, with them, the staggering M timers
   * created at M different moments got for free — every open file's stat and
   * scope resolve landed in one synchronous run on main. These pin the fix and,
   * more importantly, the thing the fix must not quietly buy it with: the floor
   * is what GUARANTEES the viewer follows the file, so slicing may move a file's
   * turn inside the period and may not lengthen the period.
   *
   * The services here are built locally rather than using the fixture's `svc`
   * because what they count is `probe` calls, which needs a probe that keeps a
   * log; `svc` is left with nothing open, so it holds no timer of its own and
   * the counts below are this block's alone.
   */
  describe('the floor wheel is sliced, not one burst (#682)', () => {
    /** one slot's turn — derived, so the numbers below follow the constant */
    const SLICE = POLL / FILE_WATCH_POLL_SLICES;

    /** every path `sliced` stat'd, in order */
    let probed: string[];
    let sliced: FileWatchService;
    let opened: number;

    beforeEach(() => {
      probed = [];
      opened = 0;
      sliced = new FileWatchService({
        log: rec.log,
        scope: fakeScope(() => allowed),
        push: (callerId, notice) => notices.push({ callerId, notice }),
        debounceMs: DEBOUNCE,
        maxWaitMs: MAX_WAIT,
        pollMs: POLL,
        watchFactory: fs.factory,
        probe: (p) => {
          probed.push(p);
          return fs.probe(p);
        },
      });
    });

    afterEach(() => sliced.stop());

    /** `n` more documents in `DIR`, open on `sliced` as tokens `s0`, `s1`, …
     *  Opening probes twice per file (the not-a-file check, then the seed), so
     *  every test below clears `probed` after it opens what it needs. */
    const open = (n: number): string[] => {
      const paths: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const p = `${DIR}/slice-${opened}.md`;
        fs.sigs.set(p, { mtimeMs: 1000, size: 10, ino: 200 + opened });
        allowed.push(p);
        expect(sliced.watch(1, `s${opened}`, p)).toMatchObject({ ok: true });
        paths.push(p);
        opened += 1;
      }
      return paths;
    };

    it('a sub-tick stats only its own slot, not every open file', () => {
      // Eight tabs, four slots: the burst #682 is about would be eight stats at
      // once, every two seconds.
      open(8);
      probed.length = 0;
      vi.advanceTimersByTime(SLICE);
      expect(probed.length).toBe(2);
      probed.length = 0;
      vi.advanceTimersByTime(SLICE);
      expect(probed.length).toBe(2);
    });

    it('and the wheel runs at the SLICE period, not the poll period', () => {
      // The half of the change a count alone cannot see: four sub-ticks per
      // `pollMs` rather than one, still from a single timer.
      open(4);
      probed.length = 0;
      vi.advanceTimersByTime(SLICE - 1);
      expect(probed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(probed.length).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('every open file is still stat`d exactly once per pollMs', () => {
      // The floor is the authority, so "sliced" has to mean a different PHASE
      // per file and not a lower rate for any of them. Nine over four slots is
      // deliberately uneven — 3, 2, 2, 2 — so a test that only worked when the
      // division came out whole would not pass here.
      const paths = open(9);
      probed.length = 0;
      vi.advanceTimersByTime(POLL);
      expect([...probed].sort()).toEqual([...paths].sort());
    });

    it('a slot never holds more than its share, however the tabs opened', () => {
      // Round-robin assignment, so ten tabs opened in one go are spread over
      // the wheel. Assigning every new file to whichever slot was next to fire
      // would pass the "once per pollMs" test above and put all ten back in one
      // burst.
      open(10);
      for (let i = 0; i < FILE_WATCH_POLL_SLICES; i += 1) {
        probed.length = 0;
        vi.advanceTimersByTime(SLICE);
        expect(probed.length).toBeLessThanOrEqual(Math.ceil(10 / FILE_WATCH_POLL_SLICES));
      }
    });

    it('the ceiling is unchanged: a write is reported within pollMs from any slot', () => {
      // The done-when's "semantics preserved", stated as the promise the rest of
      // the app makes — `FILE_WATCH_POLL_MS` is the worst case for the whole
      // feature. One file per slot, and the writes land mid-revolution so no
      // slot is sitting at a convenient phase.
      const paths = open(FILE_WATCH_POLL_SLICES);
      vi.advanceTimersByTime(POLL + 1);
      notices.length = 0;
      paths.forEach((p, i) => fs.write(p, 40 + i));
      vi.advanceTimersByTime(POLL + DEBOUNCE);
      expect(notices.map((n) => n.notice.token).sort()).toEqual(['s0', 's1', 's2', 's3']);
    });

    it('a file opened mid-revolution waits for its own slot, and no longer', () => {
      // A late tab inherits the wheel's phase — it cannot get a fresh `pollMs`
      // of its own without a second timer, which is the thing #544 removed. So
      // the claim is only that its first check lands inside one revolution.
      open(1);
      vi.advanceTimersByTime(SLICE + 7); // arbitrary point inside the wheel
      const [late] = open(1);
      fs.write(late, 44);
      notices.length = 0;
      vi.advanceTimersByTime(POLL + DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['s1']);
    });

    it('a quiet sub-tick still arms nothing, and an idle service holds no timer', () => {
      // #544's rule, re-checked at the finer grain: four chances a period to
      // accidentally arm a debounce per file instead of one.
      open(6);
      for (let i = 0; i < FILE_WATCH_POLL_SLICES * 2; i += 1) {
        vi.advanceTimersByTime(SLICE);
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(states()).toEqual([]);
      sliced.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  /**
   * #683: the fold is a parameter, so both of its answers can be asked here.
   *
   * `read-scope.ts` made `PathStyle` injectable for the reason repeated below —
   * "a test that can only assert its own platform's half is half a test" — and
   * since #544 this module folds THREE keys with it: the file entry, the
   * directory entry, and the name an event is fanned out by. The failure mode is
   * the quiet one. A fold that disagreed with the platform would not throw; it
   * would look like a folder whose documents simply stopped re-rendering.
   */
  describe('the fold style is injected, not read off the host (#683)', () => {
    const running: FileWatchService[] = [];

    /** the fixture's service, built again with a chosen filesystem convention */
    const styled = (pathStyle?: PathStyle): FileWatchService => {
      const svc2 = new FileWatchService({
        log: rec.log,
        scope: fakeScope(() => allowed),
        push: (callerId, notice) => notices.push({ callerId, notice }),
        debounceMs: DEBOUNCE,
        maxWaitMs: MAX_WAIT,
        pollMs: POLL,
        watchFactory: fs.factory,
        probe: fs.probe,
        pathStyle,
      });
      running.push(svc2);
      return svc2;
    };

    afterEach(() => {
      running.splice(0).forEach((s) => s.stop());
    });

    it('delivers an event that differs only in case where the filesystem folds it', () => {
      const win = styled(WIN32_STYLE);
      expect(win.watch(1, 'tok', FILE)).toMatchObject({ ok: true });
      // What Windows actually hands back: the name as the WRITER spelled it,
      // which is not necessarily the spelling the tab was opened with.
      fs.fire('progress.MD');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(states()).toEqual(['changed']);
    });

    it('and treats it as a neighbour where the filesystem does not', () => {
      const posix = styled(POSIX_STYLE);
      expect(posix.watch(1, 'tok', FILE)).toMatchObject({ ok: true });
      fs.fire('progress.MD');
      vi.advanceTimersByTime(DEBOUNCE * 2);
      expect(states()).toEqual([]);
      // …and the same service delivers the exact name, so the assertion above is
      // about the FOLD and not about a watch that was never wired up.
      fs.fire('PROGRESS.md');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(states()).toEqual(['changed']);
    });

    it('folds the file and directory keys by the same rule: one entry, one watch', () => {
      // The other two keys #544 added. Two spellings of one path on a folding
      // filesystem are one file, one folder and ONE OS handle — the sharing
      // this module exists for, decided entirely by the fold.
      const other = '/PROJ/Progress.MD';
      fs.sigs.set(other, { mtimeMs: 1000, size: 10, ino: 7 });
      allowed.push(other);

      const win = styled(WIN32_STYLE);
      win.watch(1, 'a', FILE);
      win.watch(1, 'b', other);
      expect(win.stats()).toMatchObject({ files: 1, dirs: 1, viewers: 2, watched: [FILE] });
      expect(fs.live()).toBe(1);
    });

    it('and keeps them apart where two spellings really are two files', () => {
      const other = '/PROJ/Progress.MD';
      fs.sigs.set(other, { mtimeMs: 1000, size: 10, ino: 9 });
      allowed.push(other);

      const posix = styled(POSIX_STYLE);
      posix.watch(1, 'a', FILE);
      posix.watch(1, 'b', other);
      expect(posix.stats()).toMatchObject({ files: 2, dirs: 2, viewers: 2 });
      expect(fs.live()).toBe(2);

      // …and each folder's watch answers only for its own file.
      fs.write(other, 40);
      fs.fire('Progress.MD', '/PROJ');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(notices.map((n) => n.notice.token)).toEqual(['b']);
    });

    it('defaults to the host rule, so nothing in production changed', () => {
      // The one thing an injectable knob can silently get wrong: the default.
      const host = styled(undefined);
      host.watch(1, 'tok', FILE);
      fs.fire('progress.MD');
      vi.advanceTimersByTime(DEBOUNCE);
      expect(states()).toEqual(HOST_STYLE.caseInsensitive ? ['changed'] : []);
    });
  });
});
