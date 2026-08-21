// #559 — reordering a group by dragging, and the order surviving a relaunch.
//
// The RULES are unit-tested: lib/rail-order.test.ts (the model, including the
// decision about what happens when an arrangement meets a pin),
// lib/groups.test.ts (railOrder applies it per bucket, pin sort still last),
// store/session-store.test.ts (derives + persists),
// components/SessionsRail.reorder.test.tsx (the drop hit test, the menu).
//
// This file owns the two claims none of those can make: a REAL drag, taken with
// real sessions in a real group, reorders the rail — and the order reaches the
// ui blob on disk and is read back before the first session push, so the rail
// paints in the arranged order on the next launch instead of shuffling itself
// in front of the user a moment later.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const rows = (w: Page) => rail(w).locator('[draggable="true"]');
const row = (w: Page, title: string) => rows(w).filter({ hasText: title }).first();

/** the rail's own order, top to bottom — what Ctrl+1..9 counts against */
async function railTitles(w: Page): Promise<string[]> {
  return rows(w).evaluateAll((els) =>
    els.map((e) => e.querySelector('[data-rail-open] > span')?.textContent?.trim() ?? '')
  );
}

/** open one more session, in its own folder (so nothing auto-groups) */
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

/**
 * Drag `from` onto the given half of `to`.
 *
 * The same synthesized-DataTransfer shape groups.spec.ts uses (Playwright
 * cannot drive a real HTML5 drag), plus the one thing this gesture needs that a
 * membership drop does not: a `clientY`, because "above or below the middle of
 * that row" is the whole question a reorder asks.
 */
async function dragOnto(
  w: Page,
  from: string,
  to: string,
  half: 'top' | 'bottom'
): Promise<void> {
  const src = row(w, from);
  const dst = row(w, to);
  const box = (await dst.boundingBox())!;
  const clientY = half === 'top' ? box.y + box.height * 0.25 : box.y + box.height * 0.75;
  const dt = await w.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt, clientY });
  await dst.dispatchEvent('drop', { dataTransfer: dt, clientY });
}

/** put every session in one persistent group, by the drag that already worked */
async function groupThemAll(w: Page, titles: string[]): Promise<void> {
  await w.getByTitle('Create a persistent group').click();
  const header = w.getByText('New group', { exact: true });
  await expect(header).toBeVisible();
  for (const title of titles) {
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row(w, title).dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    await expect(row(w, title)).toBeVisible();
  }
}

test.describe('reordering a group (#559)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a drag reorders a group, and the order survives a relaunch', async () => {
    const folder = tempProjectFolder();
    // assigned IMMEDIATELY, and reassigned after the relaunch: `afterEach` is
    // the only thing that kills the Electron process and deletes its temp home,
    // so a failure before the second launch must still have something to clean
    // up (#213).
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    const titles = [path.basename(folder)];
    await expect(rows(w)).toHaveCount(1, { timeout: 25_000 });
    titles.push(await addSession(first));
    titles.push(await addSession(first));

    await groupThemAll(w, titles);
    const before = await railTitles(w);
    expect(before).toHaveLength(3);

    // the LAST session, dragged onto the top half of the FIRST — the move that
    // proves both halves of the hit test at once
    await dragOnto(w, before[2], before[0], 'top');
    await expect
      .poll(() => railTitles(w))
      .toEqual([before[2], before[0], before[1]]);

    // ...and it SURVIVES A RELAUNCH (§5.25: the workspace comes back as you
    // left it). This is the clause a unit test cannot make: the arrangement has
    // to reach the ui blob on disk and be read back before the first session
    // push, or the rail would paint in arrival order and reshuffle itself in
    // front of the user.
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(rows(w2)).toHaveCount(3, { timeout: 25_000 });
    await expect.poll(() => railTitles(w2)).toEqual([before[2], before[0], before[1]]);

    // and the keyboard writes the same order the drag does (§5.32): the
    // palette's command steps the session the workspace is showing.
    await row(w2, before[2]).click();
    await expect(w2.locator('.dv-active-tab')).toContainText(before[2]);
    await w2.keyboard.press(`${MOD}+Alt+ArrowDown`);
    await expect.poll(() => railTitles(w2)).toEqual([before[0], before[2], before[1]]);
  });

  test('the row menu moves a session without a mouse, and says so', async () => {
    // §5.32's fifth rule — a drag is never the only way to do something. Driven
    // from the keyboard end to end: Shift+F10 opens the menu the ContextMenu
    // key opens, and the live region is what a screen reader would be told.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const titles = [path.basename(folder)];
    await expect(rows(w)).toHaveCount(1, { timeout: 25_000 });
    titles.push(await addSession(a));

    const before = await railTitles(w);
    // focus the LAST row's own button, then summon its menu from the keyboard
    await w.locator(`[data-rail-open]`).last().focus();
    await w.keyboard.press('Shift+F10');
    const menu = w.getByRole('menu');
    await expect(menu).toBeVisible();

    // at the bottom of the list, "Move down" is present but unavailable — the
    // arrow walk must never find a hole where an item used to be
    await expect(menu.locator('[data-order-item="down"]')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await menu.locator('[data-order-item="up"]').click();

    await expect.poll(() => railTitles(w)).toEqual([before[1], before[0]]);
    // the words a screen reader gets, carrying the position so a second press
    // re-announces rather than repeating a string the region already holds
    await expect(rail(w).locator('[role="status"]')).toHaveText(
      `${before[1]} is now 1 of 2 in Ungrouped`
    );
  });
});
