// The right-click menu's one shared contract (#526): its four labels.
//
// Shared for the reason `shared/terminal-accelerators.ts` is: the payload has
// THREE ends — the renderer that resolves the strings from i18next, the preload
// that carries them, and main that puts them in a native menu — and a fifth item
// added to a private copy would compile cleanly in two of the three.
export interface ContextMenuLabels {
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
}

/**
 * English, for the window that exists before its renderer has spoken and for a
 * payload we do not trust. Main has no i18next — `main/app-menu.ts` hardcodes
 * its labels for the same reason — so this is the floor, not the source.
 */
export const DEFAULT_CONTEXT_MENU_LABELS: ContextMenuLabels = {
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
};
