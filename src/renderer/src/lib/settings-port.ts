// A way for a control deep inside a card to open Settings (#1294).
//
// The Settings window is the App's, and a card's composer sits several
// components and a dockview panel away from it — in a popout, in another
// window's document altogether. Threading a callback down through every layer
// for one menu item ("Manage AIs…") would touch a dozen props; this is the
// prompt-port pattern instead: the App registers the opener once, and anything
// can ask for it. Same JS realm in a popout (the opener's), so one registration
// serves every window.
import type { SettingsSection } from './settings-sections';

let opener: ((section: SettingsSection | null) => void) | null = null;

/** The App's `openSettings`. Returns the unregister. */
export function registerSettingsOpener(fn: (section: SettingsSection | null) => void): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Open Settings at `section`. False when nothing is registered (a test, a torn-down app). */
export function openSettingsAt(section: SettingsSection | null): boolean {
  if (!opener) return false;
  try {
    opener(section);
    return true;
  } catch {
    return false;
  }
}
