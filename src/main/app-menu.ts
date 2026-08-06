// Application menu (P2-E9-01). Electron's DEFAULT menu registers accelerators
// in the browser process, ahead of the renderer — and two of them are hostile
// to a session host:
//
//   • Window > Close  = Ctrl/Cmd+W  — closes the WHOLE window, killing every
//     session in it. It also shadows the renderer's "close the focused
//     session" command, which is the one a user actually means.
//   • View > Reload   = Ctrl/Cmd+R  — reloads the renderer mid-session, tearing
//     down every terminal view and re-running the whole restore path.
//
// So we own the menu instead of inheriting it. Keyboard capability lives in the
// renderer's command registry (lib/commands.ts) — the menu exists for the
// things only the browser process can do, and deliberately claims no
// accelerator the registry wants.
//
// macOS needs a real menu for basic editing keys (Cmd+C/V/Z come FROM the menu
// there, unlike Windows/Linux where Chromium handles them natively), so the
// darwin template keeps the standard app + edit roles.
import type { MenuItemConstructorOptions } from 'electron';

/** accelerators the renderer's command registry owns — never claim these */
export const RESERVED_ACCELERATORS = ['CommandOrControl+W', 'CommandOrControl+R'];

/**
 * Things the menu can ask the app to do.
 *
 * Optional, so the template stays pure data a test can build for any platform
 * without wiring. A menu item whose callback is absent is simply not added —
 * better a shorter Help menu than one with a dead entry in it.
 */
export interface MenuActions {
  /** manual "Check for updates…" (P2-E19-03) */
  checkForUpdates?: () => void;
}

export function buildMenuTemplate(
  platform: NodeJS.Platform,
  actions: MenuActions = {}
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    // Cmd+Q / Hide / Services live here; without it macOS shows no app menu
    template.push({ role: 'appMenu' });
    // Cmd+C / Cmd+V / Cmd+Z come from this menu on macOS — dropping it would
    // break copy-paste in the composer
    template.push({ role: 'editMenu' });
  }

  template.push({
    label: 'View',
    submenu: [
      // NO Reload / Force Reload: a reload kills every hosted session's view.
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: isMac
      ? // NOT role:'windowMenu' — it would re-add Close on Cmd+W
        [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }],
  });

  // Help exists for exactly one thing so far: the manual update check
  // (P2-E19-03). It is in the menu as well as the palette and the About panel
  // because the menu is where every desktop app has put it for thirty years,
  // and §5.8's promise is that capability is never out of reach — a user who
  // has never opened the palette still has to be able to ask.
  //
  // NO accelerator: the registry owns keys, and this is a once-in-a-while
  // action (`app-menu.test.ts` asserts the menu claims none of the two the
  // renderer needs).
  if (actions.checkForUpdates) {
    template.push({
      label: 'Help',
      submenu: [{ label: 'Check for Updates…', click: () => actions.checkForUpdates?.() }],
    });
  }

  return template;
}

/**
 * Every accelerator this template registers, flattened — lets a test prove we
 * never take a key the command registry needs.
 */
export function acceleratorsIn(template: MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.accelerator) out.push(item.accelerator);
      const sub = item.submenu;
      if (Array.isArray(sub)) walk(sub);
    }
  };
  walk(template);
  return out;
}
