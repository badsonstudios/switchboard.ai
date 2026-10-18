import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ActivatableWindow,
  childWindowOptions,
  NO_ACTIVATE_ENV,
  noActivate,
  noActivateRequested,
  raiseWindow,
  revealChildWindow,
  revealWindow,
  setNoActivate,
} from './window-activation';

/** A BrowserWindow stand-in that records every call, in order. */
function fakeWindow(state: { destroyed?: boolean; minimized?: boolean } = {}) {
  const calls: string[] = [];
  const win: ActivatableWindow & { calls: string[] } = {
    calls,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    focus: () => calls.push('focus'),
  };
  return win;
}

afterEach(() => setNoActivate(false));

describe('noActivateRequested (#1332)', () => {
  it('is UNREACHABLE for a packaged app, whatever the environment says', () => {
    expect(noActivateRequested({ [NO_ACTIVATE_ENV]: '1' }, true)).toBe(false);
    // the fake provider does not open it either: packaged is the whole gate
    expect(
      noActivateRequested({ [NO_ACTIVATE_ENV]: '1', SWITCHBOARD_FAKE_PROVIDER: '1' }, true)
    ).toBe(false);
  });

  it('is on for an unpackaged app only when the var is exactly "1"', () => {
    expect(noActivateRequested({ [NO_ACTIVATE_ENV]: '1' }, false)).toBe(true);
    expect(noActivateRequested({}, false)).toBe(false);
    expect(noActivateRequested({ [NO_ACTIVATE_ENV]: '' }, false)).toBe(false);
    expect(noActivateRequested({ [NO_ACTIVATE_ENV]: 'true' }, false)).toBe(false);
  });

  it('defaults to off', () => {
    expect(noActivate()).toBe(false);
  });
});

describe('the normal path is unchanged', () => {
  it('reveal is show()', () => {
    const w = fakeWindow();
    revealWindow(w);
    expect(w.calls).toEqual(['show']);
  });

  it('raise is restore-if-minimized, show, focus', () => {
    const w = fakeWindow({ minimized: true });
    raiseWindow(w);
    expect(w.calls).toEqual(['restore', 'show', 'focus']);
    const v = fakeWindow();
    raiseWindow(v);
    expect(v.calls).toEqual(['show', 'focus']);
  });

  it('popouts get no extra options and no extra show', () => {
    expect(childWindowOptions()).toEqual({});
    const w = fakeWindow();
    revealChildWindow(w);
    expect(w.calls).toEqual([]);
  });
});

describe('quiet mode never activates', () => {
  it('reveal and raise are showInactive() only — no focus(), no restore()', () => {
    setNoActivate(true);
    const a = fakeWindow();
    revealWindow(a);
    const b = fakeWindow({ minimized: true });
    raiseWindow(b);
    expect(a.calls).toEqual(['showInactive']);
    // restore() is SW_RESTORE on Windows, which activates; showInactive
    // un-minimizes without it
    expect(b.calls).toEqual(['showInactive']);
  });

  it('popouts are created hidden and then shown inactive', () => {
    setNoActivate(true);
    expect(childWindowOptions()).toEqual({ show: false, focusable: false });
    const w = fakeWindow();
    revealChildWindow(w);
    expect(w.calls).toEqual(['showInactive']);
  });

  it('a destroyed window is left alone', () => {
    setNoActivate(true);
    const w = fakeWindow({ destroyed: true });
    revealWindow(w);
    raiseWindow(w);
    expect(w.calls).toEqual([]);
  });
});

describe('every show/focus in src/main goes through this seam', () => {
  // A source scan, because index.ts cannot be imported under vitest. A new
  // raise written as `win.focus()` would steal the foreground in quiet mode —
  // route it through `raiseWindow` instead.
  //
  // ANY receiver, optional chaining included, and every call that can activate
  // a window on Windows: show/focus/restore, `moveTop` (SetWindowPos without
  // SWP_NOACTIVATE), `maximize`/`unmaximize` (SW_MAXIMIZE / SW_RESTORE), and
  // `app.focus({ steal })`.
  const ACTIVATING = /[\w\])]\??\.(show|focus|restore|moveTop|maximize|unmaximize)\(\)|\.focus\(\{/;

  /** Each allowed line, and why it is not a raise. Matched on the trimmed source. */
  const ALLOWED: Record<string, string> = {
    // re-focuses a window that ALREADY holds the foreground (blur then focus,
    // to bring the keys back after a native dialog): it takes nothing from
    // anyone else
    'dialog-refocus.ts: focused.focus();': 'already in front',
    // an OS notification, not a window
    'index.ts: toast.show();': 'a Notification',
    // KNOWN EXCEPTIONS (#1332), named in window-activation.ts: Windows has no
    // non-activating maximize, and no spec seeds a maximized window. A quiet
    // run that restores one maximized WILL take the foreground here.
    'index.ts: if (state.isMaximized) win.maximize();': 'no inactive maximize exists',
    'index.ts: if (plan.maximizeAfter) win.maximize();': 'no inactive maximize exists',
    'index.ts: if (plan.unmaximizeFirst) win.unmaximize();': 'no inactive un-maximize exists',
    'index.ts: if (win.isMaximized()) win.unmaximize();': 'no inactive un-maximize exists',
  };

  it('no other main-process line can activate a window', () => {
    const root = path.resolve(__dirname);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const rel = path.relative(root, p).split(path.sep).join('/');
          if (rel === 'window-activation.ts') continue;
          fs.readFileSync(p, 'utf8')
            .split(/\r?\n/)
            .forEach((line) => {
              const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
              if (ACTIVATING.test(code)) offenders.push(`${rel}: ${line.trim()}`);
            });
        }
      }
    };
    walk(root);
    expect(offenders.filter((o) => !(o in ALLOWED))).toEqual([]);
    // and the allowance cannot rot: every entry still names a real line
    expect(Object.keys(ALLOWED).filter((k) => !offenders.includes(k))).toEqual([]);
  });

  it('the scan is not vacuous: it flags the shapes it claims to', () => {
    for (const line of [
      'win.focus();',
      'currentWindow?.focus();',
      'child.show();',
      'BrowserWindow.fromId(id)?.focus();',
      'target.moveTop();',
      'app.focus({ steal: true });',
      'focused.focus();',
    ])
      expect(ACTIVATING.test(line), line).toBe(true);
    expect(ACTIVATING.test('win.showInactive();')).toBe(false);
  });
});
