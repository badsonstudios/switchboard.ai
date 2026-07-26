import { describe, it, expect } from 'vitest';
import { groupIdFromFrameName, patchPopoutPositions, resolvePopoutBounds } from './popout-geometry';

const box = (left: number, top: number, width = 600, height = 400) => ({ left, top, width, height });

describe('patchPopoutPositions (#86 — main process has the last word)', () => {
  const grouped = (id: string, position = box(0, 0)) => ({ position, data: { id, views: [] } });

  it('stamps live geometry over the stored positions, matched by group id', () => {
    const layout = { grid: { anything: true }, popoutGroups: [grouped('g1'), grouped('g2')] };
    const out = patchPopoutPositions(layout, [
      { groupId: 'g2', box: box(500, 40) },
      { groupId: 'g1', box: box(-1900, 300) },
    ]) as typeof layout;
    // deliberately handed in the WRONG order: identity wins over position
    expect(out.popoutGroups[0].position).toEqual(box(-1900, 300));
    expect(out.popoutGroups[1].position).toEqual(box(500, 40));
    expect(out.grid).toEqual({ anything: true }); // nothing else touched
  });

  it('never swaps two popouts when the lists are ordered differently', () => {
    // dockview registers a popout when its window finishes LOADING, we see it
    // when it OPENS — a slow first load inverts the two lists
    const layout = { popoutGroups: [grouped('slow', box(1, 1)), grouped('fast', box(2, 2))] };
    const out = patchPopoutPositions(layout, [
      { groupId: 'fast', box: box(900, 90) },
      { groupId: 'slow', box: box(100, 10) },
    ]) as typeof layout;
    expect(out.popoutGroups[0].position).toEqual(box(100, 10));
    expect(out.popoutGroups[1].position).toEqual(box(900, 90));
  });

  it('falls back to order only when no ids match AND the counts agree', () => {
    const layout = { popoutGroups: [{ position: box(10, 10) }, { position: box(20, 20) }] };
    const ordered = patchPopoutPositions(layout, [
      { box: box(1, 1) },
      { box: box(2, 2) },
    ]) as typeof layout;
    expect(ordered.popoutGroups[0].position).toEqual(box(1, 1));

    // counts disagree: we cannot know which is which, so change nothing
    const bailed = patchPopoutPositions(layout, [{ box: box(99, 99) }]) as typeof layout;
    expect(bailed.popoutGroups[0].position).toEqual(box(10, 10));
    expect(bailed.popoutGroups[1].position).toEqual(box(20, 20));
  });

  it('leaves an unmatched group alone — stale beats wrong', () => {
    const layout = { popoutGroups: [grouped('g1', box(10, 10)), grouped('g2', box(20, 20))] };
    const out = patchPopoutPositions(layout, [{ groupId: 'g1', box: box(99, 99) }]) as typeof layout;
    expect(out.popoutGroups[0].position).toEqual(box(99, 99));
    expect(out.popoutGroups[1].position).toEqual(box(20, 20));
  });

  it('refuses junk geometry from a minimized or zero-size window', () => {
    const layout = { popoutGroups: [grouped('g1', box(10, 10))] };
    const out = patchPopoutPositions(layout, [
      { groupId: 'g1', box: box(0, 0, 0, 0) },
    ]) as typeof layout;
    expect(out.popoutGroups[0].position).toEqual(box(10, 10));
  });

  it('is a no-op on a layout with no popouts, and on junk input', () => {
    expect(patchPopoutPositions({ grid: 1 }, [{ box: box(1, 1) }])).toEqual({ grid: 1 });
    expect(patchPopoutPositions(null, [{ box: box(1, 1) }])).toBeNull();
    expect(patchPopoutPositions('nonsense', [])).toBe('nonsense');
  });

  it('does not mutate the layout it was handed', () => {
    const layout = { popoutGroups: [grouped('g1', box(10, 10))] };
    patchPopoutPositions(layout, [{ groupId: 'g1', box: box(77, 77) }]);
    expect(layout.popoutGroups[0].position).toEqual(box(10, 10));
  });
});

describe('groupIdFromFrameName', () => {
  it('takes the group id dockview appends to its component id', () => {
    expect(groupIdFromFrameName('dockview-1-group-7')).toBe('7');
    expect(groupIdFromFrameName('abc-xyz')).toBe('xyz');
  });

  it('returns nothing it cannot trust', () => {
    expect(groupIdFromFrameName(undefined)).toBeUndefined();
    expect(groupIdFromFrameName('')).toBeUndefined();
    expect(groupIdFromFrameName('trailing-')).toBeUndefined();
  });
});

describe('resolvePopoutBounds (#86 — undo dockview double-counting the opener)', () => {
  const opener = { x: 640, y: 296 };

  it('a restore is recognised and given back its absolute position', () => {
    const stored = [box(160, 240, 606, 437)];
    // dockview asks for opener + stored, having already added the origin once
    const asked = { x: 800, y: 536, width: 606, height: 437 };
    const { bounds, matchedIndex } = resolvePopoutBounds(asked, opener, stored);
    expect(matchedIndex).toBe(0);
    expect(bounds).toEqual({ x: 160, y: 240, width: 606, height: 437 });
  });

  it('a fresh pop-out passes through untouched', () => {
    // tearing off a panel: the box is a rect INSIDE the opener, so opener+box
    // is the correct absolute position and matches no stored entry
    const asked = { x: 900, y: 400, width: 500, height: 300 };
    const { bounds, matchedIndex } = resolvePopoutBounds(asked, opener, [box(160, 240)]);
    expect(matchedIndex).toBe(-1);
    expect(bounds).toBe(asked);
  });

  it('matches the right entry when several popouts are restored', () => {
    const stored = [box(10, 10), box(-1900, 300), box(2600, 100)];
    const asked = { x: 640 - 1900, y: 296 + 300, width: 600, height: 400 };
    expect(resolvePopoutBounds(asked, opener, stored).matchedIndex).toBe(1);
    expect(resolvePopoutBounds(asked, opener, stored).bounds).toMatchObject({ x: -1900, y: 300 });
  });

  it('tolerates a pixel of rounding either way', () => {
    const stored = [box(160, 240)];
    expect(resolvePopoutBounds({ x: 801, y: 535 }, opener, stored).matchedIndex).toBe(0);
    expect(resolvePopoutBounds({ x: 812, y: 536 }, opener, stored).matchedIndex).toBe(-1);
  });

  it('passes through when there is nothing to match against', () => {
    const asked = { x: 5, y: 5 };
    expect(resolvePopoutBounds(asked, opener, []).bounds).toBe(asked);
    expect(resolvePopoutBounds({}, opener, [box(1, 1)]).matchedIndex).toBe(-1);
  });
});
