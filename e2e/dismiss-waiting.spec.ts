// Click "waiting" to dismiss it (#1413).
//
// A session whose turn finished says "waiting" on its tab, its card header's
// pill, its row in the left list and its pill on the strip, and its group's
// heading counts it ("3 waiting"). The owner wants to click the word and have
// it go: back to normal colours everywhere, out of every count, until the
// session's NEXT turn finishes. Dismissing in one place clears all of them.
//
// Driven through the real machinery by the fake stream CLI: `hello` is a turn
// that finishes. The store rule is session-store.test's and rail-view.test's;
// this is what a glance reads, and that the four click targets are wired.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter, tempProjectFolder } from './fixtures/app';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) => rail(w).locator('.rail-row').filter({ hasText: title });
const tab = (w: Page, title: string) =>
  w.locator('.dv-tabs-container .dv-tab').filter({ hasText: title }).locator('.identity-tab');
const groupCard = (w: Page) => rail(w).locator('[data-group-card]').filter({ hasText: 'New group' });
const summary = (w: Page) => groupCard(w).locator('[data-rail-group-summary]');
const strip = (w: Page) => w.getByTestId('sessions-strip');
const pill = (w: Page, title: string) =>
  strip(w)
    .locator('[data-strip-pill]')
    .filter({ has: w.locator('[data-strip-pill-title]', { hasText: title }) });

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

test.describe('dismissing "waiting" (#1413)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('a click on the word clears it everywhere and drops the group count; the next turn brings it back', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const one = path.basename(folder);
    await expect(row(w, one)).toBeVisible({ timeout: 25_000 });
    const two = await addSession(a);
    const three = await addSession(a);
    const solo = await addSession(a);

    // three of them in one group, so its heading has a count to drop
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    for (const title of [one, two, three]) {
      await row(w, title).click({ button: 'right' });
      await w.getByRole('menuitemradio', { name: 'New group' }).click();
    }
    await expect(groupCard(w).locator('.rail-row')).toHaveCount(3);

    const prompt = streamPrompter(a);
    for (const title of [one, two, three, solo]) await prompt(title, 'hello');
    for (const title of [one, two, three, solo]) {
      await expect(row(w, title)).toHaveAttribute('data-wait-state', 'waiting', { timeout: 30_000 });
    }
    await expect(summary(w)).toHaveText('3 waiting');

    // ── on the TAB: the word goes everywhere, the heading drops, the tab opens ──
    await tab(w, one).locator('[data-dismiss-waiting="tab"]').click();
    await expect(summary(w)).toHaveText('2 waiting');
    await expect(w.locator('.dv-active-tab')).toContainText(one);
    await expect(tab(w, one)).not.toHaveAttribute('data-wait-state', /./);
    await expect(tab(w, one).locator('[data-tab-state]')).toHaveCount(0);
    await expect(row(w, one)).not.toHaveAttribute('data-wait-state', /./);
    await expect(row(w, one).locator('[data-rail-state]')).toHaveText('calm');
    await expect(w.getByTestId('card-header').filter({ hasText: one }).locator('.status-pill')).toHaveText('calm');
    // the others are untouched
    await expect(row(w, two)).toHaveAttribute('data-wait-state', 'waiting');
    await expect(tab(w, two).locator('[data-tab-state]')).toHaveText('waiting');

    // ── on the ROW: the word only, it does not open the session ──
    await row(w, two).locator('[data-dismiss-waiting="row"]').click();
    await expect(summary(w)).toHaveText('1 waiting');
    await expect(row(w, two)).not.toHaveAttribute('data-wait-state', /./);
    await expect(tab(w, two).locator('[data-tab-state]')).toHaveCount(0);
    await expect(w.locator('.dv-active-tab')).toContainText(one);

    // ── on the CARD HEADER's pill: the last one, so the clause goes ──
    await tab(w, three).click();
    const header = w.getByTestId('card-header').filter({ hasText: three });
    await expect(header.locator('.status-pill')).toHaveText('waiting');
    await header.locator('[data-dismiss-waiting="pill"]').click();
    await expect(summary(w)).toHaveText('calm');
    await expect(header.locator('.status-pill')).toHaveText('calm');
    await expect(row(w, three)).not.toHaveAttribute('data-wait-state', /./);

    // ── the next turn that finishes is "waiting" again ──
    await prompt(one, 'hello');
    await expect(row(w, one)).toHaveAttribute('data-wait-state', 'waiting', { timeout: 30_000 });
    await expect(summary(w)).toHaveText('1 waiting');
    await expect(tab(w, one).locator('[data-tab-state]')).toHaveText('waiting');

    // ── on the STRIP's pill ──
    await w.locator('[data-placement="top"]').click();
    await expect(strip(w)).toBeVisible();
    await expect(pill(w, solo)).toHaveAttribute('data-wait-state', 'waiting');
    await pill(w, solo).locator('[data-dismiss-waiting="pill"]').click();
    await expect(pill(w, solo)).not.toHaveAttribute('data-wait-state', /./);
    await expect(tab(w, solo).locator('[data-tab-state]')).toHaveCount(0);
  });
});
