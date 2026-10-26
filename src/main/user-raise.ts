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

const awaitingFocus = new WeakSet<object>();

/** What a person-asked raise needs of a window. Structural, for tests. */
export interface UserRaiseTarget extends ActivatableWindow {
  isFocused(): boolean;
  flashFrame(flag: boolean): void;
  once(event: 'focus', listener: () => void): unknown;
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
 * `appHadForeground` is read by the caller BEFORE the raise: whether one of our
 * windows was the focused one. Known limit (recorded at #756): a refused DOM
 * `focus()` can leave Electron's `isFocused()` saying true, so a window can
 * look focused when it is not — which is exactly why "the app was not in front
 * when asked" flashes regardless of what `isFocused()` says afterwards.
 */
export async function performUserRaise(
  win: UserRaiseTarget,
  deps: { appHadForeground: boolean; wait: (ms: number) => Promise<void> }
): Promise<UserRaiseResult> {
  if (win.isDestroyed()) return { outcome: 'no-window', wasMinimized: false };
  const wasMinimized = win.isMinimized();
  raiseWindow(win);
  if (noActivate()) return { outcome: 'no-activate', wasMinimized };
  await deps.wait(RAISE_SETTLE_MS);
  if (win.isDestroyed()) return { outcome: 'no-window', wasMinimized };
  if (deps.appHadForeground && win.isFocused()) return { outcome: 'raised', wasMinimized };
  try {
    win.flashFrame(true);
    // one pending clear per window: repeated clicks on a refused window must
    // not stack a `focus` listener each
    if (!awaitingFocus.has(win)) {
      awaitingFocus.add(win);
      win.once('focus', () => {
        awaitingFocus.delete(win);
        if (!win.isDestroyed()) win.flashFrame(false);
      });
    }
  } catch {
    // best-effort, like every other signal: never break the click
  }
  return { outcome: 'flashed', wasMinimized };
}
