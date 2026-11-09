// The Start-menu shortcut carries the Toast Activator CLSID (#675).
//
// Windows finds the COM class to call for a toast pressed in the Action Center
// through the shortcut whose AppUserModelID matches the toast's. The installer
// writes the AUMID onto that shortcut (WinShell::SetLnkAUMI) but cannot write
// the CLSID: electron-builder's NSIS template has no way to, and WinShell has
// no function for it. Electron does: `shell.writeShortcutLink` takes
// `toastActivatorClsid` ("Needed for participating in Action Center", its own
// API docs). So the app stamps its own shortcut at boot.
//
// Every update reinstalls the shortcut (a one-click NSIS install recreates it),
// which wipes the stamp; the next boot puts it back. Reading first keeps the
// common case a read and nothing else.
//
// Fail-open throughout (P6): a missing shortcut, a locked file or a refusal
// costs only the Action Center path, never the boot.

import path from 'node:path';

export interface ShortcutIo {
  /** the parts of a .lnk this needs; throws when there is no such file */
  read(file: string): ShortcutFields;
  /**
   * `shell.writeShortcutLink(file, 'update', ...)`; false when it refused.
   * `link` is what `read` returned, so the link's own fields (its target
   * above all) can go back with ours.
   */
  update(file: string, fields: { toastActivatorClsid: string; appUserModelId: string }, link: ShortcutFields): boolean;
}

/** the parts of Electron's ShortcutDetails this reads (it returns more) */
export type ShortcutFields = { target: string; appUserModelId?: string; toastActivatorClsid?: string };

export type StampOutcome = 'stamped' | 'already' | 'no-shortcut' | 'not-ours' | 'refused';

/** where the per-user installer puts the Start-menu shortcut */
export function startMenuShortcutPath(appData: string, shortcutName: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${shortcutName}.lnk`);
}

/** `{ABC-...}`, `abc-...` and `{abc-...}` are one CLSID */
export function sameClsid(a: string | undefined, b: string): boolean {
  const norm = (v: string): string => v.trim().replace(/^\{|\}$/g, '').toUpperCase();
  return a !== undefined && a !== '' && norm(a) === norm(b);
}

/**
 * Make sure the shortcut names our activator. A shortcut carrying a DIFFERENT
 * AppUserModelID is someone else's (a renamed install, a hand-made link) and is
 * left alone: stamping our class onto it would route their toasts to us.
 */
export function stampToastActivator(
  io: ShortcutIo,
  file: string,
  clsid: string,
  appUserModelId: string
): StampOutcome {
  let link: ShortcutFields;
  try {
    link = io.read(file);
  } catch {
    return 'no-shortcut';
  }
  if (link.appUserModelId && link.appUserModelId !== appUserModelId) return 'not-ours';
  if (sameClsid(link.toastActivatorClsid, clsid)) return 'already';
  try {
    return io.update(file, { toastActivatorClsid: clsid, appUserModelId }, link) ? 'stamped' : 'refused';
  } catch {
    return 'refused';
  }
}
