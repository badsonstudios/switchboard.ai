// Dragging a session up and down inside its group's list, with the sessions
// across the top (#1178), in the real app.
//
// The owner: "If I have the sessions at the top, I can't move a session up or
// down in a group to relocate it. I have to move the session window to the
// left and then move it there."
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const leftRows = (w: Page) => w.locator('nav [draggable="true"]');
const leftRow = (w: Page, title: string) => leftRows(w).filter({ hasText: title }).first();
const list = (w: Page) => w.locator('[data-strip-list]');
const listRow = (w: Page, title: string) =>
  list(w).locator('.rail-row').filter({ hasText: title }).first();

/** the titles in the group's open list on the strip, top to bottom */
const listTitles = (w: Page): Promise<string[]> =>
  list(w)
    .locator('.rail-row [data-rail-title]')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));

/** the titles in the list on the left, top to bottom */
const leftTitles = (w: Page): Promise<string[]> =>
  w
    .locator('nav .rail-row [data-rail-title]')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(a.window.locator('nav .rail-row', { hasText: name })).toBeVisible({ timeout: 25_000 });
  return name;
}

/** drag one row of the open list onto the top or bottom half of another */
async function dragInList(w: Page, from: string, to: string, half: 'top' | 'bottom'): Promise<void> {
  const src = listRow(w, from);
  const dst = listRow(w, to);
  const box = (await dst.boundingBox())!;
  const clientY = half === 'top' ? box.y + box.height * 0.25 : box.y + box.height * 0.75;
  const dt = await w.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt, clientY });
  await dst.dispatchEvent('drop', { dataTransfer: dt, clientY });
}

test.describe('reordering inside a group, with the sessions across the top (#1178)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('a row in the group’s list drags above and below the others, and the left list agrees', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(w.locator('nav .rail-row', { hasText: first })).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);

    // one group holding all three, arranged in the list on the left
    await w.getByTitle('Create a persistent group').click();
    const header = w.getByText('New group', { exact: true });
    await expect(header).toBeVisible();
    for (const title of [first, second, third]) {
      const dt = await w.evaluateHandle(() => new DataTransfer());
      await leftRow(w, title).dispatchEvent('dragstart', { dataTransfer: dt });
      await header.dispatchEvent('drop', { dataTransfer: dt });
      await expect(w.locator('[data-group-card] .rail-row', { hasText: title })).toBeVisible();
    }
    const before = await leftTitles(w);
    expect(before).toHaveLength(3);

    // across the top, and open the group
    await w.locator('[data-placement="top"]').click();
    const strip = w.getByTestId('sessions-strip');
    await strip.locator('[data-strip-group-open]').click();
    await expect(list(w)).toBeVisible();
    expect(await listTitles(w)).toEqual(before);

    // the LAST one, onto the top half of the FIRST: it goes to the top
    await dragInList(w, before[2], before[0], 'top');
    await expect.poll(() => listTitles(w)).toEqual([before[2], before[0], before[1]]);
    // the list did not close under the drag: go again, the other way
    await expect(list(w)).toBeVisible();
    await dragInList(w, before[2], before[1], 'bottom');
    await expect.poll(() => listTitles(w)).toEqual([before[0], before[1], before[2]]);

    // one more, so the order left behind is not the one it started with
    await dragInList(w, before[0], before[1], 'bottom');
    const after = [before[1], before[0], before[2]];
    await expect.poll(() => listTitles(w)).toEqual(after);

    // and it is the SAME order the list on the left shows: one order, two views
    await w.locator('[data-placement="left"]').click();
    await expect.poll(() => leftTitles(w)).toEqual(after);
  });
});
