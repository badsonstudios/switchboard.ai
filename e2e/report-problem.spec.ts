// Help ▸ Report a problem… — the two things only a real window can show.
//
// The unit test pins which tokens the Send button asks for; it cannot see
// whether they RESOLVE. The owner's report was exactly that gap: the button
// asked for `--accent`, which is only defined inside a session card, so at the
// root it painted a transparent box with near-black text and read as disabled.
// jsdom has no cascade and no layout, so the fill and the field widths are
// measured here, on the built app.
//
// It never presses Send: every destination reveals the zip in the OS file
// manager, which is a window this suite has no business opening.
import { test, expect } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('Report a problem', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('Send report is a filled primary button, and the form does not scroll sideways', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press('Control+Shift+P');
    await w.keyboard.type('Report a problem');
    await w.keyboard.press('Enter');
    const dialog = w.locator('[data-report-dialog]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await w.locator('[data-report-field="subject"]').fill('a subject');
    const send = w.locator('[data-report-submit]');
    await expect(send).toBeEnabled();

    // The fill must RESOLVE — an undefined custom property computes to
    // transparent, which is the bug — and it must differ from Cancel's, or the
    // primary action does not look like one.
    const fills = await w.evaluate(() => {
      const bg = (el: Element | null): string => (el ? getComputedStyle(el).backgroundColor : '');
      const submit = document.querySelector('[data-report-submit]');
      const cancel = document.querySelector('[data-report-cancel]');
      return { submit: bg(submit), cancel: bg(cancel) };
    });
    expect(fills.submit).not.toBe('rgba(0, 0, 0, 0)');
    expect(fills.submit).not.toBe('transparent');
    expect(fills.submit).not.toBe(fills.cancel);

    // No sideways scroll: fields at 100% width without border-box were 18px
    // wider than the dialog.
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await w.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
