// A session moved into a group lands at the bottom of it (#582), in the real app.
//
// The store's tests pin the rule. What only the real app can show is that the
// one place every move goes through really calls it: three sessions opened in
// the order A, X, B; A and B are put in a group; then X is moved in. Before the
// fix X appeared BETWEEN A and B (the order they were opened in), because a
// group nobody has arranged shows its members in that order.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  const before = await a.window.locator('nav [data-rail-open]').count();
  await a.window.getByRole('button', { name: '+ session' }).click();
  await expect(a.window.locator('nav [data-rail-open]')).toHaveCount(before + 1, { timeout: 25_000 });
  return path.basename(dir);
}

/** the list, top to bottom, as the folder names on its rows */
const rows = (w: Page): Promise<string[]> =>
  w.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('nav .rail-row [data-rail-title]')).map((el) =>
      (el.textContent ?? '').trim()
    )
  );

/** right-click a session's row and choose a group from "Move to group" */
async function moveToGroup(w: Page, name: string): Promise<void> {
  await w.locator('nav .rail-row').filter({ hasText: name }).click({ button: 'right' });
  const item = w.locator('[data-move-item]:not([data-move-item="ungrouped"])').first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
}

test.describe('a session moved into a group lands at the bottom (#582)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('moved in through the menu, it is last in the group, not where it was opened', async () => {
    const first = tempProjectFolder();
    a = await launchApp({ seedFolder: first, env: DIRECT });
    const w = a.window;
    const A = path.basename(first);
    await expect(w.locator('nav [data-rail-open]')).toHaveCount(1, { timeout: 25_000 });
    const X = await addSession(a);
    const B = await addSession(a);
    expect(await rows(w)).toEqual([A, X, B]); // the order they were opened in

    // one group, with A and B in it
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await moveToGroup(w, A);
    await moveToGroup(w, B);
    await expect.poll(() => rows(w), { timeout: 10_000 }).toEqual([A, B, X]);

    // THE CASE: X joins them. It was opened between A and B.
    await moveToGroup(w, X);
    await expect.poll(() => rows(w), { timeout: 10_000 }).toEqual([A, B, X]);
    // and it really is IN the group now, not still listed after it
    const inGroup = await w.evaluate(() => {
      const card = document.querySelector<HTMLElement>('nav [data-rail-group-toggle]')!.closest('div')!;
      let box: HTMLElement | null = card;
      // the group card: the nearest ancestor holding all three rows
      while (box && box.querySelectorAll('.rail-row').length < 3) box = box.parentElement;
      return box ? box.tagName !== 'NAV' : false;
    });
    expect(inGroup, 'the three rows are not inside one group card').toBe(true);

    // it stays that way after the app is closed and opened again
    const home = a.home;
    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();
    a = await launchApp({ home, env: DIRECT });
    await expect.poll(() => rows(a.window), { timeout: 25_000 }).toEqual([A, B, X]);
  });
});
