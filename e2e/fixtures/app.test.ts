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

import {
  blurApp,
  E2E_MONITOR_ENV,
  killTree,
  launchApp,
  onTestDisplay,
  pickTestDisplay,
  translateToDisplay,
  type DisplayInfo,
  type LaunchedApp,
} from './app';

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

/** A three-monitor desktop, in the arrangement this was developed on. */
const FAKE_BOUNDS = { x: 100, y: 50, width: 1280, height: 800 };
const PRIMARY: DisplayInfo = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1392 } };
const RIGHT: DisplayInfo = { id: 2, workArea: { x: 2560, y: 0, width: 2560, height: 1392 } };
const LEFT: DisplayInfo = { id: 3, workArea: { x: -2560, y: 0, width: 2560, height: 1392 } };

/**
 * `app.evaluate` for the display move (#479), without an Electron process.
 *
 * The fixture makes exactly two calls: read the displays and the window's
 * bounds, then apply a box. The stub answers the first from `displays` and
 * records the second — so a test can assert WHERE the window was sent without
 * a machine that has two monitors, which CI does not.
 */
function fakeDisplays(displays: DisplayInfo[], primaryId: number, on = primaryId) {
  const applied: Array<{ id: number; box: unknown }> = [];
  let first = true;
  const evaluate = vi.fn((_fn: unknown, arg?: unknown) => {
    if (first) {
      first = false;
      // `on` is the display the window is ALREADY on — `primaryId` for a first
      // launch, the target for the second launch of a relaunch spec.
      const at = displays.find((d) => d.id === on)!.workArea;
      const bounds = { ...FAKE_BOUNDS, x: FAKE_BOUNDS.x + at.x, y: FAKE_BOUNDS.y + at.y };
      return Promise.resolve({ displays, primaryId, winId: 7, bounds, onId: on });
    }
    applied.push(arg as { id: number; box: unknown });
    return Promise.resolve(undefined);
  });
  return { evaluate, applied };
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
  vi.unstubAllEnvs(); // the display tests (#479) set SWITCHBOARD_E2E_MONITOR
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

/*
 * The secondary-monitor switch (#479).
 *
 * The whole feature is about a machine with more than one display, and the
 * machine that has to STAY unaffected — CI — has exactly one. So the two
 * decisions are pure functions taking a display list as data, and they are
 * pinned here with desktops no runner has. `launchApp`'s own wiring is then
 * three cases: off (asks nothing), on (moves), broken (warns, carries on).
 */
describe('pickTestDisplay — monitor 1 is the primary, 2..N are the rest (#479)', () => {
  const three = [RIGHT, PRIMARY, LEFT]; // deliberately NOT primary-first

  it('never lands on the primary, whatever order the displays arrive in', () => {
    // The reason for the re-ordering at all: `getAllDisplays()` has no
    // documented order, so a raw index into it could put the suite back on the
    // working screen — the one outcome that makes the switch pointless. Both
    // orderings, because the primary-FIRST list is the one where a raw index
    // would have looked correct.
    expect(pickTestDisplay(three, PRIMARY.id, '2')?.target).toEqual(RIGHT);
    expect(pickTestDisplay(three, PRIMARY.id, '3')?.target).toEqual(LEFT);
    expect(pickTestDisplay([PRIMARY, RIGHT, LEFT], PRIMARY.id, '2')?.target).toEqual(RIGHT);
    expect(pickTestDisplay([LEFT, RIGHT, PRIMARY], PRIMARY.id, '2')?.target).toEqual(LEFT);
  });

  it('reports the primary alongside the target, since the offset is the delta', () => {
    expect(pickTestDisplay(three, PRIMARY.id, '2')?.primary).toEqual(PRIMARY);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['junk', 'yes'],
    ['a fraction', '1.5'],
    ['zero', '0'],
    ['negative', '-1'],
    ['monitor 1 — the primary, i.e. today', '1'],
    ['past the end', '4'],
  ])('does nothing when the value is %s', (_what, value) => {
    expect(pickTestDisplay(three, PRIMARY.id, value)).toBeNull();
  });

  it('does nothing on a single-display machine — which is every CI runner', () => {
    expect(pickTestDisplay([PRIMARY], PRIMARY.id, '2')).toBeNull();
  });

  it('does nothing when the primary is not in the list at all', () => {
    // Not reachable through Electron, but the offset is defined as a delta FROM
    // the primary — with no primary there is no offset, and guessing one would
    // put every absolute box in the suite somewhere arbitrary.
    expect(pickTestDisplay([RIGHT, LEFT], PRIMARY.id, '2')).toBeNull();
  });
});

describe('translateToDisplay — shift, do not re-centre (#479)', () => {
  it('preserves the position WITHIN the display, so relative geometry survives', () => {
    expect(translateToDisplay(FAKE_BOUNDS, PRIMARY.workArea, RIGHT.workArea)).toEqual({
      x: 2660,
      y: 50,
      width: 1280,
      height: 800,
    });
  });

  it('handles a display to the LEFT, where the offset is negative', () => {
    expect(translateToDisplay(FAKE_BOUNDS, PRIMARY.workArea, LEFT.workArea)).toEqual({
      x: -2460,
      y: 50,
      width: 1280,
      height: 800,
    });
  });

  it('shrinks and pulls back a window that would not fit the target', () => {
    const small = { x: 1000, y: 0, width: 800, height: 600 };
    expect(translateToDisplay(FAKE_BOUNDS, PRIMARY.workArea, small)).toEqual({
      // shrunk to the display's full width, so there is exactly one x that
      // fits — the shift would have put it at 1100, hanging into whatever sits
      // to the right of this screen
      x: 1000,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('clamps to the far edge without shrinking, when the window does fit', () => {
    // The other half of the clamp, where "shrunk" and "moved" are separable:
    // a 1280-wide window shifted to x=2500 on a 2000-wide screen comes back to
    // 2000 - 1280 = 720 (plus the target's origin) at its original size.
    const target = { x: 0, y: 0, width: 2000, height: 1000 };
    expect(translateToDisplay({ x: 2500, y: 10, width: 1280, height: 800 }, target, target)).toEqual(
      { x: 720, y: 10, width: 1280, height: 800 }
    );
  });
});

describe('onTestDisplay — the specs’ view of the switch (#479)', () => {
  const box = { x: 160, y: 240, width: 620, height: 500 };
  const withOffset = (displayOffset: { x: number; y: number }) =>
    ({ displayOffset }) as unknown as Parameters<typeof onTestDisplay>[0];

  it('returns the box’s own numbers when the switch is off', () => {
    // THE hard requirement of this item: every converted spec calls this, so if
    // it is not the identity at `{0,0}` then CI is not running what it ran
    // before.
    expect(onTestDisplay(withOffset({ x: 0, y: 0 }), box)).toEqual(box);
  });

  it('shifts by the offset and touches nothing else', () => {
    expect(onTestDisplay(withOffset({ x: 2560, y: -40 }), box)).toEqual({
      x: 2720,
      y: 200,
      // the size is the spec's, always — this moves a window, it does not
      // resize one (unlike `translateToDisplay`, which has a display to fit)
      width: 620,
      height: 500,
    });
  });

  it('carries extra properties through, and does not mutate the argument', () => {
    const tagged = { ...box, label: 'viewer' };
    expect(onTestDisplay(withOffset({ x: 10, y: 20 }), tagged).label).toBe('viewer');
    expect(tagged.x).toBe(160);
  });
});

describe('launchApp — the display move (#479)', () => {
  function launchable(evaluate?: unknown) {
    const f = fakeApp(999_479);
    f.handle.firstWindow.mockResolvedValue(fakeWindow());
    if (evaluate) Object.assign(f.handle, { evaluate });
    h.launch.mockResolvedValue(f.handle);
    return f;
  }

  it('asks the app NOTHING when the switch is off — the CI path', async () => {
    // Stubbed to EMPTY rather than trusted to be absent. The developer most
    // likely to have this exported in their shell is the one this feature was
    // built for, and inheriting it here would fail their unit suite with a
    // message naming the wrong cause — the same trap `launchApp` scrubs
    // `SWITCHBOARD_TRANSPORT` for.
    vi.stubEnv(E2E_MONITOR_ENV, '');
    const displays = fakeDisplays([PRIMARY, RIGHT], PRIMARY.id);
    launchable(displays.evaluate);

    const launched = await launchApp();

    // Not "moved nothing": did not evaluate at all. An `app.evaluate` per launch
    // is a round-trip into the main process ~160 times a run, and the default
    // has to be byte-identical to what came before.
    expect(displays.evaluate).not.toHaveBeenCalled();
    expect(launched.displayOffset).toEqual({ x: 0, y: 0 });
    await launched.cleanup();
  });

  it('moves the window and reports the offset when it is on', async () => {
    vi.stubEnv(E2E_MONITOR_ENV, '2');
    vi.spyOn(console, 'log').mockImplementation(() => {}); // the once-per-worker banner
    const displays = fakeDisplays([PRIMARY, RIGHT], PRIMARY.id);
    launchable(displays.evaluate);

    const launched = await launchApp();

    expect(displays.applied).toEqual([
      { id: 7, box: { x: 2660, y: 50, width: 1280, height: 800 } },
    ]);
    // the DELTA between the work areas, not where the window ended up — that is
    // what `onTestDisplay` adds to a spec's absolute box
    expect(launched.displayOffset).toEqual({ x: 2560, y: 0 });
    await launched.cleanup();
  });

  it('does NOT move a window already on the target — the relaunch case', async () => {
    // The bug this pins cost a red gate run: the app persists window geometry,
    // so launch 2 of a relaunch spec restores a window that is already over
    // there. Translating THAT from the primary again pushed it another screen
    // right, the clamp pulled it back to the edge, and every popout restored
    // opener-relative to it inherited the 640px error (session.spec E8-02).
    vi.stubEnv(E2E_MONITOR_ENV, '2');
    const displays = fakeDisplays([PRIMARY, RIGHT], PRIMARY.id, RIGHT.id);
    launchable(displays.evaluate);

    const launched = await launchApp();

    expect(displays.applied).toEqual([]);
    // ...and the offset is still reported, because it describes the DISPLAY,
    // not the move: `onTestDisplay` has to answer the same on both launches or
    // a spec's absolute box lands somewhere different the second time.
    expect(launched.displayOffset).toEqual({ x: 2560, y: 0 });
    await launched.cleanup();
  });

  it('moves nothing when the machine has one display — the switch on, in CI', async () => {
    vi.stubEnv(E2E_MONITOR_ENV, '2');
    const displays = fakeDisplays([PRIMARY], PRIMARY.id);
    launchable(displays.evaluate);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const launched = await launchApp();

    // It ASKS — the display list is the only way to know — and then leaves the
    // window alone. Both halves are asserted: exactly ONE evaluate (the query,
    // never the setBounds), which is the precise complement of the switch-off
    // case's "not called at all".
    expect(displays.evaluate).toHaveBeenCalledTimes(1);
    expect(displays.applied).toEqual([]);
    expect(launched.displayOffset).toEqual({ x: 0, y: 0 });
    await launched.cleanup();
  });

  it('fails OPEN — a display query that throws does not fail the launch', async () => {
    vi.stubEnv(E2E_MONITOR_ENV, '2');
    launchable(() => Promise.reject(new Error('no screen module')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The switch is developer comfort. It must never be the reason a suite goes
    // red, and it must not route the launch into the reaping path either — the
    // app comes back alive, with the offset it really has.
    const launched = await launchApp();

    expect(launched.displayOffset).toEqual({ x: 0, y: 0 });
    expect(warn).toHaveBeenCalled();
    await launched.cleanup();
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

/**
 * `blurApp` — the #538 flake, reproduced deterministically.
 *
 * The real failure is a `blur()` the window manager drops: the command returns,
 * nothing happens, and the old idiom (blur ONCE, then passively poll
 * `isFocused()`) had no way back from it — it spent its whole 15 s waiting for
 * a state change that had already been lost. That is a one-in-sixteen event on
 * a loaded machine and unforceable in Playwright, so it is forced HERE instead:
 * a fake window that ignores the first N blurs is exactly the observed
 * behaviour, and it runs in milliseconds.
 *
 * `evaluate` really RUNS the callback against a fake `BrowserWindow`, so these
 * cover the body — every window blurred, destroyed ones skipped — and not just
 * the retry loop wrapped around it.
 */
describe('blurApp — a dropped blur is retried, not waited out (#538)', () => {
  /** a window that swallows `ignoreBlurs` blur() calls before honouring one */
  const fakeWin = (opts: { focused?: boolean; ignoreBlurs?: number; destroyed?: boolean } = {}) => {
    let focused = opts.focused ?? true;
    let left = opts.ignoreBlurs ?? 0;
    return {
      blurs: 0,
      isDestroyed: () => opts.destroyed === true,
      isFocused: () => focused,
      blur(): void {
        this.blurs++;
        if (left > 0) {
          left--;
          return; // the window manager dropped it
        }
        focused = false;
      },
    };
  };

  const appWith = (wins: ReturnType<typeof fakeWin>[]): LaunchedApp =>
    ({
      app: {
        evaluate: (fn: (m: { BrowserWindow: unknown }) => unknown) =>
          Promise.resolve(fn({ BrowserWindow: { getAllWindows: () => wins } })),
      },
    }) as unknown as LaunchedApp;

  it('settles on the first attempt when the blur lands', async () => {
    const win = fakeWin();
    await blurApp(appWith([win]));
    expect(win.isFocused()).toBe(false);
    expect(win.blurs).toBe(1);
  });

  it('recovers from a dropped blur by re-issuing it', async () => {
    const win = fakeWin({ ignoreBlurs: 2 });
    await blurApp(appWith([win]));
    expect(win.isFocused()).toBe(false);
    // three asks: two swallowed, the third honoured. The old idiom asked once.
    expect(win.blurs).toBe(3);
  });

  it('blurs EVERY window, because one focused popout holds the whole app', async () => {
    // visibilityAcross() answers "focused" if ANY window is, so blurring
    // getAllWindows()[0] alone would leave every away-rule held back.
    const first = fakeWin({ focused: false });
    const popout = fakeWin({ focused: true });
    await blurApp(appWith([first, popout]));
    expect(popout.isFocused()).toBe(false);
    expect(first.blurs).toBeGreaterThan(0);
  });

  it('skips destroyed windows rather than throwing on them', async () => {
    const dead = fakeWin({ destroyed: true });
    const live = fakeWin();
    await blurApp(appWith([dead, live]));
    expect(dead.blurs).toBe(0);
    expect(live.isFocused()).toBe(false);
  });

  it('throws when the blur never takes, instead of letting the spec carry on', async () => {
    // A spec that continued from here would go on to prove its away-rule fired
    // for a reason it did not have.
    const stuck = fakeWin({ ignoreBlurs: Number.MAX_SAFE_INTEGER });
    await expect(blurApp(appWith([stuck]), 300)).rejects.toThrow(/never went away/);
    expect(stuck.blurs).toBeGreaterThan(1);
  });
});
