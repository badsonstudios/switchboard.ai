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
import type { ReadScope } from './read-scope';
import type { FileWatchNotice } from '../../shared/ipc/fs';
import { FileSignature, FileWatchService } from './file-watch';

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
 * Watchers are a LIST, not a map keyed by directory: two files in one folder are
 * two independent handles in Node, and a fake that collapsed them would quietly
 * report a leak as a pass (and the reverse).
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
});
