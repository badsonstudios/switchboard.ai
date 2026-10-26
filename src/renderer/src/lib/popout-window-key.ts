// Which popped-out OS window a dockview group lives in, named the way MAIN
// names it (#1456).
//
// Main's popout registry is keyed by the group id in the window's frame name —
// the group the window was opened for. The group a panel is in now may be a
// different one in the same window (a split inside the popout, a tab dropped on
// its edge, an anchor promoted after the first group left), and asking main for
// that id raised nothing. `shared/popout-frame.ts` has the whole story.
//
// The popout's DOM `window.name` IS the frame name main saw, and the window is
// same-origin to us (dockview built it), so it can be read directly.
import { groupIdFromFrameName } from '../../../shared/popout-frame';

/** The slice of a dockview group this needs. Structural, for tests. */
export interface PopoutKeyGroup {
  id: string;
  api: { location: { type: string; getWindow?: () => Window | undefined } };
}

/**
 * The id main knows this group's popout window by, or `null` when the group
 * is not popped out.
 *
 * Falls back to the group's own id when the window's name cannot be read (a
 * window closing under us) — which is right for a window's first group, the
 * only case the old code handled, so the fallback never does worse than it did.
 */
export function popoutWindowKey(group: PopoutKeyGroup | null | undefined): string | null {
  if (!group) return null;
  const loc = group.api.location;
  if (loc.type !== 'popout') return null;
  let name: string | undefined;
  try {
    name = loc.getWindow?.()?.name;
  } catch {
    // a closed window's proxy can throw on access: fall back below
  }
  return groupIdFromFrameName(name) ?? group.id ?? null;
}
