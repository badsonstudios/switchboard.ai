// The commit graph's ink (E24 Git v2 item 3, §5.7) — mockup screen 6.
//
// One `<svg>` per row, sized in lane indexes by `lib/git-lanes.ts` and turned into
// pixels here. The split is the point: `allocateLanes` is a pure topological walk
// that can be tested at eight lanes without a DOM, and this file knows nothing
// except where a lane index sits and what colour it is.
//
// ⚠️ **ONE SVG PER ROW, NOT ONE OVER THE WHOLE LIST.** A single tall SVG would have
// to be re-laid-out on every filter keystroke and every "show 50 more", and it
// would have to know each row's height — which is a text measurement, in a font
// the theme can change. A per-row SVG stretches to whatever height its row became
// (`preserveAspectRatio="none"` over a fixed viewBox), so the graph follows the
// rows instead of the rows following the graph.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { DRAWN_LANES, laneClamped, laneColumn, type LaneRow } from '../lib/git-lanes';

/** px between lane centres, and the gutter's own padding. */
const LANE_W = 13;
const LANE_X0 = 8;

/** The viewBox's height. Arbitrary — `preserveAspectRatio="none"` scales it. */
const VB_H = 26;

/**
 * The six lane colours, as token names.
 *
 * ⚠️ **TOKENS, NOT LITERALS, AND THE REVIEW OF ITEM 2 IS WHY THE NAMES ARE
 * CHECKED.** Two invented custom properties shipped in that item — `--border-faint`
 * and `--diff-added-ink` — and both failed silently, because a `var()` with a
 * fallback cannot tell you the name was wrong. Every name below exists in
 * `theme/tokens.css`; `lane-colours.test.ts` is the standing check, since the token
 * drift test reads the token files and cannot see an inline style.
 *
 * Six because `DRAWN_LANES` is six, and they are reused by index modulo that —
 * the colour identifies a LANE, not a branch, which is what every git GUI does and
 * is the only thing possible without naming every branch in the window.
 *
 * ⚠️ **AND THE FIRST DRAFT OF THIS LIST OPENED WITH `--accent`, WHICH DOES NOT
 * EXIST** — the token is `--accent-blue`, one of an eight-colour palette
 * (`tokens.css` §accents) that is exactly the right thing for lanes and that
 * nothing here knew about. Found by checking rather than by looking at it, which
 * is the entire argument for the test.
 */
export const LANE_INKS = [
  '--accent-blue',
  '--accent-indigo',
  '--accent-violet',
  '--accent-green',
  '--accent-teal',
  '--accent-coral',
] as const;

function ink(lane: number): string {
  return `var(${LANE_INKS[laneColumn(lane) % LANE_INKS.length]})`;
}

const x = (lane: number): number => LANE_X0 + laneColumn(lane) * LANE_W;

/**
 * The gutter for one row.
 *
 * `width` is the layout's lane count, clamped — passed in rather than recomputed,
 * so every row in a list is the same width and the dots line up vertically. A row
 * that sized itself to its own lanes would make the column breathe as you scroll.
 */
export function LaneGutter(props: { row: LaneRow; width: number }): React.JSX.Element {
  const { t } = useTranslation();
  const row = props.row;
  const columns = Math.min(Math.max(props.width, 1), DRAWN_LANES);
  const vbWidth = LANE_X0 * 2 + (columns - 1) * LANE_W;
  const cx = x(row.lane);
  const mid = VB_H / 2;
  const clamped = laneClamped(row.lane) || row.pass.some(laneClamped);
  /**
   * The pass-through lanes, ONE PER VISIBLE COLUMN.
   *
   * See the `pass` block below for why this exists rather than mapping `pass`
   * directly. `firstByColumn` keeps the LEFTMOST lane for each column, so the
   * colour drawn in the clamped column is the colour of the leftmost branch
   * sharing it — stable as you scroll, rather than whichever happened to be last.
   */
  const passColumns = React.useMemo(() => firstByColumn(row.pass), [row.pass]);

  return (
    <svg
      className="history-lane"
      viewBox={`0 0 ${vbWidth} ${VB_H}`}
      preserveAspectRatio="none"
      // DECORATIVE: every fact the graph draws — the merge, the refs, the author —
      // is in the row's own `aria-label` as words. A screen reader reading the SVG
      // as well would hear the commit twice, once as geometry it cannot describe.
      aria-hidden="true"
      style={{ inlineSize: vbWidth, blockSize: '100%', flexShrink: 0, display: 'block' }}
    >
      {/* Lanes passing straight through, drawn FIRST so the dot and the curves
          land on top of them rather than under.

          ⚠️ **ONE LINE PER DRAWN COLUMN, NOT ONE PER LANE — and the first version
          got that wrong in a way a test found by running out of memory.** `pass`
          is geometry truth and can name two thousand lanes; `laneColumn` clamps
          them all into six, so mapping over `pass` directly emitted two thousand
          `<line>` elements per row with 1,994 of them stacked invisibly in the last
          column. Quadratic DOM nodes in the width of the history, for pixels
          nobody can see. The clamp has to apply to the ELEMENT COUNT and not only
          to the x coordinate. */}
      {passColumns.map((lane) => (
        <line
          key={`p${lane}`}
          x1={x(lane)}
          y1={0}
          x2={x(lane)}
          y2={VB_H}
          stroke={ink(lane)}
          strokeWidth={2}
        />
      ))}
      {/* This commit's own lane, in two halves, because the two halves mean
          different things: `up` is "a child of this commit is above", `down` is
          "this commit has a parent". A root commit has no bottom half and the
          newest row has no top half, and drawing either anyway would promise
          history that is not there. */}
      {row.up && <line x1={cx} y1={0} x2={cx} y2={mid} stroke={ink(row.lane)} strokeWidth={2} />}
      {row.down && <line x1={cx} y1={mid} x2={cx} y2={VB_H} stroke={ink(row.lane)} strokeWidth={2} />}
      {/* Curves IN from above: another child's lane ending at this commit. Drawn
          in the SOURCE lane's colour, so the eye can follow a branch down to where
          it joined rather than losing it at the join. */}
      {row.merges.map((lane) => (
        <path
          key={`m${lane}`}
          d={`M ${x(lane)} 0 C ${x(lane)} ${mid * 0.8}, ${cx} ${mid * 0.4}, ${cx} ${mid}`}
          fill="none"
          stroke={ink(lane)}
          strokeWidth={2}
        />
      ))}
      {/* Curves OUT below: an extra parent of a merge. Same colouring rule, for
          the same reason — this is the line you will follow downward. */}
      {row.branches.map((lane) => (
        <path
          key={`b${lane}`}
          d={`M ${cx} ${mid} C ${cx} ${mid * 1.4}, ${x(lane)} ${mid * 1.2}, ${x(lane)} ${VB_H}`}
          fill="none"
          stroke={ink(lane)}
          strokeWidth={2}
        />
      ))}
      {/* The dot. Hollow for a merge, so a merge is identifiable from the geometry
          as well as from the `⑃` in the row — two readings of one fact, which is
          what makes a graph scannable. */}
      <circle
        cx={cx}
        cy={mid}
        r={row.merges.length > 0 || row.branches.length > 0 ? 4.5 : 4}
        fill={row.branches.length > 0 ? 'var(--card-bg)' : ink(row.lane)}
        stroke={ink(row.lane)}
        strokeWidth={2}
      />
      {/* ⚠️ THE CLAMP IS VISIBLE. A history wider than the gutter draws its extra
          lanes in the last column, which means two different branches share one
          line — so the row says so instead of quietly lying about which is which.
          `title` on an `aria-hidden` SVG is for the pointer; the words are also in
          the row's label. */}
      {clamped && <title>{t('history.laneClamped', { count: DRAWN_LANES })}</title>}
    </svg>
  );
}

/**
 * One lane per drawn column — the LOWEST lane index of however many share it.
 *
 * Bounds the element count at `DRAWN_LANES` whatever the history's real width is.
 * Exported for the test, because "a 2,000-lane row draws six lines" is the claim
 * and it cannot be read off the picture.
 *
 * ⚠️ **"LOWEST", NOT "FIRST SEEN", AND A TEST CAUGHT THE DIFFERENCE.** First-seen
 * let a CLAMPED lane steal a real one's column: given `[7, 6, 5]`, lane 7 claimed
 * column 5 and lane 5 — which genuinely belongs there and is the only one of the
 * three the gutter can place honestly — was dropped. In practice `pass` arrives
 * ascending, so first-seen happened to be right; depending on that is how an
 * ordering assumption becomes a bug the day something re-sorts.
 */
export function firstByColumn(lanes: readonly number[]): number[] {
  const lowest = new Map<number, number>();
  for (const lane of lanes) {
    const column = laneColumn(lane);
    const held = lowest.get(column);
    if (held === undefined || lane < held) lowest.set(column, lane);
  }
  return [...lowest.values()].sort((a, b) => a - b);
}

/** The gutter's pixel width for a given lane count — the row reserves this. */
export function laneGutterWidth(lanes: number): number {
  const columns = Math.min(Math.max(lanes, 1), DRAWN_LANES);
  return LANE_X0 * 2 + (columns - 1) * LANE_W;
}
