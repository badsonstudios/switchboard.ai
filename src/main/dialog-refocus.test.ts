import { describe, it, expect } from 'vitest';
import { refocusAfterDialog, type RefocusableWindow } from './dialog-refocus';

function fakeWin(over: Partial<RefocusableWindow> = {}): RefocusableWindow & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    isFocused: () => true,
    blur: () => calls.push('blur'),
    focus: () => calls.push('focus'),
    ...over,
  };
}

describe('refocusAfterDialog (#909)', () => {
  it('blurs THEN focuses the focused window when it is ours, the only order that brings keys back', () => {
    const main = fakeWin();
    expect(refocusAfterDialog('win32', main, [main])).toBe('refocused');
    expect(main.calls).toEqual(['blur', 'focus']);
  });

  it('repairs a popout the same way when that is the focused one', () => {
    const main = fakeWin();
    const popout = fakeWin();
    expect(refocusAfterDialog('win32', popout, [main, popout])).toBe('refocused');
    expect(popout.calls).toEqual(['blur', 'focus']);
    expect(main.calls).toEqual([]);
  });

  it('is Windows-only: blur() lowers the window on macOS and X11', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const main = fakeWin();
      expect(refocusAfterDialog(platform, main, [main]), platform).toBe('skipped');
      expect(main.calls, platform).toEqual([]);
    }
  });

  it('does nothing when no window has focus, because the user went to another app', () => {
    const main = fakeWin();
    expect(refocusAfterDialog('win32', null, [main])).toBe('skipped');
    expect(main.calls).toEqual([]);
  });

  it('never touches a window that is not ours', () => {
    const main = fakeWin();
    const stranger = fakeWin();
    expect(refocusAfterDialog('win32', stranger, [main])).toBe('skipped');
    expect(stranger.calls).toEqual([]);
  });

  it('leaves a minimized or destroyed window alone', () => {
    const min = fakeWin({ isMinimized: () => true });
    const dead = fakeWin({ isDestroyed: () => true });
    expect(refocusAfterDialog('win32', min, [min])).toBe('skipped');
    expect(refocusAfterDialog('win32', dead, [dead])).toBe('skipped');
    expect([...min.calls, ...dead.calls]).toEqual([]);
  });

  it('reports `lost` when focus did not come back, so main can log it', () => {
    const main = fakeWin({ isFocused: () => false });
    expect(refocusAfterDialog('win32', main, [main])).toBe('lost');
  });

  it('fails open: a window that throws is swallowed, not an error modal in main', () => {
    const boom = fakeWin({
      blur: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(refocusAfterDialog('win32', boom, [boom])).toBe('skipped');
  });
});
