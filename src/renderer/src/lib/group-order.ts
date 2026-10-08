// Where a group goes when it is moved (#1144).
//
// Groups in the Sessions list are drawn in the order main keeps them, and main
// moves one by being told "put it just BEFORE this other group, or last"
// (`groups:move`). These two functions turn the two gestures — a step from the
// menu, a drop from a drag — into that answer.
//
// `null` from either means THERE IS NOTHING TO DO: the group is already at that
// end, was dropped where it already sits, or is not in the list. The caller
// uses that to grey the menu item and to draw no drop line, so an offer that
// would do nothing is never made.
//
// Pure, because "one above" and "just after" are each one off-by-one away from
// wrong, and the wrong answer here is silent: the group lands one place off and
// looks as if the drag was sloppy.

/** What `groups:move` is asked for. `beforeId: null` is "last". */
export interface GroupMove {
  id: string;
  beforeId: string | null;
}

/** One step up or down the list — the menu's Move up / Move down. */
export function stepGroup(
  ids: readonly string[],
  id: string,
  direction: 'up' | 'down'
): GroupMove | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  if (direction === 'up') return at === 0 ? null : { id, beforeId: ids[at - 1] };
  if (at === ids.length - 1) return null;
  // "down one" is "before the group after the next one" — or last, if the next
  // one is the end of the list
  return { id, beforeId: ids[at + 2] ?? null };
}

/**
 * A group dropped on the top or the bottom half of another group's card.
 *
 * `after: false` is "above the target", `true` is "below it".
 */
export function dropGroup(
  ids: readonly string[],
  id: string,
  targetId: string,
  after: boolean
): GroupMove | null {
  const from = ids.indexOf(id);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0 || id === targetId) return null;
  // the slot, counted in the list as it is now: 0 is above the first group
  const slot = after ? target + 1 : target;
  // on either side of where it already sits: nothing would move
  if (slot === from || slot === from + 1) return null;
  return { id, beforeId: ids[slot] ?? null };
}
