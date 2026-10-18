// Say where the main window went (#1277).
//
// The owner's report — "the session window closed out or minimized, and I had to
// go over to the session list and click it to bring it back up" — left NO trace
// in the log. The `ui` subsystem logged `window shown` at boot and #864's
// `main window returned to its remembered display`, and nothing else: no
// minimize, no hide, no move, no restore. So every report of a window that
// wandered off was a guess. This logs each of those transitions with the
// window's bounds and the display it is on, so the next report can be read off
// the log instead of reconstructed.
//
// Electron-free, like `window-reach.ts`: the window and the display lookup are
// handed in, so the debounce and the off-screen transitions are unit tests.
import type { Rectangle } from 'electron';
import type { Logger } from './log/logger';
import { isOnAnyDisplay } from './window-state';

/** What this needs from a BrowserWindow — a real one satisfies it. */
export interface PlacementWindow {
  on(event: string, listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): Rectangle;
  getNormalBounds(): Rectangle;
}

export interface PlacementDeps {
  log: Pick<Logger, 'info' | 'warn'>;
  workAreas: () => Rectangle[];
  /** the OS display the rectangle is on (Electron's `getDisplayMatching`), or null */
  displayIdOf: (bounds: Rectangle) => number | null;
  /** how long a burst of move/resize events must be quiet before it is logged */
  moveSettleMs?: number;
}

/** `x,y wxh` — the shape #864's restore line already uses, so the two grep together. */
export function rectText(b: Rectangle): string {
  return `${b.x},${b.y} ${b.width}x${b.height}`;
}

/**
 * The window state transitions that are logged the moment they happen. Each is
 * a discrete event the OS raises once; `move`/`resize` are not in this list
 * because they fire continuously during a drag (and during an OS shuffle) and
 * are debounced instead.
 */
export const PLACEMENT_EVENTS = [
  'minimize',
  'restore',
  'hide',
  'show',
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
] as const;

/**
 * Log the main window's placement transitions in `ui`.
 *
 * Every line carries the same fields — `bounds`, `displayId`, `onScreen`, and
 * the three state flags — so one grep for `main window` reads as a timeline.
 * `normalBounds` rides along when the window is maximized or minimized, because
 * that is the rectangle it comes back to, and #864's restore path writes it.
 *
 * Going OFF every attached display is a `warn`, coming back is an `info`, each
 * logged once per transition, so it is impossible to miss in a log. It is the
 * commonest way the permission gate (#1277) starts declining, but not the only
 * one and not a guarantee: a hidden window also declines, and a visible popout
 * or a hotplug still settling keeps holds on. The gate logs its own `why`.
 */
export function watchMainWindowPlacement(win: PlacementWindow, deps: PlacementDeps): PlacementWatch {
  const settleMs = deps.moveSettleMs ?? 400;
  let onScreen = true;
  let moveTimer: NodeJS.Timeout | undefined;

  const describe = (): Record<string, unknown> => {
    const bounds = win.getBounds();
    const minimized = win.isMinimized();
    const maximized = win.isMaximized();
    // a minimized window's own bounds are wherever the OS parks it; the
    // rectangle that matters is the one it comes back to
    const placed = minimized ? win.getNormalBounds() : bounds;
    const visible = isOnAnyDisplay(placed, deps.workAreas());
    return {
      bounds: rectText(bounds),
      ...(minimized || maximized ? { normalBounds: rectText(win.getNormalBounds()) } : {}),
      displayId: deps.displayIdOf(placed),
      onScreen: visible,
      minimized,
      maximized,
      visible: win.isVisible(),
    };
  };

  const checkOnScreen = (fields: Record<string, unknown>): void => {
    const now = fields.onScreen === true;
    if (now === onScreen) return;
    onScreen = now;
    if (now) deps.log.info('main window is back on an attached display', fields);
    else deps.log.warn('main window is off every attached display', fields);
  };

  const report = (what: string): void => {
    try {
      if (win.isDestroyed()) return;
      const fields = describe();
      deps.log.info(`main window ${what}`, fields);
      checkOnScreen(fields);
    } catch {
      // diagnostics must never be why a window event handler throws
    }
  };

  for (const ev of PLACEMENT_EVENTS) win.on(ev, () => report(ev));

  const onMove = (): void => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => report('moved'), settleMs);
    moveTimer.unref?.();
  };
  win.on('move', onMove);
  win.on('resize', onMove);
  win.on('closed', () => clearTimeout(moveTimer));

  return {
    recheck: () => {
      try {
        if (win.isDestroyed()) return;
        checkOnScreen(describe());
      } catch {
        // diagnostics must never be why a display handler throws
      }
    },
  };
}

/** What `watchMainWindowPlacement` hands back. */
export interface PlacementWatch {
  /**
   * Re-judge on-screen-ness WITHOUT a window event (review, #1277). A display
   * detaching can leave the window off every display without the window itself
   * raising anything (a minimized or full-screen one, whose restore is
   * deferred), so the display handlers call this. Logs only a transition — the
   * same off-screen warn / back-on info — never a line of its own.
   */
  recheck(): void;
}
