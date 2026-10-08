// What is off each end of the sessions strip (#1143).
//
// The strip is one row that scrolls sideways, and a row that scrolls can hide
// the one session that is waiting on you. So each end of it has a fixed cell
// that says what is past that edge: nothing, something, or — in amber, with a
// number — sessions that need you. This file is the arithmetic; the strip
// measures the boxes and draws the cells.
//
// Pure, and in physical pixels along one axis. Which end is "start" in a
// right-to-left layout is the caller's question, not this function's.

export interface StripItemBox {
  /** the item's near and far edges, in the same coordinates as the view's */
  from: number;
  to: number;
  /** how many sessions this item stands for that need you: 0 or 1 for a
   *  session, the group's own count for a group */
  need: number;
}

export interface EdgeState {
  /** something is cut off past this edge */
  cut: boolean;
  /** how many sessions that need you are past it */
  need: number;
}

/** sub-pixel layout noise: an item 0.4px over the edge is not "cut off" */
const SLACK = 1;

/**
 * What is past the low edge (`before`) and the high edge (`after`) of the view.
 *
 * AN ITEM COUNTS TOWARD AN EDGE'S NUMBER WHEN ITS MIDPOINT IS PAST THAT EDGE.
 * Not "any part": a group with two pixels clipped is still on screen, saying
 * its own "2 need you" where you can read it, and counting it again in the
 * arrow would show the same demand twice. Not "the whole of it" either: a
 * session with only a sliver showing is not one you can read. The midpoint is
 * the line between those two, and it means each item is counted in at most one
 * place.
 */
export function edgeOverflow(
  items: readonly StripItemBox[],
  viewFrom: number,
  viewTo: number
): { before: EdgeState; after: EdgeState } {
  const before: EdgeState = { cut: false, need: 0 };
  const after: EdgeState = { cut: false, need: 0 };
  for (const it of items) {
    const mid = (it.from + it.to) / 2;
    if (it.from < viewFrom - SLACK) {
      before.cut = true;
      if (mid < viewFrom) before.need += it.need;
    }
    if (it.to > viewTo + SLACK) {
      after.cut = true;
      if (mid > viewTo) after.need += it.need;
    }
  }
  return { before, after };
}

export function sameEdges(
  a: { before: EdgeState; after: EdgeState },
  b: { before: EdgeState; after: EdgeState }
): boolean {
  return (
    a.before.cut === b.before.cut &&
    a.before.need === b.before.need &&
    a.after.cut === b.after.cut &&
    a.after.need === b.after.need
  );
}
