// Unit tests for the e2e fixture itself — run by VITEST, not Playwright.
//
// `launchApp` is the single point every one of the ~160 specs goes through, and
// its most important branch is the one no spec can reach on purpose: what
// happens when Electron has already SPAWNED and the wiring after it throws.
// Until #230 that branch killed nothing, so a main process that came up far
// enough for Playwright to attach but never opened a window outlived the whole
// suite, holding its temp home open — one of the sources of the un-deletable
// `sb-e2e-` orphans #213 counted.
//
// Reaching that branch for real would mean deliberately wedging the app's main
// process, which is a product change in service of a test. Mocking the two
// modules the fixture reaps THROUGH — Playwright's launcher and `child_process`
// — reaches it in milliseconds and asserts the things that actually matter: the
// pid, and the ORDER (kill, then delete).
//
// #235 added the other half of the same problem: `killTree` itself has two
// branches, and each is unreachable on the OS the other one is for. The platform
// is an argument now, so both are asserted on every CI leg.
//
// The file is `*.test.ts` on purpose: `playwright.config.ts` pins `testMatch` to
// `*.spec.ts` so the two runners never pick up each other's files.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../src/test-temp-dirs';

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  execFileSync: vi.fn(),
}));

// `_electron` is the only runtime import the fixture takes from Playwright, so
// this one is replaced wholesale. `child_process` keeps its real exports around
// the spy: the fixture reaching for another one should be an ordinary call, not
// a cryptic "not a function" in whichever test happens to hit it.
vi.mock('@playwright/test', () => ({ _electron: { launch: h.launch } }));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: h.execFileSync };
});

import { killTree, launchApp } from './app';

/**
 * A stand-in `ElectronApplication`.
 *
 * `detach()` reproduces the #185 behaviour that makes the eager pid capture
 * necessary: once Playwright has torn its connection down, `app.process()`
 * THROWS rather than returning a dead handle. Any code that waits until the
 * failure path to ask for the pid gets an exception instead of a number.
 */
function fakeApp(pid: number | undefined) {
  let attached = true;
  const handle = {
    process: () => {
      if (!attached) throw new TypeError("Cannot read properties of undefined (reading 'pid')");
      return pid === undefined ? undefined : { pid };
    },
    firstWindow: vi.fn(),
    close: vi.fn(async () => {}),
  };
  return { handle, detach: () => (attached = false) };
}

/** A window whose load state resolves — the happy path. */
function fakeWindow() {
  return { waitForLoadState: vi.fn(async () => {}) };
}

let scratch: string;

/**
 * The POSIX half of `killTree`. Stubbed for EVERY test in the file (and restored
 * by `restoreAllMocks`), because the real one signals real processes: this is
 * the vitest worker's own `process`.
 *
 * The pids below are `999_0xx` for the same reason — implausible as live pids on
 * any runner, and deliberately not the small integers a fixture reaches for
 * first. `1` is the one that matters: `killTree(1)` on POSIX is
 * `process.kill(-1, 'SIGKILL')`, i.e. a BROADCAST to every process this user may
 * signal. The stub is what stands between that and the ubuntu runner, so nothing
 * here relies on the stub alone.
 */
let kill: MockInstance<typeof process.kill>;

/** The isolated-home directories currently on disk. */
function homes(): string[] {
  return fs.readdirSync(scratch).filter((n) => n.startsWith('sb-e2e-'));
}

/**
 * Pids passed to `killTree` by the tests that go through `launchApp` — however
 * the AMBIENT platform spells it, and always POSITIVE, so those tests assert on
 * the pid rather than on the signalling convention. POSIX passes a NEGATIVE pid
 * to name the process group (#235); that sign is the whole point of the fix, so
 * the `killTree` block below asserts it directly, on both platforms, everywhere.
 */
function killedPids(): number[] {
  if (process.platform === 'win32') {
    return (h.execFileSync.mock.calls as unknown[][])
      .filter((c) => c[0] === 'taskkill')
      .map((c) => Number((c[1] as string[])[1]));
  }
  return kill.mock.calls.map((c) => Math.abs(c[0]));
}

/** Run `fn` at the moment the tree kill fires, on either platform. */
function onKill(fn: () => void): void {
  h.execFileSync.mockImplementation(fn as () => Buffer);
  kill.mockImplementation(() => {
    fn();
    return true;
  });
}

beforeEach(() => {
  // Made BEFORE the spy, or `tempDir` would resolve its parent through it.
  scratch = tempDir('sb-fixture-');
  vi.spyOn(os, 'tmpdir').mockReturnValue(scratch);
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  h.launch.mockReset();
  h.execFileSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanupTempDirs();
});

describe('launchApp — the launch-failure path (#230)', () => {
  it('killTrees the spawned process when the wiring after launch throws', async () => {
    const f = fakeApp(999_042);
    f.handle.firstWindow.mockImplementation(() => {
      // Playwright drops the connection on its way out — from here on
      // `process()` throws, so only a pid read EAGERLY still exists.
      f.detach();
      // a REJECTED promise, not a synchronous throw: `firstWindow()` is awaited,
      // and the two are not the same thing to a caller that stores it first.
      return Promise.reject(new Error('firstWindow timed out'));
    });
    h.launch.mockResolvedValue(f.handle);

    await expect(launchApp()).rejects.toThrow('firstWindow timed out');

    expect(killedPids()).toEqual([999_042]);
  });

  it('kills BEFORE deleting the home, and leaves no home behind', async () => {
    const f = fakeApp(999_077);
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    let homesAtKill: string[] = [];
    onKill(() => {
      homesAtKill = homes();
    });

    await expect(launchApp()).rejects.toThrow('boom');

    // The order is the whole point on Windows: the live process holds its home
    // as an open handle, so a delete attempted first is the one that fails.
    expect(homesAtKill).toHaveLength(1);
    expect(homes()).toEqual([]);
  });

  it('closes the handle too — the only reaper when there is no pid', async () => {
    const f = fakeApp(undefined);
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    await expect(launchApp()).rejects.toThrow('boom');

    expect(killedPids()).toEqual([]);
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });

  it('does not hang when close() never settles', async () => {
    vi.useFakeTimers();
    const f = fakeApp(999_009);
    f.handle.close.mockImplementation(() => new Promise<void>(() => {}));
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    const launching = launchApp();
    const asserted = expect(launching).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(5_000);
    // The bounded close gives up rather than parking the caller forever — the
    // rejection arrives, and the home is gone with it.
    await asserted;

    expect(killedPids()).toEqual([999_009]);
    expect(homes()).toEqual([]);
  });

  it('reaps nothing, and masks nothing, when launch() itself rejects', async () => {
    h.launch.mockRejectedValue(new Error('spawn failed'));

    // There is no handle and no pid on this path, so the catch must do NOTHING
    // with either — a `launched.close()` that lost its guard would throw a
    // TypeError from in here and replace the real launch error with it.
    await expect(launchApp()).rejects.toThrow('spawn failed');

    expect(killedPids()).toEqual([]);
    expect(homes()).toEqual([]);
  });

  it('leaves the live-app counter alone, so later sweeps still sweep', async () => {
    const failing = fakeApp(999_001);
    failing.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(failing.handle);
    await expect(launchApp()).rejects.toThrow('boom');

    // A failed launch that wrongly incremented `liveApps` would wedge it above
    // zero for the rest of the worker and turn every later `sweepTempDirs()`
    // into a silent no-op — the invisible leak #213 exists to remove, and
    // nothing else in the suite would go red for it.
    const ok = fakeApp(999_002);
    ok.handle.firstWindow.mockResolvedValue(fakeWindow());
    h.launch.mockResolvedValue(ok.handle);
    const launched = await launchApp();
    await launched.cleanup();

    expect(homes()).toEqual([]);
  });

  it('never deletes a home the caller supplied', async () => {
    const supplied = tempDir('sb-supplied-');
    const f = fakeApp(999_005);
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    await expect(launchApp({ home: supplied })).rejects.toThrow('boom');

    expect(killedPids()).toEqual([999_005]);
    // Relaunch/persistence specs own their home across launches; a failed
    // launch must not take it with it.
    expect(fs.existsSync(supplied)).toBe(true);
    expect(fs.existsSync(path.join(supplied, 'AppData', 'Roaming'))).toBe(true);
  });
});

/*
 * Both branches of `killTree`, on every CI leg (#235).
 *
 * POSIX used to run `kill -9 <pid>` — the main pid alone — under a comment that
 * promised a tree. Nothing could have caught that: the branch is unreachable on
 * the Windows machines this suite is developed on, and on the ubuntu leg its
 * failure mode is a surviving grandchild, not a red test.
 *
 * So the platform is an ARGUMENT (see `killTree`'s docblock and `launchSpec`'s),
 * and every case below runs everywhere. They are shape tests and nothing more:
 * they prove which signal goes to which pid, NOT that the OS reaps the tree when
 * it arrives. The proof of THAT is the ubuntu e2e leg staying green, plus
 * playwright-core's own launcher, which spawns electron `detached` off-Windows
 * and reaps it with this exact call.
 */
describe('killTree — both branches, on every CI leg (#235)', () => {
  it('POSIX: signals the process GROUP, not just the leader', () => {
    killTree(999_042, 'linux');

    // NEGATIVE pid = the whole group. `999042` on its own is the bug: it reaps
    // the main process and leaves the popped-out window and node-pty's children
    // running, which is what keeps a Playwright worker past its teardown budget.
    expect(kill.mock.calls).toEqual([[-999_042, 'SIGKILL']]);
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  it('POSIX: falls back to the leader when the group kill fails — for any reason', () => {
    kill.mockImplementation((pid) => {
      if (pid < 0) throw new Error('ESRCH');
      return true;
    });

    killTree(999_042, 'darwin');

    // Errno-blind by design: ESRCH here is usually just "already dead" (the
    // graceful close got there first) and the retry is one no-op syscall — but
    // if Playwright ever stopped spawning detached, this is the line between
    // reaping the leader and reaping nothing at all.
    expect(kill.mock.calls).toEqual([
      [-999_042, 'SIGKILL'],
      [999_042, 'SIGKILL'],
    ]);
  });

  it('POSIX: an unkillable tree does not throw', () => {
    kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    // Teardown runs after tests that have already PASSED. Fail-open: a tree that
    // will not die is a leak, not a red test.
    expect(() => killTree(999_042, 'linux')).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('win32: taskkill /T walks the tree, and no signal is sent', () => {
    killTree(999_042, 'win32');

    // `/T` is the tree, `/F` is the force. Windows has no process groups to
    // signal, so a `kill(-pid)` here would be meaningless — assert it stays out.
    expect(h.execFileSync.mock.calls).toEqual([
      ['taskkill', ['/PID', '999042', '/T', '/F'], { stdio: 'ignore' }],
    ]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('win32: a failing taskkill does not throw either', () => {
    h.execFileSync.mockImplementation(() => {
      throw new Error('process "999042" not found');
    });

    // taskkill EXITS NONZERO for a pid that is already gone, which is the common
    // case on the close() path — `execFileSync` turns that into a throw.
    expect(() => killTree(999_042, 'win32')).not.toThrow();
  });

  it('does nothing at all without a pid — on either platform', () => {
    killTree(undefined, 'linux');
    killTree(undefined, 'win32');

    // The guard is load-bearing on POSIX beyond the obvious: `kill(-0)` is
    // `kill(0)`, which signals THIS process's own group — the Playwright worker
    // and the vitest runner included.
    expect(kill).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
  });
});

describe('launchApp — the success path', () => {
  it('close() killTrees the eagerly-captured pid after the connection is gone', async () => {
    const f = fakeApp(999_234);
    f.handle.firstWindow.mockResolvedValue(fakeWindow());
    h.launch.mockResolvedValue(f.handle);

    const launched = await launchApp();
    expect(killedPids()).toEqual([]);

    // The #185 shape: the spec closed the app itself, so by teardown
    // `app.process()` no longer answers.
    f.detach();
    await launched.close();

    expect(killedPids()).toEqual([999_234]);
  });
});
