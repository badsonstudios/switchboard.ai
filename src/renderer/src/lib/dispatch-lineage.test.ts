import { describe, expect, it } from 'vitest';
import {
  LineageMap,
  LINEAGE_KEY,
  loadLineage,
  MAX_RAIL_DEPTH,
  nestWithin,
  NO_LINEAGE,
  parentOf,
  persistableLineage,
  pruneLineage,
  railDepthIndent,
  withoutCard,
  withParent,
} from './dispatch-lineage';

const map = (pairs: Array<[string, string]>): LineageMap => new Map(pairs);

describe('withParent', () => {
  it('records a child under its author', () => {
    expect([...withParent(NO_LINEAGE, 'child', 'author')]).toEqual([['child', 'author']]);
  });

  it('returns the SAME map when nothing changed — identity is the store change signal', () => {
    const before = map([['c', 'a']]);
    expect(withParent(before, 'c', 'a')).toBe(before);
  });

  it('refuses a self-parent, blank ends, and never mutates the input', () => {
    const before = map([['c', 'a']]);
    expect(withParent(before, 'x', 'x')).toBe(before);
    expect(withParent(before, '', 'a')).toBe(before);
    expect(withParent(before, 'c2', '')).toBe(before);
    const after = withParent(before, 'c2', 'a');
    expect(after).not.toBe(before);
    expect(before.size).toBe(1);
  });

  it('re-parents a child rather than keeping two answers', () => {
    expect(withParent(map([['c', 'a']]), 'c', 'b').get('c')).toBe('b');
  });
});

describe('withoutCard — BOTH directions', () => {
  it('forgets the card as a child', () => {
    expect([...withoutCard(map([['c', 'a']]), 'c')!]).toEqual([]);
  });

  it('⚠️ AND AS A PARENT — the done-when: closing the author leaves no dangling ↳', () => {
    const next = withoutCard(
      map([
        ['c1', 'author'],
        ['c2', 'author'],
        ['other', 'elsewhere'],
      ]),
      'author'
    )!;
    expect([...next]).toEqual([['other', 'elsewhere']]);
  });

  it('answers null when there is nothing to forget, so the caller skips the write', () => {
    expect(withoutCard(map([['c', 'a']]), 'stranger')).toBeNull();
    expect(withoutCard(NO_LINEAGE, 'anything')).toBeNull();
    expect(withoutCard(map([['c', 'a']]), '')).toBeNull();
  });
});

describe('pruneLineage', () => {
  it('drops a record when EITHER end is unknown — half a relation is a dangling one', () => {
    const next = pruneLineage(
      map([
        ['live', 'alsoLive'],
        ['live2', 'gone'],
        ['gone2', 'alsoLive'],
      ]),
      ['live', 'alsoLive', 'live2']
    )!;
    expect([...next]).toEqual([['live', 'alsoLive']]);
  });

  it('answers null when nothing is stale', () => {
    expect(pruneLineage(map([['c', 'a']]), ['c', 'a'])).toBeNull();
  });

  it('an EMPTY known set wipes it, which is why the caller guards a refused read', () => {
    // The guard is `SessionGrid`'s boot sweep, which the comment there names
    // precisely; this test pins the behaviour the guard exists for rather than
    // pretending the function defends itself.
    expect([...pruneLineage(map([['c', 'a']]), [])!]).toEqual([]);
  });
});

describe('parentOf', () => {
  it('answers the author, and nothing for an unknown or absent card', () => {
    const l = map([['c', 'a']]);
    expect(parentOf(l, 'c')).toBe('a');
    expect(parentOf(l, 'a')).toBeUndefined();
    expect(parentOf(l, undefined)).toBeUndefined();
  });
});

describe('nestWithin — the placement, and the depth that comes out of it', () => {
  it('puts a child directly under its author, at depth 1', () => {
    const got = nestWithin(['a', 'x', 'c'], map([['c', 'a']]));
    expect(got.ids).toEqual(['a', 'c', 'x']);
    expect(got.depth.get('c')).toBe(1);
    expect(got.depth.has('a')).toBe(false);
  });

  it('keeps roots in arrival order and children in arrival order under each', () => {
    const got = nestWithin(
      ['a', 'b', 'c1', 'c2', 'd1'],
      map([
        ['c1', 'a'],
        ['c2', 'a'],
        ['d1', 'b'],
      ])
    );
    expect(got.ids).toEqual(['a', 'c1', 'c2', 'b', 'd1']);
  });

  it('nests a chain depth-first — a reviewer that dispatched its own reviewer', () => {
    const got = nestWithin(
      ['a', 'b', 'c'],
      map([
        ['b', 'a'],
        ['c', 'b'],
      ])
    );
    expect(got.ids).toEqual(['a', 'b', 'c']);
    expect([got.depth.get('b'), got.depth.get('c')]).toEqual([1, 2]);
  });

  it('⚠️ A PARENT OUTSIDE THE RUN IS NOT A PARENT — no reorder, and NO DEPTH', () => {
    // This one condition is the pin boundary, the bucket boundary and the
    // closed-author case all at once. Depth 0 means the rail draws no connector,
    // which is what makes an orphan with a dangling ↳ unrepresentable.
    const got = nestWithin(['x', 'c'], map([['c', 'elsewhere']]));
    expect(got.ids).toEqual(['x', 'c']);
    expect(got.depth.size).toBe(0);
  });

  it('is cycle-proof: A→B→A renders flat, in arrival order, losing nobody', () => {
    const got = nestWithin(
      ['a', 'b'],
      map([
        ['a', 'b'],
        ['b', 'a'],
      ])
    );
    expect(got.ids.slice().sort()).toEqual(['a', 'b']);
    expect(got.ids.length).toBe(2);
  });

  it('a cycle hanging off a real root still emits every id exactly once', () => {
    const got = nestWithin(
      ['root', 'kid', 'p', 'q'],
      map([
        ['kid', 'root'],
        ['p', 'q'],
        ['q', 'p'],
      ])
    );
    expect(got.ids.slice(0, 2)).toEqual(['root', 'kid']);
    expect(got.ids.length).toBe(4);
    expect(new Set(got.ids).size).toBe(4);
  });

  it('hands the SAME array back when there is nothing to do', () => {
    const ids = ['a', 'b'];
    expect(nestWithin(ids, NO_LINEAGE).ids).toBe(ids);
    // a lineage that names nobody in this run is also nothing to do
    expect(nestWithin(ids, map([['elsewhere', 'other']])).ids).toBe(ids);
  });

  it('a self-parent in the data is a root, not a loop', () => {
    const got = nestWithin(['a', 'b'], map([['a', 'a']]));
    expect(got.ids).toEqual(['a', 'b']);
    expect(got.depth.size).toBe(0);
  });
});

describe('railDepthIndent', () => {
  it('is zero at the top level and grows by one step per level', () => {
    expect(railDepthIndent(undefined)).toBe(0);
    expect(railDepthIndent(0)).toBe(0);
    expect(railDepthIndent(1)).toBeGreaterThan(0);
    expect(railDepthIndent(2)).toBe(railDepthIndent(1) * 2);
  });

  it('clamps, so a deep chain does not indent a row into a sliver', () => {
    expect(railDepthIndent(MAX_RAIL_DEPTH + 5)).toBe(railDepthIndent(MAX_RAIL_DEPTH));
  });
});

describe('persistence', () => {
  it('round-trips through the blob', () => {
    const before = map([
      ['c1', 'a'],
      ['c2', 'b'],
    ]);
    expect(loadLineage(persistableLineage(before))).toEqual(before);
  });

  it('writes nothing for a workspace that has never dispatched', () => {
    expect(persistableLineage(NO_LINEAGE)).toBeNull();
  });

  it('sorts its keys, so an unchanged lineage does not rewrite the file each launch', () => {
    expect(
      Object.keys(
        persistableLineage(
          map([
            ['z', 'a'],
            ['b', 'a'],
          ])
        )!
      )
    ).toEqual(['b', 'z']);
  });

  it('survives junk a hand-edited or older blob can hold (§4, fail-open)', () => {
    expect(loadLineage(null)).toBe(NO_LINEAGE);
    expect(loadLineage(['a'])).toBe(NO_LINEAGE);
    expect(loadLineage('nope')).toBe(NO_LINEAGE);
    expect(loadLineage({ c: 42, d: null, e: '', f: 'f', g: 'author' })).toEqual(
      map([['g', 'author']])
    );
  });

  it('names the ui-blob key the boot seed reads', () => {
    expect(LINEAGE_KEY).toBe('dispatchLineage');
  });
});
