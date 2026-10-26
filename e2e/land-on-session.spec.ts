// #1456 — picking a session from a list LANDS on it: its pane becomes the
// active one and flashes for a moment, so the eye finds it.
//
// The DOCKED half only. The popped-out half (its window raised, restored if
// minimised, the taskbar blinking when Windows refuses) needs real OS focus
// between two windows, which Playwright cannot measure — every page reports
// `document.hasFocus()` true — so that is unit-tested (`focusCardIn`,
// `performUserRaise`) and hand-tested from the dogfood tracker. The raise for a
// plain popout is still pinned end to end by `popout-raise.spec.ts`.
//
// The flash lasts ~700 ms, which a polling assertion could miss on a loaded
// runner, so a MutationObserver installed before the click records every time
// the attribute is set, and the test reads that record instead of racing it.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const railRow = (w: Page, name: string) =>
  w.locator('nav [draggable="true"]').filter({ hasText: name }).first();

interface Landing {
  value: string;
  activeGroup: boolean;
  activeTab: string;
}

/** Start recording every `data-landed` set on a dockview group. */
async function recordLandings(w: Page): Promise<void> {
  await w.evaluate(() => {
    const seen: Landing[] = [];
    (window as unknown as { __landings: Landing[] }).__landings = seen;
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        const value = el.getAttribute('data-landed');
        if (!value || !el.classList.contains('dv-groupview')) continue;
        seen.push({
          value,
          activeGroup: el.classList.contains('dv-active-group'),
          activeTab: el.querySelector('.dv-active-tab')?.textContent ?? '',
        });
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-landed'], subtree: true });
  });
}

const landings = (w: Page): Promise<Landing[]> =>
  w.evaluate(() => (window as unknown as { __landings: Landing[] }).__landings);

test.describe('landing on a session you picked (#1456)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('clicking a docked session in the list makes its pane active and flashes it', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    const first = path.basename(folderA);
    const second = path.basename(folderB);
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    await expect(w.getByText(first).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    // recording from HERE: starting a session puts it in front, and that is
    // not a pick from a list, so it must not flash
    await recordLandings(w);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(railRow(w, second)).toBeVisible({ timeout: 25_000 });
    // the new session is the one in front; the click below has to MOVE you
    await expect(w.locator('.dv-active-group .dv-active-tab')).toContainText(second);
    expect(await landings(w)).toHaveLength(0);

    await railRow(w, first).click();

    await expect(w.locator('.dv-active-group .dv-active-tab')).toContainText(first);
    await expect.poll(() => landings(w), { timeout: 5_000 }).toHaveLength(1);
    const [landed] = await landings(w);
    expect(landed.activeGroup).toBe(true);
    expect(landed.activeTab).toContain(first);
    expect(['motion', 'static']).toContain(landed.value);
    // ...and it goes away by itself
    await expect(w.locator('.dv-groupview[data-landed]')).toHaveCount(0, { timeout: 5_000 });

    // a second click restarts it (one more landing, then gone again)
    await railRow(w, first).click();
    await expect.poll(async () => (await landings(w)).length, { timeout: 5_000 }).toBe(2);
    await expect(w.locator('.dv-groupview[data-landed]')).toHaveCount(0, { timeout: 5_000 });
  });
});
