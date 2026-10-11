// The ONLY place the renderer may open a native confirm/alert (#909).
//
// On Windows, after `window.confirm` / `window.alert` closes, the page takes
// clicks but no keystrokes until the user switches apps and back. Every focus
// signal reports all is well, so the state cannot be detected and has to be
// repaired every time: main does `blur()` + `focus()` on our focused window
// (`main/dialog-refocus.ts` has the measurements). `native-dialog.test.ts`
// fails if any renderer source calls the bare globals, so a new confirm cannot
// bring the bug back quietly.

/**
 * `window.confirm`, then put the keyboard back.
 *
 * `inWindow` is the window the question is ABOUT (#1214): a popped-out card's
 * own. A popout runs this window's JavaScript, so the bare global is always
 * the MAIN window's confirm, and its box opened over the main window while
 * the user was looking at the popout it concerned. A window that has gone, or
 * that will not answer, falls back to this one: the question is still asked.
 */
export function nativeConfirm(message: string, inWindow?: Window): boolean {
  try {
    if (inWindow && inWindow !== window) {
      try {
        if (!inWindow.closed) return inWindow.confirm(message);
      } catch {
        // fall through to this window's own
      }
    }
    return window.confirm(message);
  } finally {
    refocus();
  }
}

/** `window.alert`, then put the keyboard back. */
export function nativeAlert(message: string): void {
  try {
    window.alert(message);
  } finally {
    refocus();
  }
}

// Fail-open: an older preload without the method, or a send that throws, must
// never turn a closed dialog into an exception at the call site.
function refocus(): void {
  try {
    window.switchboard?.refocusAfterDialog?.();
  } catch {
    // nothing to do: the worst case is the pre-#909 behaviour
  }
}
