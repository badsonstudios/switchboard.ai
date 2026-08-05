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
// The file is `*.test.ts` on purpose: `playwright.config.ts` pins `testMatch` to
// `*.spec.ts` so the two runners never pick up each other's files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../src/test-temp-dirs';

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// `_electron` is the only runtime import the fixture takes from Playwright, so
// this one is replaced wholesale. `child_process` keeps its real exports around
// the two spies: the fixture reaching for a third one should be an ordinary
// call, not a cryptic "not a function" in whichever test happens to hit it.
vi.mock('@playwright/test', () => ({ _electron: { launch: h.launch } }));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: h.execFileSync, spawnSync: h.spawnSync };
});

import { launchApp } from './app';

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

/** The isolated-home directories currently on disk. */
function homes(): string[] {
  return fs.readdirSync(scratch).filter((n) => n.startsWith('sb-e2e-'));
}

/** Pids passed to `killTree`, however this platform spells it. */
function killedPids(): number[] {
  const win = process.platform === 'win32';
  const calls = (win ? h.execFileSync : h.spawnSync).mock.calls as unknown[][];
  return calls
    .filter((c) => c[0] === (win ? 'taskkill' : 'kill'))
    .map((c) => Number((c[1] as string[])[1]));
}

/** Run `fn` at the moment the tree kill fires, on either platform. */
function onKill(fn: () => void): void {
  h.execFileSync.mockImplementation(fn);
  h.spawnSync.mockImplementation(fn);
}

beforeEach(() => {
  // Made BEFORE the spy, or `tempDir` would resolve its parent through it.
  scratch = tempDir('sb-fixture-');
  vi.spyOn(os, 'tmpdir').mockReturnValue(scratch);
  h.launch.mockReset();
  h.execFileSync.mockReset();
  h.spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanupTempDirs();
});

describe('launchApp — the launch-failure path (#230)', () => {
  it('killTrees the spawned process when the wiring after launch throws', async () => {
    const f = fakeApp(4242);
    f.handle.firstWindow.mockImplementation(async () => {
      // Playwright drops the connection on its way out — from here on
      // `process()` throws, so only a pid read EAGERLY still exists.
      f.detach();
      throw new Error('firstWindow timed out');
    });
    h.launch.mockResolvedValue(f.handle);

    await expect(launchApp()).rejects.toThrow('firstWindow timed out');

    expect(killedPids()).toEqual([4242]);
  });

  it('kills BEFORE deleting the home, and leaves no home behind', async () => {
    const f = fakeApp(77);
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
    const f = fakeApp(9);
    f.handle.close.mockImplementation(() => new Promise<void>(() => {}));
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    const launching = launchApp();
    const asserted = expect(launching).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(5_000);
    // The bounded close gives up rather than parking the caller forever — the
    // rejection arrives, and the home is gone with it.
    await asserted;

    expect(killedPids()).toEqual([9]);
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
    const failing = fakeApp(1);
    failing.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(failing.handle);
    await expect(launchApp()).rejects.toThrow('boom');

    // A failed launch that wrongly incremented `liveApps` would wedge it above
    // zero for the rest of the worker and turn every later `sweepTempDirs()`
    // into a silent no-op — the invisible leak #213 exists to remove, and
    // nothing else in the suite would go red for it.
    const ok = fakeApp(2);
    ok.handle.firstWindow.mockResolvedValue(fakeWindow());
    h.launch.mockResolvedValue(ok.handle);
    const launched = await launchApp();
    await launched.cleanup();

    expect(homes()).toEqual([]);
  });

  it('never deletes a home the caller supplied', async () => {
    const supplied = tempDir('sb-supplied-');
    const f = fakeApp(5);
    f.handle.firstWindow.mockRejectedValue(new Error('boom'));
    h.launch.mockResolvedValue(f.handle);

    await expect(launchApp({ home: supplied })).rejects.toThrow('boom');

    expect(killedPids()).toEqual([5]);
    // Relaunch/persistence specs own their home across launches; a failed
    // launch must not take it with it.
    expect(fs.existsSync(supplied)).toBe(true);
    expect(fs.existsSync(path.join(supplied, 'AppData', 'Roaming'))).toBe(true);
  });
});

describe('launchApp — the success path', () => {
  it('close() killTrees the eagerly-captured pid after the connection is gone', async () => {
    const f = fakeApp(1234);
    f.handle.firstWindow.mockResolvedValue(fakeWindow());
    h.launch.mockResolvedValue(f.handle);

    const launched = await launchApp();
    expect(killedPids()).toEqual([]);

    // The #185 shape: the spec closed the app itself, so by teardown
    // `app.process()` no longer answers.
    f.detach();
    await launched.close();

    expect(killedPids()).toEqual([1234]);
  });
});
