// One switchboard per user profile (#289) — the window half of it.
//
// `app.requestSingleInstanceLock()` lives in `index.ts`, where it has to be the
// FIRST thing the bootstrap does; this module is what the surviving instance
// does when a second launch is turned away. It is here, and not inline, so it
// can be tested: `index.ts` calls `app.enableSandbox()` at module scope and
// cannot be imported under vitest at all.

export interface AcquireOptions {
  /** one attempt at `app.requestSingleInstanceLock()` */
  tryLock: () => boolean;
  /** how long to keep trying before giving up. 0 = a single attempt */
  retryForMs: number;
  /** blocks the calling thread — see `sleepSync` */
  sleep: (ms: number) => void;
  stepMs?: number;
  /** injectable clock, so the retry can be tested without spending the time */
  now?: () => number;
}

/**
 * Take the single-instance lock, optionally retrying for a bounded window.
 *
 * The retry exists for ONE caller — `npm run dev` — and it is not optional
 * there. electron-vite's main-process watcher restarts the app like this
 * (`electron-vite/dist/chunks/lib-B4dCEySN.js`, verified in the installed copy):
 *
 *     ps.removeAllListeners();
 *     ps.kill();
 *     ps = startElectron(root);   // <- same tick, no wait for exit
 *
 * It never waits for the old process to die. So on every save to a main-process
 * file the replacement races the corpse for the lock, and a straight
 * lose-and-quit turns "rebuild successful / restart electron app..." into a dev
 * loop with no app in it — mysterious, intermittent, and the kind of thing that
 * gets a lock deleted rather than debugged. A short retry closes that race
 * without weakening anything: a genuine second `npm run dev` finds the lock
 * still held after the whole window and is turned away exactly as a packaged
 * launch would be, only later.
 *
 * Everywhere else (`npm run start`, the e2e suite, a packaged install) makes a
 * SINGLE attempt and leaves immediately — nothing there kills its own
 * predecessor, so a held lock means a live app, and waiting would only make a
 * double-click feel slow.
 *
 * Each failed attempt re-notifies the running instance, so a real user who
 * launched twice gets their window raised on the first poll rather than after
 * the wait.
 */
export function acquireInstanceLock(opts: AcquireOptions): boolean {
  const step = opts.stepMs ?? 250;
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.retryForMs;
  for (;;) {
    if (opts.tryLock()) return true;
    // Check BEFORE sleeping, and check the sleep's END: a launch that is going
    // to fail must not first sit through a poll it has no time left for.
    if (now() + step > deadline) return false;
    opts.sleep(step);
  }
}

/**
 * Block this thread for `ms`.
 *
 * Sleeping synchronously is normally a crime; here it is the only option and it
 * is free. This runs at module scope, BEFORE `app.whenReady()` and therefore
 * before Electron's message loop exists — there is nothing to starve, and an
 * async wait would mean the bootstrap could no longer state "the lock is taken
 * before anything else happens", which is the whole property being bought.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The subset of `BrowserWindow` a raise needs.
 *
 * Structural, so the tests can hand it a plain object — a real BrowserWindow
 * satisfies it without a cast, and nothing here can quietly start depending on
 * the rest of the class.
 */
export interface RaisableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Bring the running app's window to the user — the whole visible behaviour of
 * the single-instance lock. Returns whether there was a window to raise.
 *
 * All three calls are needed, and each covers a case the others do not:
 *
 * - **`restore()`** — `focus()` on a MINIMIZED window is a no-op on Windows
 *   (and only flashes the taskbar button), so an unminimize has to come first.
 * - **`show()`** — our main window is created with `show: false` and revealed
 *   on `ready-to-show`, and `focus()` does not show a hidden window. Without
 *   this, a second launch during the first one's startup would do *nothing
 *   visible at all*, which reads exactly like the app being broken.
 * - **`focus()`** — the actual raise. It works from a background process
 *   because Chromium's ProcessSingleton calls `AllowSetForegroundWindow` for
 *   the primary before the secondary exits; we do not need (and deliberately do
 *   not use) an always-on-top bounce to force it.
 *
 * A destroyed window is NOT a window: on macOS the app lives on with every
 * window closed, and the caller opens a fresh one when this returns false.
 */
export function focusRunningWindow(win: RaisableWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}
