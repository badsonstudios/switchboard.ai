// Ctrl+= zooms (#1114).
//
// The owner: *"Pressing Ctrl+ does not work. It doesn't increase the size of all
// the text."*
//
// The View menu carried Electron's stock `{ role: 'zoomIn' }`, whose accelerator
// is `CommandOrControl+Plus` — and Plus is a SHIFTED key, so it answered only
// Ctrl+Shift+=. Every browser also answers the unshifted Ctrl+=, because that is
// the key fingers actually press. Nothing here did.
//
// WHY `before-input-event` AND NOT A SECOND MENU ACCELERATOR: it fires before
// the keystroke is dispatched into the page, so no focus sink — the composer,
// Monaco, a find bar — can take the chord first. That is the same doorway
// `terminal-accelerators.ts` uses, for the same reason. `preventDefault()` there
// also suppresses the menu's own shortcut, so the View items can keep showing an
// accelerator without the chord zooming twice.
//
// WHAT THIS DOES NOT HAVE TO DO, measured rather than assumed: persist, or reach
// the other windows. Chromium keeps the zoom level PER HOST and writes it to the
// profile — the owner's own `Preferences` carries
// `"per_host_zoom_levels": { …: { "127.0.0.1": 1.0 } }` — and every window of
// this app is served from that one host, so a popout follows the main window and
// a restart comes back at the same size. `e2e/window-zoom.spec.ts` pins the restart.
import type { WebContents } from 'electron';
import type { Platform } from '../shared/accelerators';
import type { AcceleratorInput } from '../shared/terminal-accelerators';

export type ZoomAction = 'in' | 'out' | 'reset';

/** One press. The same step Electron's own `zoomIn` / `zoomOut` roles take. */
export const ZOOM_STEP = 0.5;

/**
 * As far as a level may go: about 58% to 207%.
 *
 * Chromium allows far more in both directions, and past these the app is not
 * usable — at which point the only way back is a chord the user has to already
 * know. Stopping short of that is the whole reason for a bound.
 */
export const ZOOM_MIN = -3;
export const ZOOM_MAX = 4;

/**
 * Which zoom chord is this, if any?
 *
 * `=` and `+` are the same physical key with and without Shift, and the numeric
 * keypad's plus arrives as `+` too — all three zoom in, which is the dual
 * binding every browser has. `-` and `_` likewise.
 *
 * NOT with Alt: on many layouts AltGr IS Ctrl+Alt, and AltGr+0 or AltGr+- types
 * a character (`}` and `\` on a German keyboard). Claiming those would eat text.
 */
export function matchZoomInput(input: AcceleratorInput, platform: Platform): ZoomAction | null {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod || input.alt) return null;
  switch (input.key) {
    case '=':
    case '+':
      return 'in';
    case '-':
    case '_':
      return 'out';
    case '0':
      // Ctrl+Shift+0 is not a zoom chord anywhere, and `)` never reaches here
      return input.shift ? null : 'reset';
    default:
      return null;
  }
}

/** The level after one action, held inside the bounds. */
export function nextZoomLevel(current: number, action: ZoomAction): number {
  if (action === 'reset') return 0;
  const from = Number.isFinite(current) ? current : 0;
  const to = from + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, to));
}

/** Apply one action to a window. Shared by the chord and the View menu. */
export function applyZoom(contents: WebContents, action: ZoomAction): number {
  const level = nextZoomLevel(contents.getZoomLevel(), action);
  contents.setZoomLevel(level);
  return level;
}

export interface ZoomDeps {
  platform: Platform;
  /** never let a listener throw into Chromium's input path */
  onError?: (err: unknown) => void;
}

/**
 * Claim the zoom chords on one window's contents.
 *
 * Called for the main window and for every popout: `before-input-event` is per
 * webContents, so a popout that was not wired would be a window where the chord
 * does nothing — while still changing size when the MAIN window zooms, because
 * the level is shared. That would read as broken twice over.
 *
 * Auto-repeat is claimed too, unlike the terminal accelerators: holding Ctrl+=
 * to keep growing is what the chord is for.
 */
export function installWindowZoom(contents: WebContents, deps: ZoomDeps): void {
  contents.on('before-input-event', (event, input: AcceleratorInput) => {
    try {
      const action = matchZoomInput(input, deps.platform);
      if (!action) return;
      applyZoom(contents, action);
      event.preventDefault();
    } catch (err) {
      deps.onError?.(err); // a throw must cost the user nothing but this one chord
    }
  });
}
