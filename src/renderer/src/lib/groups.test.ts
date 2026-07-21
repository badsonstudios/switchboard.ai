import { describe, it, expect } from 'vitest';
import { pickAdoptedGroupId } from './groups';

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
