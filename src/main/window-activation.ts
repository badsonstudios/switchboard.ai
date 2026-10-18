// The ONE place this app decides whether showing a window may take the OS
// foreground (#1332).
//
// Every e2e launch used to activate its new window, and on Windows activation is
// GLOBAL: the developer typing in an editor on another screen lost the keyboard
// ~160 times per run. Playwright drives the page over CDP (keyboard, mouse,
// `document.hasFocus()` pinned true by focus emulation), so almost nothing in the
// suite needs the OS to have activated the window — see `e2e/fixtures/app.ts`.
//
// So the suite can ask for a QUIET launch: `SWITCHBOARD_E2E_NO_ACTIVATE=1`. In
// that mode every window is shown with `showInactive()` and every raise the app
// issues on its own initiative un-minimizes and shows without activating. The
// app is never told it is focused when it is not — `isFocused()` stays the OS's
// honest answer, which is why the few specs that need "the user is here" have
// to activate the window themselves.
//
// NON-PACKAGED BUILDS ONLY — the rule `SWITCHBOARD_MUTE_AUDIO` and the other
// e2e switches follow. A stray variable in a user's environment must never be
// able to stop the shipped app from coming to the front when they ask for it.
//
// Every show/focus in `src/main` goes through `revealWindow` / `raiseWindow`.
// A new raise site that calls `focus()` directly is the bug this file exists to
// prevent; route it through here instead. `window-activation.test.ts` scans the
// main process for one.
//
// KNOWN EXCEPTIONS — the calls Windows offers no non-activating form of:
// `maximize()` (on a hidden window Electron shows it maximized, SW_SHOWMAXIMIZED)
// and `unmaximize()` (SW_RESTORE), both in index.ts's window creation and
// display-return restore. No spec seeds a maximized window, so a quiet run never
// reaches them today; one that did would take the foreground there.
//
// WINDOWS SEMANTICS. `showInactive()` un-minimizing a window is a Windows fact
// (SW_SHOWNOACTIVATE); the quiet mode exists for the developer's Windows desktop
// and nothing ships it, so macOS/Linux differences are not handled.

/** The env var the e2e fixture sets on the launched app. Named once. */
export const NO_ACTIVATE_ENV = 'SWITCHBOARD_E2E_NO_ACTIVATE';

/**
 * Whether this process was launched quiet. Pure, so the "unreachable when
 * packaged" rule is a unit test and not a promise.
 */
export function noActivateRequested(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): boolean {
  return !packaged && env[NO_ACTIVATE_ENV] === '1';
}

let quiet = false;

/** Set once at startup from `noActivateRequested`. */
export function setNoActivate(value: boolean): void {
  quiet = value;
}

/** True when windows must be shown without taking the foreground. */
export function noActivate(): boolean {
  return quiet;
}

/** The subset of `BrowserWindow` a show or a raise needs. Structural, for tests. */
export interface ActivatableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
}

/** First show of a window the app just created (`ready-to-show`). */
export function revealWindow(win: ActivatableWindow): void {
  if (win.isDestroyed()) return;
  if (quiet) win.showInactive();
  else win.show();
}

/**
 * Bring a window to the user: un-minimize, show, activate.
 *
 * All three are needed normally — `focus()` on a minimized window only flashes
 * the taskbar on Windows, and `focus()` does not show a hidden one.
 *
 * Quiet: `showInactive()` alone, which on Windows is `SW_SHOWNOACTIVATE`: a
 * hidden or minimized window is shown and un-minimized without taking the
 * foreground. It does NOT change the stacking order of a window that is
 * already visible behind others — a quiet raise of that window is a no-op, and
 * deliberately so (`moveTop()` is SetWindowPos without SWP_NOACTIVATE). Nor is
 * `restore()` called: it is `SW_RESTORE`, which activates.
 */
export function raiseWindow(win: ActivatableWindow): void {
  if (win.isDestroyed()) return;
  if (quiet) {
    win.showInactive();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Extra `BrowserWindow` options for a window opened through `window.open`
 * (dockview's popouts). Empty when not quiet, so the normal path is unchanged.
 *
 * Quiet: created hidden (so `revealChildWindow` shows it inactive) AND not
 * focusable. The second one is not optional, and it was measured (#1332): the
 * RENDERER activates popouts too — dockview calls `popoutWindow.focus()` on the
 * DOM window whenever the popout's group becomes active, which Electron honours
 * for a window the page opened. That never passes through main, so no seam
 * here can turn it into a show-without-activating; a quiet full run still saw
 * popout windows take the desktop foreground ~13 times. `focusable: false` is
 * `WS_EX_NOACTIVATE` on Windows: the OS will not activate the window for anyone.
 * Playwright's input arrives over CDP and does not need it. A spec that needs
 * the popout to be the focused window makes it focusable again
 * (`bringToFront(a, 'popout')`).
 */
export function childWindowOptions(): { show?: false; focusable?: false } {
  return quiet ? { show: false, focusable: false } : {};
}

/** Pair of `childWindowOptions`: show a just-created child window if we hid it. */
export function revealChildWindow(win: ActivatableWindow): void {
  if (quiet) revealWindow(win);
}
