// The Events drawer (P2-E14-01, Shape B — Dan's pick at the 2026-08-13 gate).
//
// The item's claim is a trade: the Events panel gives up being always visible,
// and in exchange the session grid gets the 220px it used to hold in every
// layout mode. That trade is only honest if two things are true at once, and
// both of them are measurements rather than opinions:
//
//   • the column is GONE — the grid really does reach the right edge; and
//   • opening the drawer costs the grid NOTHING — it overlays, so nothing you
//     were reading moves under you.
//
// The rest of this file is §5.8's invariant: collapsing chrome never removes
// capability. Three ways in (the tab, the hotkey, the palette), a way out that
// puts focus back, and — while it is shut — a tab that still says how many
// sessions are waiting and whether a notice is up behind it.
//
// The panel's CONTENT is not re-tested here. It did not change, and it is
// covered where it always was: attention.spec.ts for the queue's order,
// service-health.spec.ts for the incidents card, update.spec.ts for the update
// notice, a11y-keyboard.spec.ts for the rows' keyboard reach.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  hookPoster,
  launchApp,
  LaunchedApp,
  openEventsDrawer,
  tempProjectFolder,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const tab = (w: Page) => w.getByTestId('events-tab');
const drawer = (w: Page) => w.getByTestId('events-drawer');
const statusCount = (w: Page) => w.getByTestId('status-attention');
const groupview = (w: Page) => w.locator('.dv-groupview').first();

/** run a palette command by its visible title */
async function palette(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(title);
  await w.keyboard.press('Enter');
}

test.describe('the events drawer (P2-E14-01)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  async function oneSession(): Promise<{ w: Page; title: string }> {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    return { w, title };
  }

  test('starts collapsed, and the grid has the column back', async () => {
    const { w } = await oneSession();

    // nothing but the tab
    await expect(drawer(w)).toHaveCount(0);
    await expect(tab(w)).toBeVisible();
    await expect(tab(w)).toHaveAttribute('aria-expanded', 'false');

    // THE MEASUREMENT. The grid used to stop 220px short of the window's right
    // edge, in every layout mode, forever. Now the only thing between them is
    // the tab, whose whole width is the price this item agreed to pay.
    const grid = await groupview(w).boundingBox();
    const tabBox = await tab(w).boundingBox();
    const viewport = w.viewportSize() ?? (await w.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })));
    expect(grid, 'no dockview group to measure').not.toBeNull();
    expect(tabBox).not.toBeNull();
    const gridRight = grid!.x + grid!.width;
    expect(
      viewport.width - gridRight,
      'the session grid still stops well short of the right edge — something is ' +
        'holding a column there, which is exactly what this item removed'
    ).toBeLessThan(tabBox!.width + 8);
  });

  test('opening it moves nothing — it overlays the grid', async () => {
    const { w } = await oneSession();
    const before = await groupview(w).boundingBox();

    await openEventsDrawer(w);
    await expect(drawer(w)).toBeVisible();

    const after = await groupview(w).boundingBox();
    // The whole reason Shape B overlays instead of pushing: a drawer that took
    // its width back from the grid would reflow every terminal in the workspace
    // each time you glanced at the queue.
    expect(
      after,
      'the grid was re-laid-out when the drawer opened — it is pushing, not ' +
        'overlaying, so every session reflows on a glance at the queue'
    ).toEqual(before);
  });

  test('the tab counts what is waiting, live, and the status bar agrees', async () => {
    const { w, title } = await oneSession();

    // cold: nothing waiting, and the bar says so rather than hiding
    await expect(tab(w)).toHaveAttribute('data-count', '0');
    await expect(statusCount(w)).toHaveAttribute('data-count', '0');

    const post = await hookPoster(a, 1);
    await post(title, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    // the count arrives on the collapsed tab — no opening required, which is
    // the point of putting it there
    await expect(tab(w)).toHaveAttribute('data-count', '1', { timeout: 20_000 });
    // ...tinted by what is waiting (§5.32: never the colour alone — the name
    // carries the same fact in words)
    await expect(tab(w)).toHaveAttribute('data-hottest', 'needs-permission');
    await expect(tab(w)).toHaveAttribute('aria-label', /1 session waiting/);

    // §5.14's status-bar attention count, built with this item and reading the
    // same queue. Two surfaces, one authority (lib/queue.ts).
    await expect(statusCount(w)).toHaveAttribute('data-count', '1', { timeout: 20_000 });
    await expect(statusCount(w)).toContainText('1 waiting');
    // ...and tinted by the SAME queue head the tab is. Two readouts of one
    // number sitting inches apart in different colours is how a set of status
    // inks stops being a vocabulary and becomes decoration.
    await expect(statusCount(w)).toHaveAttribute('data-hottest', 'needs-permission');

    // and it goes back down when the session stops waiting
    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(tab(w)).toHaveAttribute('data-count', '0', { timeout: 20_000 });
    await expect(statusCount(w)).toHaveAttribute('data-count', '0');
  });

  // THE NOTICE MARKER is asserted where each of the slot's three tenants can
  // actually be raised, rather than faked here — each of those files needs a
  // whole apparatus this one has no business rebuilding (a stub status page, a
  // staged release, a rescued popout and a synthetic display event):
  //
  //   • the incidents card  → service-health.spec.ts
  //   • the update notice   → update.spec.ts
  //   • the reconnect offer → reconnect.spec.ts
  //
  // All three now assert the same two steps: the marker appears on the shut
  // tab, and opening finds the notice itself. That is the #425 coordination
  // note's requirement — the three rehomed together — held by the three specs
  // that own them. The derivation behind the marker (including that all three
  // raise it) is unit-tested in `lib/events-drawer.test.ts`.
  test('the marker is down when no notice is up', async () => {
    const { w, title } = await oneSession();
    await expect(tab(w)).not.toHaveAttribute('data-notice', 'true');
    // ...and a queued event alone is not a notice: the count and the marker are
    // two different facts, and conflating them would make the marker useless
    const post = await hookPoster(a, 1);
    await post(title, { hook_event_name: 'Stop' });
    await expect(tab(w)).toHaveAttribute('data-count', '1', { timeout: 20_000 });
    await expect(tab(w)).not.toHaveAttribute('data-notice', 'true');
  });

  test('opens by click, and the same tab shuts it again', async () => {
    const { w } = await oneSession();
    await tab(w).click();
    await expect(drawer(w)).toBeVisible();
    await expect(tab(w)).toHaveAttribute('aria-expanded', 'true');
    await tab(w).click();
    await expect(drawer(w)).toHaveCount(0);
  });

  // §5.8: hiding chrome must never remove capability. Both keyboard routes in.
  test('opens from the hotkey, and shutting that way is not a dead end', async () => {
    const { w } = await oneSession();
    await w.keyboard.press(`${MOD}+E`);
    await expect(drawer(w)).toBeVisible();
    // opened from the keyboard, it has to be READABLE from the keyboard —
    // §5.8's invariant fails on its second half otherwise
    await expect(drawer(w)).toBeFocused();
    await w.keyboard.press(`${MOD}+E`);
    await expect(drawer(w)).toHaveCount(0);
    // ...and the chord that shut it must not unmount a focused body and leave
    // the caret on <body>, where the only way back in is Tabbing from the top
    // of the document
    await expect(tab(w)).toBeFocused();
  });

  test('opens from the command palette', async () => {
    const { w } = await oneSession();
    await palette(w, 'Show or hide the events drawer');
    await expect(drawer(w)).toBeVisible();
  });

  test('Escape closes it and hands focus back where it came from', async () => {
    const { w } = await oneSession();

    // open from the tab, so the anchor is a thing we can name
    await tab(w).focus();
    await tab(w).press('Enter');
    await expect(drawer(w)).toBeVisible();
    // focus went INTO the drawer, or a keyboard user could see it and not read it
    await expect(drawer(w)).toBeFocused();

    await w.keyboard.press('Escape');
    await expect(drawer(w)).toHaveCount(0);
    await expect(tab(w)).toBeFocused();
  });

  test('open, act on a row, close — the whole errand without a layout shift', async () => {
    const { w, title } = await oneSession();
    const post = await hookPoster(a, 1);
    await post(title, { hook_event_name: 'Stop' });
    await expect(tab(w)).toHaveAttribute('data-count', '1', { timeout: 20_000 });

    const before = await groupview(w).boundingBox();
    await openEventsDrawer(w);

    const row = drawer(w).locator('[data-event-kind]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // dismiss it — the row's own control, unchanged by the reshape
    await row.locator('.event-dismiss').click();
    await expect(drawer(w).locator('[data-event-kind]')).toHaveCount(0, { timeout: 15_000 });
    // the queue emptied, so both readouts follow
    await expect(tab(w)).toHaveAttribute('data-count', '0');
    await expect(statusCount(w)).toHaveAttribute('data-count', '0');

    await w.keyboard.press('Escape');
    await expect(drawer(w)).toHaveCount(0);
    // ...and the grid is exactly where it was before any of that
    expect(await groupview(w).boundingBox()).toEqual(before);
  });
});
