import { describe, it, expect } from 'vitest';
import { captureSlot, openerRelative, placeAt, type SlotSource } from './dock-slot';

function panel(id: string, groupId: string, siblings: string[], location = 'grid'): SlotSource {
  return {
    id,
    group: {
      id: groupId,
      panels: siblings.map((p) => ({ id: p })),
      api: { location: { type: location } },
    },
  };
}

describe('captureSlot (P2-E15-08)', () => {
  it('records the group and the tab index within it', () => {
    const p = panel('session-2', 'g1', ['session-1', 'session-2', 'session-3']);
    expect(captureSlot(p)).toEqual({ groupId: 'g1', index: 1, location: 'grid' });
  });

  it('keeps the window rect for a popped-out card — its monitor IS its slot', () => {
    const box = { left: -1920, top: 40, width: 900, height: 700 };
    const p = panel('session-1', 'g2', ['session-1'], 'popout');
    expect(captureSlot(p, box)).toEqual({ groupId: 'g2', index: 0, location: 'popout', box });
    // a grid panel handed a box does not record one: it has no window
    expect(captureSlot(panel('session-1', 'g1', ['session-1']), box)?.box).toBeUndefined();
  });
});

describe('placeAt (P2-E15-08)', () => {
  it('rejoins the group it left', () => {
    expect(placeAt({ groupId: 'g1', index: 2, location: 'grid' }, ['g0', 'g1'])).toEqual({
      groupId: 'g1',
      index: 2,
      popout: null,
    });
  });

  it('falls back to the caller when the group died with the card', () => {
    // removing a group's LAST panel destroys the group, so a card that was
    // alone has nothing to rejoin — "exactly where it was" is best-effort and
    // must degrade to somewhere sensible rather than to nothing
    expect(placeAt({ groupId: 'gone', index: 0, location: 'grid' }, ['g0'])).toEqual({
      groupId: null,
      index: -1,
      popout: null,
    });
  });

  it('asks for a new window only when the popout group is gone', () => {
    const box = { left: 100, top: 100, width: 800, height: 600 };
    const slot = { groupId: 'gp', index: 0, location: 'popout' as const, box };
    // the window is still open: joining it IS restoring the prior slot, and
    // opening a second window would be wrong
    expect(placeAt(slot, ['gp'])).toEqual({ groupId: 'gp', index: 0, popout: null });
    expect(placeAt(slot, ['g0'])).toEqual({ groupId: null, index: -1, popout: box });
  });

  it('no slot recorded means no opinion', () => {
    expect(placeAt(null, ['g0'])).toEqual({ groupId: null, index: -1, popout: null });
  });
});

describe('openerRelative', () => {
  it('subtracts the opener origin, because dockview adds it back (#86)', () => {
    const box = { left: 2000, top: 150, width: 800, height: 600 };
    expect(openerRelative(box, { screenX: 1920, screenY: 100 })).toEqual({
      left: 80,
      top: 50,
      width: 800,
      height: 600,
    });
  });
});
