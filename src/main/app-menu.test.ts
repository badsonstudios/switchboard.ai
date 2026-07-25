import { describe, it, expect } from 'vitest';
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
