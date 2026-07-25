// P2-E9-01: command registry + keybinding dispatcher. Proves BOTH directions of
// the hard rule — the bindings work, and they never steal a keystroke that the
// composer or the CLI (xterm) should get.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

// 'Mod' in the registry is Ctrl everywhere but macOS
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** the dockview tab currently active — i.e. the focused session card */
const activeTab = (w: Page) => w.locator('.dv-active-tab');

test.describe('keyboard commands (E9-01)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /** two sessions in DIFFERENT folders, so neither auto-groups and rail order
   *  is plain creation order */
  async function twoSessions(): Promise<{ w: Page; first: string; second: string }> {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    const first = path.basename(folderA);
    const second = path.basename(folderB);
    await expect(w.getByText(first).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(second).first()).toBeVisible({ timeout: 25_000 });
    // the rail lists them in creation order — what Ctrl+1/2 count against
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(2);
    const rows = await w.locator('nav [draggable="true"]').allInnerTexts();
    expect(rows[0]).toContain(first);
    expect(rows[1]).toContain(second);
    return { w, first, second };
  }

  test('Ctrl+1..9 focuses the Nth rail session', async () => {
    const { w, first, second } = await twoSessions();
    // the new session is active; jump back to the first, then forward again
    await expect(activeTab(w)).toContainText(second);
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(first);
    await w.keyboard.press(`${MOD}+2`);
    await expect(activeTab(w)).toContainText(second);
    // a slot with no session behind it does nothing at all
    await w.keyboard.press(`${MOD}+7`);
    await expect(activeTab(w)).toContainText(second);
  });

  test('Ctrl+PageUp / PageDown step through the rail and wrap', async () => {
    const { w, first, second } = await twoSessions();
    await w.keyboard.press(`${MOD}+PageDown`); // second -> wraps to first
    await expect(activeTab(w)).toContainText(first);
    await w.keyboard.press(`${MOD}+PageUp`); // first -> wraps back to second
    await expect(activeTab(w)).toContainText(second);
  });

  test('typing in the composer never jumps (the composer owns its keys)', async () => {
    const { w, first, second } = await twoSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(first);

    // by placeholder: a bare 'textarea' also matches xterm's hidden helper input
    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await w.keyboard.type('1 2 3');
    await expect(composer).toHaveValue('1 2 3'); // the digits went to the composer
    await expect(activeTab(w)).toContainText(first); // ...and nowhere else

    // even the MODIFIED binding stands down while a text input has focus
    await w.keyboard.press(`${MOD}+2`);
    await expect(activeTab(w)).toContainText(first);
    expect(await w.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    // and the second session is still reachable once focus leaves the composer
    await w.locator('.dv-active-tab').click();
    await w.keyboard.press(`${MOD}+2`);
    await expect(activeTab(w)).toContainText(second);
  });

  test('the terminal swallows every binding — the CLI owns its keys', async () => {
    const { w, first, second } = await twoSessions();
    await w.keyboard.press(`${MOD}+2`);
    await expect(activeTab(w)).toContainText(second);

    await showTerminal(w);
    await w.locator('.xterm-screen').first().click();
    await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });

    // a jump binding pressed inside the terminal must NOT jump...
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(second);
    await expect(activeTab(w)).not.toContainText(first);
    // ...and the terminal is still a live PTY afterwards
    await w.keyboard.type('echo E9_TERMINAL_ALIVE');
    await w.keyboard.press('Enter');
    await expect(w.getByText(/E9_TERMINAL_ALIVE/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Ctrl+B hides and shows the sessions rail (and the chip agrees)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('nav')).toBeVisible();

    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(0);
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toBeVisible();

    // the mouse path does the same thing (hiding chrome never removes capability)
    const chip = w.getByTitle(/Show or hide the sessions rail/);
    await chip.click();
    await expect(w.locator('nav')).toHaveCount(0);
    await chip.click();
    await expect(w.locator('nav')).toBeVisible();
  });

  test('the application menu claims none of the registry accelerators', async () => {
    // Electron's DEFAULT menu binds Ctrl+W (Window > Close — closes the window
    // and every session in it) and Ctrl+R (reload — tears down every session
    // view) in the BROWSER process, ahead of the renderer. Playwright injects
    // keys over CDP, which bypasses native accelerators entirely, so a passing
    // keyboard test proves nothing here — inspect the built menu instead.
    a = await launchApp();
    const claimed = await a.app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) return [];
      const walk = (items: Electron.MenuItem[]): string[] =>
        items.flatMap((i) => [
          ...(i.accelerator ? [i.accelerator] : []),
          ...(i.submenu ? walk(i.submenu.items) : []),
        ]);
      return walk(menu.items);
    });
    for (const reserved of ['CommandOrControl+W', 'CommandOrControl+R', 'CmdOrCtrl+W']) {
      expect(claimed).not.toContain(reserved);
    }
  });

  test('a rail rename field owns its keys too', async () => {
    const { w, first, second } = await twoSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(first);

    // double-click a rail row to rename it: the input must swallow the binding
    await w.locator('nav [draggable="true"]').first().dblclick();
    const rename = w.locator('nav input');
    await expect(rename).toBeVisible();
    await w.keyboard.press(`${MOD}+2`);
    await expect(activeTab(w)).toContainText(first);
    await expect(activeTab(w)).not.toContainText(second);
    await w.keyboard.press('Escape');
  });

  test('Ctrl+N opens a new session', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    await expect(w.getByText(path.basename(folderA)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1);

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.keyboard.press(`${MOD}+N`);
    await expect(w.getByText(path.basename(folderB)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(2);
  });

  test('Ctrl+W asks before it closes the focused session', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    // declining keeps the session — closing one ends it and forgets the record,
    // so the command routes through the same confirm as the tab ✕
    w.once('dialog', (d) => void d.dismiss());
    await w.keyboard.press(`${MOD}+W`);
    await expect(w.locator('nav').getByText(name)).toBeVisible();

    w.once('dialog', (d) => void d.accept());
    await w.keyboard.press(`${MOD}+W`);
    await expect(w.locator('nav').getByText(name)).toHaveCount(0, { timeout: 15_000 });
    // NOTE: Playwright injects keys via CDP, which bypasses native menu
    // accelerators — this cannot prove Ctrl+W isn't ALSO closing the window.
    // src/main/app-menu.test.ts covers that side (no menu item claims it).
  });

  test('Ctrl+` toggles the focused card between the Session and Terminal views', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    // Session is the default view (the terminal stays MOUNTED but hidden, so
    // its scrollback survives tab switches — assert visibility, not presence)
    await expect(w.locator('.xterm-screen').first()).toBeHidden();

    await w.keyboard.press(`${MOD}+\``);
    await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    // pressing it again returns to the Session view rather than sticking
    await w.keyboard.press(`${MOD}+\``);
    await expect(
      w.getByText('No activity yet — the Feed renders the conversation once it starts.')
    ).toBeVisible();
  });
});
