// P2-E10-12 (#485): typed-but-unsent prompt text is not thrown away.
//
// WHAT THIS PROVES THAT A UNIT TEST CANNOT. `composer-draft.test.ts` pins the
// seam — synchronous cache write, coalesced push, immediate clear — and would
// stay green with the value never threaded into the composer, with `cardId`
// never reaching it, or with the blob never reaching disk. The three ways the
// draft actually gets lost are all whole-app events:
//
//   1. POPPING THE CARD OUT (owner, 2026-08-15 — the reason this was raised),
//   2. docking it back,
//   3. quitting and relaunching.
//
// Only an e2e crosses those. Deliberately keyboard-walk-free: nothing here
// presses Tab, so it shares no ground with #524's stream-feed flake.
import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  skipPopoutOnLinux,
  tempProjectFolder,
} from './fixtures/app';

test.describe.configure({ mode: 'serial' });

const DRAFT = 'a half-written thought that must not evaporate';

test.describe('the composer draft survives (#485)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    // popout e2e convention: hand every child window back before teardown
    for (const p of a?.app.windows().filter((w) => w.url().includes('popout.html')) ?? []) {
      await p.evaluate(() => window.close()).catch(() => undefined);
    }
    await a?.cleanup();
  });

  test('a popped-out card keeps what you typed, and so does docking it back', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill(DRAFT);
    await expect(box).toHaveValue(DRAFT);

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = app.windows().find((p) => p.url().includes('popout.html'))!;

    // THE ASSERTION THE ISSUE IS ABOUT: the card is now in another OS window,
    // and the words are still in its box.
    await expect(popout.getByPlaceholder(/Prompt this session/)).toHaveValue(DRAFT, {
      timeout: 20_000,
    });

    // ...and back again. Docking in is a rebuild too, and a draft that only
    // survived one direction would be a draft you lose by putting the card
    // back where it came from.
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(w.getByPlaceholder(/Prompt this session/)).toHaveValue(DRAFT, {
      timeout: 20_000,
    });
  });

  test('it comes back after a relaunch, per card — and sending it forgets it', async () => {
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    const one = path.basename(folder);
    const two = path.basename(folder2);
    const first = await launchApp({ seedFolder: folder });
    a = first; // assigned immediately: a failure before the relaunch still cleans up
    const w = first.window;
    await expect(w.getByText(one).first()).toBeVisible({ timeout: 25_000 });

    // A SECOND card, so "per card" is a fact rather than an assumption: with one
    // draft in the blob every composer would read it back and look correct.
    // The two stack as TABS, so exactly one composer is mounted at a time —
    // which makes every switch below a remount, and therefore a second test of
    // the same thing the pop-out exercises.
    await first.app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder2);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('nav').getByText(two).first()).toBeVisible({ timeout: 25_000 });

    await typeDraft(w, `draft for ${two}`);
    await focusCard(w, one);
    await typeDraft(w, `draft for ${one}`);

    await first.close();
    a = await launchApp({ home: first.home });
    let w2 = a.window;
    await expect(w2.locator('nav').getByText(one).first()).toBeVisible({ timeout: 25_000 });

    // Each card got ITS OWN words back, and neither got the other's.
    await focusCard(w2, one);
    await expect(composer(w2)).toHaveValue(`draft for ${one}`, { timeout: 20_000 });
    await focusCard(w2, two);
    await expect(composer(w2)).toHaveValue(`draft for ${two}`);

    // SENDING clears both the box and the saved copy. The second half is the
    // one that matters: a draft that outlived its own prompt would reappear on
    // an empty composer next launch, which reads as the app un-sending you.
    await composer(w2).click();
    await composer(w2).press('Enter');
    await expect(composer(w2)).toHaveValue('');

    const home = a.home;
    await a.close();
    a = await launchApp({ home });
    w2 = a.window;
    await expect(w2.locator('nav').getByText(one).first()).toBeVisible({ timeout: 25_000 });
    await focusCard(w2, two);
    await expect(composer(w2)).toHaveValue('', { timeout: 20_000 });
    // the card nobody sent from still has its draft — clearing is per card too
    await focusCard(w2, one);
    await expect(composer(w2)).toHaveValue(`draft for ${one}`);
  });
});

/** the mounted card's prompt box — exactly one, since cards stack as tabs */
function composer(w: Page): Locator {
  return w.getByPlaceholder(/Prompt this session/);
}

/** bring a card to the front from the rail, which unmounts the one it replaces */
async function focusCard(w: Page, title: string): Promise<void> {
  await w.locator('nav').getByText(title).first().click();
  await expect(composer(w)).toBeVisible({ timeout: 20_000 });
}

/**
 * Type, then blur.
 *
 * The blur is not decoration: it is what flushes the pending write, and it is
 * also what a user does on their way to anything else. Without it the assertion
 * after a `close()` would be racing a 400ms timer — and a spec that passes by
 * arriving late is worse than one that fails.
 */
async function typeDraft(w: Page, text: string): Promise<void> {
  await composer(w).click();
  await composer(w).fill(text);
  await expect(composer(w)).toHaveValue(text);
  await composer(w).blur();
}
