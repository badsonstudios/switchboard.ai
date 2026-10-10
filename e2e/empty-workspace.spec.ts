// An empty workspace says how to start (#1166), in the real app.
//
// With the Sessions list hidden and nothing open, the window used to be blank.
// What only the real app can show: the message is really there when nothing is
// open (list showing AND list hidden), its button really opens a session the
// way "+ session" does, it is gone once a card exists, and it comes back when
// the last card is closed.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const empty = (w: Page) => w.getByTestId('empty-workspace');
const start = (w: Page) => w.getByTestId('empty-workspace-new-session');

test.describe('the empty workspace (#1166)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('says how to start with the list showing and with it hidden, and its button opens a session', async () => {
    a = await launchApp({ env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;

    // nothing open: the message is in the workspace
    await expect(empty(w)).toBeVisible({ timeout: 25_000 });
    await expect(empty(w)).toContainText('No sessions open');
    await expect(start(w)).toHaveText('Start a session');
    // ...and it is the only thing called that; the list's own button keeps its name
    await expect(w.getByRole('button', { name: '+ session' })).toHaveCount(1);

    // THE CASE THE TICKET IS ABOUT: hide the Sessions list. The window is not blank.
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.getByRole('button', { name: '+ session' })).toHaveCount(0);
    await expect(empty(w)).toBeVisible();
    await expect(start(w)).toBeVisible();

    // in the middle of the workspace, not tucked in a corner
    const place = await w.evaluate(() => {
      const b = document.querySelector<HTMLElement>('[data-testid="empty-workspace-new-session"]')!
        .getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return { offCentre: Math.abs(b.left + b.width / 2 - vw / 2), vw };
    });
    expect(place.offCentre, JSON.stringify(place)).toBeLessThan(place.vw * 0.15);

    // THE BUTTON STARTS A SESSION, with the mouse and nothing else known
    const folder = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, folder);
    await start(w).click();
    await expect(w.locator('.dv-tab .identity-tab').filter({ hasText: path.basename(folder) })).toHaveCount(
      1,
      { timeout: 25_000 }
    );
    // gone the moment there is a card
    await expect(empty(w)).toHaveCount(0);

    // close the only session: the workspace is empty again and says so
    w.once('dialog', (d) => void d.accept());
    await w.locator('.dv-tab .identity-tab button').click();
    await expect(empty(w)).toBeVisible({ timeout: 15_000 });
  });

  test('cancelling the folder picker leaves the message where it was', async () => {
    a = await launchApp({ env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(start(w)).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] });
    });
    await start(w).click();
    await w.waitForTimeout(500);
    await expect(empty(w)).toBeVisible();
    await expect(w.locator('.dv-tab .identity-tab')).toHaveCount(0);
  });
});
