// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  DIFF_VIEW_DEFAULTS,
  DIFF_VIEW_KEYS,
  DIFF_VIEW_TOGGLES,
  getDiffViewToggle,
  monacoDiffViewOptions,
  parseDiffViewToggle,
  setDiffViewToggle,
  subscribeDiffViewPrefs,
  toggleDiffViewToggle,
} from './diff-view-prefs';
import { loadUiState } from './ui-state';

// Same harness as `diff-layout.test.ts`: the prefs live in the workspace `ui`
// blob behind the preload bridge, never localStorage.
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

describe('diff view toggles (#1384)', () => {
  describe('defaults — what every diff showed before the toggles existed', () => {
    it('ignores whitespace, because that is Monaco’s default and therefore today’s diff', () => {
      expect(DIFF_VIEW_DEFAULTS.ignoreWhitespace).toBe(true);
    });

    it('collapses nothing and wraps nothing', () => {
      expect(DIFF_VIEW_DEFAULTS.collapseUnchanged).toBe(false);
      expect(DIFF_VIEW_DEFAULTS.wordWrap).toBe(false);
    });

    it('has a distinct key per toggle, so one never reads another’s value', () => {
      const keys = DIFF_VIEW_TOGGLES.map((w) => DIFF_VIEW_KEYS[w]);
      expect(new Set(keys).size).toBe(keys.length);
      // and none of them collides with the layout toggle's key
      expect(keys).not.toContain('diffLayout');
    });
  });

  describe('parseDiffViewToggle — a blob outlives the code that wrote it', () => {
    it('reads real booleans', () => {
      expect(parseDiffViewToggle('wordWrap', true)).toBe(true);
      expect(parseDiffViewToggle('ignoreWhitespace', false)).toBe(false);
    });

    it('falls back to the default on anything else', () => {
      for (const junk of [undefined, null, 'true', 1, 0, {}, []]) {
        expect(parseDiffViewToggle('ignoreWhitespace', junk)).toBe(true);
        expect(parseDiffViewToggle('collapseUnchanged', junk)).toBe(false);
      }
    });
  });

  describe('monacoDiffViewOptions — the mapping onto the diff editor', () => {
    it('uses the diff editor’s own switches', () => {
      expect(
        monacoDiffViewOptions({ ignoreWhitespace: false, collapseUnchanged: true, wordWrap: true })
      ).toEqual({
        ignoreTrimWhitespace: false,
        hideUnchangedRegions: { enabled: true },
        diffWordWrap: 'on',
      });
    });

    it('says "off" for word wrap rather than inheriting', () => {
      // `inherit` would read the editor's own `wordWrap`, which is a second
      // place the answer could come from
      expect(
        monacoDiffViewOptions({ ignoreWhitespace: true, collapseUnchanged: false, wordWrap: false })
          .diffWordWrap
      ).toBe('off');
    });
  });

  describe('persistence through the ui blob', () => {
    let bridge: { store: Record<string, unknown> };
    let cleanups: Array<() => void> = [];

    beforeEach(async () => {
      bridge = stubBridge();
      await loadUiState();
    });

    afterEach(() => {
      for (const off of cleanups) off();
      cleanups = [];
    });

    it('an untold workspace reads the defaults', () => {
      for (const w of DIFF_VIEW_TOGGLES) expect(getDiffViewToggle(w)).toBe(DIFF_VIEW_DEFAULTS[w]);
    });

    it('writes each toggle under its own key and reads it back', () => {
      setDiffViewToggle('wordWrap', true);
      expect(bridge.store[DIFF_VIEW_KEYS.wordWrap]).toBe(true);
      expect(getDiffViewToggle('wordWrap')).toBe(true);
      // the others are untouched
      expect(getDiffViewToggle('collapseUnchanged')).toBe(false);
      expect(getDiffViewToggle('ignoreWhitespace')).toBe(true);
    });

    it('survives a relaunch', async () => {
      bridge = stubBridge({ [DIFF_VIEW_KEYS.ignoreWhitespace]: false });
      await loadUiState();
      expect(getDiffViewToggle('ignoreWhitespace')).toBe(false);
    });

    it('toggle flips and announces; a no-op write announces nothing', () => {
      const spy = vi.fn();
      cleanups.push(subscribeDiffViewPrefs(spy));
      expect(toggleDiffViewToggle('collapseUnchanged')).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      setDiffViewToggle('collapseUnchanged', true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a throwing subscriber costs only its own update', () => {
      const good = vi.fn();
      cleanups.push(
        subscribeDiffViewPrefs(() => {
          throw new Error('bad');
        })
      );
      cleanups.push(subscribeDiffViewPrefs(good));
      expect(() => setDiffViewToggle('wordWrap', true)).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });
  });
});
