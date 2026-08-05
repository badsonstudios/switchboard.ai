// P2-E9-07 — §5.8's layout modes (grid · focus · queue) and the maximize toggle.
//
// E9-05 proved the LADDER: one session moving between four rungs, and coming
// back to exactly the slot it left. This file is the workspace-level claim —
// one setting that puts EVERY session on a rung at once:
//
//   • focus folds everything but the card you are in, and the big card FOLLOWS
//     you when you click another session;
//   • queue expands only the sessions that need a human, and expands one the
//     instant it starts needing one — driven through the REAL hook listener, so
//     what moves the card is the real status machine and not a mock;
//   • the mode survives a relaunch (§5.25, the ui blob);
//   • maximize round-trips, by double-click and by its command, and puts the
//     PRIOR arrangement back rather than re-applying the mode.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
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
const stripRows = (w: Page) => strip(w).locator('[data-collapsed-row]');
const stripRow = (w: Page, title: string) =>
  strip(w).locator(`[data-collapsed-row][title^="${title}"]`);
const modeChip = (w: Page) => w.getByTestId('layout-mode');
/**
 * The header of whichever card is on screen.
 *
 * ONE element, because every card these tests open lands in the same dockview
 * group (addSessionCard reuses the first grid group) and dockview mounts only
 * the visible panel. A future change that splits new cards across groups would
 * turn this into a strict-mode failure rather than a silent wrong answer.
 */
const cardHeader = (w: Page) => w.getByTestId('card-header').filter({ visible: true });

/** run a palette command by its visible title */
async function palette(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(title);
  await w.keyboard.press('Enter');
}

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

/** how many live sessions the main process is running */
async function liveCount(w: Page): Promise<number> {
  return w.evaluate(async () => (await window.switchboard.sessions.list()).length);
}

test.describe('layout modes (E9-07)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('focus mode leaves one card and folds the rest — and the big card follows you', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    // grid is the default: nothing is folded until a mode is chosen
    await expect(strip(w)).toHaveCount(0);

    await row(w, second).click();
    await expect(w.locator('.dv-active-tab')).toContainText(second);
    await palette(w, 'Layout: Focus — one big card, the rest as strips');

    // one large + slim strips (§5.8), and the large one is the card you are in
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(tabs(w).first()).toContainText(second);
    await expect(stripRows(w)).toHaveCount(2);
    await expect(stripRow(w, first)).toBeVisible();
    await expect(stripRow(w, third)).toBeVisible();
    // NOTHING was closed: a mode is a map of card -> rung, never a close
    await expect(rail(w).locator('[draggable="true"]')).toHaveCount(3);
    expect(await liveCount(w)).toBe(3);

    // click another session: it becomes the big card and the old one folds. This
    // is what makes focus a MODE and not a one-off rearrangement.
    await stripRow(w, third).click();
    await expect(tabs(w).first()).toContainText(third, { timeout: 25_000 });
    await expect(tabs(w)).toHaveCount(1);
    await expect(stripRow(w, second)).toBeVisible();
    await expect(stripRows(w)).toHaveCount(2);

    // ...and grid gives every session its card back
    await palette(w, 'Layout: Grid — every session gets a card');
    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    await expect(strip(w)).toHaveCount(0);
    expect(await liveCount(w)).toBe(3);
  });

  test('queue mode expands a session the instant it needs attention', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);

    await row(w, first).click();
    await palette(w, 'Layout: Queue — only the sessions that need you');
    // nothing needs a human yet, so only the card you are IN is left standing —
    // the workspace must not empty itself out from under you
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(tabs(w).first()).toContainText(first);
    await expect(stripRows(w)).toHaveCount(2);

    // now one of the folded sessions blocks on a permission. Nobody clicked
    // anything: the status machine did this.
    await post(third, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect(stripRows(w)).toHaveCount(1);
    await expect(stripRow(w, second)).toBeVisible();

    // Move to the session that is NOT blocked. The blocked one must stay
    // expanded — queue mode holds it up, and this is the assertion E9-05's
    // reveal-on-attention cannot produce on its own: the card you LEFT folds,
    // and the one that needs a human does not.
    await stripRow(w, second).click();
    await expect(tabs(w).filter({ hasText: second })).toHaveCount(1, { timeout: 25_000 });
    await expect(stripRow(w, first)).toBeVisible({ timeout: 25_000 });
    await expect(tabs(w).filter({ hasText: third })).toHaveCount(1);
    await expect(tabs(w)).toHaveCount(2);
    expect(await liveCount(w)).toBe(3);
  });

  test('the mode survives a relaunch, and the chip says which one you are on', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = path.basename(folder);
    await expect(tabs(a.window)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(a.window)).toHaveCount(2);

    // the chip is the mouse path: it cycles, and its label is the answer to
    // "why is everything a strip all of a sudden?"
    await expect(modeChip(a.window)).toContainText('Grid');
    await row(a.window, first).click();
    await modeChip(a.window).click();
    await expect(modeChip(a.window)).toContainText('Focus');
    await expect(tabs(a.window)).toHaveCount(1, { timeout: 15_000 });
    await expect(stripRow(a.window, second)).toBeVisible();

    const home = a.home;
    await a.window.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();

    // the mode is in the ui blob, where the done-when says it lives
    const ui = persistedUi(readWorkspaceFile(home));
    expect(ui.layoutMode?.mode).toBe('focus');

    a = await launchApp({ home });
    const w = a.window;
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    await expect(modeChip(w)).toContainText('Focus');
    // and the workspace comes back arranged, not merely labelled
    await expect(tabs(w)).toHaveCount(1);
    await expect(stripRow(w, second)).toBeVisible();
  });

  test('double-clicking a card header maximizes it, and puts the PRIOR layout back', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);

    // hide one BY HAND first: "restores the prior layout" has to mean the
    // arrangement that was there, not a re-run of the current mode — which
    // would drag this session back into the grid uninvited
    await row(w, third).click();
    await palette(w, 'Hide session (keeps it running)');
    await expect(tabs(w)).toHaveCount(2);

    await row(w, first).click();
    await expect(w.locator('.dv-active-tab')).toContainText(first);
    await cardHeader(w).dblclick({ position: { x: 4, y: 4 } });

    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(tabs(w).first()).toContainText(first);
    await expect(stripRow(w, second)).toBeVisible();
    // the hand-hidden session is still hidden: maximize put the rest away, it
    // did not go and fetch one
    await expect(stripRows(w)).toHaveCount(1);

    // A held maximize is not a trap: §5.8 says clicking a session anywhere
    // reveals it, so going to look at the folded one has to work — and stick.
    await stripRow(w, second).click();
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect(strip(w)).toHaveCount(0);
    // give a stray reactive sweep a chance to undo it before we believe it
    await w.waitForTimeout(500);
    await expect(tabs(w)).toHaveCount(2);
    await row(w, first).click();

    // ...and again puts it back exactly as it was — including the hidden one
    // STAYING hidden
    await cardHeader(w).dblclick({ position: { x: 4, y: 4 } });
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect(strip(w)).toHaveCount(0);
    await expect(rail(w).locator('[draggable="true"]')).toHaveCount(3);
    expect(await liveCount(w)).toBe(3);

    // the keyboard is an equal of the gesture (§5.8: hiding chrome never
    // removes capability)
    await w.keyboard.press(`${MOD}+Shift+M`);
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });
    await w.keyboard.press(`${MOD}+Shift+M`);
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect(strip(w)).toHaveCount(0);
  });
});
