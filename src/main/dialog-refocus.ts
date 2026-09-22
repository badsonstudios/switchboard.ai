// Put the keyboard back after a renderer dialog closes (#909).
//
// MEASURED, NOT GUESSED. On Windows, after the renderer's `window.confirm` /
// `window.alert` closes, a click in the composer moves the caret target but no
// keystroke arrives, until the user switches apps and back. Paste from the
// right-click menu still works, because it needs no keyboard. It was reproduced
// with real OS input (Playwright's keys ride CDP and cannot see it), and in the
// broken state EVERY focus signal says all is well: `document.hasFocus()`,
// `win.isFocused()`, `webContents.isFocused()`, `getFocusedWindow() === win`.
// So nothing can DETECT the state; it has to be repaired every time.
//
// Of the remedies tried, only `blur()` then `focus()` brings the keys back.
// `webContents.focus()` alone does not, and neither does `win.focus()` alone.
// A main-process `dialog.showMessageBox` never broke it.
//
// WINDOWS ONLY. That is the only place it was measured, and elsewhere `blur()`
// is not harmless: on macOS it is `orderBack:` and on X11 it lowers the window.
//
// WHO IT TOUCHES: only the window the OS says is focused, and only if that
// window is ours. If the user moved to another app while the dialog was up,
// this does nothing. What it cannot promise: on Windows, `blur()` briefly hands
// activation to the next window in Z-order before `focus()` takes it back. The
// user's last input went to our dialog, so Windows allows the take-back, and
// the probe saw it every time. If it is ever refused, the caller logs it.

/** The slice of `BrowserWindow` this needs, so a test can hand in a fake. */
export interface RefocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  blur(): void;
  focus(): void;
}

/** What happened, for the log line: `lost` means focus did not come back. */
export type RefocusOutcome = 'skipped' | 'refocused' | 'lost';

/**
 * Re-seat keyboard focus in `focused` if it is one of `ours`. Never throws: a
 * window that died mid-call is not worth an error.
 */
export function refocusAfterDialog(
  platform: NodeJS.Platform,
  focused: RefocusableWindow | null,
  ours: readonly RefocusableWindow[]
): RefocusOutcome {
  try {
    if (platform !== 'win32') return 'skipped';
    if (!focused || !ours.includes(focused)) return 'skipped';
    if (focused.isDestroyed() || focused.isMinimized()) return 'skipped';
    focused.blur();
    focused.focus();
    return focused.isFocused() ? 'refocused' : 'lost';
  } catch {
    return 'skipped';
  }
}
