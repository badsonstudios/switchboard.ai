// Multi-row tab strip (#84). With more sessions than fit the width, dockview
// hides the rest behind a `⌄ N` dropdown. For a session host that's exactly
// backwards — the sessions you can't see are the ones you most need to see —
// so the default is to WRAP them onto another row. The dropdown behaviour is
// still one toggle away for anyone who prefers a single fixed-height strip.
//
// The mode rides on <html data-tab-rows>, next to data-theme, so the CSS in
// theme/dockview-tokens.css can switch on it and the popout windows (separate
// documents that inherit the same stylesheet) behave identically.
import { uiGet, uiSet } from './ui-state';
import { openPopoutWindows } from './popout-windows';
import { copyThemeOverlay } from '../theme/theme';

export type TabRows = 'wrap' | 'single';

const KEY = 'tabRows';

export function loadTabRows(): TabRows {
  return uiGet<TabRows>(KEY, 'wrap') === 'single' ? 'single' : 'wrap';
}

/** paint the mode onto <html>; returns what was applied */
export function applyTabRows(mode: TabRows): TabRows {
  document.documentElement.dataset.tabRows = mode;
  return mode;
}

/** flip and persist; returns the new mode */
export function toggleTabRows(): TabRows {
  const next: TabRows = loadTabRows() === 'wrap' ? 'single' : 'wrap';
  uiSet(KEY, next);
  applyTabRows(next);
  syncDocumentFlags();
  return next;
}

/**
 * A popped-out group lives in its own DOCUMENT, so it has neither `data-theme`
 * nor `data-tab-rows` on its `<html>` — it would render in the stylesheet's
 * default theme and never wrap. Copy both across.
 *
 * Since P2-E15-05 a theme is a base preset PLUS a token overlay, and the
 * overlay is inline style on our own `<html>` — which a popout inherits even
 * less than an attribute. Copying only the flags would give a high-contrast
 * app a nordic popout: the base right and every override missing, which looks
 * exactly like a theme that half-applied.
 *
 * Called when a popout opens and whenever any of it changes; `windows` defaults
 * to every popout currently open, which is `lib/popout-windows`' answer and no
 * longer a second list kept here (#227).
 */
export function syncDocumentFlags(windows: Iterable<Window> = openPopoutWindows()): void {
  const srcEl = document.documentElement;
  const src = srcEl.dataset;
  for (const win of windows) {
    try {
      const dest = win.document?.documentElement;
      if (!dest) continue;
      if (src.theme) dest.dataset.theme = src.theme;
      if (src.themeId) dest.dataset.themeId = src.themeId;
      if (src.colorScheme) dest.dataset.colorScheme = src.colorScheme;
      if (src.tabRows) dest.dataset.tabRows = src.tabRows;
      copyThemeOverlay(srcEl, dest);
    } catch {
      /* window closed mid-iteration — fail open, it's cosmetic */
    }
  }
}
