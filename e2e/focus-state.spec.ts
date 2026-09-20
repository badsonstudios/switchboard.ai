// P2-E12-08: focus-state persistence — the active view tab (and focused card)
// come back exactly after a relaunch, via the workspace store's ui blob (NOT
// localStorage, which resets with the loopback port each packaged launch).
//
// TRANSPORT SCOPE (P2-E18-18, #404): transport-independent, and no longer
// tagged. The first test used to prove the restore by looking for a live
// `.xterm`, which only a PTY session had — that is what made it `[pty]`. The
// Terminal tab was removed (#873), so the non-default tab it restores is now
// Changes, and the mechanism it covers was never PTY-only in the first place.
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('focus-state persistence (E12-08)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('active view tab survives a relaunch (Session default -> Changes restored)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    a = await launchApp({ seedFolder: folder }); // shared handle first (#16)
    const first = a;
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // Session is the default, so the restore has to be proved on a NON-default
    // tab: the default would come back correctly even if the state were lost
    // entirely. That tab was the Terminal until #873 removed it; Changes is the
    // surviving one, and `aria-selected` is the tablist's own answer about
    // which tab is current.
    await expect(w.getByText('No conversation yet')).toBeVisible();
    const changes = w.getByRole('tab', { name: 'Changes', exact: true });
    await changes.click();
    await expect(changes).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    // give the debounced workspace save a beat, relaunch on the same home
    await w.waitForTimeout(900);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    // restored card resumes ON THE CHANGES TAB with no clicks — the tab choice
    // survived the relaunch (and the focused card auto-resumed)
    await expect(
      a.window.getByRole('tab', { name: 'Changes', exact: true })
    ).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
  });

  test('titlebar autonomy choice survives a relaunch (ui blob, not localStorage)', async () => {
    a = await launchApp(); // shared handle first (#16)
    const first = a;
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
