// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { nativeAlert, nativeConfirm } from './native-dialog';

type Api = { refocusAfterDialog?: () => void };
const setApi = (api: Api | undefined): void => {
  (window as unknown as { switchboard?: Api }).switchboard = api;
};

describe('nativeConfirm / nativeAlert (#909)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setApi(undefined);
  });

  it('returns the answer and THEN asks main to put the keyboard back', () => {
    const order: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation(() => {
      order.push('confirm');
      return false;
    });
    setApi({ refocusAfterDialog: () => order.push('refocus') });
    expect(nativeConfirm('close it?')).toBe(false);
    expect(order).toEqual(['confirm', 'refocus']);
  });

  it('alert refocuses too', () => {
    const refocus = vi.fn();
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    setApi({ refocusAfterDialog: refocus });
    nativeAlert('nothing to close');
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it('fails open: no preload method, or one that throws, still returns the answer', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setApi(undefined);
    expect(nativeConfirm('x')).toBe(true);
    setApi({
      refocusAfterDialog: () => {
        throw new Error('ipc gone');
      },
    });
    expect(nativeConfirm('x')).toBe(true);
  });
});

// THE GUARD. The bug is invisible to every automated test we can run in CI
// (it needs real OS input), so the protection is structural: nothing in the
// renderer opens a bare native dialog, because a bare one leaves Windows
// delivering clicks but no keys.
describe('no bare window.confirm / alert / prompt in the renderer (#909)', () => {
  const root = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(root);

  it('finds the renderer sources (a wrong root would pass vacuously)', () => {
    expect(files.some((f) => f.endsWith('SessionGrid.tsx'))).toBe(true);
  });

  // Any receiver (`window.`, `window?.`, `globalThis.`, a popout's
  // `getWindow()?.`, `defaultView.`) and the bare global. The lookbehind keeps
  // `nativeConfirm(` and `props.confirm(` out. Comments are stripped, so prose
  // ("the batch prompt (P2-E9-11)") does not trip it.
  const BARE =
    /(?:\b(?:window|globalThis|defaultView)\??\.|\)\??\.|(?<![\w.$]))(confirm|alert|prompt)\s*\(/;
  const code = (f: string): string =>
    fs
      .readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

  it('the pattern catches every spelling, and not our own helpers', () => {
    for (const bad of [
      'window.confirm(m)',
      'window?.alert(m)',
      'globalThis.prompt(m)',
      'loc.getWindow()?.confirm(m)',
      'el.ownerDocument.defaultView.alert(m)',
      'if (!confirm(m)) return;',
    ])
      expect(BARE.test(bad), bad).toBe(true);
    for (const ok of ['nativeConfirm(m)', 'nativeAlert(m)', 'onConfirm(m)', 'props.confirm(m)'])
      expect(BARE.test(ok), ok).toBe(false);
  });

  it('only lib/native-dialog.ts calls them', () => {
    const offenders = files
      .filter((f) => !f.endsWith(path.join('lib', 'native-dialog.ts')))
      .filter((f) => BARE.test(code(f)));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
