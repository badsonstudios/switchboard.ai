// PROBE (#1456). Which link breaks between a rail click and a raised popout.
// Findings: `spike/findings/1456-popout-raise.md`.
//
// HOW TO RUN IT: copy this file into `e2e/`, `npm run build`, then
// `npx playwright test e2e/probe-popout-raise.spec.ts` (it takes the desktop
// foreground on purpose, so hold the e2e machine lock). It PRINTS, it does not
// assert. `spike/**` is outside every tsconfig, which is why the import below
// does not resolve from this directory.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  bringToFront,
  E2E_NO_ACTIVATE_ENV,
  launchApp,
  LaunchedApp,
  tempProjectFolder,
} from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream', [E2E_NO_ACTIVATE_ENV]: '' };

const focusedWindow = (a: LaunchedApp): Promise<string> =>
  a.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isFocused()) continue;
      return w.webContents.getURL().includes('popout.html') ? 'popout' : 'main';
    }
    return 'none';
  });

const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const railRow = (w: Page, name: string) =>
  w.locator('nav [draggable="true"]').filter({ hasText: name }).first();

async function answerFolderDialog(a: LaunchedApp, dir: string): Promise<void> {
  await a.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, dir);
}

async function settle(a: LaunchedApp): Promise<string> {
  // give the IPC raise time to land, then read the OS answer
  await new Promise((r) => setTimeout(r, 1500));
  return focusedWindow(a);
}

test('probe 1456', async () => {
  test.setTimeout(240_000);
  const folderA = tempProjectFolder();
  const folderB = tempProjectFolder();
  const nameA = path.basename(folderA);
  const nameB = path.basename(folderB);
  const a = await launchApp({ seedFolder: folderA, env: DIRECT });
  try {
    const w = a.window;
    await expect(w.getByText(nameA).first()).toBeVisible({ timeout: 25_000 });
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 20_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p !== w)!;
    await popout.waitForLoadState('domcontentloaded');
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
    const frame = await popout.evaluate(() => window.name);
    console.log('PROBE frame name', frame);

    // 1. baseline
    await bringToFront(a);
    await railRow(w, nameA).click();
    console.log('PROBE 1 baseline (anchor, main in front):', await settle(a));

    // 2. minimised
    await a.app.evaluate(({ BrowserWindow }) => {
      for (const x of BrowserWindow.getAllWindows())
        if (x.webContents.getURL().includes('popout.html')) x.minimize();
    });
    await new Promise((r) => setTimeout(r, 800));
    await bringToFront(a);
    await railRow(w, nameA).click();
    const minimised = await a.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((x) => x.webContents.getURL().includes('popout.html'))
        .map((x) => x.isMinimized())
    );
    console.log('PROBE 2 minimised:', await settle(a), 'still minimised?', minimised);

    // 3. a second session in the popout, split beside the first (a 2nd group)
    await answerFolderDialog(a, folderB);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });
    const tabB = tabs(popout).filter({ hasText: nameB }).first();
    const content = popout.locator('.dv-content-container').first();
    const box = (await content.boundingBox())!;
    await tabB.dragTo(content, {
      targetPosition: { x: Math.floor(box.width - 10), y: Math.floor(box.height / 2) },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const groups = await popout.evaluate(() => document.querySelectorAll('.dv-groupview').length);
    console.log('PROBE 3 groups in popout after split:', groups);

    await bringToFront(a);
    await railRow(w, nameB).click();
    console.log('PROBE 3 split (non-anchor group, main in front):', await settle(a));

    await bringToFront(a);
    await railRow(w, nameA).click();
    console.log('PROBE 3b anchor after split:', await settle(a));
  } finally {
    await a.cleanup();
  }
});
