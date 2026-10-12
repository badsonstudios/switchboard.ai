// Hostile input at the composer (#499), in the real app.
//
// Two things the composer used to take as they came:
//
//   * A FILE'S NAME. It is text somebody else chose, and Unicode lets it carry
//     direction overrides: `invoice` + RIGHT-TO-LEFT OVERRIDE + `fdp.exe` is
//     drawn as `invoiceexe.pdf`, and an override left open reverses whatever
//     the app prints after the name. The name on the chip is now the name as
//     it is really spelled, and it is the same one Claude is sent.
//   * THE PROMPT'S LENGTH. There was no ceiling on the words. Past a million
//     characters the composer now says so and sends nothing; nothing is cut.
//
// `shared/prompt-attachments.hardening.test.ts` owns the list of characters
// and `sessions/ipc.test.ts` owns main's refusal. What only the real app can
// show is that the chip, the message under the box and the send agree.
//
// The override is built from its code point in the page, never typed here.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);

test.describe('hostile input at the composer (#499)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a file name full of direction overrides is inert on its chip', async () => {
    test.setTimeout(120_000);
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });

    // paste a text file whose name is `invoice<RLO>fdp<LRO>.exe<RLO>.txt`
    await w.evaluate(() => {
      const RLO = String.fromCodePoint(0x202e);
      const LRO = String.fromCodePoint(0x202d);
      const box = document.querySelector('textarea')!;
      box.focus();
      const dt = new DataTransfer();
      dt.items.add(new File(['hello'], `invoice${RLO}fdp${LRO}.exe${RLO}.txt`, { type: 'text/plain' }));
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const chip = w.locator('[data-composer-attachment]');
    await expect(chip).toHaveCount(1, { timeout: 15_000 });
    // the name as it is really spelled, on the attribute and in what is drawn
    await expect(chip).toHaveAttribute('data-composer-attachment', 'invoicefdp.exe.txt');
    await expect(chip).toContainText('invoicefdp.exe.txt');
    // ...and NOTHING in the composer carries a character that reorders text
    const invisible = await w.evaluate(() => {
      // built from code points: a file may not contain these characters itself
      const cp = (n: number): string => String.fromCodePoint(n);
      const bad = new RegExp(
        `[${cp(0x200b)}${cp(0x200e)}${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2064)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}]`
      );
      const root = document.querySelector('[data-composer-attachment]')!.closest('form, [data-composer]') ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let found = 0;
      while (walker.nextNode()) if (bad.test(walker.currentNode.nodeValue ?? '')) found += 1;
      for (const el of root.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) if (bad.test(el.getAttribute(attr) ?? '')) found += 1;
      }
      return found;
    });
    expect(invisible).toBe(0);
  });

  test('a prompt past the limit is refused out loud: nothing sent, nothing cut, nothing cleared', async () => {
    test.setTimeout(180_000);
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });

    // a hundred thousand characters, twice the reference's number: it GOES
    await composer(w).click();
    await composer(w).fill(`LONG-OK ${'word '.repeat(20_000)}`);
    await composer(w).press('Enter');
    await expect(w.locator('[data-feed-block="user"]').filter({ hasText: 'LONG-OK' })).toHaveCount(1, { timeout: 60_000 });
    await expect(composer(w)).toHaveValue('', { timeout: 30_000 });

    // one character past a million: it does not
    const tooLong = `TOO-LONG ${'x'.repeat(1_000_000)}`;
    await composer(w).fill(tooLong);
    await composer(w).press('Enter');
    await expect(w.getByText(/That prompt is too long to send: 1,000,009 characters, and the most that can go is 1,000,000/)).toBeVisible({
      timeout: 30_000,
    });
    // NOT CLEARED, and not shortened
    expect(await composer(w).evaluate((el: HTMLTextAreaElement) => el.value.length)).toBe(tooLong.length);
    // NOT SENT, in whole or in part
    await w.waitForTimeout(1500);
    await expect(w.locator('[data-feed-block="user"]').filter({ hasText: 'TOO-LONG' })).toHaveCount(0);
  });
});
