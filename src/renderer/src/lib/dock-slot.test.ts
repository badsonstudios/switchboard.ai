import { describe, it, expect } from 'vitest';
import {
  captureSlot,
  homeGroupId,
  keepsInheritedGroup,
  openerRelative,
  placeAt,
  type SlotSource,
} from './dock-slot';

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

describe('homeGroupId — where a card docking back belongs (#558)', () => {
  const grid = (id: string): { id: string; location: string; hasDocument: boolean } => ({
    id,
    location: 'grid',
    hasDocument: false,
  });
  const HOME = { groupId: 'g-left', index: 2, location: 'grid' as const };

  it('gives the card its own slot back, hidden husk and all', () => {
    // the husk IS the slot — an empty invisible group with the geometry still
    // on it — and this function does not care that it is empty; nothing about
    // a group says whether it is one, and the caller un-hides whatever it gets
    expect(homeGroupId(HOME, [grid('g-right'), grid('g-left')])).toBe('g-left');
  });

  it('refuses a home that is gone, or has left the grid', () => {
    expect(homeGroupId(HOME, [grid('g-right')])).toBeNull();
    expect(
      homeGroupId(HOME, [{ id: 'g-left', location: 'popout', hasDocument: false }])
    ).toBeNull();
  });

  it('refuses the document area even when it used to be the card’s own group', () => {
    // #462/#501: a session never displaces what you are reading. What the user
    // can see now beats what the card remembers.
    expect(homeGroupId(HOME, [{ id: 'g-left', location: 'grid', hasDocument: true }])).toBeNull();
  });

  it('a card with no grid home has none — which is the whole bug', () => {
    // the popout-born card (#531). Answering anything else here is how it
    // inherited its opener's slot: null sends the caller to the ordinary
    // placement rules, where a brand new session would land.
    expect(homeGroupId(null, [grid('g-left')])).toBeNull();
    expect(homeGroupId(undefined, [grid('g-left')])).toBeNull();
    // ...and a POPOUT home is not one either: it names another OS window, and
    // a blob outlives the code that wrote it
    expect(
      homeGroupId({ groupId: 'g-left', index: 0, location: 'popout' }, [grid('g-left')])
    ).toBeNull();
  });
});

describe('keepsInheritedGroup — a card dockview handed back (#657)', () => {
  const landed = (over: Partial<Parameters<typeof keepsInheritedGroup>[0]> = {}) =>
    keepsInheritedGroup({
      landingGroupId: 'g-left',
      landingGroupSize: 1,
      homeId: null,
      ...over,
    });

  it('keeps its own slot — the card that tore the window off', () => {
    // dockview's reference IS this card's home, so the two placements agree and
    // the ordinary round trip costs nothing
    expect(landed({ homeId: 'g-left' })).toBe(true);
  });

  it('keeps a group it arrived BESIDE somebody in', () => {
    // #558's own words for where a card with no claim belongs: "a tab beside
    // the card that owns that half rather than instead of it". A group that
    // still holds other panels is not a slot being claimed.
    expect(landed({ landingGroupSize: 2 })).toBe(true);
    expect(landed({ homeId: 'g-right', landingGroupSize: 3 })).toBe(true);
  });

  it('refuses a whole slot it never earned — alone, and not its own', () => {
    // the popout-born card (#531) left holding its opener's reference after the
    // opener has gone: this is #657 exactly
    expect(landed()).toBe(false);
    // ...and the same for a card whose home has moved on somewhere else
    expect(landed({ homeId: 'g-right' })).toBe(false);
  });

  it('counts the card itself, so ONE means alone', () => {
    // a landing size of 0 cannot happen (the card is in it), but the boundary
    // is worth stating: it is `> 1` that means company
    expect(landed({ landingGroupSize: 1 })).toBe(false);
    expect(landed({ landingGroupSize: 2 })).toBe(true);
  });
});
