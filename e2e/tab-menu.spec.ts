// Right-clicking a tab in the workspace (#1281), in the real app.
//
// The units pin the menu: that it is the lists' menu plus the tab's own items
// (`session-menu-parity.test.tsx`), which items each kind of tab gets, the
// keyboard, and what each item calls (`IdentityTab.menu.test.tsx`). What only
// the real app can show: that a right-click on a REAL dockview tab reaches the
// menu at all (dockview owns that element, and the Electron edit menu is
// listening too), that Duplicate really makes a second session in the same
// folder, that a rename typed into the tab reaches main and comes back in all
// three places, and that a popped-out tab's menu opens in the popout.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const tabs = (w: Page) => w.locator('.dv-tab .identity-tab');
const menu = (w: Page) => w.getByTestId('tab-menu');
const menuItem = (w: Page, name: string) => menu(w).getByRole('menuitem', { name, exact: true });

/** the cards main holds, as `sessions:cards` reports them */
async function cards(w: Page): Promise<Array<{ cardId: string; title: string; folder: string }>> {
  return (await w.evaluate(() => window.switchboard.sessions.cards()));
}

test.describe('the tab menu (#1281)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  test('Duplicate makes a second, fresh session in the same folder', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1, { timeout: 25_000 });

    await tab.click({ button: 'right' });
    await expect(menu(w)).toBeVisible();
    // and only ours: no Electron edit menu was asked for over a tab
    await menuItem(w, 'Duplicate session').click();
    await expect(menu(w)).toHaveCount(0);

    // two tabs now, and main has two cards in the one folder
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect
      .poll(async () => (await cards(w)).filter((c) => c.folder === folder).length, { timeout: 25_000 })
      .toBe(2);
    // the usual name rule: not two sessions with one name
    const titles = (await cards(w)).map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test('Rename, typed into the tab, is the name on the tab, the list and the strip', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1, { timeout: 25_000 });
    // the session has to have started for main to hold a record to rename
    await expect(w.locator('nav').getByText(name)).toBeVisible({ timeout: 25_000 });

    await tab.click({ button: 'right' });
    await menuItem(w, 'Rename…').click();
    const box = w.locator('[data-tab-rename] input');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(name);
    await box.fill('renamed-by-tab');
    await box.press('Enter');
    await expect(box).toHaveCount(0);

    // the tab, the list on the left, and main's own record
    await expect(tabs(w).filter({ hasText: 'renamed-by-tab' })).toHaveCount(1, { timeout: 15_000 });
    await expect(w.locator('nav').getByText('renamed-by-tab')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await cards(w)).map((c) => c.title)).toContain('renamed-by-tab');
    // ...and the strip, once the sessions are put across the top
    await w.locator('[data-placement="top"]').click();
    const strip = w.getByTestId('sessions-strip');
    await expect(strip).toBeVisible();
    await expect(strip.getByText('renamed-by-tab')).toBeVisible();
  });

  test('the rename box does not change the tab bar\'s height', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1, { timeout: 25_000 });
    await expect(w.locator('nav').getByText(name)).toBeVisible({ timeout: 25_000 });
    const bar = w.locator('.dv-tabs-and-actions-container').first();
    const before = (await bar.boundingBox())!.height;
    await tab.click({ button: 'right' });
    await menuItem(w, 'Rename…').click();
    await expect(w.locator('[data-tab-rename] input')).toBeFocused();
    expect((await bar.boundingBox())!.height).toBe(before);
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-tab-rename]')).toHaveCount(0);
  });

  test('a popped-out tab\'s menu opens in the popout, and offers the way back', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1, { timeout: 25_000 });

    // out, from the tab's own menu
    await tab.click({ button: 'right' });
    await menuItem(w, 'Pop out to a new window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p !== w)!;
    await popout.waitForLoadState('domcontentloaded');
    const outTab = tabs(popout).filter({ hasText: name });
    await expect(outTab).toHaveCount(1, { timeout: 15_000 });

    await outTab.click({ button: 'right' });
    // drawn in the popout's document, not the main window's
    await expect(menu(popout)).toBeVisible();
    await expect(menu(w)).toHaveCount(0);
    await expect(menuItem(popout, 'Return to main window')).toBeVisible();
    await popout.keyboard.press('Escape');
    await expect(menu(popout)).toHaveCount(0);

    // Copy folder path works from out here too: the write is made from the
    // popout's own window, which is the one with focus
    await a.app.evaluate(({ clipboard }) => clipboard.writeText('before'));
    await outTab.click({ button: 'right' });
    await menuItem(popout, 'Copy folder path').click();
    await expect
      .poll(() => a.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe(folder);
  });
});
