// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  DEFAULT_DIFF_LAYOUT,
  DIFF_LAYOUT_KEY,
  SIDE_BY_SIDE_MIN_WIDTH,
  effectiveDiffLayout,
  getDiffLayout,
  isTooNarrowForColumns,
  parseDiffLayout,
  setDiffLayout,
  subscribeDiffLayout,
  toggleDiffLayout,
} from './diff-layout';
import { loadUiState } from './ui-state';

// The preference lives in the workspace `ui` blob behind the preload bridge
// (P2-E15-06), never localStorage — so every test here starts from a known
// blob, the same harness theme.test.ts uses.
function stubBridge(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const state = { store: { ...initial } };
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: async () => state.store,
      setUi: (v: Record<string, unknown>) => {
        state.store = { ...v };
      },
    },
  };
  return state;
}

describe('diff layout preference (#532)', () => {
  describe('parseDiffLayout — a blob outlives the code that wrote it', () => {
    it('defaults to side by side, which is what the owner expected all along', () => {
      expect(DEFAULT_DIFF_LAYOUT).toBe('side-by-side');
      expect(parseDiffLayout(undefined)).toBe('side-by-side');
      expect(parseDiffLayout(null)).toBe('side-by-side');
    });

    it('reads the two values it writes', () => {
      expect(parseDiffLayout('inline')).toBe('inline');
      expect(parseDiffLayout('side-by-side')).toBe('side-by-side');
    });

    it('falls back rather than throwing on anything else', () => {
      // a removed value, a renamed one, a half-written file, a future version
      for (const junk of [42, {}, [], 'sideBySide', 'INLINE', '', true]) {
        expect(parseDiffLayout(junk)).toBe('side-by-side');
      }
    });
  });

  describe('isTooNarrowForColumns — the width rule, which used to be invisible', () => {
    it('leaves a normal-width pane alone', () => {
      expect(isTooNarrowForColumns(800)).toBe(false);
      expect(isTooNarrowForColumns(SIDE_BY_SIDE_MIN_WIDTH)).toBe(false);
    });

    it('fires only where two columns cannot carry code', () => {
      expect(isTooNarrowForColumns(SIDE_BY_SIDE_MIN_WIDTH - 1)).toBe(true);
      expect(isTooNarrowForColumns(200)).toBe(true);
    });

    it('leaves the width a Changes tab actually opens at alone', () => {
      // THE regression pin for #532. A Changes tab opened from the rail in a
      // default 1280px window measures 506px (probed in the real app), and
      // Monaco's own 900px breakpoint is what silently forced it inline — so a
      // threshold that fires at 506 is the bug, whoever wrote it.
      expect(SIDE_BY_SIDE_MIN_WIDTH).toBeLessThan(506);
      expect(isTooNarrowForColumns(506)).toBe(false);
    });

    it('treats a non-measurement as no verdict at all', () => {
      // 0 is BOTH the first render before the ResizeObserver has spoken and
      // every frame a dockview tab spends hidden (`display: none` observes
      // 0×0). Answering `true` would flash one column on mount and two on the
      // way back into a narrow tab.
      expect(isTooNarrowForColumns(0)).toBe(false);
      expect(isTooNarrowForColumns(-1)).toBe(false);
    });
  });

  describe('effectiveDiffLayout — preference and verdict together', () => {
    it('gives two columns when the preference asks and the pane can', () => {
      expect(effectiveDiffLayout('side-by-side', false)).toBe('side-by-side');
    });

    it('falls back on a pane that cannot', () => {
      expect(effectiveDiffLayout('side-by-side', true)).toBe('inline');
    });

    it('never widens an explicit inline choice back out', () => {
      expect(effectiveDiffLayout('inline', false)).toBe('inline');
      expect(effectiveDiffLayout('inline', true)).toBe('inline');
    });
  });

  describe('persistence through the ui blob', () => {
    let bridge: { store: Record<string, unknown> };
    // the listener set is module-level, so a case that subscribes and walks
    // away would leave a spy listening to every case after it
    let cleanups: Array<() => void> = [];
    const sub = (fn: () => void): (() => void) => {
      const off = subscribeDiffLayout(fn);
      cleanups.push(off);
      return off;
    };

    beforeEach(async () => {
      bridge = stubBridge();
      await loadUiState();
    });

    afterEach(() => {
      for (const off of cleanups) off();
      cleanups = [];
    });

    it('an untold workspace reads side by side', () => {
      expect(getDiffLayout()).toBe('side-by-side');
    });

    it('writes the choice under its own key', () => {
      setDiffLayout('inline');
      expect(bridge.store[DIFF_LAYOUT_KEY]).toBe('inline');
      expect(getDiffLayout()).toBe('inline');
    });

    it('round-trips a stored choice across a reload', async () => {
      setDiffLayout('inline');
      // a relaunch: fresh cache, same blob
      const persisted = { ...bridge.store };
      bridge = stubBridge(persisted);
      await loadUiState();
      expect(getDiffLayout()).toBe('inline');
    });

    it('toggles both ways', () => {
      expect(toggleDiffLayout()).toBe('inline');
      expect(getDiffLayout()).toBe('inline');
      expect(toggleDiffLayout()).toBe('side-by-side');
      expect(getDiffLayout()).toBe('side-by-side');
    });

    it('tells every mounted pane, and the palette, at once', () => {
      // N DiffPanes are mounted at a time (one per open Changes tab, plus any
      // in popped-out windows) and they all read this one value
      const a = vi.fn();
      const b = vi.fn();
      const offA = sub(a);
      sub(b);

      setDiffLayout('inline');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      offA();
      setDiffLayout('side-by-side');
      expect(a).toHaveBeenCalledTimes(1); // unsubscribed
      expect(b).toHaveBeenCalledTimes(2);
    });

    it('says nothing when the value did not change', () => {
      const seen = vi.fn();
      sub(seen);
      setDiffLayout('side-by-side'); // already the default
      expect(seen).not.toHaveBeenCalled();
    });

    it('a throwing subscriber costs its own update, not everyone’s', () => {
      const bad = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      sub(bad);
      sub(good);
      expect(() => setDiffLayout('inline')).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });
  });
});
