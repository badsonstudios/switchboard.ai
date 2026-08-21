// P2-E9-06 — §5.8's presentation policy and auto-minimize on submit.
//
// E9-05 proved the ladder and its reveal contract; this file is the STANDING
// RULE that drives them without the user asking each time:
//
//   • under the DEFAULT (`always-visible`, decision 2026-08-04) submitting a
//     prompt moves nothing — you can watch your own turn stream in the card you
//     sent it from;
//   • opting in to `auto-collapse` folds the card into the collapsed strip on
//     submit, and `Stop` — the CLI's done hook — brings it back into exactly the
//     slot it left;
//   • `auto-hide` takes the card out of the workspace entirely and still honours
//     the reveal contract, which is the half that would be easy to get wrong;
//   • a per-session override beats the global, and both survive a relaunch.
//
// The restore half is driven through the REAL hook listener, as ladder.spec and
// attention.spec are: the test plays the CLI's part, so what brings the card
// back is the real status machine rather than a mock.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  setPresentationPolicy,
  tempProjectFolder,
  hookPoster,
  persistedUi,
  readWorkspaceFile,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const strip = (w: Page) => w.getByTestId('collapsed-strip');
const stripRow = (w: Page, title: string) =>
  strip(w).locator(`[data-collapsed-row][title^="${title}"]`);
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);
const policyChip = (w: Page) => w.getByTestId('presentation-policy');

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

/** Set ONE session's override from the rail's context menu. */
async function setSessionPolicy(w: Page, title: string, value: string): Promise<void> {
  await row(w, title).click({ button: 'right' });
  await w.locator(`[data-policy-item="${value}"]`).click();
}

/** Focus a session's card and send it a prompt, the way a user does. */
async function submitIn(w: Page, title: string): Promise<void> {
  await row(w, title).click();
  await expect(w.locator('.dv-active-tab')).toContainText(title);
  await composer(w).click();
  await composer(w).fill('do the thing');
  await w.keyboard.press('Enter');
}

/**
 * The composer cleared, i.e. `submit()` really ran.
 *
 * A POSITIVE CONTROL for the tests that assert nothing MOVED: a dead composer
 * (never focused, Enter swallowed) would let those pass while proving nothing.
 * The tests where the card does move need no such control — the move is the
 * proof. It is also why this cannot live inside `submitIn`: in those tests the
 * composer is gone a tick later, and the assertion would race the collapse.
 */
async function expectSubmitLanded(w: Page): Promise<void> {
  await expect(composer(w)).toHaveValue('');
}

async function liveCount(w: Page): Promise<number> {
  return w.evaluate(async () => (await window.switchboard.sessions.list()).length);
}

test.describe('presentation policy (E9-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the DEFAULT leaves the card exactly where it is', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    await addSession(a);
    await expect(tabs(w)).toHaveCount(2);

    // the default, visible without opening anything and WITHOUT setting it:
    // decision 2026-08-04 — a new user must be able to watch their first turn
    // stream in the card they submitted from
    await expect(policyChip(w)).toContainText('Keep visible');

    await submitIn(w, first);
    await expectSubmitLanded(w);

    // nothing moves, and nothing is supposed to. Given a moment, because a
    // collapse that DID happen would take a tick to land.
    await w.waitForTimeout(1000);
    await expect(tabs(w)).toHaveCount(2);
    await expect(strip(w)).toHaveCount(0);
    await expect(w.locator('.dv-active-tab')).toContainText(first);
  });

  test('auto-collapse, opted in, collapses on submit and done brings it back to its slot', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);

    // one click of the chip is the whole opt-in
    await setPresentationPolicy(w, 'Collapse on submit');

    // the MIDDLE card, so a card that came back at the END would be visibly
    // wrong rather than accidentally right
    await submitIn(w, second);

    // it gave its dock slot back and left a row saying where it went — the
    // difference between auto-collapse and auto-hide
    await expect(tabs(w)).toHaveCount(2, { timeout: 15_000 });
    await expect(stripRow(w, second)).toBeVisible();
    await expect(row(w, second)).toBeVisible(); // still in the rail
    expect(await liveCount(w)).toBe(3); // and still running: a rung, not a close

    // the CLI finishes the turn — §5.8: "it restores automatically on Stop"
    await post(second, { hook_event_name: 'Stop' });

    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(first),
      expect.stringContaining(second),
      expect.stringContaining(third),
    ]);
    await expect(strip(w)).toHaveCount(0);
    expect(await liveCount(w)).toBe(3);
  });

  test('auto-hide removes the card and still honours the reveal contract', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);

    await setPresentationPolicy(w, 'Hide on submit');
    await submitIn(w, second);

    // hidden means hidden: no card AND no strip row — only the rail, the lamp
    // and the events list, which is the difference between the two rungs
    await expect(tabs(w)).toHaveCount(2, { timeout: 15_000 });
    await expect(strip(w)).toHaveCount(0);
    await expect(row(w, second)).toBeVisible();

    // stand somewhere else, so a reveal that stole focus would be obvious
    await row(w, third).click();
    await expect(w.locator('.dv-active-tab')).toContainText(third);

    // now it needs a human — §5.8's other restore trigger
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(first),
      expect.stringContaining(second),
      expect.stringContaining(third),
    ]);
    // ...without stealing the screen from what the user was doing
    await expect(w.locator('.dv-active-tab')).toContainText(third);
  });

  test('a GROUP override beats the global, for its members only', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const loose = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });

    // a group with one session in it, alongside the ungrouped seed session
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByTitle('New session in this group').click();
    const member = path.basename(dir);
    await expect(row(w, member)).toBeVisible({ timeout: 25_000 });
    await expect(tabs(w)).toHaveCount(2);

    // globally: vanish on submit. For this group: don't.
    await setPresentationPolicy(w, 'Hide on submit');
    await w.locator('[data-group-policy]').click(); // undefined -> keep visible
    await expect(w.locator('[data-group-policy]')).toHaveAttribute(
      'title',
      /Keep visible/
    );

    await submitIn(w, member);
    await expectSubmitLanded(w);
    await w.waitForTimeout(1000);
    await expect(tabs(w)).toHaveCount(2); // the group's word beat the global's

    // ...and only for its members: the ungrouped session still follows the global
    await submitIn(w, loose);
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(strip(w)).toHaveCount(0);
  });

  test('a per-session override beats the global, and both survive a relaunch', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);

    // the global says "fold into the strip"; ONE session disagrees. Both are
    // opt-ins, so both are real records in the blob — which is the half of this
    // test that a default-valued global would not exercise.
    await setPresentationPolicy(w, 'Collapse on submit');
    await setSessionPolicy(w, second, 'auto-hide');

    // the neighbour follows the global
    await submitIn(w, third);
    await expect(tabs(w)).toHaveCount(2, { timeout: 15_000 });
    await expect(stripRow(w, third)).toBeVisible();

    // the overridden one does not — it leaves entirely, strip row and all
    await submitIn(w, second);
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(stripRow(w, second)).toHaveCount(0); // auto-hide, not auto-collapse
    await expect(row(w, second)).toBeVisible();
    await expect(tabs(w)).toContainText(first); // the untouched one is still a card

    // every command still names it, because §5.8's invariant is that hiding
    // chrome never removes capability
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w
      .getByPlaceholder('Type a command or a session name…')
      .fill('This session on submit: follow the default');
    await expect(w.locator('[data-palette-rows] [role="option"]').first()).toContainText(
      'follow the default'
    );
    await w.keyboard.press('Escape');

    const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      cardId: string;
    }>;
    const overridden = cards.find((c) => c.title === second)!.cardId;

    const home = a.home;
    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();

    // the setting is in the ui blob, which is where §5.25 says it lives
    const ui = persistedUi(readWorkspaceFile(home));
    expect(ui.presentationPolicy?.global).toBe('auto-collapse');
    expect(ui.presentationPolicy?.cards?.[overridden]).toBe('auto-hide');

    // ...and it comes back saying the same thing
    a = await launchApp({ home });
    await expect(policyChip(a.window)).toContainText('Collapse on submit', { timeout: 25_000 });
    await row(a.window, second).click({ button: 'right' });
    await expect(a.window.locator('[data-policy-item="auto-hide"]')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
