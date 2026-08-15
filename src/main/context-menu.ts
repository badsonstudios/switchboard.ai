// Right-click edit menus (#526).
//
// Electron ships NO default context menu — Chromium's belongs to the browser
// UI, not to embedders — so until this module every right-click in switchboard
// did nothing at all. Cut/Copy/Paste/Select All are the oldest contract a text
// box has with its user, and a composer that answers a right-click with silence
// reads as broken rather than as minimal.
//
// WHY MAIN, AND WHY ROLES. The three things a paste has to be — a real system
// clipboard read, a TRUSTED DOM `paste` event, and the same event the keyboard
// produces — are all things only the browser process can hand out. A menu drawn
// in the renderer could at best fake a paste from `navigator.clipboard`, which
// (a) is a second clipboard path to keep in sync with the first and (b) would
// bypass the composer's `onPaste` — the attachment pipeline from #475, where a
// pasted image becomes a chip. `role: 'paste'` calls `webContents.paste()`, and
// Chromium's own paste fires the same trusted event Ctrl+V does, through the
// same handler, producing the same chip. The pipeline is shared because there
// is only one pipeline.
//
// Roles also mean a hostile LABEL can only mislabel a fixed action, never
// smuggle one in — which is what makes accepting the strings from the renderer
// (see `ContextMenuLabels`) a cosmetic risk rather than a capability leak.
//
// EVERY WINDOW NEEDS ITS OWN. `context-menu` is a per-webContents event, so a
// popped-out card would have no menus at all unless this is installed on the
// popout too — the #90 lesson (tearing a card off must not remove capability),
// arriving through a second door. `index.ts` installs it at both sites.
//
// TERMINAL: DELIBERATELY OUT OF SCOPE. xterm.js has its own right-click
// conventions (selection-copy on right-click, paste-on-middle-click, and on
// some platforms a right-click that pastes outright), and a terminal is the
// CLI's surface rather than ours — P7: we host, we do not reimplement. In
// practice this costs no guard, because of two facts about xterm that are worth
// stating so the next person can re-check them: it paints its own selection on
// a canvas layer instead of making a DOM selection (so `selectionText` is empty
// over a terminal), and its one editable node — the off-screen helper textarea
// — is parked at `left: -9999em` behind the screen at `z-index: -5`
// (`@xterm/xterm/css/xterm.css`), so the pointer cannot land on it. Both rules
// below therefore answer "no menu" there. If either fact ever changes, the fix
// is a terminal-aware menu built WITH xterm's conventions, not this one leaking
// into its surface.
import type { BrowserWindow, Menu, MenuItemConstructorOptions, WebContents } from 'electron';
import { ContextMenuLabels, DEFAULT_CONTEXT_MENU_LABELS } from '../shared/context-menu';

export type { ContextMenuLabels };
export { DEFAULT_CONTEXT_MENU_LABELS };

/** A menu label longer than this is a bug or an attack, not a translation. */
const MAX_LABEL = 60;

/**
 * Take the renderer's payload apart key by key, falling back per key.
 *
 * These strings go into a NATIVE menu, and the renderer is the one process in
 * this app that will eventually host third-party code (§5.23). A malformed or
 * hostile payload must cost the user an English word, never a menu made of
 * someone else's sentences.
 */
export function sanitizeContextMenuLabels(raw: unknown): ContextMenuLabels {
  const src = (raw ?? {}) as Record<string, unknown>;
  const one = (key: keyof ContextMenuLabels): string => {
    const v = src[key];
    if (typeof v !== 'string') return DEFAULT_CONTEXT_MENU_LABELS[key];
    // Control and FORMAT characters both go: a newline renders in a native menu
    // item and can push the rest of it off screen, and U+202E (right-to-left
    // override) reverses everything after it, so "Paste" can be made to read as
    // something else entirely. Cosmetic in both cases — the roles are fixed —
    // but the cost of ruling them out is one character class.
    const clean = v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
    if (!clean || clean.length > MAX_LABEL) return DEFAULT_CONTEXT_MENU_LABELS[key];
    return clean;
  };
  return { cut: one('cut'), copy: one('copy'), paste: one('paste'), selectAll: one('selectAll') };
}

/**
 * The slice of Electron's `ContextMenuParams` the decision uses — so the unit
 * test can state a surface without an Electron window or a DOM.
 *
 * Electron's own type is structurally assignable to this, which is why
 * `installContextMenu` below passes its params straight in: a shape change
 * upstream fails the build instead of being cast away.
 */
export interface ContextMenuSurface {
  /** the right-click landed in an input, textarea or contenteditable */
  isEditable: boolean;
  /** what is selected under the pointer — '' when nothing is */
  selectionText: string;
  /** where in the VIEW it happened, CSS px (see `popup` for why it matters) */
  x: number;
  y: number;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/**
 * Decide ONE right-click. Returns an empty template for "we have nothing to
 * offer here", which is a real answer and the most common one: right-clicking
 * the middle of the feed with nothing selected should show no menu rather than
 * a menu of four dead items.
 *
 * TWO surface classes, and the difference is what you can DO there:
 *
 *   • EDITABLE (the composer, the rename box, any input) — the full edit menu.
 *     Enablement comes from Chromium's own `editFlags`, so "Cut" is greyed with
 *     no selection and "Paste" is greyed on an empty clipboard, without us
 *     having to know either fact. Here the items STAY, greyed: a text box you
 *     can see the whole edit vocabulary of teaches what it can do (§5.8), and
 *     items that appear and vanish teach nobody anything.
 *   • NON-EDITABLE WITH A COPYABLE SELECTION (the feed, the document viewer) —
 *     Copy alone. Cut and Paste are meaningless on read-only text, and Select
 *     All over a scrolling transcript takes the app's chrome with it.
 */
export function buildContextMenuTemplate(
  params: ContextMenuSurface,
  labels: ContextMenuLabels
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'cut', label: labels.cut, enabled: params.editFlags.canCut },
      { role: 'copy', label: labels.copy, enabled: params.editFlags.canCopy },
      { role: 'paste', label: labels.paste, enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: labels.selectAll, enabled: params.editFlags.canSelectAll },
    ];
  }
  // `canCopy` as well as the text: a one-item menu whose one item is greyed is
  // the "menu of dead items" the empty answer above exists to avoid.
  if (params.selectionText.trim().length > 0 && params.editFlags.canCopy) {
    return [{ role: 'copy', label: labels.copy, enabled: true }];
  }
  return [];
}

export interface ContextMenuDeps {
  /** the current translations — read per click, so a language change lands */
  labels: () => ContextMenuLabels;
  /** show it; separated so the unit test never builds a native menu */
  popup: (
    template: MenuItemConstructorOptions[],
    contents: WebContents,
    at: { x: number; y: number }
  ) => void;
  /** a listener must never throw into Chromium's event path */
  onError?: (err: unknown) => void;
}

/** The Electron surface `makeContextMenuDeps` needs — injected, so it is testable. */
export interface ContextMenuWiring {
  labels: () => ContextMenuLabels;
  /** the window that owns these contents, or null if it has gone */
  windowFor: (contents: WebContents) => BrowserWindow | null;
  build: (template: MenuItemConstructorOptions[]) => Menu;
  onError?: (err: unknown) => void;
}

/**
 * Build the deps, with the "where does it go, and what if there is no window"
 * decision in ONE testable place — the same shape and the same reason as
 * `makeAcceleratorDeps` in `terminal-accelerators.ts`.
 */
export function makeContextMenuDeps(wiring: ContextMenuWiring): ContextMenuDeps {
  return {
    labels: wiring.labels,
    onError: wiring.onError,
    popup: (template, contents, at) => {
      const win = wiring.windowFor(contents);
      // NO FALLBACK. `menu.popup()` with no window falls back to the FOCUSED
      // window and then to `getAllWindows()[0]` — both of which put a native
      // Cut/Copy/Paste over a window the user did not right-click, with roles
      // that then act on whatever is focused. Showing nothing is the only
      // honest answer to "the window that produced this event is gone".
      if (!win || win.isDestroyed()) return;
      // Anchored to the CLICK, not to the mouse. Electron's default is the
      // cursor's current position, which is the same thing for a mouse — but
      // `context-menu` also fires for Shift+F10 and the Context Menu key, and
      // for those the cursor can be anywhere, including another monitor. The
      // rail's own menu learned this (`SessionsRail.tsx`) and anchors the same
      // way. Coordinates are view CSS px, which equal window DIP because this
      // app never sets a zoom factor; if one is ever added, this needs scaling.
      wiring.build(template).popup({ window: win, x: at.x, y: at.y });
    },
  };
}

/**
 * Wire the menu onto one window's contents. Called for the main window AND for
 * every dockview popout — see the per-window note at the top of this file.
 */
export function installContextMenu(contents: WebContents, deps: ContextMenuDeps): void {
  contents.on('context-menu', (_event, params) => {
    try {
      const template = buildContextMenuTemplate(params, deps.labels());
      if (template.length === 0) return; // nothing to offer: show nothing
      deps.popup(template, contents, { x: params.x, y: params.y });
    } catch (err) {
      // fail-open (PHILOSOPHY §3): a broken menu costs this one right-click
      deps.onError?.(err);
    }
  });
}
