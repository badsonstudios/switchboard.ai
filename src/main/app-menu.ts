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
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';

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
  /**
   * File > Open File… (#569).
   *
   * Deliberately NOT "show a dialog here". The renderer already owns this
   * action end to end — `view.openFile` in the command registry picks a file
   * (which is also what GRANTS read scope for it) and opens the viewer where
   * the placement rule says. A menu item that re-implemented that sequence in
   * the browser process would be a second path to one action, and two paths to
   * one action is how they drift. So this fires the command the palette fires.
   *
   * `from` is the window the click came from — Electron hands it to every menu
   * click, and the app menu is SHARED with popped-out session windows, so a
   * click there must run in that window rather than in a main window nobody was
   * looking at (#569 review). Typed `BaseWindow` because that is what Electron
   * passes; the caller narrows.
   */
  openFile?: (from?: BaseWindow) => void;
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
  }

  // FILE IS FIRST, to the left of View — where the owner asked for it and
  // where thirty years of desktop apps have put it (#569). §5.8 promises
  // capability is never out of reach: `Open file…` was in the palette all
  // along and nobody could find it, which is half of what #521 reports.
  if (actions.openFile) {
    template.push({
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          // SHOWN, NOT CLAIMED. `registerAccelerator: false` draws "Ctrl+O"
          // beside the item without the browser process taking the chord — the
          // renderer's command registry owns it instead (`view.openFile`).
          //
          // This is not a style choice. An application-menu accelerator is
          // consumed ahead of the page, and the hosted CLI binds `ctrl+o`
          // itself (`app:toggleTranscript`; it prints "ctrl+o to see" in its own
          // notices). Claiming it here would have switchboard answer the CLI's
          // own instruction with a file dialog — P7 broken in one keystroke, on
          // the one platform where it reaches the PTY.
          accelerator: 'CommandOrControl+O',
          registerAccelerator: false,
          click: (_item, from) => actions.openFile?.(from ?? undefined),
        },
        // NO Exit on macOS: Quit lives in the app menu there, on Cmd+Q, and a
        // second one in File is a duplicate the platform does not have.
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { role: 'quit', label: 'Exit' },
            ] as MenuItemConstructorOptions[])),
      ],
    });
  }

  if (isMac) {
    // Cmd+C / Cmd+V / Cmd+Z come FROM this menu on macOS — dropping it would
    // break copy-paste in the composer. After File, which is where macOS puts
    // it: App · File · Edit · View · Window · Help.
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
