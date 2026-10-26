// Which of our windows REALLY holds the OS foreground (#1379).
//
// Electron cannot be asked. On Windows a `focus()` from the background is
// refused by the foreground lock (#756), and afterwards EVERY focus signal
// Electron has says "focused": `isFocused()`, `getFocusedWindow()`,
// `webContents.isFocused()`, the page's `document.hasFocus()`, and even the
// window's own `focus` event, which fires for the refused call. It stays that
// way until the window is really activated and left again. Measured:
// `spike/findings/1379-isfocused-after-refused-raise.md`.
//
// What does not lie is what Windows itself sends the window, and Electron does
// let us read that (`BrowserWindow.hookWindowMessage`, no native code):
//
//   honest activation       WM_NCACTIVATE(TRUE)  then WM_ACTIVATE(on)
//   refused activation      WM_NCACTIVATE(FALSE) then WM_ACTIVATE(on)
//       — the window becomes its thread's active window, but Windows draws
//         its caption INACTIVE, because it is not in front
//   the person then really
//   brings that window up   WM_NCACTIVATE(TRUE), WM_NCACTIVATE(TRUE),
//                           and NO WM_ACTIVATE (it is already "active")
//   flashFrame's blinking   WM_NCACTIVATE FALSE / TRUE, strictly alternating
//   restoring a window that
//   is already "active"     WM_ACTIVATE(on) ALONE — the caption did not change,
//   (#756's swoop on it)    and neither did the foreground
//   leaving it              WM_ACTIVATE(off)
//   the app losing the
//   foreground              WM_ACTIVATEAPP(FALSE), to every window of ours
//
// So a window is in front from an activation whose caption was drawn active IN
// THE SAME BURST of messages (Windows sends the pair from one call, before our
// event loop turns; a blink's caption message is a turn of its own and must not
// be read as the pair's), or from a second active caption in a row on a window
// that is already "active" (a blink never sends two in a row). An activation
// with no caption message changes nothing. It stops being in front when it is
// deactivated. A probe running this rule against `GetForegroundWindow` agreed
// on every check.
//
// Elsewhere (macOS, Linux) there is no hook, and nothing was measured: the
// tracker answers with `isFocused()` exactly as the app did before.

export const WM_ACTIVATE = 0x0006;
export const WM_ACTIVATEAPP = 0x001c;
export const WM_NCACTIVATE = 0x0086;

/**
 * One window's activation, from the messages alone. Pure: the tracker feeds
 * it, the tests feed it the recorded sequences.
 */
export class ActivationState {
  /** Windows' idea: its thread's active window (true after a refused raise too) */
  active: boolean;
  /** the truth this module exists for: it holds the OS foreground */
  front: boolean;
  private lastCaption: boolean | null = null;
  /** the caption message of the burst still being delivered, if any */
  private burstCaption: boolean | null = null;

  constructor(seed: { active: boolean; front: boolean }) {
    this.active = seed.active;
    this.front = seed.active && seed.front;
  }

  /** WM_NCACTIVATE: the caption is being drawn active (`on`) or inactive. */
  caption(on: boolean): void {
    // the person arriving at a window a refused raise left "active": two
    // active captions in a row, which a blink never sends
    if (on && this.active && !this.front && this.lastCaption === true) this.front = true;
    this.lastCaption = on;
    this.burstCaption = on;
  }

  /** The burst is over: the event loop turned since the last caption message. */
  settle(): void {
    this.burstCaption = null;
  }

  /** WM_ACTIVATE: on = WA_ACTIVE / WA_CLICKACTIVE, off = WA_INACTIVE. */
  activate(on: boolean): void {
    this.active = on;
    if (!on) this.front = false;
    // the caption message of the same burst says whether Windows let it into
    // the foreground or only made it its thread's active window; with none,
    // the caption did not change, so neither did the foreground
    else if (this.burstCaption !== null) this.front = this.burstCaption;
    this.burstCaption = null;
  }
}

/** What the tracker needs of a window. A `BrowserWindow` satisfies it. */
export interface TrackableWindow {
  readonly id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  /** Windows only (Electron's own API); absent elsewhere */
  hookWindowMessage?: (message: number, callback: (wParam: Buffer, lParam: Buffer) => void) => void;
  once(event: 'closed', listener: () => void): unknown;
}

/** One change of the truth, for the debug log (`SWITCHBOARD_DEBUG=focus`). */
export interface ForegroundChange {
  windowId: number;
  message: 'activate' | 'caption' | 'app-deactivated' | 'tracked';
  on: boolean;
  front: boolean;
  /** what Electron would have said; differs exactly when it is lying */
  electronSaysFocused: boolean;
}

function low32(b: Buffer): number {
  return b.length >= 4 ? b.readUInt32LE(0) : 0;
}

export class ForegroundTracker {
  private readonly states = new Map<TrackableWindow, ActivationState>();
  private appFront = false;
  private listener: ((c: ForegroundChange) => void) | null = null;

  constructor(
    private readonly opts: {
      platform?: NodeJS.Platform;
      /** today's answer, for where there is no hook: is any of ours focused */
      anyFocused: () => boolean;
      /** runs `fn` once the event loop turns (default `setImmediate`); tests
       *  pass their own, to say where a burst of messages ends */
      defer?: (fn: () => void) => void;
    }
  ) {}

  /** Can this platform tell the truth? (Windows: yes, from the messages.) */
  get truthful(): boolean {
    return (this.opts.platform ?? process.platform) === 'win32';
  }

  onChange(listener: (c: ForegroundChange) => void): void {
    this.listener = listener;
  }

  /**
   * Start following a window. Call it as soon as the window exists — before
   * `show()` for the main window, so its first activation is seen.
   *
   * A window that was ALREADY activated when it got here (a popout: Electron
   * hands it over in `did-create-window`, after its first activation) is
   * seeded: in front if Electron says focused AND the app held the foreground,
   * because only a process in front can hand the foreground to its new window.
   */
  track(win: TrackableWindow): void {
    if (!this.truthful || typeof win.hookWindowMessage !== 'function' || this.states.has(win)) return;
    let focused = false;
    try {
      focused = win.isFocused();
    } catch {
      // a window torn down mid-call: seed as not in front
    }
    const state = new ActivationState({ active: focused, front: this.appFront });
    this.states.set(win, state);
    this.emit(win, 'tracked', focused, state.front);
    let settling = false;
    const defer = this.opts.defer ?? ((fn: () => void) => void setImmediate(fn));
    const note = (message: 'activate' | 'caption', on: boolean): void => {
      const was = state.front;
      if (message === 'activate') state.activate(on);
      else {
        state.caption(on);
        if (!settling) {
          settling = true;
          defer(() => {
            settling = false;
            state.settle();
          });
        }
      }
      if (state.front) this.appFront = true;
      // a blinking taskbar button sends a caption message twice a second:
      // only the ones that change the answer are worth a log line
      if (message === 'activate' || state.front !== was) this.emit(win, message, on, state.front);
    };
    try {
      // the low word, as Chromium reads it: the high word has been seen set
      // around minimize / restore
      win.hookWindowMessage(WM_NCACTIVATE, (wParam) => note('caption', (low32(wParam) & 0xffff) !== 0));
      // the low word: WA_INACTIVE 0, WA_ACTIVE 1, WA_CLICKACTIVE 2
      win.hookWindowMessage(WM_ACTIVATE, (wParam) => note('activate', (low32(wParam) & 0xffff) !== 0));
      win.hookWindowMessage(WM_ACTIVATEAPP, (wParam) => {
        if (low32(wParam) !== 0) return; // a refused raise sends TRUE too: ignored
        this.appFront = false;
        this.emit(win, 'app-deactivated', false, state.front);
      });
    } catch {
      // fail-open: an unhookable window is answered the old way. A hook that
      // did go in keeps feeding a state nothing reads any more: harmless.
      this.states.delete(win);
      return;
    }
    win.once('closed', () => {
      this.states.delete(win);
    });
  }

  /** Is this window the one in front? Untracked or not Windows: `isFocused()`. */
  isFront(win: TrackableWindow): boolean {
    try {
      if (win.isDestroyed()) return false;
      const s = this.states.get(win);
      return s ? s.front : win.isFocused();
    } catch {
      return false;
    }
  }

  /**
   * The id of the window of ours in front, or null when none is — read where
   * `BrowserWindow.getFocusedWindow()?.id` used to be. `fallback` is that old
   * read, used when this platform cannot tell the truth.
   */
  frontWindowId(fallback: () => number | null): number | null {
    if (!this.truthful) return fallback();
    for (const [w, s] of this.states) {
      if (s.front && !w.isDestroyed()) return w.id;
    }
    return null;
  }

  /**
   * Did the app hold the foreground? True while one of our windows is in
   * front, AND while the foreground sits on a window of ours this does not
   * track (a native file dialog, devtools): those take it without
   * WM_ACTIVATEAPP(FALSE), which is what ends it.
   */
  appHasForeground(): boolean {
    if (!this.truthful) return this.opts.anyFocused();
    return this.appFront;
  }

  private emit(win: TrackableWindow, message: ForegroundChange['message'], on: boolean, front: boolean): void {
    if (!this.listener) return;
    try {
      this.listener({
        windowId: win.id,
        message,
        on,
        front,
        electronSaysFocused: !win.isDestroyed() && win.isFocused(),
      });
    } catch {
      // logging must never break a window procedure
    }
  }
}

/** What `flashUntilArrival` needs of a window. A `BrowserWindow` satisfies it. */
export interface FlashableWindow {
  isDestroyed(): boolean;
  flashFrame(flag: boolean): void;
  once(event: 'focus' | 'blur', listener: () => void): unknown;
  removeListener(event: 'focus' | 'blur', listener: () => void): unknown;
}

const flashing = new WeakSet<object>();

/**
 * Blink a window's taskbar button until the person comes to it — the ONE way
 * every signal here flashes (the notifier, the attention raise, the refused
 * click in a list), so a window is never flashed twice over.
 *
 * Two things a refused `focus()` changes (#1379):
 *  - a window Electron wrongly calls focused gets NO `focus` event when the
 *    person really arrives, only a `blur` when they leave. So `blur` ends the
 *    wait too. It does not stop the blink: Electron's Windows flash stops by
 *    itself once the window is in front (FLASHW_TIMERNOFG), and a `blur` can
 *    also come from one of our OTHER windows being activated, which must not
 *    cut short a blink nobody has seen;
 *  - restarting a blink that is already running is not needed, and would be
 *    an unmeasured caption sequence for `ActivationState` to read. So a window
 *    already blinking is left alone.
 *
 * Returns whether it started a blink.
 */
export function flashUntilArrival(win: FlashableWindow): boolean {
  if (win.isDestroyed() || flashing.has(win)) return false;
  flashing.add(win);
  const settle = (): void => {
    flashing.delete(win);
    win.removeListener('focus', onFocus);
    win.removeListener('blur', onBlur);
  };
  const onFocus = (): void => {
    settle();
    if (!win.isDestroyed()) win.flashFrame(false);
  };
  const onBlur = (): void => settle();
  win.once('focus', onFocus);
  win.once('blur', onBlur);
  win.flashFrame(true);
  return true;
}
