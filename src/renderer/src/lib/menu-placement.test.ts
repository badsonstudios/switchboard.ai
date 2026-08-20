import { describe, it, expect } from 'vitest';
import { placeMenu, MENU_EDGE_MARGIN as M } from './menu-placement';

/** the windows-latest runner's client area, measured in #416/#524 */
const CI = { width: 1008, height: 655 };

describe('placeMenu (#641)', () => {
  it('leaves a menu that fits exactly where it was asked for', () => {
    const p = placeMenu({ x: 142, y: 100 }, { width: 254, height: 449 }, CI);
    expect(p).toMatchObject({ left: 142, top: 100 });
  });

  it('flips a menu that would run off the bottom so its foot lands on the pointer', () => {
    // 300 + 200 = 500 <= 655 - 4, so it fits; 500 + 200 does not
    const p = placeMenu({ x: 10, y: 500 }, { width: 100, height: 200 }, CI);
    expect(p.top).toBe(300);
  });

  it('flips off the right edge the same way', () => {
    const p = placeMenu({ x: 950, y: 10 }, { width: 254, height: 100 }, CI);
    expect(p.left).toBe(950 - 254);
  });

  it('the regression itself: the rail menu at the runner geometry lands ON screen', () => {
    // the measured numbers — right-click on rail row 2 opens at y=217, and the
    // menu is 449px tall once #559's Order section is in it. 217 + 449 = 666,
    // which is 11px past the runner's usable 651.
    const p = placeMenu({ x: 142, y: 217 }, { width: 254, height: 449 }, CI);
    expect(p.top + 449).toBeLessThanOrEqual(CI.height - M);
    expect(p.top).toBeGreaterThanOrEqual(M);
  });

  it('sits against the far edge when NEITHER side has room', () => {
    // anchored in the middle of a short window by a menu taller than both halves
    const vp = { width: 400, height: 300 };
    const p = placeMenu({ x: 10, y: 160 }, { width: 100, height: 200 }, vp);
    expect(p.top).toBe(300 - M - 200);
    expect(p.top).toBeGreaterThanOrEqual(M);
  });

  it('a menu taller than the window is pinned to the top and told to scroll', () => {
    const vp = { width: 400, height: 300 };
    const p = placeMenu({ x: 10, y: 200 }, { width: 100, height: 900 }, vp);
    expect(p.top).toBe(M);
    expect(p.maxBlockSize).toBe(300 - M * 2);
  });

  it('never places a menu at a negative coordinate, whatever it is asked', () => {
    for (const anchor of [
      { x: -50, y: -50 },
      { x: 0, y: 0 },
      { x: 5000, y: 5000 },
    ]) {
      const p = placeMenu(anchor, { width: 254, height: 449 }, CI);
      expect(p.left).toBeGreaterThanOrEqual(M);
      expect(p.top).toBeGreaterThanOrEqual(M);
    }
  });
});
