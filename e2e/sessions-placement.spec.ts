import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, openSettings, closeSettings, tempProjectFolder } from './fixtures/app';

// Where the sessions are listed (#1143): the rail down the left, or one strip
// across the top. This spec is the claim the unit tests cannot make — that in
// the real window the three doors (the title bar's switch, Ctrl+B and Settings)
// move ONE thing, and that the choice is still there after a restart.
//
// It covers the frame only. The strip's groups, pills, menus and dragging each
// arrive with their own spec.
test.describe('sessions list placement', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the left / top switch swaps the rail for the strip, and back', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const { window } = a;
    const rail = window.locator('nav');
    const strip = window.getByTestId('sessions-strip');
    const lamps = window.getByTestId('urgency-strip');
    const left = window.locator('[data-placement="left"]');
    const top = window.locator('[data-placement="top"]');

    // the default: the rail, and the two rows the strip will replace
    await expect(rail).toBeVisible();
    await expect(lamps).toBeVisible();
    await expect(strip).toHaveCount(0);
    await expect(left).toHaveAttribute('aria-pressed', 'true');
    await expect(top).toHaveAttribute('aria-pressed', 'false');

    await top.click();
    await expect(strip).toBeVisible();
    await expect(rail).toHaveCount(0);
    // STILL THERE, on purpose: the strip is only a frame so far, and until it
    // lists sessions itself the lamps are how you reach one you cannot see.
    // This line flips to `toHaveCount(0)` in the change that lands the pills.
    await expect(lamps).toBeVisible();
    await expect(top).toHaveAttribute('aria-pressed', 'true');
    await expect(left).toHaveAttribute('aria-pressed', 'false');
    // one session is open, so the row must not claim there are none
    await expect(strip.locator('[data-strip-empty]')).toHaveAttribute('data-strip-empty', 'pending');

    await left.click();
    await expect(rail).toBeVisible();
    await expect(lamps).toBeVisible();
    await expect(strip).toHaveCount(0);
  });

  test('the lit half hides the strip, and Ctrl+B brings it back where it was', async () => {
    a = await launchApp();
    const { window } = a;
    const strip = window.getByTestId('sessions-strip');
    const top = window.locator('[data-placement="top"]');
    const left = window.locator('[data-placement="left"]');

    await top.click();
    await expect(strip).toBeVisible();

    await top.click(); // the lit half: put it away
    await expect(strip).toHaveCount(0);
    await expect(window.locator('nav')).toHaveCount(0);
    // hidden is not a third half: neither is lit
    await expect(top).toHaveAttribute('aria-pressed', 'false');
    await expect(left).toHaveAttribute('aria-pressed', 'false');

    // `Mod+B` is scope 'app': it is ignored while focus is in a prompt box
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+b`);
    await expect(strip).toBeVisible();
    await expect(top).toHaveAttribute('aria-pressed', 'true');
  });

  test('Settings shows the same choice, and it survives a restart', async () => {
    a = await launchApp();
    const home = a.home;
    let { window } = a;

    const dialog = await openSettings(window);
    await expect(dialog.locator('[data-sessions-placement="left"]')).toBeChecked();
    await dialog.locator('[data-sessions-placement="top"]').check();
    // visible behind the modal the instant it is picked — no Save button
    await expect(window.getByTestId('sessions-strip')).toBeVisible();
    await expect(window.locator('[data-placement="top"]')).toHaveAttribute('aria-pressed', 'true');
    await closeSettings(window);

    await a.close();
    a = await launchApp({ home });
    ({ window } = a);
    await expect(window.getByTestId('sessions-strip')).toBeVisible();
    await expect(window.locator('nav')).toHaveCount(0);
  });
});
