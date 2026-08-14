import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { acquireInstanceLock, focusRunningWindow, RaisableWindow, sleepSync } from './single-instance';

describe('acquireInstanceLock (#289)', () => {
  /**
   * A lock that starts held and frees after `freeAfter` attempts, on a fake
   * clock the fake sleep advances — real time never passes, so the retry
   * window is asserted rather than waited out.
   */
  function lockFreeingAfter(freeAfter: number) {
    const state = { attempts: 0, slept: [] as number[], t: 1_000_000 };
    return {
      state,
      now: () => state.t,
      tryLock: () => ++state.attempts > freeAfter,
      sleep: (ms: number) => {
        state.slept.push(ms);
        state.t += ms;
      },
    };
  }

  it('takes a free lock on the first attempt and never sleeps', () => {
    const l = lockFreeingAfter(0);
    expect(acquireInstanceLock({ ...l, retryForMs: 3_000 })).toBe(true);
    expect(l.state.attempts).toBe(1);
    expect(l.state.slept).toEqual([]);
  });

  it('with no retry window, one attempt and out — a packaged double-click', () => {
    const l = lockFreeingAfter(99);
    expect(acquireInstanceLock({ ...l, retryForMs: 0 })).toBe(false);
    expect(l.state.attempts).toBe(1);
    expect(l.state.slept).toEqual([]);
  });

  it('retries until the dying predecessor lets go (npm run dev restart)', () => {
    const l = lockFreeingAfter(3);
    expect(acquireInstanceLock({ ...l, retryForMs: 3_000, stepMs: 250 })).toBe(true);
    expect(l.state.attempts).toBe(4);
    expect(l.state.slept).toEqual([250, 250, 250]);
  });

  it('gives up when the window runs out — a genuine second instance', () => {
    const l = lockFreeingAfter(Number.MAX_SAFE_INTEGER);
    expect(acquireInstanceLock({ ...l, retryForMs: 1_000, stepMs: 250 })).toBe(false);
    // bounded: it must not sleep past the window it was given
    expect(l.state.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000);
    expect(l.state.attempts).toBeGreaterThan(1);
  });

  it('never sleeps for longer than it was allowed, whatever the step', () => {
    const l = lockFreeingAfter(Number.MAX_SAFE_INTEGER);
    // a step BIGGER than the window must produce no sleep at all, not one
    // oversized one — the failed launch has to be quick
    acquireInstanceLock({ ...l, retryForMs: 100, stepMs: 5_000 });
    expect(l.state.slept).toEqual([]);
  });
});

describe('sleepSync', () => {
  it('blocks for roughly the time asked', () => {
    const t = Date.now();
    sleepSync(40);
    expect(Date.now() - t).toBeGreaterThanOrEqual(30);
  });
});

/** A BrowserWindow stand-in that records the raise, in order. */
function fakeWindow(state: { destroyed?: boolean; minimized?: boolean } = {}) {
  const calls: string[] = [];
  const win: RaisableWindow & { calls: string[] } = {
    calls,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  return win;
}

describe('focusRunningWindow (#289)', () => {
  it('shows and focuses a live window', () => {
    const win = fakeWindow();
    expect(focusRunningWindow(win)).toBe(true);
    expect(win.calls).toEqual(['show', 'focus']);
  });

  it('UNMINIMIZES first — focus() alone leaves a minimized window minimized', () => {
    const win = fakeWindow({ minimized: true });
    expect(focusRunningWindow(win)).toBe(true);
    expect(win.calls).toEqual(['restore', 'show', 'focus']);
    // and the restore comes BEFORE the focus, which is the whole point
    expect(win.calls.indexOf('restore')).toBeLessThan(win.calls.indexOf('focus'));
  });

  it('does not restore a window that is not minimized', () => {
    const win = fakeWindow({ minimized: false });
    focusRunningWindow(win);
    expect(win.calls).not.toContain('restore');
  });

  it('reports "no window" for a destroyed one, and touches nothing', () => {
    const win = fakeWindow({ destroyed: true });
    expect(focusRunningWindow(win)).toBe(false);
    expect(win.calls).toEqual([]);
  });

  it('reports "no window" for null/undefined — the still-booting case', () => {
    expect(focusRunningWindow(null)).toBe(false);
    expect(focusRunningWindow(undefined)).toBe(false);
  });
});

/* ---- the bootstrap ordering, pinned textually ------------------------------
 *
 * `src/main/index.ts` cannot be imported under vitest — it calls
 * `app.enableSandbox()` and `app.requestSingleInstanceLock()` at module scope,
 * against an `electron` module that only exists inside a real Electron process.
 * So the one property that makes this item worth anything — the lock is taken
 * BEFORE the bootstrap touches state a running instance owns — is asserted
 * against the source text instead.
 *
 * A regex over source is a blunt instrument and this file knows it: it can only
 * fail when someone MOVES the lock or moves state-touching code above it, which
 * is exactly the regression worth catching. Same trick, same reason, as
 * `check-scripts.test.ts` and `packaging.test.ts`: a decision nothing re-checks
 * is a decision that quietly stops being true.
 */
const INDEX = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');

/** Where `needle` first appears, asserting that it appears at all. */
function at(needle: string | RegExp): number {
  const i = typeof needle === 'string' ? INDEX.indexOf(needle) : (INDEX.match(needle)?.index ?? -1);
  expect(i, `src/main/index.ts no longer contains ${String(needle)}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('the single-instance lock comes first (#289)', () => {
  const lock = () => at('app.requestSingleInstanceLock()');

  it('is taken at all', () => {
    expect(lock()).toBeGreaterThanOrEqual(0);
  });

  it.each([
    // the log file is the FIRST thing the old bootstrap wrote, and it lands
    // under userData — a losing instance must not even create it
    ['a userData path is read', 'app.getPath('],
    ['the workspace store is built', 'new WorkspaceStore('],
    // the hook listener's start() sweeps every hook-token under stateDir (#282)
    ['the hook listener is built', 'new HookListener('],
    ['the session state dir is derived', "path.join(app.getPath('userData'), 'sessions')"],
    // …and the sweep that DELETES directories under it (#290). Its safety
    // argument is that a losing instance never reaches it — without the lock
    // it would be deleting the winner's live sessions' settings files.
    ['the session state dirs are swept', 'manager.sweepOrphanStateDirs()'],
    // (a regex: the call is line-wrapped, so `\s*` spans the break)
    ['the app becomes ready', /app\s*\.whenReady\(\)/],
  ])('is taken before %s', (_what: string, marker: string | RegExp) => {
    expect(lock()).toBeLessThan(at(marker));
  });

  // The sweep's OTHER placement claim (#290), and the one the lock says
  // nothing about: within this process it must run before anything can spawn a
  // session, or a live session's directory becomes a candidate. Every session
  // is spawned through the session IPC, so "before `registerSessionIpc`" is
  // the whole of it — and the comment at the call site asserts exactly this,
  // which is why it is pinned rather than trusted.
  it('sweeps the session state dirs before any session can be spawned (#290)', () => {
    expect(at('manager.sweepOrphanStateDirs()')).toBeLessThan(at('registerSessionIpc({'));
  });

  // The SAME claim for the token sweep inside `hooks.start()` (#282, filters
  // #470), which rests on it just as heavily: it deletes `hook-token` under
  // every session-shaped directory it finds, and a token belonging to a live
  // session of OURS is only never a candidate because none exists yet. The
  // in-function keep-set is the belt; this is the braces, and it was a comment
  // until #470 noticed only one of the two sweeps had it pinned.
  it('sweeps the hook tokens before any session can be spawned (#282)', () => {
    expect(at('hooks.start()')).toBeLessThan(at('registerSessionIpc({'));
  });

  it('turns a losing instance away instead of running the bootstrap', () => {
    // `app.quit()` in the failed-lock branch...
    expect(INDEX).toMatch(/if \(!isPrimaryInstance\) \{[\s\S]{0,900}?app\.quit\(\);/);
    // ...and the guard inside whenReady, which is what makes "never mutates
    // state" true even if quitting before the message loop ever stopped exiting
    expect(INDEX).toMatch(/\.then\(async \(\) => \{[\s\S]{0,900}?if \(!isPrimaryInstance\) return;/);
  });

  it('raises the running window when a second launch is turned away', () => {
    expect(INDEX).toContain("app.on('second-instance'");
    expect(at("app.on('second-instance'")).toBeGreaterThan(lock());
    expect(INDEX).toContain('focusRunningWindow(currentWindow)');
  });
});
