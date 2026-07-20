import { describe, it, expect, vi } from 'vitest';

// mergeState/isOnAnyDisplay are pure; mock the electron import surface.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: class {},
}));

import { mergeState, isOnAnyDisplay } from './window-state';

describe('mergeState (tolerant persisted-state reader)', () => {
  it('returns centered defaults for garbage input', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}]) {
      const s = mergeState(bad);
      expect(s.bounds).toBeNull();
      expect(s.isMaximized).toBe(false);
    }
  });

  it('rejects non-finite and too-small bounds', () => {
    expect(mergeState({ bounds: { x: 0, y: 0, width: NaN, height: 500 } }).bounds).toBeNull();
    expect(mergeState({ bounds: { x: 0, y: 0, width: 200, height: 100 } }).bounds).toBeNull();
  });

  it('keeps sane persisted state, rounds, and drops extra keys', () => {
    const s = mergeState({
      bounds: { x: 10.6, y: 20.2, width: 1000, height: 700, evil: 'x' },
      isMaximized: true,
    });
    expect(s.bounds).toEqual({ x: 11, y: 20, width: 1000, height: 700 });
    expect(s.isMaximized).toBe(true);
  });

  it('supports negative coords (left-of-primary monitors)', () => {
    const s = mergeState({ bounds: { x: -1920, y: 0, width: 1000, height: 700 } });
    expect(s.bounds?.x).toBe(-1920);
  });
});

describe('isOnAnyDisplay (missing-display rescue geometry)', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };

  it('accepts a window fully on the primary display', () => {
    expect(isOnAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, [primary])).toBe(true);
  });

  it('accepts a window on a negative-coordinate display', () => {
    expect(isOnAnyDisplay({ x: -1800, y: 50, width: 800, height: 600 }, [primary, left])).toBe(true);
  });

  it('rejects a window on a disconnected display', () => {
    expect(isOnAnyDisplay({ x: -1800, y: 50, width: 800, height: 600 }, [primary])).toBe(false);
  });

  it('rejects a window dragged almost entirely off-screen', () => {
    expect(isOnAnyDisplay({ x: 1900, y: 1030, width: 800, height: 600 }, [primary])).toBe(false);
  });
});
