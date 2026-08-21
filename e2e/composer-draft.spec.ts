// P2-E10-12 (#485): typed-but-unsent prompt text is not thrown away.
//
// WHAT THIS PROVES THAT A UNIT TEST CANNOT. `composer-draft.test.ts` pins the
// seam — synchronous cache write, coalesced push, immediate clear — and would
// stay green with the value never threaded into the composer, with `cardId`
// never reaching it, or with the blob never reaching disk. The ways the draft
// actually gets lost are all whole-app events, and only an e2e crosses them.
//
// A MEASURED CORRECTION, worth stating because the issue says otherwise
// (control run 2026-08-15, this spec against the unfixed build): a plain
// pop-out and dock-back does NOT lose the draft, and never did. dockview moves
// the group's DOM into the new window while the React tree — and the portal
// container React attaches its listeners to — goes with it, so the component
// is never unmounted. The first test below therefore passes with or without
// the fix: it is a REGRESSION GUARD on that fact, not the repro.
//
// What DOES lose it, and what the other two tests pin, is any real remount:
//   1. switching the card to the Terminal tab and back — `panel-terminal` is
//      the only `keepMounted` panel, so the Session panel is torn down;
//   2. quitting and relaunching.
// Both failed against the unfixed build. The same fix covers the third route
// the owner most plausibly hit — the stranded-popout rescue (#292), which
// rebuilds the card from its record by design and is deliberately not
// simulated here.
//
// Deliberately keyboard-walk-free: nothing here presses Tab, so it shares no
// ground with #524's stream-feed flake.
import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  showTerminal,
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

  test('it survives the view tab going away and coming back', async () => {
    // The cheapest real remount in the app, and the one a user hits daily:
    // `panel-terminal` is the only keepMounted panel, so leaving the Session
    // tab tears its whole tree down. This test FAILS against the unfixed build
    // (verified), which the pop-out one does not.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await typeDraft(w, DRAFT);
    await showTerminal(w);
    await expect(composer(w)).toHaveCount(0, { timeout: 20_000 }); // genuinely gone
    await w.getByRole('tab', { name: 'Session' }).click();
    await expect(composer(w)).toHaveValue(DRAFT, { timeout: 20_000 });
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

    // The card is now in another OS window, and the words are still in its box.
    // Green before the fix as well as after (see the header): what this guards
    // is that dockview keeps on MOVING the tree rather than rebuilding it —
    // and if it ever stops, the draft is now durable enough not to care.
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

// ---------------------------------------------------------------------------
// #546: the ATTACHMENTS half of the same draft.
//
// #485 kept the words and stopped there, so a card whose whole prompt was a
// pasted screenshot still lost the lot on a view-tab switch. The decision this
// pins (`lib/composer-attachment-draft.ts`) is a SPLIT one, and each half needs
// a different whole-app event to be visible at all:
//
//   * a REMOUNT keeps the chips, because the bytes are held in a module-level
//     stash that outlives the component — this is the fix;
//   * a RELAUNCH does not, because those bytes are deliberately never written
//     to disk — and it SAYS SO, naming the files, which is the other half of
//     "no longer silent".
//
// A unit test cannot see either one: `composer-attachment-draft.test.ts` would
// stay green with the stash never threaded into the composer, and it cannot
// cross a process boundary at all.
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** a real 1x1 PNG — small, and a genuine image so the chip's canvas decodes */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('the composer draft keeps its attachments too (#546)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  /**
   * Paste a named PNG, from inside the page.
   *
   * A real `ClipboardEvent` on a real `DataTransfer` — Chromium can build both
   * — which is as close to Ctrl+V as a test gets without touching the machine's
   * actual clipboard, which belongs to whoever is using it. The name is given
   * rather than left as `image.png`, because an anonymous PASTE is renamed
   * (`pastedImageName`) and the relaunch assertion below is about a name the
   * user would recognise.
   */
  const pasteImage = (w: Page, name: string): Promise<void> =>
    w.evaluate(
      ({ b64, name }) => {
        const box = document.querySelector('textarea')!;
        box.focus();
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: 'image/png' }));
        box.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        );
      },
      { b64: PNG_1X1, name }
    );

  const chip = (w: Page, name: string): Locator => w.locator(`[data-composer-attachment="${name}"]`);

  test('an image-only prompt survives the view tab going away and coming back', async () => {
    // The exact report: nothing typed, one pasted screenshot, and the cheapest
    // real remount in the app. FAILS against the unfixed build — the chip is
    // simply not there when the Session tab comes back.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await pasteImage(w, 'diagram.png');
    await expect(chip(w, 'diagram.png')).toBeVisible({ timeout: 20_000 });
    await expect(composer(w)).toHaveValue(''); // the picture IS the whole prompt
    await composer(w).blur();

    await showTerminal(w);
    await expect(composer(w)).toHaveCount(0, { timeout: 20_000 }); // genuinely gone
    await w.getByRole('tab', { name: 'Session' }).click();

    await expect(chip(w, 'diagram.png')).toBeVisible({ timeout: 20_000 });
    // and it is still sendable — the strip is not a picture of a chip
    await expect(w.getByTitle('Send to the session')).toBeEnabled();
  });

  test('a relaunch drops them and says which ones, rather than losing them silently', async () => {
    const folder = tempProjectFolder();
    const first = await launchApp({ seedFolder: folder, env: DIRECT });
    a = first;
    const w = first.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await typeDraft(w, DRAFT);
    await pasteImage(w, 'diagram.png');
    await expect(chip(w, 'diagram.png')).toBeVisible({ timeout: 20_000 });
    // the blur is what flushes the pending write; without it the close below
    // would be racing a 400ms timer
    await composer(w).blur();

    await first.close();
    a = await launchApp({ home: first.home, env: DIRECT });
    const w2 = a.window;
    await expect(w2.locator('nav').getByText(path.basename(folder)).first()).toBeVisible({
      timeout: 25_000,
    });

    // the WORDS came back, per #485...
    await expect(composer(w2)).toHaveValue(DRAFT, { timeout: 20_000 });
    // ...the picture did not, because its bytes were never written anywhere...
    await expect(chip(w2, 'diagram.png')).toHaveCount(0);
    // ...and the composer says so, by name. This is the whole difference
    // between #546 fixed and #546 open.
    await expect(w2.locator('[data-composer-attach-notice]')).toContainText('diagram.png', {
      timeout: 20_000,
    });
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
