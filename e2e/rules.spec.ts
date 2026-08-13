// P2-E14-03 — one rule, end to end, in a real window.
//
// The unit tests own the matrix (event × scope × visibility, in
// `src/main/events/rules.test.ts`). What only a real app can show is that the
// three halves are actually joined: a checkbox in the renderer writes a rule
// into the workspace store, a hook event from the CLI reaches the engine with
// the LIVE session id, and the engine resolves that back to the CARD the rule
// was scoped to — then hands an OS toast to Electron.
//
// The toast is asserted through the app LOG rather than by intercepting
// `Notification`: the line is written by the action handler itself, so it says
// the action RAN, and it carries the card and the visibility the engine saw —
// the difference between "a toast happened" and "the right toast happened for
// the right reason". Reading the log for main-process facts is the house
// pattern (`approval.spec.ts`, `hookPoster`).
import { test, expect, Page, Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  findFile,
  hookPoster,
  poll,
  tempProjectFolder,
} from './fixtures/app';

interface ToastLine {
  cardId: string;
  kind: string;
  visibility: string;
  ruleId: string;
}

/** every "os toast shown" line the app has written so far */
function toasts(home: string): ToastLine[] {
  const f = findFile(home, 'switchboard.log');
  if (!f) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"os toast shown"'))
    .map((l) => JSON.parse(l) as ToastLine);
}

/** the header of the card whose title contains `title` — menus are inside it */
const card = (w: Page, title: string): Locator =>
  w.locator('[data-testid="card-header"]').filter({ hasText: title });

/**
 * The entry is a TOGGLE BUTTON (`aria-pressed`), not a `menuitemcheckbox`: the
 * card's ⋯ dropdown is not a `role=menu`, and an orphaned menuitem is invalid
 * ARIA. Asserting the role and the pressed state here is what stops the next
 * edit quietly turning it back into a plain stateless button.
 */
const notifyBox = (scope: Locator): Locator =>
  scope.getByRole('button', { name: /Notify when done/ });

test.describe('notification rules (P2-E14-03)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the notify-when-done checkbox toasts its own session and no other', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    const names = folders.map((f) => path.basename(f));
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    await expect(w.getByText(names[0]).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(names[1]).first()).toBeVisible({ timeout: 25_000 });

    // Two sessions land as two TABS in one dockview group, and dockview mounts
    // only the active panel — the first card's header does not exist in the DOM
    // until its tab is selected. Select it, rather than reaching for a header
    // that is not there.
    await w.getByRole('tab', { name: new RegExp(names[0]) }).click();

    // Tick the box on the FIRST card only. The toggle-button contract
    // (`aria-pressed`) is the a11y half (§5.32): a screen reader has to be told
    // this entry has a state, and asserting it here is what stops the next edit
    // quietly turning it back into a plain stateless button.
    await card(w, names[0]).getByTitle('Session menu').click();
    const box = notifyBox(card(w, names[0]));
    await expect(box).toHaveAttribute('aria-pressed', 'false');
    await box.click();
    await expect(box).toHaveAttribute('aria-pressed', 'true');
    await w.keyboard.press('Escape');

    // The user looks away — the rule's visibility condition needs it. Asserted
    // rather than assumed: a `blur()` that did nothing would leave this test
    // proving the rule fired for a reason it did not have. (The FOCUSED half of
    // the condition is unit-tested; a headless runner is no place to insist on
    // owning OS focus.)
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    await expect
      .poll(
        () => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        { timeout: 15_000 }
      )
      .toBe(false);

    const post = await hookPoster(a, 2);
    // The UNTICKED session finishes FIRST: if `done` still toasted globally,
    // this is where it would show, and the count below would catch it.
    await post(names[1], { hook_event_name: 'Stop' });
    await post(names[0], { hook_event_name: 'Stop' });

    const shown = await poll(() => {
      const t = toasts(a.home);
      return t.length > 0 ? t : null;
    }, 20_000);
    expect(shown).toHaveLength(1);
    expect(shown[0].kind).toBe('done');
    expect(shown[0].visibility).not.toBe('focused');

    // …and it belongs to the card whose box is ticked
    const cards = await w.evaluate(() => window.switchboard.sessions.cards());
    expect(shown[0].cardId).toBe(cards.find((c) => c.title === names[0])!.cardId);
  });

  test('the checkbox survives a restart', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const first = a; // the handle afterEach must still be able to kill (#16)
    const w = first.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await card(w, name).getByTitle('Session menu').click();
    await notifyBox(card(w, name)).click();
    await expect(notifyBox(card(w, name))).toHaveAttribute('aria-pressed', 'true');

    await w.waitForTimeout(900); // the store's debounced save
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    // A card restored from the workspace file comes back LIVE (it re-launches
    // on its own); `Resume` belongs to a card suspended by hand, which this one
    // never was. Waiting for the title is the house shape for a relaunch
    // (`feed.spec.ts`).
    await expect(w2.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await card(w2, name).getByTitle('Session menu').click();
    await expect(notifyBox(card(w2, name))).toHaveAttribute('aria-pressed', 'true', {
      timeout: 10_000,
    });
  });
});
