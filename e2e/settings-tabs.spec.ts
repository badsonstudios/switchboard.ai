// The settings window is in tabs (#1199).
//
// The owner: "We need to organize the settings a little more, possibly with
// some tabs and sectioning things off." Fourteen settings in one scroll became
// six tabs in the same window.
//
// What only the real app can show: that a tab really hides the others'
// controls (jsdom has no layout, and `hidden` is only an attribute there), that
// the window does not change size as you move along the tabs, and that the
// palette's entries, which name a section, land on the tab that owns it.
import { test, expect, Page, Locator } from '@playwright/test';
import { closeSettings, launchApp, LaunchedApp, openSettings, openSettingsTab } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const tab = (d: Locator, id: string) => d.locator(`[data-settings-tab="${id}"]`);
const panel = (d: Locator, id: string) => d.locator(`[data-settings-section="${id}"]`);
const item = (d: Locator, id: string) => d.locator(`[data-settings-item="${id}"]`);

async function runCommand(w: Page, title: string): Promise<void> {
  await w.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await w.keyboard.press(`${MOD}+Shift+P`);
  await expect(w.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await w.keyboard.type(title);
  await w.keyboard.press('Enter');
}

test.describe('Settings is in tabs (#1199)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('six tabs, one showing; a tab hides the others’ settings; nothing is lost', async () => {
    a = await launchApp();
    const w = a.window;
    const d = await openSettings(w);

    await expect(d.getByRole('tab')).toHaveText([
      'Appearance',
      'General',
      'Notifications',
      'Sessions',
      'Diagnostics',
      'Advanced',
    ]);
    // it opens on Appearance, with the theme on screen and the language not
    await expect(tab(d, 'appearance')).toHaveAttribute('aria-selected', 'true');
    await expect(item(d, 'theme')).toBeVisible();
    await expect(item(d, 'context-meter')).toBeVisible();
    await expect(item(d, 'language')).toBeHidden();
    await expect(item(d, 'experimental-fork')).toBeHidden();

    // EVERY setting is on some tab, and only the tab showing can be seen
    const homes: Array<[string, string[]]> = [
      ['general', ['language', 'updates', 'status-polling']],
      ['attention', []],
      ['sessions', []],
      ['diagnostics', []],
      ['advanced', ['experimental-fork']],
      ['appearance', ['theme', 'context-meter']],
    ];
    const size = await d.boundingBox();
    for (const [id, items] of homes) {
      await tab(d, id).click();
      await expect(tab(d, id)).toHaveAttribute('aria-selected', 'true');
      await expect(panel(d, id)).toBeVisible();
      for (const other of homes.map(([o]) => o).filter((o) => o !== id)) {
        await expect(panel(d, other)).toBeHidden();
      }
      for (const it of items) await expect(item(d, it)).toBeVisible();
      // something to read on every tab
      expect(((await panel(d, id).innerText()) ?? '').trim().length).toBeGreaterThan(20);
      // ⚠️ the window is the same size on every tab: one that grew and shrank
      // would move the tabs out from under the pointer
      const now = await d.boundingBox();
      expect(Math.round(now!.height), id).toBe(Math.round(size!.height));
      expect(Math.round(now!.width), id).toBe(Math.round(size!.width));
    }

    // THE TABS AND DONE DO NOT SCROLL AWAY. On the longest tab, scrolled to its
    // end, both are still on screen and nothing has spilled out of the window.
    await tab(d, 'appearance').click();
    const body = d.locator('[data-settings-body]');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(tab(d, 'appearance')).toBeInViewport({ ratio: 1 });
    await expect(d.getByRole('button', { name: 'Done', exact: true })).toBeInViewport({ ratio: 1 });
    const win = (await d.boundingBox())!;
    const done = (await d.getByRole('button', { name: 'Done', exact: true }).boundingBox())!;
    expect(done.y + done.height).toBeLessThanOrEqual(win.y + win.height);
    // EVERY TAB STARTS AT ITS TOP: still scrolled to the end of Appearance,
    // go to another tab and back
    await tab(d, 'general').click();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
    await tab(d, 'appearance').click();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
    // and the intro above the first setting is not cut off under the tabs
    const intro = (await body.locator('p').first().boundingBox())!;
    const tabs = (await d.getByRole('tablist').boundingBox())!;
    expect(intro.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1);
  });

  test('by keyboard: one tab stop, the arrows move along it and wrap', async () => {
    a = await launchApp();
    const w = a.window;
    const d = await openSettings(w);
    await tab(d, 'appearance').focus();
    await w.keyboard.press('ArrowRight');
    await expect(tab(d, 'general')).toBeFocused();
    await expect(panel(d, 'general')).toBeVisible();
    await w.keyboard.press('End');
    await expect(tab(d, 'advanced')).toBeFocused();
    await w.keyboard.press('ArrowRight');
    await expect(tab(d, 'appearance')).toBeFocused();
    await expect(panel(d, 'appearance')).toBeVisible();
    // Escape still closes from a tab
    await w.keyboard.press('Escape');
    await expect(d).toBeHidden();
  });

  test('it reopens on the tab you were last on; a palette entry opens on the tab it names', async () => {
    a = await launchApp();
    const w = a.window;
    let d = await openSettingsTab(w, 'sessions');
    await closeSettings(w);
    d = await openSettings(w);
    await expect(tab(d, 'sessions')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(d, 'sessions')).toBeVisible();
    await closeSettings(w);

    // "Quiet hours" names the Attention section, which is the Notifications tab
    await runCommand(w, 'Quiet hours');
    d = w.getByRole('dialog', { name: 'Settings' });
    await expect(d).toBeVisible({ timeout: 15_000 });
    await expect(tab(d, 'attention')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(d, 'attention')).toBeVisible();
    await expect(panel(d, 'attention')).toContainText('Quiet hours');
  });
});
