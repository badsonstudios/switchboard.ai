// "N need you" and "N finished" are two counts, and looking at a finished
// session clears it (#1219).
//
// The owner: "It still says 'Need you' at the top, even though I viewed the
// sessions … it doesn't really need me." A finished session was counted with
// the ones holding a permission, and only the jump hotkey and the Events list
// counted as having looked.
//
// Real app, because the claim is about real clicks: that the ordinary ways of
// going to a session reach main's acknowledge, and that none of them can
// silence a held permission.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  answerHeldPermissions,
  hookPoster,
  launchApp,
  LaunchedApp,
  permissionHolder,
  tempProjectFolder,
} from './fixtures/app';

const row = (w: Page, title: string) => w.locator('nav .rail-row').filter({ hasText: title });
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const finishedTotal = (w: Page) => w.locator('nav [data-rail-finished]');
const needTotal = (w: Page) => w.locator('nav [data-rail-need]');

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

test.describe('two counts: need you, and finished (#1219)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a finished session is "finished", and going to it clears it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);

    // we are standing on the THIRD; the first two finish behind us
    await post(first, { hook_event_name: 'Stop' });
    await post(second, { hook_event_name: 'Stop' });

    // FINISHED, not "need you": its own total, and the rows are lit so the
    // count leads somewhere
    await expect(finishedTotal(w)).toHaveText('2 finished', { timeout: 20_000 });
    await expect(needTotal(w)).toHaveCount(0);
    await expect(row(w, first)).toHaveAttribute('data-finished', 'true');
    await expect(row(w, first)).toHaveAttribute('data-needs-you', 'false');
    await expect(w.locator('nav .rail-row[data-finished="true"]')).toHaveCount(2);

    // GO TO ONE, the ordinary way: click it in the list. No Events panel.
    await row(w, first).click();
    await expect(w.locator('.dv-active-tab')).toContainText(first);
    await expect(finishedTotal(w)).toHaveText('1 finished', { timeout: 15_000 });
    await expect(row(w, first)).not.toHaveAttribute('data-finished', 'true');

    // MARK THE OTHER AS SEEN without going to it
    await row(w, second).click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Mark as seen' }).click();
    await expect(finishedTotal(w)).toHaveCount(0, { timeout: 15_000 });
    // ...and we did not move
    await expect(w.locator('.dv-active-tab')).toContainText(first);
    // nothing left to mark, so the item is not offered
    await row(w, second).click({ button: 'right' });
    await expect(w.getByRole('menuitem', { name: 'Close session' })).toBeVisible();
    await expect(w.getByRole('menuitem', { name: 'Mark as seen' })).toHaveCount(0);
    await w.keyboard.press('Escape');
  });

  test('a tab click counts, the total clears them all, and looking never clears a permission', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);

    // A TAB is a way of going to it too
    await post(first, { hook_event_name: 'Stop' });
    await expect(finishedTotal(w)).toHaveText('1 finished', { timeout: 20_000 });
    await tabs(w).filter({ hasText: first }).click();
    await expect(finishedTotal(w)).toHaveCount(0, { timeout: 15_000 });

    // THE TOTAL IS A BUTTON: two finish behind us, one click clears both
    await post(second, { hook_event_name: 'Stop' });
    await post(third, { hook_event_name: 'Stop' });
    await expect(finishedTotal(w)).toHaveText('2 finished', { timeout: 20_000 });
    await finishedTotal(w).click();
    await expect(finishedTotal(w)).toHaveCount(0, { timeout: 15_000 });
    await expect(w.locator('.dv-active-tab')).toContainText(first);

    // A HELD PERMISSION is the other count, and looking does not touch it
    await permissionHolder(a)(second);
    await expect(needTotal(w)).toHaveAttribute('data-rail-need', '1', { timeout: 20_000 });
    await expect(finishedTotal(w)).toHaveCount(0);
    await row(w, second).click();
    await expect(w.locator('.dv-active-tab')).toContainText(second);
    await row(w, second).click();
    // given a moment: a clear that DID happen would take a tick to land
    await w.waitForTimeout(1000);
    await expect(needTotal(w)).toHaveAttribute('data-rail-need', '1');
    await expect(row(w, second)).toHaveAttribute('data-needs-you', 'true');

    // answered: gone
    expect(await answerHeldPermissions(a)).toBe(1);
    await expect(needTotal(w)).toHaveCount(0, { timeout: 15_000 });
  });
});
