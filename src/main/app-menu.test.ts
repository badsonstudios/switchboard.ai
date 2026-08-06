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
      item.click?.(
        undefined as never,
        undefined as never,
        undefined as never
      );
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
