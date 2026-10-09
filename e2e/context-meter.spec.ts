// The context meter under the prompt box (#715), in the real app.
//
// The contract was measured against the real CLI (spike/probes/715); this
// drives the app against the stand-in CLI, which answers `get_context_usage`
// the way the real one was measured to and lets a test fill the window with
// `!context <n>`. What only the real app can show: the meter is at the
// right-hand end of the composer's row with no turn taken, it moves when a turn
// ends, the three states are drawn in the right inks (and none of them is
// yellow), the choice of form in Settings changes what is drawn, and nothing
// but the four numbers crosses to the window.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, openSettings, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const meter = (w: Page) => w.getByTestId('composer-context');

async function prompt(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** the hue of an element's ink, in degrees, or -1 for a grey */
async function inkHue(w: Page, selector: string): Promise<number> {
  return w.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const m = getComputedStyle(el).color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)!;
    const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 0.08) return -1;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return Math.round(h < 0 ? h + 360 : h);
  }, selector);
}

test.describe('the context meter (#715)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('is at the end of the composer’s row before any turn, and moves when a turn ends', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // there with no turn taken, and NOT at zero: a cold window already holds
    // the system prompt and tools
    await expect(meter(w)).toBeVisible({ timeout: 20_000 });
    await expect(meter(w)).toHaveText('context 4%');
    await expect(meter(w)).toHaveAttribute('data-context-level', 'normal');

    // BOTTOM RIGHT: the last thing in the options row, right of Clear
    const place = await w.evaluate(() => {
      const m = document.querySelector<HTMLElement>('[data-testid="composer-context"]')!;
      const row = document.querySelector<HTMLElement>('[data-testid="composer-options"]')!;
      const clear = document.querySelector<HTMLElement>('[data-testid="composer-clear"]')!;
      const mr = m.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return {
        inRow: row.contains(m),
        gapToRowEnd: Math.round(rr.right - mr.right),
        rightOfClear: mr.left >= clear.getBoundingClientRect().right - 1,
      };
    });
    expect(place.inRow).toBe(true);
    expect(place.rightOfClear).toBe(true);
    expect(place.gapToRowEnd).toBeLessThan(24);

    await prompt(w, '!context 72');
    await expect(meter(w)).toHaveText('context 72%', { timeout: 15_000 });
    await expect(meter(w)).toHaveAttribute('data-context-level', 'filling');
    // Compact is on the same row, which is the point of saying it at 60
    await expect(w.getByTestId('composer-compact')).toBeVisible();
    await expect(meter(w)).toHaveAttribute('title', /144,000 of 200,000 tokens/);
    await expect(meter(w)).toHaveAttribute('title', /Compact or Clear/);

    await prompt(w, '!context 91');
    await expect(meter(w)).toHaveText('context 91%', { timeout: 15_000 });
    await expect(meter(w)).toHaveAttribute('data-context-level', 'nearly-full');

    // CLEAR EMPTIES IT, and the meter says so without waiting for a prompt:
    // the button the hover points at must be seen to work
    await w.getByTestId('composer-clear').click();
    await w.getByTestId('composer-clear-go').click();
    await expect(meter(w)).toHaveText('context 4%', { timeout: 15_000 });
  });

  test('none of the three states is yellow or orange: blue from 60, red from 80', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(meter(w)).toBeVisible({ timeout: 25_000 });

    const reserved = (h: number): boolean => h >= 20 && h <= 70;
    const plain = await inkHue(w, '[data-testid="composer-context"]');
    expect(reserved(plain), `plain ink hue ${plain}`).toBe(false);

    await prompt(w, '!context 65');
    await expect(meter(w)).toHaveAttribute('data-context-level', 'filling', { timeout: 15_000 });
    const filling = await inkHue(w, '[data-testid="composer-context"]');
    expect(filling, 'blue').toBeGreaterThan(180);
    expect(filling, 'blue').toBeLessThan(260);

    await prompt(w, '!context 88');
    await expect(meter(w)).toHaveAttribute('data-context-level', 'nearly-full', { timeout: 15_000 });
    const full = await inkHue(w, '[data-testid="composer-context"]');
    expect(full <= 15 || full >= 330, `red, got ${full}`).toBe(true);
  });

  test('Settings chooses the form: a number, a bar, or both, and the choice is kept', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    let w = a.window;
    await expect(meter(w)).toBeVisible({ timeout: 25_000 });
    const bar = (p: Page) => meter(p).locator('.context-meter-bar');
    const number = (p: Page) => meter(p).locator('.context-meter-number');

    // the default: the number alone
    await expect(number(w)).toBeVisible();
    await expect(bar(w)).toBeHidden();

    const dialog = await openSettings(w);
    // EACH CHOICE'S SAMPLE IS DRAWN IN ITS OWN FORM, whatever the app is on
    // (review: with the app on "a number", all three samples lost their bar)
    const sample = (form: string) =>
      dialog.locator(`label:has([data-context-meter-choice="${form}"]) .context-meter`);
    await expect(sample('percent').locator('.context-meter-bar')).toBeHidden();
    await expect(sample('percent').locator('.context-meter-number')).toBeVisible();
    await expect(sample('bar').locator('.context-meter-bar')).toBeVisible();
    await expect(sample('bar').locator('.context-meter-number')).toBeHidden();
    await expect(sample('both').locator('.context-meter-bar')).toBeVisible();
    await expect(sample('both').locator('.context-meter-number')).toBeVisible();
    await dialog.locator('[data-context-meter-choice="both"]').check();
    await expect(bar(w)).toBeVisible();
    await expect(number(w)).toBeVisible();

    await dialog.locator('[data-context-meter-choice="bar"]').check();
    await expect(bar(w)).toBeVisible();
    // a comfortable window: the bar alone
    await expect(number(w)).toBeHidden();
    await w.keyboard.press('Escape');

    // ...and the number comes back with the bar once it asks something of you
    await prompt(w, '!context 64');
    await expect(meter(w)).toHaveAttribute('data-context-level', 'filling', { timeout: 15_000 });
    await expect(number(w)).toBeVisible();
    await expect(number(w)).toHaveText('context 64%');

    const home = a.home;
    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();
    a = await launchApp({ home, env: DIRECT });
    w = a.window;
    await expect(meter(w)).toBeVisible({ timeout: 25_000 });
    await expect(bar(w)).toBeVisible();
  });

  test('only the numbers cross to the window: no path from the CLI’s answer', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(meter(w)).toBeVisible({ timeout: 25_000 });
    const answer = await w.evaluate(async () => {
      const live = (await window.switchboard.sessions.list()) as Array<{ id: string }>;
      return window.switchboard.sessions.contextUsage(live[0].id);
    });
    expect(answer).toEqual({
      ok: true,
      response: { percentage: 4, totalTokens: 8000, maxTokens: 200000, autoCompactAt: 167000 },
    });
  });
});
