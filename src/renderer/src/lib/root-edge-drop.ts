// Dragging a session to the EDGE of the workspace gives it a column (or a
// row) of its own, the full height (or width) of the workspace (#731).
//
// ── WHAT WAS MEASURED BEFORE THIS WAS WRITTEN (2026-10-09, dockview 7.0.2) ───
//
// The owner: with two sessions stacked on one side and a third beside them, a
// stacked one could not be dragged out into its own full-height column; the
// drop "only lets the panel land above or below".
//
// A real mouse drag in the real app showed the full-height drop DOES exist. It
// is the docking library's "edge" target, and dropping there made exactly the
// column he wanted. But it was only offered within about EIGHT PIXELS of the
// workspace's edge (the library's default is 10), and its marker was a sliver
// 20 pixels wide. From 12 pixels in, the nearest card's own "split me" target
// took over, which is the above/below/beside-inside-the-stack he kept getting.
// A target you have to hit to within eight pixels is one you do not know is
// there.
//
// ── THE FIX, AND THE ONE THING IT MUST NOT BREAK ─────────────────────────────
//
// The library takes ONE size for all four edges (`dndEdges`). Widening it
// widens the TOP edge too, and along the top edge is every top-row card's row
// of tabs: at 40 pixels the edge target swallowed the whole row, and dropping
// a tab onto another card's tabs (#620) stopped working. (The #620 real-mouse
// test is what caught it.)
//
// So the zone is widened in the library, and then NARROWED AGAIN for the top
// and bottom edges here, by refusing the library's edge marker there unless
// the pointer is within the old ten pixels. A refused marker is not "used", so
// the tab or card underneath gets the drag as it always did.
//
// Left and right are the wide ones because a full-height COLUMN is what was
// asked for. ONE THING DOES LIVE ALONG THEM (found in review): the first
// and last 40 pixels of the outermost cards' rows of tabs. Dropping a tab
// "before the first tab" of the left-hand card is a drop in exactly that
// corner, so over a row of tabs the side zones are narrow as well.

/** what the docking library is told: how deep the edge zone is, and how big a
 *  marker it draws (a third of the workspace: it reads as "a new column") */
export const ROOT_EDGE_DROP = {
  activationSize: { type: 'pixels', value: 40 },
  size: { type: 'percentage', value: 30 },
} as const;

/** how deep the TOP and BOTTOM edge zones stay: the library's own default */
export const ROOT_EDGE_NARROW_PX = 10;

export type EdgePosition = 'left' | 'right' | 'top' | 'bottom' | 'center';

/**
 * Should the library's workspace-edge marker be offered here?
 *
 * `point` is the pointer and `dock` the workspace's box, both in viewport
 * pixels. Top and bottom: only within the narrow band. Left and right: the
 * whole widened zone (the library has already decided the pointer is in it),
 * EXCEPT over a row of tabs, where they are narrow too.
 */
export function rootEdgeDropAllowed(
  position: EdgePosition,
  point: { x: number; y: number },
  dock: { left: number; top: number; right: number; bottom: number },
  overTabRow = false
): boolean {
  if (position === 'top') return point.y - dock.top <= ROOT_EDGE_NARROW_PX;
  if (position === 'bottom') return dock.bottom - point.y <= ROOT_EDGE_NARROW_PX;
  if (overTabRow) {
    if (position === 'left') return point.x - dock.left <= ROOT_EDGE_NARROW_PX;
    if (position === 'right') return dock.right - point.x <= ROOT_EDGE_NARROW_PX;
  }
  return true;
}
