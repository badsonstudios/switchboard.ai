// Only the top modal is modal (#1020), in the real app.
//
// A dialog marked `aria-modal` tells a screen reader it owns the window. Two
// at once is a contradiction. The app now keeps one stack per window
// (`lib/modal-layer`): only the top dialog is modal, and the one beneath is
// inert until it is on top again.
//
// What only the real app can show: that a stack the app really makes (About,
// then Settings from its own button) leaves exactly one modal, gives the
// lower one back when the upper closes, and that a dialog whose state the
// app's root never knew about (a session's history window) now silences the
// shortcut that used to open a second dialog over it.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const about = (w: Page) => w.getByRole('dialog', { name: 'About this build', includeHidden: true });
const settings = (w: Page) => w.getByRole('dialog', { name: 'Settings', includeHidden: true });
const modal = (w: Page) => w.locator('[aria-modal="true"]');

test.describe('only the top modal is modal (#1020)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('About, then Settings over it: one modal, and About comes back when Settings closes', async () => {
    a = await launchApp();
    const w = a.window;
    await expect(w.getByText('switchboard.ai').first()).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press(`${MOD}+Shift+p`);
    await w.keyboard.type('about');
    await w.keyboard.press('Enter');
    await expect(about(w)).toBeVisible({ timeout: 15_000 });
    await expect(modal(w)).toHaveCount(1);
    await expect(about(w)).toHaveAttribute('aria-modal', 'true');

    // the stack the app makes itself: About's own Settings button
    await about(w).getByRole('button', { name: 'Settings…' }).click();
    await expect(settings(w)).toBeVisible({ timeout: 15_000 });
    // EXACTLY ONE claims the window, and it is the one on top
    await expect(modal(w)).toHaveCount(1);
    await expect(settings(w)).toHaveAttribute('aria-modal', 'true');
    // the one beneath is out of reach: not modal, and inert
    await expect(about(w)).not.toHaveAttribute('aria-modal', 'true');
    expect(await about(w).evaluate((el) => el.hasAttribute('inert'))).toBe(true);
    // WHAT IS MODAL IS WHAT IS DRAWN ON TOP: the point in the middle of the
    // window belongs to Settings, not to the dialog beneath it
    const onTop = await w.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return el?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null;
    });
    expect(onTop).toBe('Settings');

    // Settings closes: About is the modal again, and usable
    await w.keyboard.press('Escape');
    await expect(settings(w)).toHaveCount(0);
    await expect(modal(w)).toHaveCount(1);
    await expect(about(w)).toHaveAttribute('aria-modal', 'true');
    expect(await about(w).evaluate((el) => el.hasAttribute('inert'))).toBe(false);
    // the keyboard is back INSIDE About (on the button that opened Settings),
    // not lost to the page: a real browser moves focus out of an inert
    // subtree, so this is the part a unit test cannot see
    await expect
      .poll(() => about(w).evaluate((el) => el.contains(document.activeElement)), { timeout: 10_000 })
      .toBe(true);
    await w.keyboard.press('Escape');
    await expect(about(w)).toHaveCount(0);
    await expect(modal(w)).toHaveCount(0);
  });

  test('a session’s history window silences the shortcut that opened a second dialog over it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.locator('[data-testid="card-history"]').first().click();
    const history = w.locator('[data-history-dialog]');
    await expect(history).toBeVisible({ timeout: 15_000 });
    await expect(modal(w)).toHaveCount(1);

    // The command list is claimed above the page, so it arrives however the
    // keyboard is occupied. The app's root did not know this dialog was open
    // (its state lives in the card), so this used to open a second modal.
    await w.keyboard.press(`${MOD}+Shift+p`);
    await w.waitForTimeout(700);
    await expect(w.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(modal(w)).toHaveCount(1);
    await expect(history).toBeVisible();

    // close it: the shortcut works again
    await w.keyboard.press('Escape');
    await expect(history).toHaveCount(0);
    await w.keyboard.press(`${MOD}+Shift+p`);
    await expect(modal(w)).toHaveCount(1, { timeout: 15_000 });
  });
});
