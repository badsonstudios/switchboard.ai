// P2-E9-03: the attention queue and its jump hotkey, driven through the REAL
// hook listener — the test plays the CLI's part (Notification / Stop POSTs
// with each session's own token), exactly as approval.spec.ts does for holds.
// No mock sits between the state machine and the queue.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  showTerminal,
  tempProjectFolder,
  hookPoster,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const activeTab = (w: Page) => w.locator('.dv-active-tab');
const eventRows = (w: Page) => w.locator('aside [data-event-kind]');

test.describe('attention queue (E9-03)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /**
   * Three sessions in three different folders (so none auto-group and rail
   * order is plain creation order), each driven into a DIFFERENT attention
   * state. Creation order is deliberately not priority order — that is what
   * makes the ordering assertions mean something.
   */
  async function threeWaitingSessions(): Promise<{
    w: Page;
    post: (title: string, body: Record<string, unknown>) => Promise<string>;
    titles: { done: string; permission: string; input: string };
  }> {
    const folders = [tempProjectFolder(), tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(w.getByText(names[0]).first()).toBeVisible({ timeout: 25_000 });

    for (const folder of folders.slice(1)) {
      await a.app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      }, folder);
      await w.getByRole('button', { name: '+ session' }).click();
      await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    }

    const post = await hookPoster(a, 3);

    // creation order 0,1,2 -> priority order 1,2,0. If the queue ever falls
    // back to rail order or arrival order, these assertions break.
    const titles = { done: names[0], permission: names[1], input: names[2] };
    await post(titles.done, { hook_event_name: 'Stop' });
    await post(titles.permission, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await post(titles.input, {
      hook_event_name: 'Notification',
      message: 'Claude needs input to continue',
    });
    await expect(eventRows(w)).toHaveCount(3, { timeout: 15_000 });
    return { w, post, titles };
  }

  test('the panel lists the queue in priority order, not arrival order', async () => {
    const { w } = await threeWaitingSessions();
    await expect
      .poll(() => eventRows(w).evaluateAll((els) => els.map((e) => e.getAttribute('data-event-kind'))))
      .toEqual(['needs-permission', 'needs-input', 'done']);
    // the head is marked as where the hotkey goes
    await expect(w.locator('aside [data-next="true"]')).toHaveCount(1);
    await expect(w.locator('aside [data-next="true"]')).toHaveAttribute(
      'data-event-kind',
      'needs-permission',
    );
  });

  test('three sessions in different states clear in priority order under repeated Ctrl+Space', async () => {
    const { w, titles } = await threeWaitingSessions();
    // focus something that is NOT first in the queue, so the first press has
    // to actually move
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    const marked = w.locator('aside [data-next="true"]');
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.permission);
    // the panel's marker MOVES with the walk — from press 2 on, a marker that
    // stayed on the head would be pointing at a row the hotkey has left behind
    await expect(marked).toHaveAttribute('data-event-kind', 'needs-input');

    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.input);
    await expect(marked).toHaveAttribute('data-event-kind', 'done');

    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done);
    // ...and the walk wraps rather than dead-ending
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.permission);
  });

  test('an answered item leaves the queue', async () => {
    const { w, post, titles } = await threeWaitingSessions();
    // the human answers the permission: the session goes back to work, which
    // is not an attention state, so the feed drops its item
    await post(titles.permission, { hook_event_name: 'UserPromptSubmit' });
    await expect(eventRows(w)).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(() => eventRows(w).evaluateAll((els) => els.map((e) => e.getAttribute('data-event-kind'))))
      .toEqual(['needs-input', 'done']);

    // and the hotkey now goes to what is actually still waiting
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.input);
  });

  test('Ctrl+Space is a no-op when nothing is waiting', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(eventRows(w)).toHaveCount(0);

    await w.keyboard.press(`${MOD}+Space`);
    // nothing moved, nothing broke, and no page error was thrown
    await expect(activeTab(w)).toContainText(title);
    await expect(eventRows(w)).toHaveCount(0);
  });

  test('the RENDERER never claims Ctrl+Space in a terminal (the hard rule)', async () => {
    // The terminal branch of classifyTarget is the one NO scope can override,
    // and it is a different code path from the text-input branch below.
    //
    // #90 did not loosen it: the chord now works from a terminal because the
    // BROWSER process claims it before the page ever sees it (covered in
    // terminal-accelerators.spec.ts). Playwright injects over CDP, which never
    // reaches before-input-event, so what this test drives is the renderer path
    // alone — which must still stand down. If it ever starts jumping here, the
    // hard rule has been bent instead of stepped over.
    const { w, titles } = await threeWaitingSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    await showTerminal(w);
    await w.locator('.xterm-screen').first().click();
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done); // never jumped
  });

  test('the composer owns Ctrl+Space too — a text input keeps its keys', async () => {
    const { w, titles } = await threeWaitingSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done); // did not jump
    expect(await w.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  });
});
