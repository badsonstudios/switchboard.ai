// What a popped-out window used to be missing (#1022, and two gaps found beside
// it on 2026-10-09).
//
// A popout is a second DOCUMENT run by the main window's JavaScript. Anything a
// card renders arrives there with the card; anything mounted at the root of the
// app does not. Three things were on the wrong side of that line:
//
//   1. the live region: a screen reader in a popout heard nothing;
//   2. the last-prompt box: it listened for the pointer on one document;
//   3. the context meter's form: copied across as an attribute, by a change
//      made "by reading the code" and never run.
//
// Only a real second window can show any of them, which is why this is here
// and not only in the unit tests. Skipped on Linux CI like every popout spec
// (`skipPopoutOnLinux`); `a.cleanup()` tree-kills, which is what takes the
// popout down with the app.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { LaunchedApp, launchApp, openSettings, closeSettings, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const tabs = (w: Page): ReturnType<Page['locator']> => w.locator('.dv-tabs-container .dv-tab');

async function popoutWindow(a: LaunchedApp): Promise<Page> {
  await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
  const popout = a.app.windows().find((p) => p !== a.window)!;
  await popout.waitForLoadState('domcontentloaded');
  return popout;
}

async function poppedOut(a: LaunchedApp, name: string): Promise<{ w: Page; popout: Page }> {
  const w = a.window;
  await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });
  await w.getByTitle('Pop out into its own window').click();
  const popout = await popoutWindow(a);
  await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
  return { w, popout };
}

/** every sentence currently in a window's live regions */
const spoken = (p: Page): Promise<string> =>
  p
    .locator('[data-live-region]')
    .evaluateAll((els) => els.map((e) => e.textContent ?? '').filter(Boolean).join(' | '));

test.describe('a popped-out window has what the main window has (#1022)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('it has a live region of its own, and a chord refused there is said THERE', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const { w, popout } = await poppedOut(a, path.basename(folder));

    // PRESENT AND EMPTY, in the popout's own document: a region inserted
    // already holding its text is announced by almost nothing
    const regions = popout.locator('[data-live-region]');
    await expect(regions).toHaveCount(2);
    await expect(regions.nth(0)).toHaveText('');
    await expect(regions.nth(1)).toHaveText('');
    await expect(regions.nth(0)).toHaveAttribute('aria-live', 'polite');

    // NOTHING HERE RESTS ON `document.hasFocus()`, and that is deliberate.
    // Under Playwright every page reports it true at once (`fixtures/app.ts`
    // measured this), so a test that asked "which window has the keyboard"
    // would pass whatever the app did. The case below is one where the app
    // does not ask either: the key bridge KNOWS which window the chord came
    // from and that nothing ran, and names the window. That naming is what
    // this test can fail on.

    // ── refused: the user stays in the popout, and so does the reason ────────
    // The only card is popped out, so the main window has no focused session
    // and the pin chord has nothing to act on. That refusal is the case the
    // ticket called the one that stings: a chord refused in silence.
    await tabs(popout).first().click(); // on the tab, not in the prompt box: chords are suppressed while typing
    await popout.keyboard.press(`${MOD}+Alt+p`);
    await expect.poll(() => spoken(popout), { timeout: 15_000 }).toBe('No session is focused');
    expect(await spoken(w)).toBe('');

    // NOT HERE: the other half of the rule, a chord that RUNS from a popout
    // being said in the main window it raises. It was tried with a second,
    // docked session, and the pin chord was refused again: a card-scoped chord
    // pressed in a popout finds no focused session whatever the main window is
    // showing (filed as its own question). No chord both runs from a popout
    // and speaks today, so that half is held where it can be reached, in
    // `PopoutSurfaces.test.tsx` ("held until the caller knows...").
  });

  test('resting on a tab in the popout shows that session’s last prompt, in the popout', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // something to have been asked, before the card leaves this window
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('say something short');
    await box.press('Enter');
    await expect(w.locator('[data-testid="composer-context"]')).toBeVisible({ timeout: 30_000 });

    const { popout } = await poppedOut(a, name);
    const tab = popout.locator('.dv-tab .identity-tab[data-last-prompt-for]').first();
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await popout.mouse.move(2, 2);
    await tab.hover();
    const hover = popout.locator('[data-testid="last-prompt-hover"]');
    await expect(hover).toBeVisible({ timeout: 10_000 });
    await expect(hover).toContainText('say something short');
    // drawn where the pointer is, not in the window it left
    await expect(w.locator('[data-testid="last-prompt-hover"]')).toHaveCount(0);
    // and it gets out of the way like the one in the main window
    await popout.mouse.move(2, 2);
    await expect(hover).toHaveCount(0);
  });

  test('the context meter’s form reaches a popout, and follows a change made while it is open', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // a prompt first: the meter has nothing to show until the session has
    // been asked something, and this test is about the meter being DRAWN right
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('say something short');
    await box.press('Enter');
    await expect(w.locator('[data-testid="composer-context"]')).toBeVisible({ timeout: 30_000 });

    const { popout } = await poppedOut(a, name);
    const formOf = (p: Page): Promise<string | undefined> =>
      p.evaluate(() => document.documentElement.dataset.contextMeter);
    const meter = popout.locator('[data-testid="composer-context"]');
    await expect(meter).toBeVisible({ timeout: 15_000 });

    // what the main window is set to arrived with the window: the default,
    // the number and no bar
    await expect.poll(() => formOf(w)).toBe('percent');
    await expect.poll(() => formOf(popout)).toBe('percent');
    await expect(meter.locator('.context-meter-number')).toBeVisible();
    await expect(meter.locator('.context-meter-bar')).toBeHidden();

    // change it in Settings, in the main window, with the popout still open
    const dialog = await openSettings(w);
    await dialog.locator('[data-context-meter-choice="both"]').check();
    await closeSettings(w);
    await expect.poll(() => formOf(popout)).toBe('both');
    // ...and it is what the popout's own stylesheet acts on
    await expect(meter.locator('.context-meter-bar')).toBeVisible();
    await expect(meter.locator('.context-meter-number')).toBeVisible();
  });
});
