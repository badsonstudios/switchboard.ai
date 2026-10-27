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
// Every show/focus in `src/main` goes through `revealWindow` / `raiseWindow`
// (or `raiseForAttention`, #756, for a session pulling you to it).
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

/** What an ATTENTION raise needs on top of a plain raise (#756). */
export interface AttentionWindow extends ActivatableWindow {
  minimize(): void;
  isFullScreen(): boolean;
}

/** Which call sequence an attention raise used — logged, and asserted in tests.
 *  `none` is a deliberate no-call: the OS was measured to refuse every option
 *  left, and a refused `focus()` would do harm (see below). */
export type AttentionTechnique =
  | 'quiet'
  | 'destroyed'
  | 'none'
  | 'restore'
  | 'minimize-restore'
  | 'show-focus'
  /** `restore` / `minimize-restore` with our other windows stepped aside (#1468) */
  | 'restore-aside'
  | 'minimize-restore-aside';

/** What stepping aside needs of one of our OTHER windows (#1468). */
export interface AsideWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  hide(): void;
  showInactive(): void;
  /** to start a hidden window's taskbar blink again once it is back */
  flashFrame?(flag: boolean): void;
}

/** How long our other windows stay hidden while the swoop lands. The probe hid
 *  them for 150 ms (`spike/probes/1468/`); a granted restore lands inside it. */
export const ASIDE_MS = 150;

/** Windows hidden by a swoop right now, until they are shown back (#1468). */
const steppedAside = new WeakSet<object>();

/**
 * Is this window hidden only because another window's swoop stepped it aside?
 * A second raise inside those 150 ms must not read it as "hidden, unreachable"
 * (no raise AND no flash), so the reach check asks this first.
 */
export function isSteppedAside(win: object): boolean {
  return steppedAside.has(win);
}

/**
 * Bring a window forward because a SESSION asked for you (#756), not because
 * you clicked something.
 *
 * Different from `raiseWindow` on purpose, and the difference was MEASURED
 * (`spike/findings/756-foreground-lock.md`, Windows 11, Electron 43). When
 * another app holds the foreground — the normal case for an attention event —
 * Windows refuses every `focus()` variant on a window that is merely behind:
 * `focus()`, `show()+focus()`, `moveTop()+focus()`, `app.focus({ steal })`,
 * `webContents.focus()`, `hide()+show()` all left the other app in front, 3 of
 * 3 runs each. Worse, every refused `focus()` left Electron's `isFocused()`
 * reporting TRUE while another process held the foreground — so a refused
 * attempt is not just useless, it blinds the taskbar-flash guard in
 * `notifier.ts` for the next event. The always-on-top flicker put the window on
 * top WITHOUT the keyboard, which is the worst of both.
 *
 * What did take the foreground, 3 of 3: `restore()` on a MINIMIZED window, and
 * `minimize()` then `restore()` on one that was behind — a maximized one
 * included, which came back maximized. So that is what this does on Windows.
 * It is a visible swoop, which is what "Always jump to it" asked for; it never
 * runs under `smart`, the default.
 *
 * WHEN ONE OF OUR OWN WINDOWS HOLDS THE FOREGROUND (`appHasForeground`, read at
 * event time by the caller), the foreground process may hand it to its own
 * windows, and the plain `raiseWindow` was measured to do exactly that (3/3,
 * sibling window in front). No swoop for moving between our own windows.
 *
 * A FULL-SCREEN window on Windows gets NO call at all: minimizing it would drop
 * it out of full screen, and the only calls left are the refused `focus()`
 * family, whose lie is the harm above. The caller treats `none` as refused —
 * flash and log.
 *
 * Other platforms: the plain `raiseWindow`, unmeasured — the measurement and the
 * owner's machine are Windows.
 *
 * OUR OTHER WINDOWS STEP ASIDE (#1468). The swoop only takes the foreground
 * when NO OTHER window of this process is on screen: measured
 * (`spike/findings/1468-popout-swoop.md`), a lone window 10 of 10, and with a
 * second visible window of ours 0 of 59 — for the main window and the
 * popout alike, a popout made by `window.open` or by main, owned or not. That
 * is why a popped-out session's swoop never won (the main window is always on
 * screen beside it). With every other visible window of ours hidden for the
 * swoop and shown again without activating (`showInactive`, which kept a
 * maximized window maximized and put each one back BEHIND the app the person
 * was in), it took the foreground 66 of 66, including from a target a refused
 * `focus()` had left "active". Minimized and hidden windows are left alone:
 * they do not count against the swoop, and `showInactive` would un-minimize
 * one. `others` is every window of ours; the target in it is skipped.
 *
 * NOT EVERY TIME: right after a refused swoop the next attempt was refused too
 * (0 of 48), and in the real app the first raise after a popout opened behind
 * another app, and its immediate repeat, were still refused (4 of 4 runs);
 * every raise after that was granted. A refusal still ends in the flash
 * (`performAttentionRaise`).
 *
 * Quiet (`SWITCHBOARD_E2E_NO_ACTIVATE`): NOTHING. Not even `showInactive()` —
 * an attention raise is never something the suite needs to see happen to the
 * OS window, only to see requested.
 */
export function raiseForAttention(
  win: AttentionWindow,
  opts: {
    appHasForeground: boolean;
    platform?: NodeJS.Platform;
    /** every window of ours (#1468); the visible, un-minimized ones step aside */
    others?: readonly AsideWindow[];
    /** runs `fn` after `ms` (default `setTimeout`); tests pass their own */
    later?: (fn: () => void, ms: number) => void;
    /** is this window's taskbar button blinking for someone who has not come
     *  to it yet (`isFlashing`)? Hiding a window takes its taskbar button
     *  away, so such a window has its blink started again once it is back.
     *  It still steps aside: the notifier blinks the main window for every
     *  attention event, and leaving it on screen is what makes the swoop lose */
    blinking?: (w: AsideWindow) => boolean;
  }
): AttentionTechnique {
  const platform = opts.platform ?? process.platform;
  if (win.isDestroyed()) return 'destroyed';
  if (quiet) return 'quiet';
  if (opts.appHasForeground || platform !== 'win32') {
    raiseWindow(win);
    return 'show-focus';
  }
  if (win.isFullScreen()) return 'none';
  // a window an earlier swoop hid a moment ago: back on screen first, quietly
  if (steppedAside.has(win)) {
    steppedAside.delete(win);
    win.showInactive();
  }
  // read BEFORE hiding: a hide can emit `blur`, which ends the blink's wait
  const reblink = new Set((opts.others ?? []).filter((o) => safely(() => opts.blinking?.(o) === true)));
  const aside = stepAside(win, opts.others ?? []);
  const wasMinimized = win.isMinimized();
  if (!wasMinimized) win.minimize();
  win.restore();
  if (aside.length === 0) return wasMinimized ? 'restore' : 'minimize-restore';
  const later = opts.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  later(() => {
    for (const o of aside) {
      // a later swoop that raised this window has already shown it
      if (!steppedAside.has(o)) continue;
      steppedAside.delete(o);
      try {
        if (o.isDestroyed()) continue;
        o.showInactive();
        if (reblink.has(o)) o.flashFrame?.(true);
      } catch {
        // a window closed meanwhile: nothing to bring back
      }
    }
  }, ASIDE_MS);
  return wasMinimized ? 'restore-aside' : 'minimize-restore-aside';
}

/** Hide every OTHER visible, un-minimized window of ours; returns the ones hidden. */
function safely(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

function stepAside(target: object, others: readonly AsideWindow[]): AsideWindow[] {
  const hidden: AsideWindow[] = [];
  for (const o of others) {
    try {
      if (o === target || o.isDestroyed() || !o.isVisible() || o.isMinimized()) continue;
      o.hide();
      steppedAside.add(o);
      hidden.push(o);
    } catch {
      // fail-open: a window we cannot read or hide stays as it is
    }
  }
  return hidden;
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
