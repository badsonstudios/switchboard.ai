// P2-E9-08 — §5.8's idle collapse & aggregation.
//
// E9-05 built the collapsed strip (one slim row per collapsed session) and
// E9-07 built the modes that put sessions on it wholesale. This is what happens
// once the strip has more idle rows in it than are worth reading one by one:
// "more than ~3 idle aggregate into a single 'N idle sessions' row. Working /
// errored / currently-focused sessions always keep their own row" (§5.8).
//
// The statuses are driven through the REAL hook listener, exactly as
// urgency.spec.ts and layout-modes.spec.ts do: a spawned session starts at
// `starting` — which reads as WORKING, and so is deliberately not foldable — and
// only the CLI's own SessionStart makes it idle. The test plays the CLI's part
// so what folds is the real status machine and not a mock.
//
// The unit tests (lib/ladder.test.ts, components/CollapsedStrip.test.tsx) own
// the rule itself — which rows fold, where the fold sits, what the label says.
// This file owns the claim those cannot make: that a real workspace of real
// sessions, folded by a real layout mode, behaves that way end to end.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, hookPoster } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const strip = (w: Page) => w.getByTestId('collapsed-strip');
const stripRows = (w: Page) => strip(w).locator('[data-collapsed-row]');
const stripRow = (w: Page, title: string) =>
  strip(w).locator(`[data-collapsed-row][title^="${title}"]`);
const fold = (w: Page) => strip(w).locator('[data-idle-fold]');

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

/**
 * A workspace of `count` sessions, every one of them IDLE, with the first one
 * focused and every other one collapsed into the strip by focus mode.
 *
 * Focus mode rather than N collapse commands on purpose: it is the shape a user
 * actually arrives in with seven or eight agents running, and it produces the
 * one arrangement idle aggregation exists for in a single gesture.
 */
async function idleWorkspace(
  count: number
): Promise<{ a: LaunchedApp; titles: string[] }> {
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder });
  const w = a.window;
  const titles = [path.basename(folder)];
  await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
  for (let i = 1; i < count; i++) titles.push(await addSession(a));
  await expect(tabs(w)).toHaveCount(count);

  // a spawned session is `starting`, which reads as working — nothing folds
  // until the CLI says the session is up. This is the real transition
  // (SessionStart -> idle), not a nudge.
  const post = await hookPoster(a, count);
  for (const title of titles) await post(title, { hook_event_name: 'SessionStart' });
  for (const title of titles) {
    await expect(row(w, title)).toHaveAttribute('data-session-status', 'idle', {
      timeout: 20_000,
    });
  }

  // stand in the first session, then fold the rest away
  await row(w, titles[0]).click();
  await expect(w.locator('.dv-active-tab')).toContainText(titles[0]);
  await palette(w, 'Layout: Focus — one big card, the rest as strips');
  await expect(tabs(w)).toHaveCount(1, { timeout: 20_000 });
  return { a, titles };
}

test.describe('idle collapse & aggregation (E9-08)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('four idle sessions become one row, which opens into the four', async () => {
    const ws = await idleWorkspace(5);
    a = ws.a;
    const w = a.window;
    const [focused, ...folded] = ws.titles;

    // FOUR rows became one. Not four rows plus a summary — one row.
    await expect(fold(w)).toHaveAttribute('data-idle-fold', '4', { timeout: 20_000 });
    await expect(fold(w)).toContainText('4 idle sessions');
    await expect(stripRows(w)).toHaveCount(0);

    // the session you are IN is never swallowed: it still has its card, and it
    // is not one of the four
    await expect(tabs(w)).toHaveCount(1);
    await expect(tabs(w).first()).toContainText(focused);
    await expect(stripRow(w, focused)).toHaveCount(0);

    // NOTHING was closed or stopped — a fold is a way of drawing the strip, not
    // a rung and certainly not a close
    await expect(rail(w).locator('[draggable="true"]')).toHaveCount(5);
    expect(await liveCount(w)).toBe(5);

    // it opens...
    await expect(fold(w)).toHaveAttribute('aria-expanded', 'false');
    await fold(w).click();
    await expect(fold(w)).toHaveAttribute('aria-expanded', 'true');
    await expect(stripRows(w)).toHaveCount(4);
    for (const title of folded) await expect(stripRow(w, title)).toBeVisible();

    // ...and closes again
    await fold(w).click();
    await expect(stripRows(w)).toHaveCount(0);

    // and a folded session is still one click from coming back, once it is
    // listed: open the fold, click the session (§4's two-gesture rule)
    await fold(w).click();
    await stripRow(w, folded[1]).click();
    await expect(w.locator('.dv-active-tab')).toContainText(folded[1], { timeout: 25_000 });
    expect(await liveCount(w)).toBe(5);
  });

  test('a status change pops the RIGHT one back out and leaves the rest folded', async () => {
    const ws = await idleWorkspace(6);
    a = ws.a;
    const w = a.window;
    const [focused, ...folded] = ws.titles;
    const waker = folded[2]; // in the middle of the fold, not at an end

    await expect(fold(w)).toHaveAttribute('data-idle-fold', '5', { timeout: 20_000 });
    await expect(stripRows(w)).toHaveCount(0);

    // one of the five starts working. The CLI's own UserPromptSubmit, so this
    // is the real status machine — and deliberately NOT an attention event: a
    // permission or a Stop would reveal the whole card (E9-05), which would
    // prove the reveal contract rather than this item's rule.
    const post = await hookPoster(a, 6);
    await post(waker, { hook_event_name: 'UserPromptSubmit' });

    // it gets its own row back — §5.8: "working sessions always keep their own
    // row" — and the other four stay folded
    await expect(stripRow(w, waker)).toBeVisible({ timeout: 20_000 });
    await expect(stripRow(w, waker)).toHaveAttribute('data-status', 'working');
    await expect(stripRows(w)).toHaveCount(1);
    await expect(fold(w)).toHaveAttribute('data-idle-fold', '4');

    // the session you are in never joined the fold in the first place
    await expect(tabs(w).first()).toContainText(focused);
    await expect(stripRow(w, focused)).toHaveCount(0);

    // and going idle again puts it back in with the others: the fold is derived
    // from live status, not a set someone remembered once
    await post(waker, { hook_event_name: 'SessionStart' });
    await expect(fold(w)).toHaveAttribute('data-idle-fold', '5', { timeout: 20_000 });
    await expect(stripRows(w)).toHaveCount(0);
    expect(await liveCount(w)).toBe(6);
  });
});
