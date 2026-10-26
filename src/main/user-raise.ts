// Bringing a window forward because the PERSON asked for a session in it
// (#1456) — a click in a list, the palette, a toast — as opposed to a session
// pulling you to it (`attention-raise.ts`, #756).
//
// The raise itself is `raiseWindow` (restore if minimised, show, focus), which
// was measured to work between our own windows (#571, #756): a click in the
// main window's list leaves THIS process holding the foreground, and Windows
// lets the foreground process hand it to its own windows.
//
// WHAT THIS ADDS is the honest fallback. When the app did NOT hold the
// foreground at the moment of asking, or the window still is not focused once
// the OS has had its moment, Windows' foreground lock may have refused — so the
// window's taskbar button blinks (`flashFrame`) until the person arrives, and
// the blink is cleared on focus. A blink on a window that DID come forward is
// harmless: Electron's Windows flash is FLASHW_TIMERNOFG, which stops once the
// window is in the foreground.
import { noActivate, raiseWindow, type ActivatableWindow } from './window-activation';
import { RAISE_SETTLE_MS } from './attention-raise';
import { flashUntilArrival, type FlashableWindow } from './foreground';

/** What a person-asked raise needs of a window. Structural, for tests. */
export interface UserRaiseTarget extends ActivatableWindow, FlashableWindow {
  isFocused(): boolean;
}

export type UserRaiseOutcome =
  /** the window is focused and the app held the foreground when asked */
  | 'raised'
  /** raised as far as the OS allowed; the taskbar button blinks until focus */
  | 'flashed'
  /** the window is gone */
  | 'no-window'
  /** SWITCHBOARD_E2E_NO_ACTIVATE: shown inactive, no foreground taken */
  | 'no-activate';

export interface UserRaiseResult {
  outcome: UserRaiseOutcome;
  /** it was minimised when asked — `raiseWindow` restored it */
  wasMinimized: boolean;
}

/**
 * Raise `win` for a person who asked for it, then check, then fall back.
 *
 * `appHadForeground` is read by the caller BEFORE the raise: whether the app
 * held the OS foreground (`ForegroundTracker.appHasForeground`). "Is it in
 * front now?" is `deps.isFront` (`ForegroundTracker.isFront`), because a
 * refused `focus()` leaves Electron's `isFocused()` saying true (#756, #1379).
 * Without `isFront` it is `isFocused()`, and "the app was not in front when
 * asked" still flashes regardless of what that says afterwards.
 */
export async function performUserRaise(
  win: UserRaiseTarget,
  deps: {
    appHadForeground: boolean;
    wait: (ms: number) => Promise<void>;
    /** is `win` really in front now (`ForegroundTracker.isFront`) */
    isFront?: () => boolean;
  }
): Promise<UserRaiseResult> {
  if (win.isDestroyed()) return { outcome: 'no-window', wasMinimized: false };
  const wasMinimized = win.isMinimized();
  raiseWindow(win);
  if (noActivate()) return { outcome: 'no-activate', wasMinimized };
  await deps.wait(RAISE_SETTLE_MS);
  if (win.isDestroyed()) return { outcome: 'no-window', wasMinimized };
  const inFront = deps.isFront ? deps.isFront() : win.isFocused();
  if (deps.appHadForeground && inFront) return { outcome: 'raised', wasMinimized };
  try {
    // once per window: repeated clicks on a refused window neither restart
    // the blink nor stack a listener each (`flashUntilArrival`)
    flashUntilArrival(win);
  } catch {
    // best-effort, like every other signal: never break the click
  }
  return { outcome: 'flashed', wasMinimized };
}
