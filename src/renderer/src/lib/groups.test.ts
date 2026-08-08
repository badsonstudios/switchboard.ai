import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeAutoGroups, groupChangeLanded, pickAdoptedGroupId, railOrder } from './groups';

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

  it('promotes WITHIN an auto-group without moving the auto-group itself', () => {
    // the invariant lib/pinning states and this is where it would be easiest to
    // break: pre-sorting railOrder's INPUT would hoist the whole `c:/two`
    // bucket above `c:/one` — moving unpinned a, b and c relative to each
    // other, which nobody asked for. Membership and bucket order come from the
    // sessions as they arrived; the pin reorders inside one bucket only.
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
    expect(r.autoGroups.map((g) => g.key)).toEqual(['c:/one', 'c:/two']);
    expect(r.autoGroups[1].members.map((s) => s.id)).toEqual(['d', 'c']);
    expect(r.flat.map((s) => s.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('does not move a session between buckets, only within one', () => {
    // a pinned GROUP member stays in its group even though that leaves it below
    // the loose sessions in `flat` — the group is a thing the user built, and
    // emptying its header count to hoist one row would cost more than it buys
    const r = railOrder(
      [
        { id: 'loose' },
        { id: 'a', groupId: 'g1' },
        { id: 'b', groupId: 'g1' },
      ],
      [{ id: 'g1' }],
      new Set(['b'])
    );
    expect(r.groups[0].members.map((s) => s.id)).toEqual(['b', 'a']);
    expect(r.loose.map((s) => s.id)).toEqual(['loose']);
  });

  it('no pins means the order nobody asked to change', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }];
    expect(railOrder(sessions, []).flat.map((s) => s.id)).toEqual(['a', 'b']);
    expect(railOrder(sessions, [], new Set(['zz'])).flat.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('groupChangeLanded — reading a refusal instead of catching one (issue 326)', () => {
  let warned: string[];
  let restore: () => void;
  beforeEach(() => {
    warned = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '));
    restore = () => {
      console.warn = original;
    };
  });
  afterEach(() => restore());

  it('a group that came back landed, and says nothing about it', () => {
    expect(// the value is opaque to the helper — only "is there one" matters
    groupChangeLanded('rename', { id: 'g1', name: 'infra' })).toBe(true);
    expect(warned).toEqual([]);
  });

  it('null is a refusal — reported, never silent', () => {
    // the whole trade a result shape makes: "refused" looks exactly like "done"
    // unless somebody reads it. This is the somebody.
    expect(groupChangeLanded('rename', null)).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('rename');
    expect(warned[0]).toContain('refused');
  });

  it('treats undefined as a refusal too — a bridge that answered nothing changed nothing', () => {
    expect(groupChangeLanded('create', undefined)).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('create');
  });

  it('names the operation, so three call sites do not produce one indistinguishable line', () => {
    groupChangeLanded('create', null);
    groupChangeLanded('rename', null);
    groupChangeLanded('recolor', null);
    expect(new Set(warned).size).toBe(3);
  });
});
