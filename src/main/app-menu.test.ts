import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { acceleratorsIn, buildMenuTemplate, RESERVED_ACCELERATORS } from './app-menu';

/** roles that carry a default accelerator we refuse to give the menu */
const FORBIDDEN_ROLES = [
  'close', // Ctrl/Cmd+W — would close the window (and every session in it)
  'reload', // Ctrl/Cmd+R — reloads the renderer mid-session
  'forceReload',
  'windowMenu', // contains Close on Cmd+W
  'fileMenu', // contains Close/Quit
];

function rolesIn(template: MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.role) out.push(item.role);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return out;
}

describe('application menu (E9-01: the menu must not shadow the command registry)', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
    it(`${platform}: claims no reserved accelerator, directly or via a role`, () => {
      const template = buildMenuTemplate(platform);
      for (const acc of acceleratorsIn(template)) {
        expect(RESERVED_ACCELERATORS).not.toContain(acc);
      }
      for (const role of rolesIn(template)) {
        expect(FORBIDDEN_ROLES).not.toContain(role);
      }
    });
  }

  it('macOS keeps the app + edit menus (Cmd+C/V come from the menu there)', () => {
    const roles = rolesIn(buildMenuTemplate('darwin'));
    expect(roles).toContain('appMenu');
    expect(roles).toContain('editMenu');
    // ...but builds Window by hand, since role:'windowMenu' would re-add Cmd+W
    expect(roles).toContain('minimize');
  });

  it('keeps DevTools reachable (dogfooding) on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      expect(rolesIn(buildMenuTemplate(platform))).toContain('toggleDevTools');
    }
  });
});

describe('Help ▸ Check for Updates… (P2-E19-03)', () => {
  function labels(template: MenuItemConstructorOptions[]): string[] {
    const out: string[] = [];
    const walk = (items: MenuItemConstructorOptions[]): void => {
      for (const item of items) {
        if (typeof item.label === 'string') out.push(item.label);
        if (Array.isArray(item.submenu)) walk(item.submenu);
      }
    };
    walk(template);
    return out;
  }

  it('appears on every platform when the app wires it up, and RUNS the callback', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      const checkForUpdates = vi.fn();
      const template = buildMenuTemplate(platform, { checkForUpdates });
      expect(labels(template), platform).toContain('Help');
      expect(labels(template), platform).toContain('Check for Updates…');
      const help = template.find((t) => t.label === 'Help')!;
      const item = (help.submenu as MenuItemConstructorOptions[])[0];
      // only the MIDDLE parameter (`browserWindow`) is declared
      // `BaseWindow | undefined`; the other two are not optional
      item.click?.(undefined as never, undefined, undefined as never);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    }
  });

  it('is ABSENT rather than dead when nothing is wired to it', () => {
    // The template is pure data a test can build for any platform; a menu item
    // that does nothing when clicked is worse than one that is not there.
    expect(labels(buildMenuTemplate('win32'))).not.toContain('Help');
  });

  it('claims no accelerator — the registry owns keys', () => {
    const template = buildMenuTemplate('win32', { checkForUpdates: () => {} });
    const help = template.find((t) => t.label === 'Help')!;
    for (const item of help.submenu as MenuItemConstructorOptions[]) {
      expect(item.accelerator).toBeUndefined();
    }
    for (const acc of acceleratorsIn(template)) {
      expect(RESERVED_ACCELERATORS).not.toContain(acc);
    }
  });
});

// ── #569 — the File menu ────────────────────────────────────────────────────
describe('the File menu (#569)', () => {
  const withFile = (platform: NodeJS.Platform) =>
    buildMenuTemplate(platform, { openFile: () => {}, checkForUpdates: () => {} });
  const labels = (t: MenuItemConstructorOptions[]) => t.map((i) => i.label ?? String(i.role ?? ''));
  const fileMenu = (t: MenuItemConstructorOptions[]) =>
    (t.find((i) => i.label === 'File')?.submenu ?? []) as MenuItemConstructorOptions[];

  it('is FIRST on Windows — left of View, where the owner asked for it', () => {
    expect(labels(withFile('win32'))[0]).toBe('File');
    expect(labels(withFile('win32'))).toEqual(['File', 'View', 'Window', 'Help']);
  });

  it('carries Open File… and Exit, in that order', () => {
    const items = fileMenu(withFile('win32'));
    expect(items[0].label).toBe('Open File…');
    expect(items[items.length - 1]).toMatchObject({ role: 'quit', label: 'Exit' });
  });

  it('Open File… fires the action rather than doing the work itself', () => {
    const calls: string[] = [];
    const t = buildMenuTemplate('win32', { openFile: () => calls.push('open') });
    const item = fileMenu(t)[0] as { click: () => void };
    item.click();
    // one path: the renderer's own `view.openFile` command, which is also what
    // grants read scope for the file — not a second dialog in the browser process
    expect(calls).toEqual(['open']);
  });

  it('has NO Exit on macOS, where Quit belongs to the app menu', () => {
    const items = fileMenu(withFile('darwin'));
    expect(items.map((i) => i.role)).not.toContain('quit');
    expect(items.map((i) => i.label)).toEqual(['Open File…']);
  });

  it('follows the macOS order: App, File, Edit, View…', () => {
    // the platform convention, and File comes BEFORE Edit there
    expect(labels(withFile('darwin')).slice(0, 4)).toEqual([
      'appMenu',
      'File',
      'editMenu',
      'View',
    ]);
  });

  it('is absent entirely when nothing wired it — no dead entry', () => {
    expect(labels(buildMenuTemplate('win32', {}))).not.toContain('File');
  });

  // THE ONE THAT MATTERS. An application-menu accelerator is consumed by the
  // browser process ahead of the page, and the hosted CLI binds `ctrl+o` itself
  // (`app:toggleTranscript` — it prints "ctrl+o to see" in its own notices). So
  // the item SHOWS the chord and registers nothing; the renderer's registry owns
  // it, where `dispatch` refuses terminal targets and the CLI keeps its key.
  it('SHOWS Ctrl+O without claiming it — the CLI binds that key', () => {
    const item = fileMenu(withFile('win32'))[0];
    expect(item.accelerator).toBe('CommandOrControl+O');
    expect(item.registerAccelerator).toBe(false);
  });

  it('still claims none of the accelerators the renderer owns', () => {
    const accels = acceleratorsIn(withFile('win32'));
    for (const reserved of RESERVED_ACCELERATORS) expect(accels).not.toContain(reserved);
  });

  it('hands the click the window it came from, for the shared popout menu', () => {
    const seen: unknown[] = [];
    const t = buildMenuTemplate('win32', { openFile: (from) => seen.push(from) });
    const item = fileMenu(t)[0] as unknown as {
      click: (i: unknown, w: unknown, e: unknown) => void;
    };
    const win = { id: 7 };
    item.click({}, win, {});
    expect(seen).toEqual([win]);
  });
});
