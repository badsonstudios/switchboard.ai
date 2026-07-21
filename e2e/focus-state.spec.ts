// P2-E12-08: focus-state persistence — the active view tab (and focused card)
// come back exactly after a relaunch, via the workspace store's ui blob (NOT
// localStorage, which resets with the loopback port each packaged launch).
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('focus-state persistence (E12-08)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('active view tab survives a relaunch (Feed default -> Terminal restored)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    const first = await launchApp({ seedFolder: folder });
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // Feed is the default; switch this card to Terminal
    await expect(w.getByText('No activity yet — the Feed renders the conversation once it starts.')).toBeVisible();
    await w.getByRole('button', { name: 'Terminal' }).click();
    await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });

    // give the debounced workspace save a beat, relaunch on the same home
    await w.waitForTimeout(900);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    // restored card resumes ON THE TERMINAL TAB with no clicks — the tab
    // choice survived the relaunch (and the focused card auto-resumed)
    await expect(a.window.locator('.xterm-screen').first()).toBeVisible({ timeout: 20_000 });
    await expect(
      a.window.getByText('No activity yet — the Feed renders the conversation once it starts.')
    ).toHaveCount(0);
  });

  test('titlebar autonomy choice survives a relaunch (ui blob, not localStorage)', async () => {
    const first = await launchApp();
    const w = first.window;
    await expect(w.getByRole('button', { name: /ask/ })).toBeVisible();
    await w.getByRole('button', { name: /ask/ }).click(); // -> plan
    await expect(w.getByRole('button', { name: /plan/ })).toBeVisible();
    await w.waitForTimeout(900);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByRole('button', { name: /plan/ })).toBeVisible();
  });
});
