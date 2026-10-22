// Prompt History (#1203): go back to a prompt you sent, in the real app.
//
// The owner, of the History button: "nothing in there tells me: when I put in a
// new prompt, if I want to go back to a previous prompt, how do I do that?"
//
// WHERE IT LIVES (#1237): it shipped behind a small "prompts" button of its own
// and the owner could not find it ("I don't see any icon for that"). It is now
// the second tab of the window the 🕘 history button opens.
//
// What only the real app can show: that choosing a prompt really brings it
// into view in a conversation long enough to have scrolled it away, that "Use
// again" really lands in the prompt box with the keyboard, and that it does
// not cost what was already typed there.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);
const opener = (w: Page) => w.locator('[data-testid="card-history"]').first();
const dialog = (w: Page) => w.locator('[data-history-dialog]');
const tab = (w: Page, id: 'conversations' | 'prompts') => w.locator(`[data-history-tab="${id}"]`);
const panel = (w: Page) => w.locator('[data-prompt-history]');
/** the history window, on its Prompts tab */
async function openPrompts(w: Page): Promise<void> {
  await opener(w).click();
  await tab(w, 'prompts').click();
  await expect(panel(w)).toBeVisible();
}
const rows = (w: Page) => panel(w).locator('[data-prompt-history-row]');

async function send(w: Page, text: string, reply: string): Promise<void> {
  await composer(w).click();
  await composer(w).fill(text);
  await composer(w).press('Enter');
  await expect(w.getByText(reply).first()).toBeAttached({ timeout: 60_000 });
}

test.describe('Prompt History (#1203)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('lists what you sent, newest first; a row goes to it; Use again puts it back', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1100, height: 760 });
    });

    // ONE WAY IN: the button of its own is gone from the conversation
    await expect(w.locator('[data-prompt-history-open]')).toHaveCount(0);
    // the history button opens a window with TWO tabs, on Conversations
    await opener(w).click();
    await expect(tab(w, 'conversations')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(w, 'prompts')).toHaveAttribute('aria-selected', 'false');
    await expect(w.locator('[data-history-search]')).toBeFocused();
    // the window is the same size on either tab
    const before = await dialog(w).boundingBox();
    await tab(w, 'prompts').click();
    await expect(panel(w)).toBeVisible();
    expect(await dialog(w).boundingBox()).toEqual(before);
    // before anything is sent, the list says so
    await expect(panel(w)).toContainText('You have not sent this session a prompt yet.');
    await expect(w.locator('[data-prompt-history-filter]')).toBeFocused();
    await w.keyboard.press('Escape');
    await expect(dialog(w)).toBeHidden();
    // the keyboard went back to the button that opened it
    await expect(opener(w)).toBeFocused();

    // three prompts, with enough conversation after the first to scroll it away
    await send(w, 'FIRST_PROMPT find the bug', 'FAKE-REPLY: FIRST_PROMPT');
    await send(w, '!bulk 60 FILLER_', 'FILLER_60');
    await send(w, 'THIRD_PROMPT write the notes', 'FAKE-REPLY: THIRD_PROMPT');
    const first = w.locator('[data-feed-block="user"]').filter({ hasText: 'FIRST_PROMPT' });
    await expect(first).not.toBeInViewport();

    // NEWEST FIRST. The window opens on the tab last used: Prompts.
    await opener(w).click();
    await expect(tab(w, 'prompts')).toHaveAttribute('aria-selected', 'true');
    await expect(rows(w)).toHaveCount(3);
    await expect(rows(w).nth(0)).toContainText('THIRD_PROMPT write the notes');
    await expect(rows(w).nth(2)).toContainText('FIRST_PROMPT find the bug');
    // the filter has the keyboard: type to narrow
    await w.keyboard.type('find bug');
    await expect(rows(w)).toHaveCount(1);
    await expect(rows(w).first()).toContainText('FIRST_PROMPT');

    // GO TO IT: the list closes and that prompt is on screen
    await rows(w).first().locator('[data-prompt-history-jump]').click();
    await expect(dialog(w)).toBeHidden();
    await expect(first).toBeInViewport({ timeout: 15_000 });
    // the keyboard is in the conversation, not lost
    await expect(w.locator('[data-feed-region]')).toBeFocused();
    // THE MARK IS A BEAT. It shows where you landed and then lets go: left on,
    // it would outline that prompt for good and going to it again would do
    // nothing the second time.
    const outlined = (): Promise<string> => first.evaluate((el) => getComputedStyle(el).outlineStyle);
    await expect.poll(outlined, { timeout: 10_000 }).toBe('none');
    // ...so going to the SAME prompt again works: scroll away, and come back
    await w.locator('[data-feed-region]').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(first).not.toBeInViewport();
    await openPrompts(w);
    await rows(w).nth(2).locator('[data-prompt-history-jump]').click();
    await expect(first).toBeInViewport({ timeout: 15_000 });

    // USE AGAIN, into an empty box: the prompt, with the keyboard in the box
    await openPrompts(w);
    await rows(w).nth(2).locator('[data-prompt-history-recall]').click();
    await expect(dialog(w)).toBeHidden();
    await expect(composer(w)).toHaveValue('FIRST_PROMPT find the bug');
    await expect(composer(w)).toBeFocused();
    // typing carries on at the END of what was put back
    await w.keyboard.type(' now');
    await expect(composer(w)).toHaveValue('FIRST_PROMPT find the bug now');
    await composer(w).fill('');
    await openPrompts(w);
    await rows(w).nth(2).locator('[data-prompt-history-recall]').click();

    // ...and into a box with words already in it: THEY ARE KEPT
    await composer(w).fill('half a thought');
    await openPrompts(w);
    await rows(w).nth(0).locator('[data-prompt-history-recall]').click();
    await expect(composer(w)).toHaveValue(/^half a thought\n\nTHIRD_PROMPT write the notes$/);

    // a press outside closes it without choosing anything
    await openPrompts(w);
    // (the dimmed area around the window, well clear of it)
    const scrim = dialog(w).locator('..');
    const around = (await scrim.boundingBox())!;
    await scrim.click({ position: { x: 6, y: Math.round(around.height / 2) } });
    await expect(dialog(w)).toBeHidden();
    await expect(composer(w)).toHaveValue(/^half a thought/);
  });
});
