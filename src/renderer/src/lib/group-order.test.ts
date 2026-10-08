import { describe, it, expect } from 'vitest';
import { dropGroup, stepGroup, GroupMove } from './group-order';

const IDS = ['a', 'b', 'c', 'd'];

/** what main does with the answer (`WorkspaceStore.moveGroup`), so each case
 *  can be stated as the list the user ends up looking at */
function apply(ids: readonly string[], move: GroupMove | null): string[] {
  if (!move) return [...ids];
  const next = ids.filter((x) => x !== move.id);
  next.splice(move.beforeId === null ? next.length : next.indexOf(move.beforeId), 0, move.id);
  return next;
}

describe('stepGroup — Move up / Move down (#1144)', () => {
  it('moves one place up', () => {
    expect(apply(IDS, stepGroup(IDS, 'c', 'up'))).toEqual(['a', 'c', 'b', 'd']);
    expect(apply(IDS, stepGroup(IDS, 'b', 'up'))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves one place down, including into last place', () => {
    expect(apply(IDS, stepGroup(IDS, 'b', 'down'))).toEqual(['a', 'c', 'b', 'd']);
    expect(stepGroup(IDS, 'c', 'down')).toEqual({ id: 'c', beforeId: null });
    expect(apply(IDS, stepGroup(IDS, 'c', 'down'))).toEqual(['a', 'b', 'd', 'c']);
  });

  // the owner's example, by menu: the bottom group, up twice, is second
  it('takes the bottom group to second in two steps', () => {
    const once = apply(IDS, stepGroup(IDS, 'd', 'up'));
    expect(apply(once, stepGroup(once, 'd', 'up'))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('has nothing to do at either end, or for a group that is not there', () => {
    expect(stepGroup(IDS, 'a', 'up')).toBeNull();
    expect(stepGroup(IDS, 'd', 'down')).toBeNull();
    expect(stepGroup(IDS, 'zzz', 'up')).toBeNull();
    expect(stepGroup(['only'], 'only', 'up')).toBeNull();
    expect(stepGroup(['only'], 'only', 'down')).toBeNull();
  });
});

describe('dropGroup — a drag onto another group (#1144)', () => {
  // the owner's example, by drag: drop the bottom group on the top half of the
  // second one
  it('drops the bottom group above the second, making it second', () => {
    expect(apply(IDS, dropGroup(IDS, 'd', 'b', false))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('lands above or below the target, from either direction', () => {
    expect(apply(IDS, dropGroup(IDS, 'a', 'c', false))).toEqual(['b', 'a', 'c', 'd']);
    expect(apply(IDS, dropGroup(IDS, 'a', 'c', true))).toEqual(['b', 'c', 'a', 'd']);
    expect(apply(IDS, dropGroup(IDS, 'd', 'a', false))).toEqual(['d', 'a', 'b', 'c']);
    expect(apply(IDS, dropGroup(IDS, 'a', 'd', true))).toEqual(['b', 'c', 'd', 'a']);
    expect(dropGroup(IDS, 'a', 'd', true)).toEqual({ id: 'a', beforeId: null });
  });

  // every (group, target, half) lands exactly where the half says
  it('always lands adjacent to the target, on the side that was asked for', () => {
    for (const id of IDS) {
      for (const target of IDS) {
        for (const after of [false, true]) {
          const out = apply(IDS, dropGroup(IDS, id, target, after));
          if (id === target) {
            expect(out).toEqual(IDS);
            continue;
          }
          expect(out.indexOf(id) - out.indexOf(target)).toBe(after ? 1 : -1);
          // nobody else changed places relative to each other
          expect(out.filter((x) => x !== id)).toEqual(IDS.filter((x) => x !== id));
        }
      }
    }
  });

  // no drop line is drawn for these, because nothing would move
  it('has nothing to do when dropped where it already sits', () => {
    expect(dropGroup(IDS, 'b', 'b', false)).toBeNull();
    expect(dropGroup(IDS, 'b', 'a', true)).toBeNull(); // below the one above it
    expect(dropGroup(IDS, 'b', 'c', false)).toBeNull(); // above the one below it
    expect(dropGroup(IDS, 'zzz', 'a', false)).toBeNull();
    expect(dropGroup(IDS, 'a', 'zzz', false)).toBeNull();
  });
});
