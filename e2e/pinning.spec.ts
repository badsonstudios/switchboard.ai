// P2-E9-09 — §5.8's PINNING CONTRACT.
//
// "a pinned session sorts first in the rail, never scrolls out of view under
//  overflow, and is exempt from EVERY bulk operation — bulk-close, idle
//  aggregation, auto-collapse sweeps, and any future auto-eviction."
//
// The unit tests own the rules themselves — lib/pinning.test.ts (the state, the
// sort, the bulk-close exemption), lib/groups.test.ts (sorts first),
// lib/ladder.test.ts (never aggregates), lib/presentation-policy.test.ts (never
// auto-collapses on submit), store/session-store.test.ts (derives + persists).
// This file owns the four claims those cannot make: a real pin taken with a
// real gesture STILL SORTS FIRST AFTER RELAUNCH, a real pinned idle session
// DOES NOT AGGREGATE among real idle ones, a real bulk close LEAVES IT RUNNING
// — and (#295) a real OVERFLOWING rail, scrolled to its end, STILL SHOWS IT.
// That last one is the clause #78 deferred, and it is geometry: it needs a
// layout engine, a scrollbar and a window, so it exists nowhere but here.
//
// Statuses are driven through the REAL hook listener, exactly as
// idle-collapse.spec.ts does: a spawned session is `starting`, which reads as
// working, and only the CLI's own SessionStart makes it idle.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, hookPoster } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const rows = (w: Page) => rail(w).locator('[draggable="true"]');
const row = (w: Page, title: string) => rows(w).filter({ hasText: title }).first();
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

/** pin (or unpin) a session the way a user does: right-click, pick the item */
async function togglePin(w: Page, title: string): Promise<void> {
  await row(w, title).click({ button: 'right' });
  await w.getByRole('menu').getByRole('menuitem', { name: /^(Pin|Unpin) session$/ }).click();
}

/** the rail's own order, top to bottom — what Ctrl+1..9 counts against. The
 *  row button's FIRST span is the title; its second is the sub-label. */
async function railTitles(w: Page): Promise<string[]> {
  return rows(w).evaluateAll((els) =>
    els.map((e) => e.querySelector('[data-rail-open] > span')?.textContent?.trim() ?? '')
  );
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

/** the rail's scroll container — the box #295's clause is about */
const railScroll = (w: Page) => rail(w).locator('.rail-scroll');

/** the sticky block a bucket's pinned rows are lifted into (#295) */
const pinBlock = (w: Page) => rail(w).locator('[data-pinned-block]');

/** how many live sessions the main process is running */
async function liveCount(w: Page): Promise<number> {
  return w.evaluate(async () => (await window.switchboard.sessions.list()).length);
}

/** every session idle, through the CLI's own SessionStart */
async function goIdle(a: LaunchedApp, titles: string[]): Promise<void> {
  const post = await hookPoster(a, titles.length);
  for (const title of titles) await post(title, { hook_event_name: 'SessionStart' });
  for (const title of titles) {
    await expect(row(a.window, title)).toHaveAttribute('data-session-status', 'idle', {
      timeout: 20_000,
    });
  }
}

/** a workspace of `count` sessions, each in its own folder, all idle */
async function workspace(count: number): Promise<{ a: LaunchedApp; titles: string[] }> {
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder });
  const titles = [path.basename(folder)];
  await expect(tabs(a.window)).toHaveCount(1, { timeout: 25_000 });
  for (let i = 1; i < count; i++) titles.push(await addSession(a));
  await expect(tabs(a.window)).toHaveCount(count);
  await goIdle(a, titles);
  return { a, titles };
}

test.describe('pinning contract (E9-09)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a pin taken by hand sorts the session first, and still does after a relaunch', async () => {
    const ws = await workspace(3);
    // assigned IMMEDIATELY, and reassigned after the relaunch: `afterEach` is
    // the only thing that kills the Electron process and deletes its temp home,
    // so a failure before the second launch must still have something to clean
    // up (#213).
    a = ws.a;
    const first = ws.a;
    const w = first.window;
    const before = await railTitles(w);
    const target = before[before.length - 1]; // last, so "first" is a real move
    await expect(row(w, target)).toHaveAttribute('data-pinned', 'false');

    await togglePin(w, target);
    await expect(row(w, target)).toHaveAttribute('data-pinned', 'true');
    // §5.8: "sorts first in the rail" — and the rail IS Ctrl+1..9's numbering
    // authority, so this is the hotkey order too. Everything else keeps its
    // place: pinning promotes, it never shuffles.
    expect(await railTitles(w)).toEqual([target, ...before.filter((tt) => tt !== target)]);

    // ...and it SURVIVES A RELAUNCH (§5.25: the workspace comes back as you
    // left it). This is the clause a unit test cannot make: the pin has to
    // reach the ui blob on disk and be read back before the first session push,
    // or the rail would paint in the old order and reshuffle in front of you.
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(rows(w2)).toHaveCount(3, { timeout: 25_000 });
    await expect(row(w2, target)).toHaveAttribute('data-pinned', 'true');
    expect((await railTitles(w2))[0]).toBe(target);

    // unpin is the SAME gesture, and it puts the rail back rather than leaving
    // it re-sorted
    await togglePin(w2, target);
    await expect(row(w2, target)).toHaveAttribute('data-pinned', 'false');
    expect(await railTitles(w2)).toEqual(before);
  });

  test('a pinned IDLE session never folds into the aggregate', async () => {
    // five idle sessions: stand in one, fold the other four away with focus
    // mode, and they aggregate — unless one of them is pinned.
    const ws = await workspace(6);
    a = ws.a;
    const w = a.window;
    const [focused, ...others] = ws.titles;
    const kept = others[2]; // in the middle of what would be the fold

    await togglePin(w, kept);
    await row(w, focused).click();
    await expect(w.locator('.dv-active-tab')).toContainText(focused);
    await palette(w, 'Layout: Focus — one big card, the rest as strips');

    // §5.8's "pinned ≠ always-expanded" in one assertion: the pinned session
    // was collapsed by the layout mode like everybody else — pinning protects
    // existence and position, NOT size...
    await expect(tabs(w)).toHaveCount(1, { timeout: 20_000 });
    await expect(stripRow(w, kept)).toBeVisible({ timeout: 20_000 });

    // ...and it kept a row OF ITS OWN while the other four folded into one
    await expect(fold(w)).toHaveAttribute('data-idle-fold', '4');
    await expect(stripRows(w)).toHaveCount(1);
    await expect(stripRow(w, kept)).toHaveAttribute('data-status', 'idle');

    // unpin it and it joins them — the fold is derived from the pin, not from a
    // set someone remembered once
    await togglePin(w, kept);
    await expect(fold(w)).toHaveAttribute('data-idle-fold', '5', { timeout: 20_000 });
    await expect(stripRows(w)).toHaveCount(0);
    expect(await liveCount(w)).toBe(6);
  });

  test('a pinned session survives a bulk close', async () => {
    const ws = await workspace(4);
    a = ws.a;
    const w = ws.a.window;
    const kept = ws.titles[1];

    await togglePin(w, kept);
    expect(await liveCount(w)).toBe(4);

    // dismissing the confirm closes nothing: a bulk close is destructive and
    // must be answered for, exactly as the per-card close is
    w.once('dialog', (d) => void d.dismiss());
    await palette(w, 'Close all sessions (keeps pinned ones)');
    await expect(rows(w)).toHaveCount(4);
    expect(await liveCount(w)).toBe(4);

    // ...and accepting it takes THREE of the four
    w.once('dialog', (d) => void d.accept());
    await palette(w, 'Close all sessions (keeps pinned ones)');
    await expect(rows(w)).toHaveCount(1, { timeout: 25_000 });
    await expect(row(w, kept)).toHaveAttribute('data-pinned', 'true');
    // still RUNNING, not merely still listed — the protection is about the
    // session, not about a row
    expect(await liveCount(w)).toBe(1);
    await expect(tabs(w)).toHaveCount(1);
    await expect(tabs(w).first()).toContainText(kept);

    // and with nothing left to close, the command says so rather than opening a
    // confirm for an empty list
    let said = '';
    w.once('dialog', (d) => {
      said = d.message();
      void d.accept();
    });
    await palette(w, 'Close all sessions (keeps pinned ones)');
    await expect.poll(() => said).toContain('pinned');
    await expect(rows(w)).toHaveCount(1);
    expect(await liveCount(w)).toBe(1);
  });

  // #295 — "never scrolls out of view under overflow", the clause #78 shipped
  // without and said so. Everything about it is geometry, so there is no unit
  // test that can be wrong in an interesting way here: the rail has to really
  // overflow, the scrollbar has to really move, and the row has to really still
  // be on screen afterwards.
  test('a pinned session stays on screen when the rail is scrolled past it', async () => {
    test.slow(); // five sessions, then a real scroll
    const ws = await workspace(5);
    a = ws.a;
    const w = a.window;

    // MAKE IT OVERFLOW, deterministically. Five rows do not fill a 600px-tall
    // rail, and `minHeight: 600` (main/index.ts) is what stops the window being
    // shrunk into one — so the minimum is lifted first. This is the OS window,
    // not product code: nothing test-only is reachable inside the app.
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(600, 260);
      win.setSize(1000, 260);
    });
    // ...and PROVE it overflowed, or everything below is a false green
    await expect
      .poll(
        () => railScroll(w).evaluate((el) => el.scrollHeight - el.clientHeight),
        { timeout: 15_000 }
      )
      .toBeGreaterThan(40);

    // pin the LAST session, so "first" is a real move and the row we watch
    // would otherwise be the one furthest from the top
    const target = ws.titles[ws.titles.length - 1];
    await togglePin(w, target);
    await expect(row(w, target)).toHaveAttribute('data-pinned', 'true');
    await expect(pinBlock(w)).toHaveCount(1);
    // it is the pinned row that was lifted, not some other one
    await expect(pinBlock(w).locator('[draggable="true"]')).toHaveCount(1);
    await expect(pinBlock(w)).toContainText(target);

    // scroll to the very end of the rail — the state the clause is about
    await railScroll(w).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => railScroll(w).evaluate((el) => el.scrollTop), { timeout: 10_000 })
      .toBeGreaterThan(20);

    // THE CLAUSE: still visible, and still inside the rail's own box rather
    // than merely "in the DOM"
    await expect(row(w, target)).toBeInViewport();
    const boxes = await railScroll(w).evaluate((el) => {
      const scroll = el.getBoundingClientRect();
      const pinned = el.querySelector('[data-pinned-block]')!.getBoundingClientRect();
      return { scrollTop: scroll.top, scrollBottom: scroll.bottom, pinTop: pinned.top, pinBottom: pinned.bottom };
    });
    expect(boxes.pinTop).toBeGreaterThanOrEqual(boxes.scrollTop - 1);
    expect(boxes.pinBottom).toBeLessThanOrEqual(boxes.scrollBottom + 1);

    // DECISION 4: and the keyboard cannot be walked in behind it. The rail is
    // scrolled to the bottom, so focusing an EARLY row makes the browser scroll
    // it to the top edge of the scrollport — which is where the block is parked.
    const covered = ws.titles.find((tt) => tt !== target)!;
    await row(w, covered).locator('[data-rail-open]').focus();
    const after = await railScroll(w).evaluate(() => {
      const block = document.querySelector('[data-pinned-block]')!.getBoundingClientRect();
      const focused = (document.activeElement as HTMLElement).getBoundingClientRect();
      return { blockBottom: block.bottom, focusedTop: focused.top };
    });
    expect(after.focusedTop).toBeGreaterThanOrEqual(after.blockBottom - 1);

    // ...and unpinning puts the row back in the flow: the lift is derived from
    // the pin, not from a block someone forgot to take down
    await togglePin(w, target);
    await expect(pinBlock(w)).toHaveCount(0);
  });
});
