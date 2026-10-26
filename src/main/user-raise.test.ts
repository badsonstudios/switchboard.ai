import { describe, it, expect, afterEach, vi } from 'vitest';
import { performUserRaise, type UserRaiseTarget } from './user-raise';
import { setNoActivate } from './window-activation';

function fakeWindow(o: { minimized?: boolean; focusedAfter?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  let focusListener: (() => void) | null = null;
  let minimized = o.minimized ?? false;
  const win: UserRaiseTarget = {
    isDestroyed: () => o.destroyed ?? false,
    isMinimized: () => minimized,
    restore: () => {
      calls.push('restore');
      minimized = false;
    },
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    focus: () => calls.push('focus'),
    isFocused: () => o.focusedAfter ?? true,
    flashFrame: (flag: boolean) => calls.push(`flash:${flag}`),
    once: (event: 'focus' | 'blur', listener: () => void) => {
      if (event === 'focus') focusListener = listener;
      calls.push(`once:${event}`);
      return win;
    },
    removeListener: () => win,
  };
  return { win, calls, arrive: () => focusListener?.() };
}

const noWait = { wait: () => Promise.resolve() };

afterEach(() => setNoActivate(false));

describe('performUserRaise (#1456)', () => {
  it('raises a window behind ours: show + focus, no flash', async () => {
    const { win, calls } = fakeWindow();
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true });
    expect(r).toEqual({ outcome: 'raised', wasMinimized: false });
    expect(calls).toEqual(['show', 'focus']);
  });

  it('a MINIMISED window is restored first', async () => {
    const { win, calls } = fakeWindow({ minimized: true });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true });
    expect(r).toEqual({ outcome: 'raised', wasMinimized: true });
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });

  it('refused (still not focused): blinks the taskbar button, cleared on arrival', async () => {
    const { win, calls, arrive } = fakeWindow({ focusedAfter: false });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true });
    expect(r.outcome).toBe('flashed');
    expect(calls).toContain('flash:true');
    arrive();
    expect(calls.at(-1)).toBe('flash:false');
  });

  it('another app was in front when asked: blinks even if isFocused() says yes (#756 lie)', async () => {
    const { win, calls } = fakeWindow({ focusedAfter: true });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: false });
    expect(r.outcome).toBe('flashed');
    expect(calls).toContain('flash:true');
  });

  it('repeated refusals keep ONE pending clear, not one per click', async () => {
    const { win, calls } = fakeWindow({ focusedAfter: false });
    await performUserRaise(win, { ...noWait, appHadForeground: true });
    await performUserRaise(win, { ...noWait, appHadForeground: true });
    expect(calls.filter((c) => c === 'once:focus')).toHaveLength(1);
  });

  it('waits for the OS before checking', async () => {
    const { win } = fakeWindow();
    const wait = vi.fn(() => Promise.resolve());
    await performUserRaise(win, { wait, appHadForeground: true });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('a destroyed window is no-window and nothing is called', async () => {
    const { win, calls } = fakeWindow({ destroyed: true });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true });
    expect(r.outcome).toBe('no-window');
    expect(calls).toEqual([]);
  });

  it('quiet e2e launch: shown inactive, no focus, no flash', async () => {
    setNoActivate(true);
    const { win, calls } = fakeWindow({ focusedAfter: false });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: false });
    expect(r.outcome).toBe('no-activate');
    expect(calls).toEqual(['showInactive']);
  });
});

describe('performUserRaise reads the OS answer, not isFocused() (#1379)', () => {
  it('Electron says focused, the OS says not: blinks', async () => {
    const { win, calls } = fakeWindow({ focusedAfter: true });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true, isFront: () => false });
    expect(r.outcome).toBe('flashed');
    expect(calls).toContain('flash:true');
  });

  it('really in front: raised, no blink', async () => {
    const { win, calls } = fakeWindow({ focusedAfter: false });
    const r = await performUserRaise(win, { ...noWait, appHadForeground: true, isFront: () => true });
    expect(r.outcome).toBe('raised');
    expect(calls).not.toContain('flash:true');
  });
});
