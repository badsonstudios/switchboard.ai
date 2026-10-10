// The workspace-edge drop (#731): wide along the sides, narrow along the top
// and bottom. The numbers are the ones the real-app probe measured.
import { describe, it, expect } from 'vitest';
import { ROOT_EDGE_DROP, ROOT_EDGE_NARROW_PX, rootEdgeDropAllowed } from './root-edge-drop';

/** the workspace as measured in the probe */
const DOCK = { left: 298, top: 47, right: 1254, bottom: 691 };
const midY = (DOCK.top + DOCK.bottom) / 2;
const midX = (DOCK.left + DOCK.right) / 2;

describe('what the docking library is told', () => {
  it('the edge zone is deep enough to find: 40px, not the 10 it ships with', () => {
    expect(ROOT_EDGE_DROP.activationSize).toEqual({ type: 'pixels', value: 40 });
  });

  it('the marker is a share of the workspace, so it reads as a column and not a sliver', () => {
    expect(ROOT_EDGE_DROP.size.type).toBe('percentage');
    expect(ROOT_EDGE_DROP.size.value).toBeGreaterThanOrEqual(20);
  });
});

describe('rootEdgeDropAllowed', () => {
  it('left and right: anywhere the library offers it (the whole widened zone)', () => {
    for (const inset of [1, 8, 12, 30, 39]) {
      expect(rootEdgeDropAllowed('left', { x: DOCK.left + inset, y: midY }, DOCK)).toBe(true);
      expect(rootEdgeDropAllowed('right', { x: DOCK.right - inset, y: midY }, DOCK)).toBe(true);
    }
  });

  it('⚠️ top: only the narrow band, so a row of tabs under it still takes a dropped tab', () => {
    // a tab's middle is about 17px below the top edge; the widened zone would
    // have covered it and the tab row would never see the drag
    expect(rootEdgeDropAllowed('top', { x: midX, y: DOCK.top + 4 }, DOCK)).toBe(true);
    expect(rootEdgeDropAllowed('top', { x: midX, y: DOCK.top + ROOT_EDGE_NARROW_PX }, DOCK)).toBe(true);
    expect(rootEdgeDropAllowed('top', { x: midX, y: DOCK.top + ROOT_EDGE_NARROW_PX + 1 }, DOCK)).toBe(false);
    expect(rootEdgeDropAllowed('top', { x: midX, y: DOCK.top + 17 }, DOCK)).toBe(false);
    expect(rootEdgeDropAllowed('top', { x: midX, y: DOCK.top + 39 }, DOCK)).toBe(false);
  });

  it('⚠️ left and right are narrow too OVER A ROW OF TABS: "before the first tab" is a drop in that corner', () => {
    const y = DOCK.top + 17;
    expect(rootEdgeDropAllowed('left', { x: DOCK.left + 25, y }, DOCK, true)).toBe(false);
    expect(rootEdgeDropAllowed('left', { x: DOCK.left + 6, y }, DOCK, true)).toBe(true);
    expect(rootEdgeDropAllowed('right', { x: DOCK.right - 25, y }, DOCK, true)).toBe(false);
    expect(rootEdgeDropAllowed('right', { x: DOCK.right - 6, y }, DOCK, true)).toBe(true);
    // and off the tab row, the same 25px is well inside the wide zone
    expect(rootEdgeDropAllowed('left', { x: DOCK.left + 25, y: midY }, DOCK, false)).toBe(true);
  });

  it('bottom: the same narrow band, measured from the bottom', () => {
    expect(rootEdgeDropAllowed('bottom', { x: midX, y: DOCK.bottom - 4 }, DOCK)).toBe(true);
    expect(rootEdgeDropAllowed('bottom', { x: midX, y: DOCK.bottom - ROOT_EDGE_NARROW_PX - 1 }, DOCK)).toBe(false);
  });

  it('the narrow band is the library’s own old default, so top and bottom are exactly as they were', () => {
    expect(ROOT_EDGE_NARROW_PX).toBe(10);
  });

  it('a centre drop (an empty workspace) is never refused here', () => {
    expect(rootEdgeDropAllowed('center', { x: midX, y: midY }, DOCK)).toBe(true);
  });
});
