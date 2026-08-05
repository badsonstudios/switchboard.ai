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

describe('railOrder — §5.8 sorts a pinned session first (E9-09)', () => {
  it('a pinned loose session leads the rail, and Ctrl+1..9 with it', () => {
    // the default shape: no persistent or emergent groups, so the loose list IS
    // the rail and "sorts first" is literal
    const r = railOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [], new Set(['c']));
    expect(r.loose.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(r.flat.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('a pinned GROUP member leads its own group, and stays in it', () => {
    // VS Code's semantics: pinning moves a tab to the front of ITS editor
    // group, never out of it. Hoisting would empty the count on the header the
    // user deliberately filed the session under.
    const r = railOrder(
      [
        { id: 'a', groupId: 'g1' },
        { id: 'b', groupId: 'g1' },
        { id: 'c' },
      ],
      [{ id: 'g1' }],
      new Set(['b'])
    );
    expect(r.groups).toEqual([{ id: 'g1', members: [{ id: 'b', groupId: 'g1' }, { id: 'a', groupId: 'g1' }] }]);
    expect(r.flat.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('an auto-group holding a pinned session is itself computed first', () => {
    const r = railOrder(
      [
        { id: 'a', autoKey: 'c:/one' },
        { id: 'b', autoKey: 'c:/one' },
        { id: 'c', autoKey: 'c:/two' },
        { id: 'd', autoKey: 'c:/two' },
      ],
      [],
      new Set(['d'])
    );
    expect(r.autoGroups.map((g) => g.key)).toEqual(['c:/two', 'c:/one']);
    expect(r.flat.map((s) => s.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('no pins means the order nobody asked to change', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }];
    expect(railOrder(sessions, []).flat.map((s) => s.id)).toEqual(['a', 'b']);
    expect(railOrder(sessions, [], new Set(['zz'])).flat.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
