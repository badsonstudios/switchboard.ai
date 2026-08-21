import { describe, it, expect } from 'vitest';
import { placeMenu, MENU_EDGE_MARGIN as M } from './menu-placement';

/** the windows-latest runner's client area, measured in #416/#524 */
const CI = { width: 1008, height: 655 };

describe('placeMenu (#641)', () => {
  it('leaves a menu that fits exactly where it was asked for', () => {
    const p = placeMenu({ x: 142, y: 100 }, { width: 254, height: 449 }, CI);
    expect(p).toMatchObject({ insetInlineStart: 142, insetBlockStart: 100 });
  });

  it('flips a menu that would run off the bottom so its foot lands on the pointer', () => {
    // 300 + 200 = 500 <= 655 - 4, so it fits; 500 + 200 does not
    const p = placeMenu({ x: 10, y: 500 }, { width: 100, height: 200 }, CI);
    expect(p.insetBlockStart).toBe(300);
  });

  it('flips off the right edge the same way', () => {
    const p = placeMenu({ x: 950, y: 10 }, { width: 254, height: 100 }, CI);
    expect(p.insetInlineStart).toBe(950 - 254);
  });

  it('the regression itself: the rail menu at the runner geometry lands ON screen', () => {
    // the measured numbers — right-click on rail row 2 opens at y=217, and the
    // menu is 449px tall once #559's Order section is in it. 217 + 449 = 666,
    // which is 11px past the runner's usable 651.
    const p = placeMenu({ x: 142, y: 217 }, { width: 254, height: 449 }, CI);
    expect(p.insetBlockStart + 449).toBeLessThanOrEqual(CI.height - M);
    expect(p.insetBlockStart).toBeGreaterThanOrEqual(M);
  });

  it('sits against the far edge when NEITHER side has room', () => {
    // anchored in the middle of a short window by a menu taller than both halves
    const vp = { width: 400, height: 300 };
    const p = placeMenu({ x: 10, y: 160 }, { width: 100, height: 200 }, vp);
    expect(p.insetBlockStart).toBe(300 - M - 200);
    expect(p.insetBlockStart).toBeGreaterThanOrEqual(M);
  });

  it('a menu taller than the window is pinned to the top and told to scroll', () => {
    const vp = { width: 400, height: 300 };
    const p = placeMenu({ x: 10, y: 200 }, { width: 100, height: 900 }, vp);
    expect(p.insetBlockStart).toBe(M);
    expect(p.maxBlockSize).toBe(300 - M * 2);
  });

  it('never places a menu at a negative coordinate, whatever it is asked', () => {
    for (const anchor of [
      { x: -50, y: -50 },
      { x: 0, y: 0 },
      { x: 5000, y: 5000 },
    ]) {
      for (const direction of ['ltr', 'rtl'] as const) {
        const p = placeMenu(anchor, { width: 254, height: 449 }, CI, { direction });
        expect(p.insetInlineStart).toBeGreaterThanOrEqual(M);
        expect(p.insetBlockStart).toBeGreaterThanOrEqual(M);
        // ...and not off the FAR edge either, which the flip branch used to
        // allow for any anchor outside the viewport (#642)
        expect(p.insetInlineStart + 254).toBeLessThanOrEqual(CI.width - M);
        expect(p.insetBlockStart + 449).toBeLessThanOrEqual(CI.height - M);
      }
    }
  });

  it('honours an explicit margin', () => {
    const p = placeMenu({ x: 0, y: 0 }, { width: 10, height: 10 }, CI, { margin: 20 });
    expect(p).toMatchObject({ insetInlineStart: 20, insetBlockStart: 20 });
    expect(p.maxBlockSize).toBe(CI.height - 40);
  });
});

// `insetInlineStart` counts from the RIGHT edge under `dir="rtl"`, but
// `clientX` counts from the left in every writing mode. The rail fed one to the
// other, which put the menu a whole window-width away from the pointer. The
// mirror lives in `placeMenu` now, so these are the cases that pin it.
describe('placeMenu — right-to-left (#642)', () => {
  /** where the menu's physical left edge ends up, given a logical answer */
  const physicalLeft = (insetInlineStart: number, width: number, vpWidth: number): number =>
    vpWidth - insetInlineStart - width;

  it('opens AT the pointer, not mirrored across the window', () => {
    const p = placeMenu({ x: 800, y: 100 }, { width: 254, height: 100 }, CI, {
      direction: 'rtl',
    });
    // the bug: `insetInlineStart: 800` under rtl would have put the menu's
    // right edge 800px from the right, i.e. its left edge at 1008-800-254 = -46
    expect(physicalLeft(p.insetInlineStart, 254, CI.width)).toBeGreaterThanOrEqual(0);
    // and the menu's RIGHT edge sits on the pointer, the native RTL behaviour
    expect(physicalLeft(p.insetInlineStart, 254, CI.width) + 254).toBe(800);
  });

  it('grows away from the pointer in the reading direction (leftward)', () => {
    const p = placeMenu({ x: 800, y: 100 }, { width: 254, height: 100 }, CI, {
      direction: 'rtl',
    });
    expect(physicalLeft(p.insetInlineStart, 254, CI.width)).toBe(800 - 254);
  });

  it('flips to grow rightward when there is no room to the left of the pointer', () => {
    // 40px from the left edge cannot hold a 254px menu growing leftward
    const p = placeMenu({ x: 40, y: 100 }, { width: 254, height: 100 }, CI, {
      direction: 'rtl',
    });
    expect(physicalLeft(p.insetInlineStart, 254, CI.width)).toBe(40);
  });

  it('is the exact mirror of the ltr answer', () => {
    const size = { width: 254, height: 449 };
    for (const x of [0, 40, 142, 500, 800, 1000, 1008]) {
      const ltr = placeMenu({ x, y: 100 }, size, CI, { direction: 'ltr' });
      const rtl = placeMenu({ x: CI.width - x, y: 100 }, size, CI, { direction: 'rtl' });
      // same distance from the respective start edges, and the same block answer
      expect(rtl.insetInlineStart).toBe(ltr.insetInlineStart);
      expect(rtl.insetBlockStart).toBe(ltr.insetBlockStart);
    }
  });

  it('keeps the whole menu inside the window at either edge', () => {
    const size = { width: 254, height: 100 };
    for (const x of [-10, 0, 3, 127, 504, 900, 1005, 1008, 2000]) {
      const p = placeMenu({ x, y: 10 }, size, CI, { direction: 'rtl' });
      const left = physicalLeft(p.insetInlineStart, size.width, CI.width);
      expect(left).toBeGreaterThanOrEqual(M);
      expect(left + size.width).toBeLessThanOrEqual(CI.width - M);
    }
  });

  it('defaults to ltr when no direction is given, so existing callers are unmoved', () => {
    const bare = placeMenu({ x: 142, y: 217 }, { width: 254, height: 449 }, CI);
    const ltr = placeMenu({ x: 142, y: 217 }, { width: 254, height: 449 }, CI, {
      direction: 'ltr',
    });
    expect(bare).toEqual(ltr);
  });
});
