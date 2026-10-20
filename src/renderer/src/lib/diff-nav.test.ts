import { describe, it, expect } from 'vitest';
import { changeSpan, diffNavKey, diffNavState, sameDiffNavState } from './diff-nav';

// `getLineChanges()`'s public shape. A modification of lines 3–4, an insertion
// of line 8, and a deletion between lines 12 and 13 of the modified side.
const MOD = { modifiedStartLineNumber: 3, modifiedEndLineNumber: 4 };
const INS = { modifiedStartLineNumber: 8, modifiedEndLineNumber: 8 };
const DEL = { modifiedStartLineNumber: 12, modifiedEndLineNumber: 0 };
const ALL = [MOD, INS, DEL];

describe('the diff counter (#1384)', () => {
  describe('changeSpan — where goToDiff lands', () => {
    it('a modification spans its own lines', () => {
      expect(changeSpan(MOD, 50)).toEqual({ from: 3, to: 4 });
    });

    it('a DELETION lands on the line after the hole, as goToDiff puts the cursor there', () => {
      // `getLineChanges` says "after line 12"; `goToDiff` reads the internal
      // range and sets the cursor to 13. Counting from 12 would say "not on a
      // change" right after ↓ put the reader on one.
      expect(changeSpan(DEL, 50)).toEqual({ from: 13, to: 13 });
    });

    it('a deletion at the end of the file clamps to the last line, as setPosition does', () => {
      expect(changeSpan({ modifiedStartLineNumber: 20, modifiedEndLineNumber: 0 }, 20)).toEqual({
        from: 20,
        to: 20,
      });
    });

    it('a deletion at the very top lands on line 1', () => {
      expect(changeSpan({ modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }, 20)).toEqual({
        from: 1,
        to: 1,
      });
    });
  });

  describe('diffNavState', () => {
    it('says "pending" while the worker has not answered — never "no changes"', () => {
      expect(diffNavState(null, 1, 10)).toEqual({ kind: 'pending' });
    });

    it('says "none" for a computed, identical diff', () => {
      expect(diffNavState([], 1, 10)).toEqual({ kind: 'none' });
    });

    it('counts the changes and finds the one under the cursor (1-based)', () => {
      expect(diffNavState(ALL, 3, 50)).toEqual({ kind: 'changes', total: 3, index: 1 });
      expect(diffNavState(ALL, 4, 50)).toEqual({ kind: 'changes', total: 3, index: 1 });
      expect(diffNavState(ALL, 8, 50)).toEqual({ kind: 'changes', total: 3, index: 2 });
      expect(diffNavState(ALL, 13, 50)).toEqual({ kind: 'changes', total: 3, index: 3 });
    });

    it('a cursor between changes has no index — the counter shows the total', () => {
      expect(diffNavState(ALL, 1, 50)).toEqual({ kind: 'changes', total: 3, index: null });
      expect(diffNavState(ALL, 6, 50)).toEqual({ kind: 'changes', total: 3, index: null });
    });
  });

  it('sameDiffNavState lets a cursor move inside one change re-render nothing', () => {
    expect(
      sameDiffNavState({ kind: 'changes', total: 3, index: 1 }, { kind: 'changes', total: 3, index: 1 })
    ).toBe(true);
    expect(
      sameDiffNavState({ kind: 'changes', total: 3, index: 1 }, { kind: 'changes', total: 3, index: 2 })
    ).toBe(false);
    expect(sameDiffNavState({ kind: 'pending' }, { kind: 'none' })).toBe(false);
    expect(sameDiffNavState({ kind: 'none' }, { kind: 'none' })).toBe(true);
  });

  describe('diffNavKey — VS Code’s chord', () => {
    const k = (over: Partial<Parameters<typeof diffNavKey>[0]>): ReturnType<typeof diffNavKey> =>
      diffNavKey({ key: 'F5', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...over });

    it('Alt+F5 is next, Shift+Alt+F5 is previous', () => {
      expect(k({ altKey: true })).toBe('next');
      expect(k({ altKey: true, shiftKey: true })).toBe('previous');
    });

    it('leaves every other chord alone', () => {
      expect(k({})).toBeNull(); // plain F5
      expect(k({ shiftKey: true })).toBeNull();
      expect(k({ altKey: true, ctrlKey: true })).toBeNull();
      expect(k({ altKey: true, metaKey: true })).toBeNull();
      expect(k({ key: 'F6', altKey: true })).toBeNull();
    });
  });
});
