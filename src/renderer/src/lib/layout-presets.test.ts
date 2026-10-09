// One-click arrangements and "make them even" (#1147): the arithmetic.
import { describe, it, expect } from 'vitest';
import {
  assignSlots,
  evenSizes,
  GridNode,
  isEven,
  LAYOUT_PRESETS,
  PresetPanel,
  SerializedGrid,
  slotCount,
  slotPlan,
} from './layout-presets';

const s = (id: string): PresetPanel => ({ id, session: true });
const other = (id: string): PresetPanel => ({ id, session: false });
const leaf = (id: string): GridNode => ({ type: 'leaf', data: { id } });
const branch = (...kids: GridNode[]): GridNode => ({ type: 'branch', data: kids });

describe('how many places a shape has', () => {
  it('never has more places than there are sessions', () => {
    expect(slotCount('columns3', 2)).toBe(2);
    expect(slotCount('grid', 3)).toBe(3);
    expect(slotCount('columns2', 1)).toBe(1);
  });

  it('never has more places than the shape has, however many sessions', () => {
    expect(slotCount('single', 9)).toBe(1);
    expect(slotCount('columns2', 9)).toBe(2);
    expect(slotCount('columns3', 9)).toBe(3);
    expect(slotCount('rows', 9)).toBe(2);
    expect(slotCount('grid', 9)).toBe(4);
  });

  it('has one place even for nothing at all', () => {
    for (const p of LAYOUT_PRESETS) expect(slotCount(p, 0)).toBe(1);
  });
});

describe('how each shape is built', () => {
  it('single is one place, with nothing split off', () => {
    expect(slotPlan('single', 5)).toEqual([]);
  });

  it('columns go to the right, each beside the one before', () => {
    expect(slotPlan('columns2', 5)).toEqual([{ beside: 0, direction: 'right' }]);
    expect(slotPlan('columns3', 5)).toEqual([
      { beside: 0, direction: 'right' },
      { beside: 1, direction: 'right' },
    ]);
  });

  it('rows put the second under the first', () => {
    expect(slotPlan('rows', 5)).toEqual([{ beside: 0, direction: 'below' }]);
  });

  it('the grid is two on top and two underneath', () => {
    expect(slotPlan('grid', 4)).toEqual([
      { beside: 0, direction: 'right' },
      { beside: 'edge', direction: 'below' },
      { beside: 2, direction: 'right' },
    ]);
  });

  it('the grid with three gives the third the whole bottom row', () => {
    expect(slotPlan('grid', 3)).toEqual([
      { beside: 0, direction: 'right' },
      { beside: 'edge', direction: 'below' },
    ]);
  });

  it('a shape with too few sessions is the smaller shape, not one with a hole', () => {
    expect(slotPlan('grid', 2)).toEqual(slotPlan('columns2', 2));
    expect(slotPlan('columns3', 1)).toEqual([]);
  });
});

describe('which session goes where', () => {
  it('follows the Sessions list, first to the first place', () => {
    const places = [[s('c')], [s('a')], [s('b')]];
    expect(assignSlots('columns3', places, ['a', 'b', 'c'])).toEqual([['a'], ['b'], ['c']]);
  });

  it('⭐ extras stack as tabs in the LAST place: 2-up with five open', () => {
    const places = [[s('a'), s('b'), s('c'), s('d'), s('e')]];
    expect(assignSlots('columns2', places, ['a', 'b', 'c', 'd', 'e'])).toEqual([
      ['a'],
      ['b', 'c', 'd', 'e'],
    ]);
  });

  it('single stacks every session in one place, in list order', () => {
    const places = [[s('b')], [s('a')], [s('c')]];
    expect(assignSlots('single', places, ['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
  });

  it('loses nothing and repeats nothing, for every shape', () => {
    const places = [[s('a'), other('diff-a')], [s('b')], [other('doc-1')], [s('c'), s('d')]];
    for (const p of LAYOUT_PRESETS) {
      const out = assignSlots(p, places, ['a', 'b', 'c', 'd']).flat();
      expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'diff-a', 'doc-1']);
    }
  });

  it('a changes panel goes where the session it sat with went', () => {
    const places = [[s('a')], [s('b'), other('diff-b')]];
    // b is first in the list, so b (and its changes panel) take the first place
    expect(assignSlots('columns2', places, ['b', 'a'])).toEqual([['b', 'diff-b'], ['a']]);
  });

  it('a panel that sat with no session goes to the last place', () => {
    const places = [[other('doc-1')], [s('a')], [s('b')]];
    expect(assignSlots('columns2', places, ['a', 'b'])).toEqual([['a'], ['b', 'doc-1']]);
  });

  it('a session the list does not name goes after the ones it does', () => {
    const places = [[s('new')], [s('a')], [s('b')]];
    expect(assignSlots('columns3', places, ['a', 'b'])).toEqual([['a'], ['b'], ['new']]);
  });

  it('a workspace with no session cards still arranges what is there', () => {
    const places = [[other('doc-1'), other('doc-2')]];
    expect(assignSlots('columns2', places, [])).toEqual([['doc-1'], ['doc-2']]);
  });

  it('an empty workspace is one empty place', () => {
    expect(assignSlots('grid', [], [])).toEqual([[]]);
  });
});

describe('make them even', () => {
  it('⭐ two side by side come back to half each (the owner’s case)', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('l'), leaf('r')),
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid)).toEqual([
      { id: 'l', width: 500, height: 600 },
      { id: 'r', width: 500, height: 600 },
    ]);
  });

  it('two stacked come back to half the height each', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('t'), leaf('b')),
      width: 1000,
      height: 600,
      orientation: 'VERTICAL',
    };
    expect(evenSizes(grid)).toEqual([
      { id: 't', width: 1000, height: 300 },
      { id: 'b', width: 1000, height: 300 },
    ]);
  });

  it('three columns are a third each', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('a'), leaf('b'), leaf('c')),
      width: 900,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid).map((e) => e.width)).toEqual([300, 300, 300]);
  });

  it('a 2-by-2 is four equal quarters', () => {
    const grid: SerializedGrid = {
      root: branch(branch(leaf('a'), leaf('b')), branch(leaf('c'), leaf('d'))),
      width: 1000,
      height: 600,
      orientation: 'VERTICAL',
    };
    const sizes = evenSizes(grid);
    expect(sizes).toHaveLength(4);
    for (const e of sizes) expect(e).toMatchObject({ width: 500, height: 300 });
  });

  it('is even per split: one on the left, two stacked on the right', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('left'), branch(leaf('top'), leaf('bottom'))),
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid)).toEqual([
      { id: 'left', width: 500, height: 600 },
      { id: 'top', width: 500, height: 300 },
      { id: 'bottom', width: 500, height: 300 },
    ]);
  });

  it('sizes the outer pieces before anything inside them', () => {
    const grid: SerializedGrid = {
      root: branch(branch(leaf('inner1'), leaf('inner2')), leaf('outer')),
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid).map((e) => e.id)).toEqual(['outer', 'inner1', 'inner2']);
  });

  it('⚠️ a place that is not on screen gets no share (a popped-out window leaves one)', () => {
    // two cards and the spot a popped-out third will come back to: the two
    // on screen are half each, not a third each with a third for nothing
    const ghost: GridNode = { type: 'leaf', data: { id: 'ghost' }, visible: false };
    const grid: SerializedGrid = {
      root: branch(leaf('l'), ghost, leaf('r')),
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid)).toEqual([
      { id: 'l', width: 500, height: 600 },
      { id: 'r', width: 500, height: 600 },
    ]);
    // ...and "already even" can be true, so the button stops claiming it did something
    expect(isEven(grid, () => ({ width: 500, height: 600 }))).toBe(true);
  });

  it('a split whose places are all hidden is not there either', () => {
    const ghost = (id: string): GridNode => ({ type: 'leaf', data: { id }, visible: false });
    const grid: SerializedGrid = {
      root: branch(leaf('a'), branch(ghost('g1'), ghost('g2')), leaf('b')),
      width: 900,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid).map((e) => [e.id, e.width])).toEqual([['a', 450], ['b', 450]]);
  });

  it('one session alone fills the workspace', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('only')),
      width: 800,
      height: 500,
      orientation: 'HORIZONTAL',
    };
    expect(evenSizes(grid)).toEqual([{ id: 'only', width: 800, height: 500 }]);
  });

  it('knows when there is nothing to do, to within a couple of pixels', () => {
    const grid: SerializedGrid = {
      root: branch(leaf('l'), leaf('r')),
      width: 1001,
      height: 600,
      orientation: 'HORIZONTAL',
    };
    const at = (w: number) => (id: string) => ({ width: id === 'l' ? w : 1001 - w, height: 600 });
    expect(isEven(grid, at(500))).toBe(true);
    expect(isEven(grid, at(640))).toBe(false);
    expect(isEven(grid, () => undefined)).toBe(false);
  });
});
