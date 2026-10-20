// How much of the diff panel's toolbar folds into its "…" menu (#1384).
//
// The toolbar grew from three controls to eleven, and it lives in a dock panel
// that can be dragged as narrow as the user likes — #532 is the precedent for a
// diff surface that has to keep working there. The rule from the issue: the
// toggles fold into an overflow menu BEFORE anything wraps.
//
// So the toolbar is a row of GROUPS, and the groups fold in a fixed order:
//
//   1. the view toggles and Open file — useful, but a reader can live without
//      seeing them all the time;
//   2. the Side by side / Inline pair (and its too-narrow note) — folds second,
//      because which layout you are reading in is already visible in the diff.
//
// Never folded: the path (it truncates instead — it is the panel's identity),
// ↑ / ↓ and the counter (the item's whole point), and pop-out.
//
// ⚠️ **MEASURED BY SUMMING THE PARTS, NOT FROM `scrollWidth`.** #885's and
// #903's lesson, and the memory note on Linux CI fonts: a flex row's
// `scrollWidth` hides what its children wanted, and Linux renders this text
// about 5% wider than Windows — so the inputs here are the widths each group
// actually measured on THIS machine, and a slack is kept on top.
//
// Pure, so the arithmetic is tested as a rule; the component only measures.

export interface ToolbarFitInput {
  /** the toolbar's content-box width, px */
  room: number;
  /** summed widths of the children that never fold (nav, pop-out) */
  fixed: number;
  /** how many top-level children `fixed` is made of */
  fixedCount: number;
  /** each foldable group's width, in FOLD ORDER (index 0 folds first) */
  groups: readonly number[];
  /** the "…" button's width, shown only when something is folded */
  more: number;
  /** the toolbar's `column-gap`, px */
  gap: number;
  /** the least the path may be squeezed to before folding beats truncating */
  pathMin: number;
}

/**
 * Px kept spare. Rounding, sub-pixel font metrics, and a counter that grows a
 * digit ("9 of 9" -> "10 of 12") between two measurements all spend some; the
 * cost of folding a little early is one click, the cost of folding late is a
 * wrapped toolbar.
 */
export const TOOLBAR_SLACK_PX = 8;

/** The width the row needs with the first `folded` groups in the menu. */
export function toolbarNeed(input: ToolbarFitInput, folded: number): number {
  const shown = input.groups.slice(folded);
  const children = 1 /* path */ + input.fixedCount + shown.length + (folded > 0 ? 1 : 0);
  return (
    input.pathMin +
    input.fixed +
    shown.reduce((n, w) => n + w, 0) +
    (folded > 0 ? input.more : 0) +
    input.gap * Math.max(0, children - 1)
  );
}

/**
 * How many groups to fold: the fewest that make the row fit with the slack to
 * spare. When even folding everything does not fit, everything folds — the
 * path then truncates further, which is what it is for.
 *
 * `room <= 0` is NOT A MEASUREMENT (a hidden dockview tab observes 0×0) and
 * answers `null`, so the caller keeps the last real verdict — the same rule
 * `isTooNarrowForColumns` follows, for the same flash it avoids.
 */
export function foldedGroups(input: ToolbarFitInput): number | null {
  if (!(input.room > 0)) return null;
  for (let k = 0; k <= input.groups.length; k++) {
    if (toolbarNeed(input, k) + TOOLBAR_SLACK_PX <= input.room) return k;
  }
  return input.groups.length;
}
