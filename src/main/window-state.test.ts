import { describe, it, expect, vi } from 'vitest';

// mergeState/isOnAnyDisplay are pure; mock the electron import surface.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: class {},
}));

import {
  mergeState,
  isOnAnyDisplay,
  rememberArrangement,
  decideDisplayRestore,
  planDisplayRestore,
  MAX_REMEMBERED_ARRANGEMENTS,
  ArrangementMemories,
} from './window-state';

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

describe('per-arrangement memory (#864: the monitor-sleep shuffle)', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const deskFp = 'desk-two-monitors';
  const laptopFp = 'laptop-alone';
  const onLeft = { x: -1800, y: 50, width: 800, height: 600 };
  const shoved = { x: 100, y: 100, width: 800, height: 600 };

  const desk = (): ArrangementMemories =>
    rememberArrangement({}, deskFp, { bounds: onLeft, isMaximized: false });

  it('remembers bounds under the arrangement they were earned on', () => {
    expect(desk()[deskFp].bounds).toEqual(onLeft);
  });

  it('copies the bounds in — a later caller mutation cannot reach the memory', () => {
    const movable = { ...onLeft };
    const mem = rememberArrangement({}, deskFp, { bounds: movable, isMaximized: false });
    movable.x = 12345;
    expect(mem[deskFp].bounds.x).toBe(onLeft.x);
  });

  it('a save made while one monitor is asleep cannot touch the other note', () => {
    // exactly the bug: the window is shoved to the primary and saved there
    const mem = rememberArrangement(desk(), laptopFp, { bounds: shoved, isMaximized: false });
    expect(mem[deskFp].bounds).toEqual(onLeft); // the desk note is untouched
    expect(mem[laptopFp].bounds).toEqual(shoved);
  });

  it('evicts the oldest arrangement past the cap, keeping the newest', () => {
    let mem: ArrangementMemories = {};
    for (let i = 0; i < MAX_REMEMBERED_ARRANGEMENTS + 2; i++) {
      mem = rememberArrangement(mem, `fp-${i}`, { bounds: onLeft, isMaximized: false });
    }
    expect(Object.keys(mem)).toHaveLength(MAX_REMEMBERED_ARRANGEMENTS);
    expect(mem['fp-0']).toBeUndefined();
    expect(mem[`fp-${MAX_REMEMBERED_ARRANGEMENTS + 1}`]).toBeDefined();
  });

  // The previous version of this test re-added the desk immediately after each
  // new arrangement, so the desk was evicted and silently RECREATED inside the
  // same iteration — it passed under FIFO and proved nothing. This one fills to
  // the cap first, touches the desk once, and then forces exactly one eviction.
  it('a re-recorded arrangement is refreshed, not left to age out (LRU, not FIFO)', () => {
    let mem = desk(); // the desk is the OLDEST key
    for (let i = 0; i < MAX_REMEMBERED_ARRANGEMENTS - 1; i++) {
      mem = rememberArrangement(mem, `fp-${i}`, { bounds: shoved, isMaximized: false });
    }
    expect(Object.keys(mem)).toHaveLength(MAX_REMEMBERED_ARRANGEMENTS); // full

    // a day at the desk: every move rewrites that one note
    mem = rememberArrangement(mem, deskFp, { bounds: onLeft, isMaximized: false });
    // one brand-new arrangement must now evict the least-recently-USED key
    mem = rememberArrangement(mem, 'brand-new', { bounds: shoved, isMaximized: false });

    expect(mem[deskFp]).toBeDefined(); // used a moment ago — survives
    expect(mem['fp-0']).toBeUndefined(); // untouched longest — goes
    expect(Object.keys(mem)).toHaveLength(MAX_REMEMBERED_ARRANGEMENTS);
  });

  it('refreshing keeps the newest bounds, not the ones first recorded', () => {
    const moved = { x: -1700, y: 80, width: 900, height: 700 };
    const mem = rememberArrangement(desk(), deskFp, { bounds: moved, isMaximized: false });
    expect(mem[deskFp].bounds).toEqual(moved);
    expect(Object.keys(mem)).toHaveLength(1); // refreshed, not duplicated
  });

  it('restores to the remembered monitor when that arrangement returns', () => {
    const back = decideDisplayRestore({
      memories: desk(),
      fingerprint: deskFp,
      currentBounds: shoved, // where the OS left it
      workAreas: [primary, left],
    });
    expect(back?.bounds).toEqual(onLeft);
  });

  it('carries the maximized state back with the position', () => {
    const back = decideDisplayRestore({
      memories: rememberArrangement({}, deskFp, { bounds: onLeft, isMaximized: true }),
      fingerprint: deskFp,
      currentBounds: shoved,
      workAreas: [primary, left],
    });
    expect(back?.isMaximized).toBe(true);
  });

  it('leaves an arrangement it has never seen alone (the projector case)', () => {
    const back = decideDisplayRestore({
      memories: desk(),
      fingerprint: 'a-projector-in-a-meeting-room',
      currentBounds: shoved,
      workAreas: [primary, left],
    });
    expect(back).toBeNull();
  });

  it('does not move a window that is already where it belongs', () => {
    const back = decideDisplayRestore({
      memories: desk(),
      fingerprint: deskFp,
      currentBounds: { ...onLeft, x: onLeft.x + 1 }, // a rounded pixel, not a move
      workAreas: [primary, left],
    });
    expect(back).toBeNull();
  });

  it('refuses to restore onto bounds no current display can show', () => {
    const back = decideDisplayRestore({
      memories: desk(),
      fingerprint: deskFp, // a fingerprint we know, but the display really is gone
      currentBounds: shoved,
      workAreas: [primary],
    });
    expect(back).toBeNull();
  });

  it('hands back a copy — the caller cannot edit the memory through it', () => {
    const memories = desk();
    const back = decideDisplayRestore({
      memories,
      fingerprint: deskFp,
      currentBounds: shoved,
      workAreas: [primary, left],
    })!;
    back.bounds.x = 999;
    expect(memories[deskFp].bounds.x).toBe(onLeft.x);
  });
});

// The maximize dance is the part that can only be got wrong on real hardware,
// so it is decided here rather than in the main process: CI has one display and
// no way to detach it, but it can do arithmetic on rectangles all day.
describe('planDisplayRestore (#864: the maximize dance, decided on CI)', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const areas = [primary, left];
  const deskFp = 'desk';
  const onLeft = { x: -1800, y: 50, width: 800, height: 600 };
  const shoved = { x: 100, y: 100, width: 800, height: 600 };
  const memories = (isMaximized = false): ArrangementMemories =>
    rememberArrangement({}, deskFp, { bounds: onLeft, isMaximized });

  const plan = (over: Partial<Parameters<typeof planDisplayRestore>[0]> = {}) =>
    planDisplayRestore({
      memories: memories(),
      fingerprint: deskFp,
      currentBounds: shoved,
      workAreas: areas,
      isMaximized: false,
      ...over,
    });

  it('a plain move touches neither maximize verb', () => {
    expect(plan()).toEqual({ bounds: onLeft, unmaximizeFirst: false, maximizeAfter: false });
  });

  it('drops out of maximize first — setBounds on a maximized window is ignored', () => {
    expect(plan({ isMaximized: true })?.unmaximizeFirst).toBe(true);
  });

  it('re-maximizes on the far monitor when that is how it was left', () => {
    const p = plan({ memories: memories(true), isMaximized: false });
    expect(p).toMatchObject({ bounds: onLeft, maximizeAfter: true });
  });

  it('does NOT flicker a window already maximized on the target display', () => {
    // same display as the remembered note, just a different normal rect
    expect(
      plan({
        memories: memories(true),
        isMaximized: true,
        currentBounds: { x: -1700, y: 80, width: 900, height: 700 },
      })
    ).toBeNull();
  });

  it('still moves a maximized window that is maximized on the WRONG display', () => {
    expect(plan({ memories: memories(true), isMaximized: true, currentBounds: shoved })).toMatchObject({
      bounds: onLeft,
      unmaximizeFirst: true,
      maximizeAfter: true,
    });
  });

  it('passes the refusals straight through — an unknown arrangement plans nothing', () => {
    expect(plan({ fingerprint: 'a-projector' })).toBeNull();
    expect(plan({ workAreas: [primary] })).toBeNull(); // remembered display really gone
  });
});
