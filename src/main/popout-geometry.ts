// Popout geometry, captured from the main process (#86).
//
// dockview serializes a popout's position by polling `screenX` from a debounced
// requestAnimationFrame loop. rAF throttles in a backgrounded window — the exact
// state the main window is in while you drag a popout across monitors — so a
// quit can easily beat the poll, and the STALE (usually open-time) position is
// what gets restored. That's how a popout comes back straddling two monitors.
//
// Electron knows each window's true rect and doesn't care about focus, so we
// overwrite the layout's popout positions from the live windows just before the
// app goes away. Kept pure here so the patching is unit-testable without an app.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** a live popout window's rect, tagged with the dockview group it hosts */
export interface LivePopout {
  /** dockview group id, parsed from the popout window's frame name */
  groupId?: string;
  box: Box;
}

interface PopoutGroup {
  position?: Box | null;
  data?: { id?: string } | unknown;
  [k: string]: unknown;
}
interface Layout {
  popoutGroups?: PopoutGroup[];
  [k: string]: unknown;
}

/** dockview names a popout window `<componentId>-<groupId>` */
export function groupIdFromFrameName(frameName: string | undefined): string | undefined {
  if (!frameName) return undefined;
  const i = frameName.lastIndexOf('-');
  return i > 0 && i < frameName.length - 1 ? frameName.slice(i + 1) : undefined;
}

function idOf(group: PopoutGroup): string | undefined {
  const data = group.data as { id?: unknown } | undefined;
  return typeof data?.id === 'string' ? data.id : undefined;
}

/**
 * Overwrite each popout group's stored position with the live one.
 *
 * Matched by dockview GROUP ID, not by position in the array: dockview appends
 * its popout entries when the child window finishes LOADING, while we see them
 * when the window is CREATED. Restores are staggered ~100ms apart, so a slow
 * first load is enough to invert the two lists — and index-matching would then
 * confidently stamp one popout's rect onto another, swapping two windows
 * between monitors. That is the very bug this file exists to fix.
 *
 * If ids are unavailable on both sides (older layouts), fall back to index
 * order — but only when the counts agree. A mismatch means we can't know which
 * is which, and a stale position beats a wrong one.
 *
 * `boxes` carry OUTER origins with CONTENT sizes: that's what dockview stores
 * (`screenX` + `innerWidth`), and the popout is reopened with `useContentSize`,
 * so both ends speak the same units.
 */
export function patchPopoutPositions(layout: unknown, live: LivePopout[]): unknown {
  if (!layout || typeof layout !== 'object') return layout;
  const l = { ...(layout as Layout) };
  const groups = l.popoutGroups;
  if (!Array.isArray(groups) || groups.length === 0) return l;

  const byId = new Map<string, Box>();
  for (const p of live) if (p.groupId) byId.set(p.groupId, p.box);
  const anyIdMatches = groups.some((g) => {
    const id = idOf(g);
    return !!id && byId.has(id);
  });
  const canFallBackToOrder = !anyIdMatches && live.length === groups.length;

  l.popoutGroups = groups.map((group, i) => {
    const id = idOf(group);
    const box = id && byId.has(id) ? byId.get(id) : canFallBackToOrder ? live[i]?.box : undefined;
    if (!box || !isUsableBox(box)) return group;
    return { ...group, position: { ...box } };
  });
  return l;
}

/**
 * Undo dockview's double-count of the opener origin on restore (#86).
 *
 * When a popout is torn off fresh, dockview measures the panel's rect INSIDE
 * the opener and opens the window at `opener.screenX + rect.left` — correct.
 * When it RESTORES one, it feeds the saved rect through the same path — but
 * that rect is already absolute screen coordinates, so the opener's origin gets
 * added a second time. The popout marches across the desktop by the width of
 * the main window's offset on every relaunch, which is how one ends up
 * straddling two monitors.
 *
 * This is exact, not a guess: a restore is identified by finding a stored box
 * that, plus the opener origin, equals what dockview asked for — AND whose size
 * matches, since dockview passes a restored box's width/height through
 * untouched. Requiring both makes a coincidental origin collision with a
 * freshly torn-off panel rect (which carries the panel's own size) a non-event.
 */
export function resolvePopoutBounds(
  asked: Partial<{ x: number; y: number; width: number; height: number }>,
  openerOrigin: { x: number; y: number },
  storedBoxes: Box[],
  tolerance = 2
): { bounds: typeof asked; matchedIndex: number } {
  if (typeof asked.x !== 'number' || typeof asked.y !== 'number') {
    return { bounds: asked, matchedIndex: -1 };
  }
  const matchedIndex = storedBoxes.findIndex(
    (box) =>
      isUsableBox(box) &&
      Math.abs(openerOrigin.x + box.left - asked.x!) <= tolerance &&
      Math.abs(openerOrigin.y + box.top - asked.y!) <= tolerance &&
      (typeof asked.width !== 'number' || Math.abs(box.width - asked.width) <= tolerance) &&
      (typeof asked.height !== 'number' || Math.abs(box.height - asked.height) <= tolerance)
  );
  if (matchedIndex === -1) return { bounds: asked, matchedIndex };
  const box = storedBoxes[matchedIndex];
  return {
    bounds: { ...asked, x: box.left, y: box.top, width: box.width, height: box.height },
    matchedIndex,
  };
}

/** a minimized or zero-size window reports junk we must not persist or apply */
export function isUsableBox(box: Box | null | undefined): box is Box {
  return (
    !!box &&
    Number.isFinite(box.left) &&
    Number.isFinite(box.top) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}
