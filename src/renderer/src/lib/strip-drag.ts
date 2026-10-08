// Where a drag on the sessions strip would land (#1143).
//
// The strip is one row, so everything here is the rail's own reordering turned
// on its side: the rail asks "above or below the middle of this row", the strip
// asks "before or after the middle of this entry". WHAT a drop then does is not
// decided here — that is `dropGroup` and `planReorder`, the same two functions
// the rail drops through, so an order made by dragging on the strip is the order
// the rail would have made.

/**
 * Which side of an entry the pointer is on, as "this would land before it" or
 * "after it" in READING order — so in a right-to-left layout the right-hand
 * half is `before`.
 */
export function edgeAtX(
  box: { left: number; right: number },
  clientX: number,
  rtl: boolean
): 'before' | 'after' {
  const leftHalf = clientX < (box.left + box.right) / 2;
  return leftHalf !== rtl ? 'before' : 'after';
}

/**
 * The position a dragged item takes among the OTHERS when dropped on that side
 * of `targetId` — the index `planReorder` asks for.
 *
 * Counted with the dragged item taken out first, which is what makes "drop it
 * just after its own neighbour" come out as the place it already is rather
 * than one further along.
 */
export function insertIndex(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  edge: 'before' | 'after'
): number {
  const rest = ids.filter((id) => id !== draggedId);
  const j = rest.indexOf(targetId);
  if (j < 0) return rest.length;
  return edge === 'before' ? j : j + 1;
}
