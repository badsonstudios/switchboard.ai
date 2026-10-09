// Hover a session to see its last prompt (#631), in the real app.
//
// The unit tests pin the timing and the rules. What only the real app can show
// is that a real pointer resting on each of the three surfaces (the row in the
// Sessions list, the session's tab, the pill on the strip) raises the popup
// with the words that were really sent, that it is inside the window, and that
// a click still lands on what is under it.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const popup = (w: Page) => w.getByTestId('last-prompt-hover');

async function prompt(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

test.describe('hover a session to see its last prompt (#631)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('the row, the tab and the pill each show it; a fresh session says so', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const row = w.locator('nav [data-last-prompt-for]').first();
    await expect(row).toBeVisible({ timeout: 25_000 });
    // the session has to be running before there is anything true to say
    await expect(w.getByPlaceholder(/Prompt this session/)).toBeVisible({ timeout: 25_000 });

    // FRESH: running, and never asked anything
    await row.hover();
    await expect(popup(w)).toBeVisible({ timeout: 5_000 });
    await expect(popup(w)).toContainText('No prompts yet');

    await prompt(w, 'first: set the project up');
    await expect(w.getByText('first: set the project up').first()).toBeVisible({ timeout: 15_000 });
    await prompt(w, 'second: now write the tests for it');
    await expect(w.getByText('second: now write the tests for it').first()).toBeVisible({
      timeout: 15_000,
    });

    // THE ROW in the Sessions list: the LAST prompt, not the first
    await w.mouse.move(2, 2);
    await expect(popup(w)).toHaveCount(0);
    await row.hover();
    await expect(popup(w)).toBeVisible({ timeout: 5_000 });
    await expect(popup(w)).toContainText('Last prompt');
    await expect(popup(w)).toContainText('second: now write the tests for it');
    await expect(popup(w)).not.toContainText('first: set the project up');

    // inside the window, and it lets the pointer through
    const fit = await w.evaluate(() => {
      const p = document.querySelector<HTMLElement>('[data-testid="last-prompt-hover"]')!;
      const r = p.getBoundingClientRect();
      return {
        inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        pointerEvents: getComputedStyle(p).pointerEvents,
      };
    });
    expect(fit).toEqual({ inside: true, pointerEvents: 'none' });

    // THE TAB above the card
    await w.mouse.move(2, 2);
    await expect(popup(w)).toHaveCount(0);
    const tab = w.locator('.dv-tab .identity-tab[data-last-prompt-for]').filter({ hasText: name });
    await tab.hover();
    await expect(popup(w)).toBeVisible({ timeout: 5_000 });
    await expect(popup(w)).toContainText('second: now write the tests for it');

    // pressing a button puts it away at once
    await w.mouse.down();
    await expect(popup(w)).toHaveCount(0);
    await w.mouse.up();

    // THE PILL, with the sessions across the top
    await w.locator('[data-placement="top"]').click();
    const pill = w.locator('[data-strip-pill][data-last-prompt-for]').first();
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await w.mouse.move(2, 2);
    await pill.hover();
    await expect(popup(w)).toBeVisible({ timeout: 5_000 });
    await expect(popup(w)).toContainText('second: now write the tests for it');

    // a click puts it away (that it cannot TAKE a click is the pointer-events
    // check above)
    await pill.click();
    await expect(popup(w)).toHaveCount(0);
  });
});
