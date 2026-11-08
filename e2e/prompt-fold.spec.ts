// #717 — your prompt in the conversation folds to its first line when it is
// longer than one line, and a click opens and closes it. The unit tests cover
// every rule; this is the real app's look at it: a long prompt is one line
// tall folded, taller open, and back again.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, onTestDisplay } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);
const prompts = (w: Page) => w.locator('.feed-prompt');

async function send(w: Page, text: string): Promise<void> {
  await composer(w).click();
  await composer(w).fill(text);
  await composer(w).press('Enter');
}

test.describe('your prompt folds to one line (#717)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a short prompt is just its words; a long one folds and a click opens and closes it', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(box);
    }, onTestDisplay(a, { x: 40, y: 40, width: 1100, height: 760 }));

    // short: one line, no fold
    await send(w, 'a short question');
    await expect(prompts(w)).toHaveCount(1, { timeout: 30_000 });
    await expect(prompts(w).first().locator('[aria-expanded]')).toHaveCount(0);

    // one long line, no line breaks: it would wrap, so it folds
    const long =
      'Please look through the sessions list code and work out why the rows flicker when a session ' +
      'finishes its turn, then propose a fix that keeps the scroll position and does not re-sort the ' +
      'whole list on every status push, and write a test that fails without it.';
    await send(w, long);
    await expect(prompts(w)).toHaveCount(2, { timeout: 30_000 });
    const second = prompts(w).nth(1);
    const fold = second.locator('[aria-expanded]');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(second).toContainText('click to expand');
    // folded, it is ONE line tall: the first line, ellipsised
    const folded = (await second.boundingBox())!.height;

    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(second).toContainText('write a test that fails without it.');
    await expect(second).toContainText('click to collapse');
    expect((await second.boundingBox())!.height).toBeGreaterThan(folded);

    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => (await second.boundingBox())!.height).toBeLessThanOrEqual(folded + 1);
  });
});
