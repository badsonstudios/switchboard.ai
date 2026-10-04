// Help ▸ User manual — the claims only a real window can make.
//
// THREE OF THEM, and the unit tests can make none:
//
//   * the Help menu item is really built and its click really reaches the
//     renderer. `app-menu.test.ts` proves the template's shape and cannot prove
//     anything is listening at the far end — `feature-request.spec.ts`'s
//     argument, and the same one.
//   * what opens is the REAL manual, in the app's own document viewer, rendered.
//     This runs against `docs/manual` in the repository, which is the folder an
//     unpackaged build reads; `packaging.test.ts` owns the claim that the
//     installer carries the same folder to where a packaged build looks.
//   * A LINK TO ANOTHER PAGE WORKS. This is the one that would have been wrong
//     by default: a file opened on its own grants that file only, and every
//     link on the day-one page would be refused. The manual is not inside the
//     seeded session's folder here, so nothing but the folder grant can make
//     the second page readable.
//
// Playwright cannot click a native menu, so the item's `click` is invoked
// through the Electron API — the same function the OS would call.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** Fire Help › User Manual, the way the OS would. */
const clickUserManual = (a: LaunchedApp): Promise<boolean> =>
  a.app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Help');
    const item = help?.submenu?.items.find((i) => i.label === 'User Manual');
    if (!item) return false;
    // `MenuItem.click` is typed as a bare `Function` in electron.d.ts, so it is
    // called through a narrowed local rather than with an eslint suppression.
    const fire = item.click as unknown as () => void;
    fire();
    return true;
  });

const viewer = (w: Page) => w.locator('[data-testid="document-viewer"]');
const rendered = (w: Page) => w.locator('[data-testid="doc-rendered"]');
const docName = (w: Page) => w.locator('[data-testid="doc-name"]');

test.describe('Help ▸ User manual', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the Help menu opens the Contents page, and a link to another page works — and back', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // THE MENU, not the palette — this is the half that crosses processes.
    expect(await clickUserManual(a)).toBe(true);
    await expect(viewer(w)).toBeVisible({ timeout: 10_000 });
    await expect(docName(w)).toHaveText('contents.md');
    // rendered Markdown, not a wall of source
    await expect(rendered(w).locator('h1')).toHaveText('switchboard.ai — User manual');

    // A LINK TO A NEIGHBOUR. Refused — "out of scope" — if only the one file
    // had been granted, since the manual is nowhere near the seeded folder.
    await rendered(w).getByRole('link', { name: 'Sessions', exact: true }).first().click();
    await expect(docName(w)).toHaveText('02-sessions.md');
    await expect(rendered(w).locator('h1')).toHaveText('Sessions');

    // THE PICTURES LOAD (#1082) — from the manual's own `img/` folder, through
    // the scoped image scheme, in a folder that is nowhere near a session.
    const picture = rendered(w).locator('img.doc-image').first();
    await expect
      .poll(() => picture.evaluate((i) => (i as HTMLImageElement).naturalWidth), {
        message: "the Sessions page's first picture never loaded",
      })
      .toBeGreaterThan(0);
    await expect(rendered(w).locator('.doc-image-chip')).toHaveCount(0);

    // EVERY PAGE HAS A WAY BACK TO CONTENTS, at the top and at the bottom.
    const home = rendered(w).getByRole('link', { name: /Contents/ });
    await expect(home).toHaveCount(2);
    await home.first().click();
    await expect(docName(w)).toHaveText('contents.md');
    await viewer(w).getByRole('button', { name: 'Back', exact: true }).click();
    await expect(docName(w)).toHaveText('02-sessions.md');

    // …and Back returns, like any other document.
    await viewer(w).getByRole('button', { name: 'Back', exact: true }).click();
    await expect(docName(w)).toHaveText('contents.md');

    // READ-ONLY, like every other file: Source view is Monaco with typing off.
    await viewer(w).getByRole('button', { name: 'Source', exact: true }).click();
    const lines = w.locator('[data-testid="doc-source"] .view-lines');
    await expect(lines).toContainText('# switchboard.ai — User manual');
    await lines.click();
    await w.keyboard.type('EDITED');
    await expect(lines).not.toContainText('EDITED');
  });

  test('the command list has it too, and asking twice does not open a second tab', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press('Control+Shift+P');
    await w.keyboard.type('User manual');
    await w.keyboard.press('Enter');
    await expect(docName(w)).toHaveText('contents.md', { timeout: 10_000 });

    // The menu, with the manual already open: it comes to the front. It does
    // not stack a second copy. Counted on the TAB STRIP — an inactive tab's
    // body is not in the DOM, so counting viewers could not see a duplicate —
    // and after the round trip to main and back has had time to land one.
    const manualTabs = w.locator('.dv-tabs-container .dv-tab', { hasText: 'contents.md' });
    await expect(manualTabs).toHaveCount(1);
    expect(await clickUserManual(a)).toBe(true);
    await w.waitForTimeout(750);
    await expect(manualTabs).toHaveCount(1);
  });
});
