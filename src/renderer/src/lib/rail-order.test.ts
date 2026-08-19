// #559 — the manual rail order model.
//
// The rules live here rather than in the rail, so the one question the issue
// delegated — what happens when an arrangement meets a pin — is answered by a
// test and not by whichever handler ran last. `planReorder` is the whole of
// that answer: it re-applies §5.8's pin sort to its own result, so a drag that
// aims across the pinned/unpinned boundary settles against it, and one that
// would change nothing at all comes back as `null`.
import { describe, it, expect } from 'vitest';
import {
  applyManualOrder,
  autoBucket,
  canStep,
  groupBucket,
  LOOSE_BUCKET,
  loadManualOrder,
  ManualOrder,
  NO_ORDER,
  ORDER_KEY,
  persistableManualOrder,
  planReorder,
  pruneManualOrder,
  stepReorder,
  withBucketOrder,
} from './rail-order';
import { PinSet } from './pinning';

const rows = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));
const ids = (list: Array<{ id: string }>): string[] => list.map((r) => r.id);
const pins = (...list: string[]): PinSet => new Set(list);
const order = (entries: Record<string, string[]>): ManualOrder =>
  new Map(Object.entries(entries));

describe('bucket keys', () => {
  it('name the three kinds of bucket the rail paints, and nothing else', () => {
    // The key is how a persisted arrangement finds its way back to the card it
    // was made on, so these three spellings are a contract with SessionsRail's
    // `groupCard({ key })` — two spellings of one bucket would silently store
    // an order the rail never reads back.
    expect(groupBucket('g1')).toBe('g1');
    expect(autoBucket('C:\\Projects\\x')).toBe('auto:C:\\Projects\\x');
    expect(LOOSE_BUCKET).toBe('ungrouped');
    expect(ORDER_KEY).toBe('railOrder');
  });
});

describe('applyManualOrder', () => {
  it('puts the arranged sessions in the arranged order', () => {
    expect(ids(applyManualOrder(rows('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('puts a session opened SINCE the arrangement at the bottom', () => {
    // "the list I arranged, plus the new one underneath" — what every list a
    // human has dragged does, and the only answer that does not move rows the
    // user did not touch
    expect(ids(applyManualOrder(rows('a', 'b', 'new'), ['b', 'a']))).toEqual(['b', 'a', 'new']);
  });

  it('keeps several new sessions in the order they arrived', () => {
    expect(ids(applyManualOrder(rows('n1', 'a', 'n2', 'b'), ['b', 'a']))).toEqual([
      'b',
      'a',
      'n1',
      'n2',
    ]);
  });

  it('skips an id whose session is gone rather than leaving a hole', () => {
    expect(ids(applyManualOrder(rows('a', 'b'), ['b', 'closed', 'a']))).toEqual(['b', 'a']);
  });

  it('hands the SAME array back when there is nothing to do', () => {
    const same = rows('a', 'b');
    expect(applyManualOrder(same, undefined)).toBe(same);
    expect(applyManualOrder(same, [])).toBe(same);
    // an order naming no member of this bucket cannot reorder it
    expect(applyManualOrder(same, ['x', 'y'])).toBe(same);
    const one = rows('a');
    expect(applyManualOrder(one, ['a'])).toBe(one);
  });
});

describe('planReorder', () => {
  it('moves a row to the index asked for', () => {
    expect(planReorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(planReorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(planReorder(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
  });

  it('answers null when nothing would change', () => {
    expect(planReorder(['a', 'b', 'c'], 'a', 0)).toBeNull();
    expect(planReorder(['a'], 'a', 0)).toBeNull();
    expect(planReorder(['a', 'b'], 'nobody', 0)).toBeNull();
  });

  it('clamps an index off either end instead of dropping the row', () => {
    expect(planReorder(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(planReorder(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b']);
  });

  // ── THE DECISION #559 DELEGATED ────────────────────────────────────────
  // §5.8's "a pinned session sorts first in the rail" WINS over an
  // arrangement. Pinned sessions are a leading block; you reorder freely
  // inside each block, and a drag aimed across the boundary stops at it.
  describe('when it meets a pin (§5.8 wins)', () => {
    it('lands an unpinned session at the top of ITS block, not above the pin', () => {
      // Dragged to the very top, `b` gets as far as a pin allows and stops —
      // the gesture still does the most it legally can rather than being
      // thrown away, which is what makes "drag it to the top" mean something
      // in a group that has a pinned session in it.
      expect(planReorder(['p', 'a', 'b'], 'b', 0, pins('p'))).toEqual(['p', 'b', 'a']);
    });

    it('answers null when the pin leaves the row exactly where it was', () => {
      // `a` is ALREADY the top of the unpinned block, so dropping it above the
      // pin is the one gesture with nothing left to do — no write, no
      // announcement, and no insertion line offering it in the first place.
      expect(planReorder(['p', 'a', 'b'], 'a', 0, pins('p'))).toBeNull();
    });

    it('reorders freely WITHIN the unpinned block', () => {
      expect(planReorder(['p', 'a', 'b'], 'b', 1, pins('p'))).toEqual(['p', 'b', 'a']);
    });

    it('reorders freely WITHIN the pinned block', () => {
      expect(planReorder(['p1', 'p2', 'a'], 'p2', 0, pins('p1', 'p2'))).toEqual([
        'p2',
        'p1',
        'a',
      ]);
    });

    it('will not sink a pinned session below an unpinned one', () => {
      expect(planReorder(['p', 'a', 'b'], 'p', 2, pins('p'))).toBeNull();
    });

    it('is unconstrained when every session in the group is pinned', () => {
      expect(planReorder(['p1', 'p2'], 'p2', 0, pins('p1', 'p2'))).toEqual(['p2', 'p1']);
    });
  });
});

describe('stepReorder / canStep', () => {
  it('steps one place, either way', () => {
    expect(stepReorder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(stepReorder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('answers null at the ends of the group', () => {
    expect(stepReorder(['a', 'b'], 'a', -1)).toBeNull();
    expect(stepReorder(['a', 'b'], 'b', 1)).toBeNull();
  });

  it('answers null at the pinned boundary, which is what disables the menu item', () => {
    // one rule, one answer: the menu's `aria-disabled` and the move itself both
    // ask this, so an item can never be offered and then decline
    expect(canStep(['p', 'a', 'b'], 'a', -1, pins('p'))).toBe(false);
    expect(canStep(['p', 'a', 'b'], 'b', -1, pins('p'))).toBe(true);
    expect(canStep(['p', 'a'], 'p', 1, pins('p'))).toBe(false);
  });
});

describe('withBucketOrder', () => {
  it('records one bucket without touching the others', () => {
    const next = withBucketOrder(order({ g1: ['a', 'b'] }), 'g2', ['c', 'd']);
    expect(next.get('g1')).toEqual(['a', 'b']);
    expect(next.get('g2')).toEqual(['c', 'd']);
  });

  it('hands the SAME map back when nothing changed', () => {
    const before = order({ g1: ['a', 'b'] });
    expect(withBucketOrder(before, 'g1', ['a', 'b'])).toBe(before);
    expect(withBucketOrder(NO_ORDER, 'g1', ['a'])).toBe(NO_ORDER);
  });

  it('drops a bucket that no longer has an order worth keeping', () => {
    // a list of one has no arrangement, and a workspace must not accrete a
    // record per bucket it ever painted
    const next = withBucketOrder(order({ g1: ['a', 'b'] }), 'g1', ['a']);
    expect(next.has('g1')).toBe(false);
  });

  it('copies the ids in, so a later mutation of the caller\u2019s array cannot reach it', () => {
    const live = ['a', 'b'];
    const next = withBucketOrder(NO_ORDER, 'g1', live);
    live.push('c');
    expect(next.get('g1')).toEqual(['a', 'b']);
  });
});

describe('pruneManualOrder', () => {
  it('forgets cards that no longer exist', () => {
    const next = pruneManualOrder(order({ g1: ['a', 'gone', 'b'] }), ['a', 'b']);
    expect(next!.get('g1')).toEqual(['a', 'b']);
  });

  it('drops a bucket pruned down to nothing worth remembering', () => {
    const next = pruneManualOrder(order({ g1: ['a', 'gone'] }), ['a']);
    expect(next!.has('g1')).toBe(false);
  });

  it('answers null when there is nothing to drop — no write, no re-render', () => {
    expect(pruneManualOrder(order({ g1: ['a', 'b'] }), ['a', 'b', 'c'])).toBeNull();
    expect(pruneManualOrder(NO_ORDER, ['a'])).toBeNull();
  });

  it('keeps an EMPTY group\u2019s arrangement — a group can be empty and still be a group', () => {
    // E12's "empty ≠ gone": only the cards are knowable here, so only the
    // cards are retired. A bucket is never pruned for being unoccupied today.
    const next = pruneManualOrder(order({ g1: ['a', 'b'], g2: ['c', 'd'] }), ['a', 'b', 'c', 'd']);
    expect(next).toBeNull();
  });
});

describe('persistence (the ui blob — P2-E15-06, never localStorage)', () => {
  it('round-trips', () => {
    const blob = persistableManualOrder(order({ g1: ['a', 'b'], ungrouped: ['c', 'd'] }));
    expect(loadManualOrder(blob)).toEqual(order({ g1: ['a', 'b'], ungrouped: ['c', 'd'] }));
  });

  it('writes nothing at all when nobody has arranged anything', () => {
    expect(persistableManualOrder(NO_ORDER)).toBeNull();
  });

  it('writes its bucket keys sorted, so an unchanged order does not churn the file', () => {
    const blob = persistableManualOrder(order({ zz: ['a', 'b'], aa: ['c', 'd'] }))!;
    expect(Object.keys(blob)).toEqual(['aa', 'zz']);
    // ...and the IDS inside keep their order, because they ARE the data
    expect(blob.zz).toEqual(['a', 'b']);
  });

  it('survives a blob written by code that no longer exists (fail-open, §4)', () => {
    expect(loadManualOrder(null)).toBe(NO_ORDER);
    expect(loadManualOrder('nonsense')).toBe(NO_ORDER);
    expect(loadManualOrder(['a', 'b'])).toBe(NO_ORDER);
    expect(loadManualOrder({ g1: 'not-a-list' })).toBe(NO_ORDER);
    expect(loadManualOrder({ g1: ['a', 42, '', null, 'b'] })).toEqual(order({ g1: ['a', 'b'] }));
    // a duplicate would give one card two ranks; the first wins
    expect(loadManualOrder({ g1: ['a', 'b', 'a'] })).toEqual(order({ g1: ['a', 'b'] }));
    // and a bucket that survives the filter with one id has no order left
    expect(loadManualOrder({ g1: ['a', 42] })).toBe(NO_ORDER);
  });
});
