import { describe, it, expect } from 'vitest';
import { foldedGroups, toolbarNeed, TOOLBAR_SLACK_PX, type ToolbarFitInput } from './diff-toolbar-fit';

// Round numbers in the neighbourhood of what the panel measures on Windows:
// nav ~90, pop-out ~24, the toggles + Open file ~300, the layout pair ~110.
const BASE: Omit<ToolbarFitInput, 'room'> = {
  fixed: 90 + 24,
  fixedCount: 2,
  groups: [300, 110],
  more: 24,
  gap: 4,
  pathMin: 60,
};
const at = (room: number): number | null => foldedGroups({ ...BASE, room });

describe('the diff toolbar folds before it wraps (#1384)', () => {
  it('needs, with nothing folded: path floor + every group + the gaps between them', () => {
    // path, nav, toggles, layout, pop-out = 5 children, 4 gaps
    expect(toolbarNeed({ ...BASE, room: 0 }, 0)).toBe(60 + 114 + 300 + 110 + 4 * 4);
  });

  it('counts the "…" button, and its gap, only once something is folded', () => {
    // path, nav, layout, more, pop-out = 5 children
    expect(toolbarNeed({ ...BASE, room: 0 }, 1)).toBe(60 + 114 + 110 + 24 + 4 * 4);
  });

  it('a wide panel folds nothing', () => {
    expect(at(1200)).toBe(0);
  });

  it('folds the toggles first, then the layout pair', () => {
    const all = toolbarNeed({ ...BASE, room: 0 }, 0) + TOOLBAR_SLACK_PX;
    const one = toolbarNeed({ ...BASE, room: 0 }, 1) + TOOLBAR_SLACK_PX;
    expect(at(all)).toBe(0);
    expect(at(all - 1)).toBe(1);
    expect(at(one)).toBe(1);
    expect(at(one - 1)).toBe(2);
  });

  it('folds everything when even that does not fit — the path truncates further', () => {
    expect(at(150)).toBe(2);
  });

  it('keeps the slack: an exact fit is not a fit', () => {
    const exact = toolbarNeed({ ...BASE, room: 0 }, 0);
    expect(at(exact)).toBe(1);
  });

  it('answers nothing for a non-measurement (a hidden dockview tab is 0×0)', () => {
    expect(at(0)).toBeNull();
    expect(at(-5)).toBeNull();
    expect(at(Number.NaN)).toBeNull();
  });
});
