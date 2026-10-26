// A closed group still shows its NAME on a narrow list (#1455).
//
// Dan's screenshot: a list of closed groups whose names read "IT…", "Pr…", or
// nothing at all, because the header was one row and the count, the roll-up,
// the waiting chip, the folded-away pill and three buttons were all fixed
// width — the name was the only thing left to shrink. The header is two lines
// now; this is the screenshot's worst case (a session waiting on you, another
// folded away, the group closed) at the narrowest width the list allows,
// measured in the real app because jsdom does no layout.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, permissionHolder, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) => w.locator('nav .rail-row').filter({ hasText: title });

async function palette(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(title);
  await w.keyboard.press('Enter');
}

/** one more session, in its own folder so nothing auto-groups */
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

test.describe('a group header on a narrow list (#1455)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a closed group with a waiting session and a folded-away one still shows its name', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);

    // a group holding the first two
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    for (const title of [first, second]) {
      await row(w, title).click({ button: 'right' });
      await w.getByRole('menuitemradio', { name: 'New group' }).click();
    }
    const key = await rail(w)
      .locator('[data-group-card]', { hasText: 'New group' })
      .getAttribute('data-group-card');
    const card = rail(w).locator(`[data-group-card="${key}"]`);
    await expect(card.locator('.rail-row')).toHaveCount(2);

    // named "IT", the group Dan's screenshot showed as "IT…". A SHORT name is
    // the honest case: at the list's 200px minimum, line 1 is the name beside
    // three buttons, and a longer name ("New group") legitimately ends in "…"
    // there on Linux CI's ~5% wider fonts. What #1455 broke was a two-letter
    // name squeezed out by the chips; that is what this pins.
    await card.locator('[data-rail-group-toggle]').dblclick();
    const field = card.locator('.rail-head input');
    await field.fill('IT');
    await field.press('Enter');
    await expect(card.locator('[data-rail-group-toggle]')).toHaveText('IT');

    // stand on the third; Focus folds the other two away
    await row(w, third).click();
    await palette(w, 'Layout: Focus — one big card, the rest folded away');
    await expect(rail(w).locator('.rail-row[data-folded="true"]')).toHaveCount(2, {
      timeout: 15_000,
    });

    // the first asks for permission — a session that needs you is never folded,
    // so the group now has one waiting and one still folded away
    await permissionHolder(a)(first);
    await expect(row(w, first)).toHaveAttribute('data-needs-approval', 'true', { timeout: 20_000 });
    const folded = card.locator('[data-rail-group-folded]');
    await expect(folded).toBeVisible();

    // close the group: the header is all that is left of it
    await card.locator('[data-rail-group-toggle]').click();
    await expect(row(w, first)).toBeHidden();

    // the narrowest list there is: drag the edge as far left as it goes
    const handle = w.getByTitle('Drag to resize the rail');
    const hb = (await handle.boundingBox())!;
    await w.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await w.mouse.down();
    await w.mouse.move(Math.max(1, hb.x - 300), hb.y + hb.height / 2, { steps: 10 });
    await w.mouse.up();
    await expect
      .poll(async () => Math.round((await rail(w).boundingBox())!.width))
      .toBeLessThanOrEqual(200);

    const name = card.locator('[data-rail-group-toggle]');
    const summary = card.locator('[data-rail-group-summary]');
    await expect(name).toBeVisible();
    await expect(name).toHaveText('IT');
    await expect(folded).toBeVisible();
    await expect(summary).toBeVisible();

    const m = await card.locator('.rail-head').evaluate((head) => {
      const n = head.querySelector<HTMLElement>('[data-rail-group-toggle]')!;
      const s = head.querySelector<HTMLElement>('[data-rail-group-summary]')!;
      const nb = n.getBoundingClientRect();
      const sb = s.getBoundingClientRect();
      return {
        nameWidth: nb.width,
        // the name fits: nothing about it is cut off by an ellipsis
        nameCut: n.scrollWidth > n.clientWidth,
        // the chips are on a line BELOW the name, not beside it
        nameBottom: nb.bottom,
        summaryTop: sb.top,
        // and the header itself does not overflow the list sideways
        headOverflow: head.scrollWidth - head.clientWidth,
      };
    });
    expect(m.nameWidth, 'the name has no width').toBeGreaterThan(0);
    expect(m.nameCut, 'the name is ellipsised').toBe(false);
    expect(m.summaryTop, 'the chips share the name line').toBeGreaterThanOrEqual(m.nameBottom - 1);
    expect(m.headOverflow, 'the header overflows the list').toBeLessThanOrEqual(0);
  });
});
