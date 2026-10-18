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
  TITLE_BAR_SLACK_PX,
  clampIntoArrangement,
  looksLikeBootRescue,
  metricsChangeRestores,
  rescueOffscreen,
  titleBarReachable,
  workAreasOfFingerprint,
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

// #1277 — the clamp. `isOnAnyDisplay` asks "is a usable chunk visible?", and
// the owner's log had a restore to `-2296,-21` that passed it: most of the
// window was on a monitor, the title bar was not. A remembered rectangle is now
// SLID back within reach (size kept) when its title bar is not on a work area.
describe('titleBarReachable / clampIntoArrangement (#1277: the clamp)', () => {
  const primary = { x: 0, y: 0, width: 2560, height: 1392 };
  const left = { x: -2560, y: 0, width: 2560, height: 1392 };

  it('accepts a window flush to an edge, invisible frame and all', () => {
    expect(titleBarReachable({ x: -7, y: 0, width: 1200, height: 800 }, [primary])).toBe(true);
    expect(titleBarReachable({ x: 100, y: -TITLE_BAR_SLACK_PX, width: 1200, height: 800 }, [primary])).toBe(true);
  });

  it('refuses a title bar hanging off the top of the screen', () => {
    const owner = { x: -2296, y: -21, width: 1996, height: 674 };
    expect(isOnAnyDisplay(owner, [primary, left])).toBe(true); // what used to let it through
    expect(titleBarReachable(owner, [primary, left])).toBe(false);
  });

  it('...and SLIDES it back within reach, keeping its size', () => {
    const owner = { x: -2296, y: -21, width: 1996, height: 674 };
    expect(clampIntoArrangement(owner, [primary, left])).toEqual({ x: -2296, y: 0, width: 1996, height: 674 });
  });

  // review: the corner is the wrong test for both of these
  it('a window pushed half off the left edge keeps its place', () => {
    const halfOff = { x: -600, y: 100, width: 1200, height: 800 };
    expect(clampIntoArrangement(halfOff, [primary])).toEqual(halfOff);
  });

  it('a window spanning offset monitors keeps its place when its title bar is on the taller one', () => {
    const lowLeft = { x: -1920, y: 360, width: 1920, height: 1040 };
    const spanning = { x: -500, y: 100, width: 1400, height: 700 };
    expect(clampIntoArrangement(spanning, [primary, lowLeft])).toEqual(spanning);
  });

  it('a rectangle not on any attached display has nowhere to go', () => {
    expect(clampIntoArrangement({ x: -2296, y: 0, width: 1996, height: 684 }, [primary])).toBeNull();
  });

  it('a window bigger than the monitor it lands on is shrunk to fit', () => {
    const huge = { x: 100, y: -200, width: 3000, height: 2000 };
    expect(clampIntoArrangement(huge, [primary])).toEqual({ x: 0, y: 0, width: 2560, height: 1392 });
  });
});

describe('looksLikeBootRescue (#1277: the 640,296 1280x800 note)', () => {
  const primary = { x: 0, y: 0, width: 2560, height: 1392 };
  it('recognises exactly the default size centred on a work area', () => {
    expect(looksLikeBootRescue({ x: 640, y: 296, width: 1280, height: 800 }, [primary])).toBe(true);
  });
  it('anything the user moved or resized is theirs', () => {
    expect(looksLikeBootRescue({ x: 650, y: 296, width: 1280, height: 800 }, [primary])).toBe(false);
    expect(looksLikeBootRescue({ x: 640, y: 296, width: 1281, height: 800 }, [primary])).toBe(false);
  });
});

describe('workAreasOfFingerprint (#1277: a note can be checked against its own key)', () => {
  it('reads back exactly what displayFingerprint wrote', () => {
    expect(workAreasOfFingerprint('-2560,0,2560,1392|0,0,2560,1392')).toEqual([
      { x: -2560, y: 0, width: 2560, height: 1392 },
      { x: 0, y: 0, width: 2560, height: 1392 },
    ]);
  });

  it('has no opinion about anything else', () => {
    for (const junk of ['', 'fp', 'desk-two-monitors', '1,2,3', '1,2,3,x', '0,0,1,1|nope']) {
      expect(workAreasOfFingerprint(junk)).toBeNull();
    }
  });
});

describe('metricsChangeRestores (#1277: the second writer)', () => {
  it('a taskbar change alone never restores; it was the second half of every wake', () => {
    expect(metricsChangeRestores(['workArea'])).toBe(false);
  });
  it('the empty list Electron sends at every boot restores nothing', () => {
    expect(metricsChangeRestores([])).toBe(false);
    expect(metricsChangeRestores(undefined)).toBe(false);
  });
  it('a resolution, scale or rotation change still does', () => {
    expect(metricsChangeRestores(['bounds', 'workArea'])).toBe(true);
    expect(metricsChangeRestores(['scaleFactor'])).toBe(true);
    expect(metricsChangeRestores(['rotation'])).toBe(true);
  });
});

describe('rescueOffscreen (#1277: no note, and nowhere anyone can see)', () => {
  const primary = { x: 0, y: 0, width: 2560, height: 1392 };
  it('brings an off-screen window to the primary, centred, size kept', () => {
    expect(rescueOffscreen({ x: -2296, y: 0, width: 1996, height: 684 }, [primary], primary)).toEqual({
      bounds: { x: 282, y: 354, width: 1996, height: 684 },
      how: 'centred',
    });
  });
  it('leaves a visible window alone', () => {
    expect(rescueOffscreen({ x: 100, y: 100, width: 800, height: 600 }, [primary], primary)).toBeNull();
  });
  it('slides a visible window whose title bar is out of reach back where it is, not to the centre', () => {
    // mostly on screen, title bar 200 px above the top of the work area
    expect(rescueOffscreen({ x: 300, y: -200, width: 1000, height: 700 }, [primary], primary)).toEqual({
      bounds: { x: 300, y: 0, width: 1000, height: 700 },
      how: 'clamped',
    });
  });
  it('does nothing with no display attached at all', () => {
    expect(rescueOffscreen({ x: -9000, y: 0, width: 800, height: 600 }, [], primary)).toBeNull();
  });
});

describe('the runtime restore clamps or refuses, and says which (#1277)', () => {
  const primary = { x: 0, y: 0, width: 2560, height: 1392 };
  const left = { x: -2560, y: 0, width: 2560, height: 1392 };
  const fp = 'desk';

  it('a note whose title bar is off the screen is slid back within reach', () => {
    const clamped: string[] = [];
    const p = planDisplayRestore({
      memories: { [fp]: { bounds: { x: -2296, y: -21, width: 1996, height: 674 }, isMaximized: false } },
      fingerprint: fp,
      currentBounds: { x: 640, y: 296, width: 1280, height: 800 },
      workAreas: [primary, left],
      isMaximized: false,
      onClamped: (_from, to) => clamped.push(`${to.x},${to.y}`),
    });
    expect(p?.bounds).toEqual({ x: -2296, y: 0, width: 1996, height: 674 });
    expect(clamped).toEqual(['-2296,0']);
  });

  it('a note on a monitor that is gone is refused with its reason', () => {
    const refused: string[] = [];
    decideDisplayRestore({
      memories: { [fp]: { bounds: { x: -2296, y: 0, width: 1996, height: 684 }, isMaximized: true } },
      fingerprint: fp,
      currentBounds: { x: 0, y: 0, width: 1200, height: 800 },
      workAreas: [primary],
      onRefused: (why) => refused.push(why),
    });
    expect(refused).toEqual(['not visible on any attached display']);
  });

  it("the boot rescue default is never restored to (the owner's second restore)", () => {
    const refused: string[] = [];
    const p = decideDisplayRestore({
      memories: { [fp]: { bounds: { x: 640, y: 296, width: 1280, height: 800 }, isMaximized: true } },
      fingerprint: fp,
      currentBounds: { x: -2296, y: 0, width: 1996, height: 684 },
      workAreas: [primary, left],
      onRefused: (why) => refused.push(why),
    });
    expect(p).toBeNull();
    expect(refused).toEqual(['it is the boot-time default position, not one anybody chose']);
  });

  it('no note, or already there, is ordinary and reports nothing', () => {
    const onRefused = vi.fn();
    const onClamped = vi.fn();
    const here = { x: 100, y: 100, width: 1200, height: 800 };
    decideDisplayRestore({ memories: {}, fingerprint: fp, currentBounds: here, workAreas: [primary], onRefused, onClamped });
    decideDisplayRestore({
      memories: { [fp]: { bounds: here, isMaximized: false } },
      fingerprint: fp,
      currentBounds: here,
      workAreas: [primary],
      onRefused,
      onClamped,
    });
    expect(onRefused).not.toHaveBeenCalled();
    expect(onClamped).not.toHaveBeenCalled();
  });
});
