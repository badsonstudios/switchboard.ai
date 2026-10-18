// Could a PERSON get to one of our windows right now? (#1277)
//
// The permission gate used to ask only whether a window EXISTS
// (`hasLiveWindow` in main/index.ts: not destroyed, renderer not crashed). The
// owner's log showed why that is the wrong question: 1,735 heartbeats in a row
// said `windows: 1` while the window sat at a position nobody could see, and
// every permission request in that stretch waited the full 300 s for a human
// who could not see it, then was denied. An alive-but-unreachable window has to
// take the same branch as no window at all. This module decides which windows
// are which.
//
// Pure and electron-free: a BrowserWindow satisfies `ReachProbe` structurally,
// and the work areas are handed in, so every state below is a unit test rather
// than a monitor someone has to unplug.
import type { Rectangle } from 'electron';
import { isOnAnyDisplay } from './window-state';

/** The window facts reachability needs — a BrowserWindow satisfies it. */
export interface ReachProbe {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): Rectangle;
  /** the rectangle a minimized window comes back to */
  getNormalBounds(): Rectangle;
}

export interface ReachPolicy {
  /**
   * Does a MINIMIZED window count as one a person can reach?
   *
   * TRUE, and that is a deliberate reading of DESIGN rather than of the brief
   * alone — see `MINIMIZED_IS_REACHABLE`. A minimized window has a taskbar
   * button that flashes when something needs you (`notifier.ts`), and §5.9's
   * actionable toast exists precisely so a permission can be answered "without
   * the app ever coming to the front". A minimized window is the ordinary state
   * of an app you are not looking at, not a lost one.
   */
  minimizedIsReachable: boolean;
  /**
   * macOS only: the app was hidden with Cmd+H (`app.isHidden()`). That is the
   * Mac's minimize — the Dock brings it straight back — so it is treated the
   * way `minimizedIsReachable` treats a minimized window. Nothing in this app
   * ever hides its own window, so on Windows and Linux a hidden window is one
   * nobody can find: it has no taskbar button at all.
   */
  appHiddenByUser: boolean;
}

/**
 * The owner-facing policy (#1277). ONE constant, so the open question in the
 * hand-off — "should a minimized window deny at once?" — is a one-line flip.
 */
export const MINIMIZED_IS_REACHABLE = true;

/** Why ONE window cannot be reached, or null if it can. */
function whyNot(win: ReachProbe, workAreas: Rectangle[], policy: ReachPolicy): string | null {
  if (win.isDestroyed()) return 'closed';
  if (workAreas.length === 0) return 'no display is attached';
  if (win.isMinimized()) {
    if (!policy.minimizedIsReachable) return 'minimized';
    // Restoring it from the taskbar has to land somewhere visible, or the
    // taskbar button is a button that opens nothing.
    return isOnAnyDisplay(win.getNormalBounds(), workAreas)
      ? null
      : 'minimized, and it would come back off every attached display';
  }
  if (!win.isVisible()) {
    if (!policy.appHiddenByUser) return 'hidden';
    // the Dock brings it back where it was, so that has to be somewhere visible
    // — the same test a minimized window's taskbar button gets above
    return isOnAnyDisplay(win.getBounds(), workAreas)
      ? null
      : 'hidden with Cmd+H, and it would come back off every attached display';
  }
  return isOnAnyDisplay(win.getBounds(), workAreas) ? null : 'off every attached display';
}

/**
 * Null when somebody could get to at least one of these windows; otherwise why
 * the MAIN one cannot be reached, for the log.
 *
 * A POPOUT COUNTS. A session popped out onto a visible monitor shows its own
 * approval bar there, so a main window that has wandered off-screen does not
 * make that session's question unanswerable. Popouts share the main window's
 * renderer, which is why the caller only asks this once `hasLiveWindow` has
 * said the renderer is alive.
 *
 * A probe that throws is the CALLER's to handle (`StreamPermissions` holds on
 * it); this function does not swallow, so the caller can log what broke.
 */
export function unreachableReason(
  main: ReachProbe,
  popouts: readonly ReachProbe[],
  workAreas: Rectangle[],
  policy: ReachPolicy
): string | null {
  const mainWhy = whyNot(main, workAreas, policy);
  if (mainWhy === null) return null;
  if (popouts.some((p) => whyNot(p, workAreas, policy) === null)) return null;
  return mainWhy;
}

/**
 * The gate as `main/index.ts` asks it (#1277), with the two moments that are
 * this app's to know about and not the predicate's:
 *
 * - NOT SHOWN YET: the main window is created with `show: false` and shown on
 *   `ready-to-show`. Invisible, and on its way, not lost.
 * - DISPLAYS SETTLING: mid-hotplug the OS can have the window between monitors
 *   for a moment, and the #864 restore is about to place it. Denying a question
 *   in that beat would throw away one the owner is about to see.
 *
 * Either way the answer is "reachable", with the hold's deadline underneath.
 * `exists: false` is `hasLiveWindow`'s half, not this one's, so it also answers
 * null: the router never asks this question about a window that is gone.
 */
export function gateUnreachable(
  state: { exists: boolean; shown: boolean; settling: boolean },
  reason: () => string | null
): string | null {
  if (!state.exists || !state.shown || state.settling) return null;
  return reason();
}
