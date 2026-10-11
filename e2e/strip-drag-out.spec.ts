// Taking a session OUT of its group, with the sessions across the top (#1197).
//
// The owner: "I'm not able to grab a session out of the group and move it
// outside the group when my session list is at the top."
//
// What was there before this: a row could be dragged up and down its own list
// and onto ANOTHER group's box, and the right-click menu had "No group". What
// was missing is the drag he tried: there was nowhere on the strip to let go
// that meant "no group".
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const leftRows = (w: Page) => w.locator('nav [draggable="true"]');
const leftRow = (w: Page, title: string) => leftRows(w).filter({ hasText: title }).first();
const strip = (w: Page) => w.getByTestId('sessions-strip');
const list = (w: Page) => w.locator('[data-strip-list]');
const listRow = (w: Page, title: string) =>
  list(w).locator('.rail-row').filter({ hasText: title }).first();
const pill = (w: Page, title: string) => w.locator('[data-strip-pill]').filter({ hasText: title });
const hint = (w: Page) => w.locator('[data-strip-drop-out]');

const listTitles = (w: Page): Promise<string[]> =>
  list(w)
    .locator('.rail-row [data-rail-title]')
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

/** three sessions, the first two in one group; the strip on, the group open */
async function arranged(a: LaunchedApp): Promise<{ w: Page; names: string[] }> {
  const w = a.window;
  const second = await addSession(a);
  const third = await addSession(a);
  const first = (
    await w.locator('nav .rail-row [data-rail-title]').first().textContent()
  )!.trim();
  await w.getByTitle('Create a persistent group').click();
  const header = w.getByText('New group', { exact: true });
  await expect(header).toBeVisible();
  for (const title of [first, second]) {
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await leftRow(w, title).dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    await expect(w.locator('[data-group-card] .rail-row', { hasText: title })).toBeVisible();
  }
  await w.locator('[data-placement="top"]').click();
  await strip(w).locator('[data-strip-group-open]').click();
  await expect(list(w)).toBeVisible();
  expect(await listTitles(w)).toEqual([first, second]);
  // the third is loose: a pill of its own
  await expect(pill(w, third)).toHaveCount(1);
  return { w, names: [first, second, third] };
}

test.describe('a session can be taken out of its group on the strip (#1197)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => {
    await a?.close();
  });

  test('drag a row out of the group’s list onto the strip: it becomes a loose pill', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.locator('nav .rail-row').first()).toBeVisible({ timeout: 25_000 });
    const { w, names } = await arranged(a);
    const [first, second, third] = names;
    const line = strip(w).locator('[data-strip-line]');

    const dt = await w.evaluateHandle(() => new DataTransfer());
    await listRow(w, first).dispatchEvent('dragstart', { dataTransfer: dt });

    // OVER ITS OWN GROUP'S BOX it promises nothing: that is not "out"
    await strip(w).locator('[data-strip-group]').dispatchEvent('dragover', { dataTransfer: dt });
    await expect(hint(w)).toHaveCount(0);

    // OVER THE STRIP ITSELF: it says what letting go will do, in words
    await line.dispatchEvent('dragover', { dataTransfer: dt });
    await expect(hint(w)).toHaveText('Let go to take it out of its group');
    await expect(strip(w)).toHaveAttribute('data-drop-out', 'true');

    await line.dispatchEvent('drop', { dataTransfer: dt });
    // it is a pill of its own now, beside the one that was already loose
    await expect(pill(w, first)).toHaveCount(1, { timeout: 15_000 });
    await expect(pill(w, third)).toHaveCount(1);
    await expect(hint(w)).toHaveCount(0);
    await expect(strip(w)).not.toHaveAttribute('data-drop-out', 'true');

    // the group has one session left, and the list on the left agrees
    await w.locator('[data-placement="left"]').click();
    const card = w.locator('nav [data-group-card]', { hasText: 'New group' });
    await expect(card.locator('.rail-row')).toHaveCount(1);
    await expect(card.locator('.rail-row')).toContainText(second);
    await expect(w.locator('nav .rail-row', { hasText: first })).toBeVisible();
  });

  test('dropping it on a LOOSE pill takes it out too, and a refused drop inside the list does not', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.locator('nav .rail-row').first()).toBeVisible({ timeout: 25_000 });
    const { w, names } = await arranged(a);
    const [first, second, third] = names;

    // A DROP THE LIST REFUSES (a row on itself) is not an ungroup by accident:
    // the list has its own meanings, including "no"
    const self = await w.evaluateHandle(() => new DataTransfer());
    await listRow(w, first).dispatchEvent('dragstart', { dataTransfer: self });
    await listRow(w, first).dispatchEvent('dragover', { dataTransfer: self });
    await expect(hint(w)).toHaveCount(0);
    await listRow(w, first).dispatchEvent('drop', { dataTransfer: self });
    await w.waitForTimeout(500);
    expect(await listTitles(w)).toEqual([first, second]);
    await expect(pill(w, first)).toHaveCount(0);

    // ONTO A LOOSE PILL: the pill is on the strip, outside every group
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await listRow(w, second).dispatchEvent('dragstart', { dataTransfer: dt });
    await pill(w, third).dispatchEvent('dragover', { dataTransfer: dt });
    await expect(hint(w)).toBeVisible();
    await pill(w, third).dispatchEvent('drop', { dataTransfer: dt });
    await expect(pill(w, second)).toHaveCount(1, { timeout: 15_000 });
  });

  test('with a REAL mouse: press on the row, carry it up to the strip, let go', async () => {
    // the tests above dispatch drag events at elements; this one moves the
    // pointer, which is the only way to learn that the list stays open under
    // the drag and that the strip can be reached from it
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.locator('nav .rail-row').first()).toBeVisible({ timeout: 25_000 });
    const { w, names } = await arranged(a);
    const [first] = names;

    const from = (await listRow(w, first).boundingBox())!;
    const to = (await strip(w).locator('[data-strip-line]').boundingBox())!;
    await w.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await w.mouse.down();
    // in steps: a drag only starts once the pointer has really travelled
    await w.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 4 });
    await w.mouse.move(to.x + to.width * 0.7, to.y + to.height / 2, { steps: 12 });
    await expect(hint(w)).toBeVisible();
    await w.mouse.up();
    await expect(pill(w, first)).toHaveCount(1, { timeout: 15_000 });
  });

  test('without the mouse: right-click ▸ No group does the same', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.locator('nav .rail-row').first()).toBeVisible({ timeout: 25_000 });
    const { w, names } = await arranged(a);
    const [first] = names;

    await listRow(w, first).click({ button: 'right' });
    await w.getByRole('menuitemradio', { name: 'No group' }).click();
    await expect(pill(w, first)).toHaveCount(1, { timeout: 15_000 });
  });
});
