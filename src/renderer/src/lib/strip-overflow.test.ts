// What is off each end of the sessions strip (#1143).
import { describe, it, expect } from 'vitest';
import { edgeOverflow, sameEdges, StripItemBox } from './strip-overflow';

const box = (from: number, to: number, need = 0): StripItemBox => ({ from, to, need });

describe('what is past each end of the strip', () => {
  it('is nothing when everything fits', () => {
    expect(edgeOverflow([box(0, 100), box(110, 300, 2)], 0, 400)).toEqual({
      before: { cut: false, need: 0 },
      after: { cut: false, need: 0 },
    });
  });

  it('says something is cut off, without a number, when nothing off-edge needs you', () => {
    const r = edgeOverflow([box(0, 100), box(110, 300), box(310, 500)], 0, 400);
    expect(r.after).toEqual({ cut: true, need: 0 });
    expect(r.before.cut).toBe(false);
  });

  it('counts a session that needs you once it is past the edge', () => {
    const r = edgeOverflow([box(0, 100), box(450, 600, 1), box(610, 760, 1)], 0, 400);
    expect(r.after).toEqual({ cut: true, need: 2 });
  });

  it('counts a group by its own number, not as one', () => {
    const r = edgeOverflow([box(-300, -100, 3), box(-90, 80), box(90, 300)], 0, 400);
    expect(r.before).toEqual({ cut: true, need: 3 });
  });

  it('does not count an item that is mostly still on screen', () => {
    // clipped by 20px of 200: it is still saying its own "1 need you" where you
    // can read it, and the arrow repeating it would show one demand twice
    const r = edgeOverflow([box(220, 420, 1)], 0, 400);
    expect(r.after).toEqual({ cut: true, need: 0 });
  });

  it('counts an item with only a sliver showing', () => {
    const r = edgeOverflow([box(380, 580, 1)], 0, 400);
    expect(r.after).toEqual({ cut: true, need: 1 });
  });

  it('never counts one item at both ends', () => {
    // wider than the whole view: cut off both ways, counted at neither, because
    // its middle is on screen
    const r = edgeOverflow([box(-100, 500, 4)], 0, 400);
    expect(r.before).toEqual({ cut: true, need: 0 });
    expect(r.after).toEqual({ cut: true, need: 0 });
  });

  it('ignores sub-pixel overhang', () => {
    const r = edgeOverflow([box(-0.4, 100), box(300, 400.6, 1)], 0, 400);
    expect(r.before.cut).toBe(false);
    expect(r.after.cut).toBe(false);
  });

  it('works in a view that does not start at zero', () => {
    const r = edgeOverflow([box(0, 150, 1), box(160, 400), box(900, 1000, 2)], 200, 800);
    expect(r.before).toEqual({ cut: true, need: 1 });
    expect(r.after).toEqual({ cut: true, need: 2 });
  });
});

describe('comparing two readings', () => {
  it('is the same only when both ends agree on both facts', () => {
    const a = edgeOverflow([box(450, 600, 1)], 0, 400);
    expect(sameEdges(a, edgeOverflow([box(460, 610, 1)], 0, 400))).toBe(true);
    expect(sameEdges(a, edgeOverflow([box(450, 600, 0)], 0, 400))).toBe(false);
    expect(sameEdges(a, edgeOverflow([box(0, 100)], 0, 400))).toBe(false);
  });
});
