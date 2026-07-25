import { describe, it, expect } from 'vitest';
import { computeAutoGroups, pickAdoptedGroupId, railOrder } from './groups';

describe('computeAutoGroups (E12-05 emergent repo/folder groups)', () => {
  it('two ungrouped sessions sharing a key auto-group; singletons do not', () => {
    const gs = computeAutoGroups([
      { id: 'a', autoKey: 'c:/repo' },
      { id: 'b', autoKey: 'c:/repo' },
      { id: 'c', autoKey: 'c:/other' },
    ]);
    expect(gs).toEqual([{ key: 'c:/repo', memberIds: ['a', 'b'] }]);
  });

  it('explicit persistent membership overrides (S4): grouped sessions never auto-group', () => {
    const gs = computeAutoGroups([
      { id: 'a', autoKey: 'c:/repo', groupId: 'g1' },
      { id: 'b', autoKey: 'c:/repo' },
    ]);
    expect(gs).toEqual([]); // 'b' is a singleton once 'a' is claimed
  });

  it('auto-groups vanish when emptied to one (recompute-on-render semantics)', () => {
    expect(computeAutoGroups([{ id: 'b', autoKey: 'c:/repo' }])).toEqual([]);
  });

  it('falls back to folder when no autoKey', () => {
    const gs = computeAutoGroups([
      { id: 'a', folder: 'c:/x' },
      { id: 'b', folder: 'c:/x' },
    ]);
    expect(gs.map((g) => g.memberIds)).toEqual([['a', 'b']]);
  });
});

describe('railOrder (E9-01: what Ctrl+1..9 counts against)', () => {
  it('paints groups (with members) first, then auto-groups, then loose', () => {
    const r = railOrder(
      [
        { id: 'loose1', autoKey: 'c:/solo' },
        { id: 'g1a', groupId: 'g1' },
        { id: 'auto1', autoKey: 'c:/repo' },
        { id: 'g2a', groupId: 'g2' },
        { id: 'auto2', autoKey: 'c:/repo' },
        { id: 'g1b', groupId: 'g1' },
      ],
      [{ id: 'g1' }, { id: 'g2' }]
    );
    expect(r.flat.map((s) => s.id)).toEqual(['g1a', 'g1b', 'g2a', 'auto1', 'auto2', 'loose1']);
    expect(r.groups.map((g) => g.members.map((m) => m.id))).toEqual([['g1a', 'g1b'], ['g2a']]);
    expect(r.autoGroups[0].members.map((m) => m.id)).toEqual(['auto1', 'auto2']);
    expect(r.loose.map((s) => s.id)).toEqual(['loose1']);
  });

  it('a session whose groupId names a deleted group falls back to loose', () => {
    const r = railOrder([{ id: 'a', groupId: 'gone' }], [{ id: 'g1' }]);
    expect(r.loose.map((s) => s.id)).toEqual(['a']);
    expect(r.flat.map((s) => s.id)).toEqual(['a']);
  });

  it('empty groups keep their header slot but contribute no sessions', () => {
    const r = railOrder([{ id: 'a' }], [{ id: 'g1' }]);
    expect(r.groups).toEqual([{ id: 'g1', members: [] }]);
    expect(r.flat.map((s) => s.id)).toEqual(['a']);
  });
});

describe('pickAdoptedGroupId (E12-04 grid-drag adoption)', () => {
  const cards = [
    { cardId: 'a', groupId: 'g1' },
    { cardId: 'b', groupId: undefined },
    { cardId: 'c', groupId: 'g2' },
  ];

  it('adopts the first sibling with a membership', () => {
    expect(pickAdoptedGroupId('x', ['b', 'a', 'c'], cards)).toBe('g1');
  });

  it('all-ungrouped destination means ungrouped', () => {
    expect(pickAdoptedGroupId('x', ['b'], cards)).toBeNull();
    expect(pickAdoptedGroupId('x', [], cards)).toBeNull();
  });

  it('ignores itself among the siblings', () => {
    expect(pickAdoptedGroupId('a', ['a', 'b'], cards)).toBeNull();
  });

  it('unknown siblings (no record yet) are skipped', () => {
    expect(pickAdoptedGroupId('x', ['ghost', 'c'], cards)).toBe('g2');
  });
});
