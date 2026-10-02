// @vitest-environment jsdom
// The lane gutter's ink (E24 Git v2 item 3).
//
// `lib/git-lanes.test.ts` owns the GEOMETRY — which lane, which curves, at eight
// lanes wide. This file owns the two things only the drawing can answer:
//
//   1. ⚠️ **EVERY COLOUR TOKEN IT NAMES ACTUALLY EXISTS.** Item 2's review found
//      two invented custom properties that had shipped — `--border-faint` and
//      `--diff-added-ink` — and both failed in total silence, because a `var()`
//      with a fallback cannot tell you the name was wrong. `tokens.drift.test.ts`
//      reads the token files and cannot see an inline style, so this is the only
//      place the two sides are ever compared. The first draft of `LANE_INKS`
//      opened with `--accent`, which does not exist; this test is what said so.
//   2. The SVG draws one element per fact and no element per non-fact: a root
//      commit has no line below it, the newest row has none above it, and nothing
//      is drawn twice over the same lane.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { LaneGutter, LANE_INKS, firstByColumn, laneGutterWidth } from './LaneGutter';
import { DRAWN_LANES, allocateLanes, type LaneRow } from '../lib/git-lanes';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function draw(row: LaneRow, width: number): Promise<SVGSVGElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<LaneGutter row={row} width={width} />);
  });
  const svg = document.body.querySelector('svg');
  if (!svg) throw new Error('no svg was drawn');
  return svg;
}

const rowsOf = (spec: Record<string, string>): LaneRow[] =>
  allocateLanes(
    Object.entries(spec).map(([id, parents]) => ({
      id,
      parentIds: parents === '' ? [] : parents.split(' '),
    }))
  ).rows;

describe('the lane colours', () => {
  it('⚠️ every token LANE_INKS names exists in tokens.css', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/theme/tokens.css'),
      'utf8'
    );
    for (const token of LANE_INKS) {
      // The DECLARATION, not a mention: `--accent-blue:` and not merely the
      // string appearing inside some other value.
      expect(css, `${token} is not declared in tokens.css`).toContain(`${token}:`);
    }
  });

  it('has one colour per drawn lane, so two adjacent lanes are never the same', () => {
    expect(LANE_INKS).toHaveLength(DRAWN_LANES);
    expect(new Set(LANE_INKS).size).toBe(DRAWN_LANES);
  });
});

describe('the gutter width', () => {
  it('grows with the lanes and stops at the drawn cap', () => {
    expect(laneGutterWidth(1)).toBeLessThan(laneGutterWidth(3));
    expect(laneGutterWidth(DRAWN_LANES)).toBe(laneGutterWidth(DRAWN_LANES + 5));
  });

  it('never returns zero, so a caller sizing a column has no special case', () => {
    expect(laneGutterWidth(0)).toBeGreaterThan(0);
    expect(laneGutterWidth(-3)).toBeGreaterThan(0);
  });
});

describe('the gutter', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('is DECORATIVE — the facts are words in the row, not geometry', async () => {
    // A screen reader reading the SVG as well would hear the commit twice, the
    // second time as a shape it cannot describe.
    const [top] = rowsOf({ c: 'b', b: 'a', a: '' });
    const svg = await draw(top, 1);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('the NEWEST row has no line above it', async () => {
    const [top] = rowsOf({ c: 'b', b: 'a', a: '' });
    const svg = await draw(top, 1);
    // One vertical line, and it starts at the middle rather than at the top.
    const lines = [...svg.querySelectorAll('line')];
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].getAttribute('y1'))).toBeGreaterThan(0);
  });

  it('⚠️ a ROOT commit has no line BELOW it — drawing one promises history that is not there', async () => {
    const rows = rowsOf({ c: 'b', b: 'a', a: '' });
    const svg = await draw(rows[rows.length - 1], 1);
    const lines = [...svg.querySelectorAll('line')];
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].getAttribute('y1'))).toBe(0);
  });

  it('a commit in the middle of a branch has a line through it, in two halves', async () => {
    const rows = rowsOf({ c: 'b', b: 'a', a: '' });
    const svg = await draw(rows[1], 1);
    expect([...svg.querySelectorAll('line')]).toHaveLength(2);
    expect([...svg.querySelectorAll('circle')]).toHaveLength(1);
  });

  it('a merge draws a curve OUT, and the shared parent draws one IN', async () => {
    const rows = rowsOf({ m: 'a s', a: 'r', s: 'r', r: '' });
    const merge = await draw(rows[0], 2);
    expect([...merge.querySelectorAll('path')]).toHaveLength(1);
    await act(async () => {
      root?.unmount();
      root = null;
    });
    document.body.innerHTML = '';
    const base = await draw(rows[rows.length - 1], 2);
    expect([...base.querySelectorAll('path')]).toHaveLength(1);
  });

  it('⚠️ at FIVE lanes it draws four pass-through lines and nothing over the dot', async () => {
    // The row that only exists past lane 1. `pass` must not include the commit's
    // own lane — a line through it would paint over the circle — and must include
    // every other live lane, or a branch breaks in half at this row.
    const rows = rowsOf({
      m: 't1 t2 t3 t4 t5',
      t1: 'base',
      t2: 'base',
      t3: 'base',
      t4: 'base',
      t5: 'base',
      base: '',
    });
    const t3 = rows.find((r) => r.id === 't3')!;
    const svg = await draw(t3, 5);
    const lines = [...svg.querySelectorAll('line')];
    // four passing through, plus this commit's own two halves
    expect(lines).toHaveLength(6);
    const circles = [...svg.querySelectorAll('circle')];
    expect(circles).toHaveLength(1);
    // Every x is distinct for the four pass lanes — a collapsed layout would draw
    // four lines on top of each other and look like one.
    const passX = new Set(
      lines.filter((l) => l.getAttribute('y1') === '0' && l.getAttribute('y2') !== '13').map((l) => l.getAttribute('x1'))
    );
    expect(passX.size).toBeGreaterThanOrEqual(4);
  });

  it('⚠️ a 2,000-LANE ROW DRAWS SIX LINES, not two thousand', async () => {
    // THE BUG A TEST FOUND BY RUNNING OUT OF MEMORY. `pass` is geometry truth and
    // can name two thousand lanes; the clamp was applied to the x COORDINATE and
    // not to the element count, so 1,994 invisible `<line>`s were stacked in the
    // last column — quadratic DOM nodes in the width of the history, for pixels
    // nobody can see. `HistoryPane`'s ceiling test exhausted the heap the moment
    // the gutter landed, which is the only reason this was noticed at all.
    expect(firstByColumn([0, 1, 2, 3, 4, 5, 6, 7, 8, 99, 2000])).toEqual([0, 1, 2, 3, 4, 5]);
    // ⚠️ THE LOWEST lane wins each column, whatever order they arrive in. First-seen
    // let a CLAMPED lane steal a real one's column — given `[7, 6, 5]`, lane 7
    // claimed column 5 and lane 5, the only one of the three the gutter can place
    // honestly, was dropped.
    expect(firstByColumn([7, 6, 5])).toEqual([5]);
    expect(firstByColumn([9, 2, 4])).toEqual([2, 4, 9]);

    const wide: LaneRow = {
      id: 'x'.repeat(40),
      lane: 0,
      up: true,
      down: true,
      pass: Array.from({ length: 2_000 }, (_, i) => i + 1),
      merges: [],
      branches: [],
    };
    const svg = await draw(wide, 2_000);
    // six columns: five passing through, plus the commit's own two halves
    expect([...svg.querySelectorAll('line')].length).toBeLessThanOrEqual(DRAWN_LANES + 2);
  });

  it('⚠️ a history WIDER than the gutter says so rather than lying about which line is which', async () => {
    const tips = Array.from({ length: 8 }, (_, i) => `t${i}`);
    const spec: Record<string, string> = { m: tips.join(' ') };
    for (const t of tips) spec[t] = 'base';
    spec.base = '';
    const rows = rowsOf(spec);
    const clampedRow = rows.find((r) => r.lane >= DRAWN_LANES)!;
    expect(clampedRow).toBeDefined();
    const svg = await draw(clampedRow, 8);
    expect(svg.querySelector('title')?.textContent).toContain('wider than');
  });

  it('every row of a five-wide history is the SAME width, so the dots line up', async () => {
    const rows = rowsOf({
      m: 't1 t2 t3 t4 t5',
      t1: 'base',
      t2: 'base',
      t3: 'base',
      t4: 'base',
      t5: 'base',
      base: '',
    });
    const widths = new Set<string>();
    for (const row of rows) {
      document.body.innerHTML = '';
      if (root) {
        const r = root;
        root = null;
        await act(async () => r.unmount());
      }
      const svg = await draw(row, 5);
      widths.add(svg.getAttribute('viewBox') ?? '');
    }
    expect(widths.size).toBe(1);
  });
});
