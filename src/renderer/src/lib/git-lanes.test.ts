// The lane allocator (E24 Git v2 item 3).
//
// ⚠️ **TESTED AT WIDTH, WHICH IS THE ITEM'S OWN ACCEPTANCE BAR** — the design
// record asks for "≥5 lanes, not just lane 1", because every interesting bug in a
// lane allocator lives past the first column: reuse of a freed lane, two lanes
// waiting for one sha, a merge whose second parent is already somewhere, a commit
// whose child was never in the window.
//
// The histories below are written as `id: [parents]` in TOPOLOGICAL order, the
// order `--topo-order` produces, because that is the function's one precondition.
import { describe, it, expect } from 'vitest';
import {
  DRAWN_LANES,
  allocateLanes,
  laneClamped,
  laneColumn,
  type LaneCommit,
} from './git-lanes';

/** `['a', 'b c', …]` → commits. A space-separated parent list keeps the fixtures readable. */
function history(spec: Record<string, string>): LaneCommit[] {
  return Object.entries(spec).map(([id, parents]) => ({
    id,
    parentIds: parents === '' ? [] : parents.split(' '),
  }));
}

const laneOf = (layout: { rows: { id: string; lane: number }[] }): Record<string, number> =>
  Object.fromEntries(layout.rows.map((r) => [r.id, r.lane]));

describe('allocateLanes — a single line of history', () => {
  it('puts every commit in lane 0 and keeps the line continuous (the done-when)', () => {
    const layout = allocateLanes(history({ c: 'b', b: 'a', a: '' }));
    expect(layout.lanes).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // THE FIRST PARENT INHERITS THE LANE — without that rule every commit opens a
    // fresh lane and the graph is a diagonal staircase.
    expect(layout.rows.map((r) => r.pass)).toEqual([[], [], []]);
  });

  it('the newest row has no line above it and the root has none below', () => {
    const layout = allocateLanes(history({ c: 'b', b: 'a', a: '' }));
    expect(layout.rows[0]).toMatchObject({ up: false, down: true });
    expect(layout.rows[1]).toMatchObject({ up: true, down: true });
    // A root commit's line STOPS. Drawing it onward would promise history that
    // does not exist.
    expect(layout.rows[2]).toMatchObject({ up: true, down: false });
  });

  it('a commit whose parent is outside the window still draws its line downward', () => {
    // The oldest row of any page: there IS more history, we just have not asked
    // for it, and a line that stopped would say the opposite.
    const layout = allocateLanes(history({ b: 'a' }));
    expect(layout.rows[0]).toMatchObject({ up: false, down: true });
  });

  it('an empty history is one lane and no rows, not a zero to special-case', () => {
    expect(allocateLanes([])).toEqual({ rows: [], lanes: 1, orphans: 0 });
  });
});

describe('allocateLanes — merges and forks', () => {
  it('a merge commit sends its SECOND parent into a new lane', () => {
    //   m: merge of main (a) and side (s)
    const layout = allocateLanes(history({ m: 'a s', a: 'r', s: 'r', r: '' }));
    const l = laneOf(layout);
    expect(l.m).toBe(0);
    // The first parent stays in the merge's own lane…
    expect(l.a).toBe(0);
    // …and the second takes a fresh one, which is the branch line.
    expect(l.s).toBe(1);
    expect(layout.rows[0].branches).toEqual([1]);
    expect(layout.lanes).toBe(2);
  });

  it('a FORK converges: two lanes wait for one sha, and the extra one merges in', () => {
    // `r` is the parent of both `a` and `s`, so in a newest-first list the two
    // branches are ABOVE it and meet at its row.
    const layout = allocateLanes(history({ m: 'a s', a: 'r', s: 'r', r: '' }));
    const rows = Object.fromEntries(layout.rows.map((r) => [r.id, r]));
    // ⚠️ TWO LANES LEGITIMATELY WAIT FOR THE SAME SHA, and that is not a
    // duplicate to collapse — it is how the fork is represented until `r`.
    expect(rows.r.lane).toBe(0);
    expect(rows.r.merges).toEqual([1]);
    expect(rows.r.down).toBe(false);
  });

  it('⚠️ REUSES the lane a merge freed, instead of drifting right for ever', () => {
    // This is most of why a real history stays narrow. After `r` collapses lanes
    // 0 and 1, the next branch must take lane 1 again rather than lane 2.
    const layout = allocateLanes(
      history({ m2: 'r x', r: 'a s', a: 'b', s: 'b', b: 'c', c: '', x: 'c' })
    );
    expect(layout.lanes).toBeLessThanOrEqual(3);
  });

  it('a second parent that a lane ALREADY waits for SHARES that lane', () => {
    // Two merges that both bring in `s`. The second one must curve into the lane
    // already waiting for `s` rather than opening another — a second lane for the
    // same commit is two lines converging on one dot from the same direction,
    // which is a line to nowhere.
    //
    // ⚠️ The first version of this fixture was `{m1: 'a s', m2: 's b', …}` and
    // tested nothing: `m2` had no child in the window, so it was a branch TIP and
    // correctly got a fresh lane. The claim needs `s` to be an EXTRA parent of the
    // second merge, and both merges need to be reachable from one tip.
    const layout = allocateLanes(
      history({ top: 'm1 m2', m1: 'a s', m2: 'b s', a: '', b: '', s: '' })
    );
    const rows = Object.fromEntries(layout.rows.map((r) => [r.id, r]));
    expect(rows.m1.branches).toHaveLength(1);
    const sideLane = rows.m1.branches[0];
    expect(rows.m2.branches).toEqual([sideLane]);
    // One lane for `s`, not two: three lanes in total, not four.
    expect(layout.lanes).toBe(3);
    // …and `s` itself lands in that lane, with nothing merging in, because only
    // one lane was ever waiting for it.
    expect(rows.s.lane).toBe(sideLane);
    expect(rows.s.merges).toEqual([]);
  });

  it('⚠️ a commit naming the SAME parent twice does not draw a loop', () => {
    // `git commit-tree -p X -p X` is accepted by git. A curve from a lane to
    // itself renders as a smudge, so it is dropped rather than drawn.
    const layout = allocateLanes(history({ m: 'a a', a: '' }));
    expect(layout.rows[0].branches).toEqual([]);
    expect(layout.lanes).toBe(1);
  });

  it('an OCTOPUS merge opens one lane per extra parent', () => {
    // Rare and real — git allows any number of parents.
    const layout = allocateLanes(history({ o: 'a b c d', a: '', b: '', c: '', d: '' }));
    expect(layout.rows[0].branches).toEqual([1, 2, 3]);
    expect(layout.lanes).toBe(4);
  });
});

describe('allocateLanes — AT WIDTH, which is the item’s acceptance bar', () => {
  /**
   * Five concurrent branches off one base, merged back one at a time.
   *
   * Written out rather than generated so the expected shape is readable: `t1..t5`
   * are five tips, each one commit above a shared base `base`.
   */
  const fiveWide = history({
    m: 't1 t2 t3 t4 t5',
    t1: 'base',
    t2: 'base',
    t3: 'base',
    t4: 'base',
    t5: 'base',
    base: '',
  });

  it('reaches five lanes, and the dots are all in different ones', () => {
    const layout = allocateLanes(fiveWide);
    expect(layout.lanes).toBe(5);
    const l = laneOf(layout);
    expect([l.t1, l.t2, l.t3, l.t4, l.t5]).toEqual([0, 1, 2, 3, 4]);
  });

  it('⚠️ the shared base collapses FOUR lanes into one, and says which four', () => {
    // The row that only exists past lane 1. Four curves arriving from above into
    // one dot — and if `merges` were computed from "the lanes occupied before"
    // rather than from "the lanes waiting for ME", this row would claim to absorb
    // lanes that belong to other branches entirely.
    const layout = allocateLanes(fiveWide);
    const base = layout.rows[layout.rows.length - 1];
    expect(base.lane).toBe(0);
    expect(base.merges).toEqual([1, 2, 3, 4]);
    expect(base.pass).toEqual([]);
    expect(base.down).toBe(false);
  });

  it('⚠️ `pass` names the lanes a row does NOT touch, and that is what gets drawn through', () => {
    // `t3`'s row: lanes 0,1,2,3,4 are all live, `t3` owns 2, and 0,1,3,4 pass
    // straight through. A `pass` that included its own lane would paint a line
    // over the dot; one that omitted a live lane would break a branch in half.
    const layout = allocateLanes(fiveWide);
    const t3 = layout.rows.find((r) => r.id === 't3')!;
    expect(t3.lane).toBe(2);
    expect(t3.pass).toEqual([0, 1, 3, 4]);
    expect(t3.merges).toEqual([]);
  });

  it('every row’s pass, merges and own lane are DISJOINT, at every width', () => {
    // The invariant that makes the SVG correct: no lane is drawn twice in one row.
    for (const h of [fiveWide, history({ m: 'a s', a: 'r', s: 'r', r: '' })]) {
      for (const row of allocateLanes(h).rows) {
        const all = [row.lane, ...row.pass, ...row.merges];
        expect(new Set(all).size).toBe(all.length);
      }
    }
  });

  it('no lane index ever exceeds the reported width', () => {
    const layout = allocateLanes(fiveWide);
    for (const row of layout.rows) {
      for (const i of [row.lane, ...row.pass, ...row.merges, ...row.branches]) {
        expect(i).toBeLessThan(layout.lanes);
        expect(i).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('goes past the DRAWN cap without lying about it', () => {
    // Eight concurrent tips: more than the gutter can distinguish. The allocator
    // stays honest (eight lanes, eight indexes) and the CLAMP is a drawing
    // decision, because two commits sharing a lane index would be a graph that is
    // confidently wrong about which line is which.
    const tips = Array.from({ length: 8 }, (_, i) => `t${i}`);
    const spec: Record<string, string> = { m: tips.join(' ') };
    for (const t of tips) spec[t] = 'base';
    spec.base = '';
    const layout = allocateLanes(history(spec));
    expect(layout.lanes).toBe(8);
    expect(layout.lanes).toBeGreaterThan(DRAWN_LANES);
    expect(laneClamped(7)).toBe(true);
    expect(laneColumn(7)).toBe(DRAWN_LANES - 1);
    expect(laneClamped(DRAWN_LANES - 1)).toBe(false);
    expect(laneColumn(2)).toBe(2);
  });
});

describe('allocateLanes — orphans', () => {
  it('the first row is always an orphan, because nothing is above it', () => {
    expect(allocateLanes(history({ c: 'b', b: 'a', a: '' })).orphans).toBe(1);
  });

  it('a second branch TIP is an orphan too, which is correct for `--all`', () => {
    // Two tips with no merge between them: two lanes, two orphans, and both are
    // real facts about the window rather than errors.
    const layout = allocateLanes(history({ tipA: 'x', tipB: 'y', x: '', y: '' }));
    expect(layout.orphans).toBe(2);
    expect(layout.lanes).toBe(2);
  });

  it('⚠️ a list in the WRONG ORDER produces orphans everywhere — which is the signal', () => {
    // Parents BEFORE children is what a date-ordered log can produce, and it is
    // the one precondition this function cannot check cheaply. It does not throw
    // and it does not guess: it draws stubs and the orphan count says so, because
    // "three branch tips" and "a mis-ordered list" are indistinguishable from
    // inside one pass.
    const correct = allocateLanes(history({ c: 'b', b: 'a', a: '' }));
    const reversed = allocateLanes(history({ a: '', b: 'a', c: 'b' }));
    expect(correct.orphans).toBe(1);
    expect(reversed.orphans).toBe(3);
  });
});
