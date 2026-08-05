// P2-E9-05 — §5.8's presentation ladder and its reveal contract.
//
// P2-E15-08 proved the bottom rung (presentation.spec.ts: a hidden card keeps
// its session, comes back on the tab it left, into its slot, and survives a
// relaunch). This file is the rest of the ladder:
//
//   • the two middle rungs are REAL — collapsed gives its dock slot back and
//     leaves a row in the strip; tabbed stacks with the other tabbed cards;
//   • the item's headline: a session that is NOT in the workspace comes back
//     ON ITS OWN when it holds a permission, into its original slot;
//   • the whole ladder survives a relaunch, per rung.
//
// The permission hold is driven through the REAL hook listener, exactly as
// urgency.spec.ts and attention.spec.ts do: the test plays the CLI's part, so
// what reveals the card is the real status machine and not a mock.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  tempProjectFolder,
  hookPoster,
  gridLeafViews,
  persistedLayout,
  persistedUi,
  readWorkspaceFile,
  writeWorkspaceFile,
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
/** dockview groups that currently hold a session card */
const groups = (w: Page) => w.locator('.dv-groupview');

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

/** the rail's session titles, in rail order */
async function railTitles(w: Page): Promise<string[]> {
  const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
    title: string;
  }>;
  return cards.map((c) => c.title);
}

/**
 * Two REAL session cards in two side-by-side dockview groups.
 *
 * Every new card lands in the first grid group, so a split has to be arranged
 * rather than performed: splitting through the UI needs dockview's own
 * drag-and-drop state, which a synthetic dragstart does not produce. Rewriting
 * the persisted layout is the supported entry point split.spec.ts already uses,
 * and it is what a real user's workspace restores from anyway.
 */
async function twoGroups(): Promise<LaunchedApp> {
  const first = await launchApp({ seedFolder: tempProjectFolder() });
  await expect(tabs(first.window)).toHaveCount(1, { timeout: 25_000 });
  await addSession(first);
  await expect(tabs(first.window)).toHaveCount(2);
  await first.window.waitForTimeout(1200); // let the layout reach disk
  await first.close();

  const ws = readWorkspaceFile(first.home);
  const layout = persistedLayout(ws);
  const views = gridLeafViews(layout.grid.root.data[0]);
  expect(views.length, 'need two panels to split').toBe(2);
  const half = Math.floor(layout.grid.width / 2);
  layout.grid.root.data = [
    { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
    { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
  ];
  writeWorkspaceFile(first.home, ws);

  const a = await launchApp({ home: first.home });
  await expect(a.window.locator('.dv-groupview')).toHaveCount(2, { timeout: 25_000 });
  return a;
}

test.describe('presentation ladder (E9-05)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('collapsing gives the dock slot back and leaves a row — clicking it restores the slot', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);

    // the strip isn't there at all until something is collapsed: a band of
    // collapsed sessions with none in it is dead chrome
    await expect(strip(w)).toHaveCount(0);

    // collapse the MIDDLE one — coming back at the end would look like success
    // in a two-card test and is exactly the failure the slot record prevents
    await row(w, second).click();
    await expect(w.locator('.dv-active-tab')).toContainText(second);
    await palette(w, 'Collapse session to a strip');

    // out of the workspace, into the strip — and still running. Collapsed is a
    // rung, never a quiet close.
    await expect(tabs(w)).toHaveCount(2);
    await expect(stripRow(w, second)).toBeVisible();
    await expect(stripRows(w)).toHaveCount(1);
    await expect(row(w, second)).toBeVisible(); // still in the rail
    expect(await liveCount(w)).toBe(3);

    // one click on the row brings it back to EXACTLY the slot it left
    await stripRow(w, second).click();
    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(path.basename(folder)),
      expect.stringContaining(second),
      expect.stringContaining(third),
    ]);
    // ...and the strip empties itself out again
    await expect(strip(w)).toHaveCount(0);
    // one session per card, not two: the card remounts over a session that is
    // still running, and create() must adopt it rather than spawn a second
    expect(await liveCount(w)).toBe(3);
  });

  test('the ladder steps down and back up on the keyboard, one rung per press', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    await addSession(a); // a neighbour, so the grid doesn't empty out
    await expect(tabs(w)).toHaveCount(2);
    await row(w, title).click();

    // expanded -> collapsed
    await w.keyboard.press(`${MOD}+Shift+ArrowDown`);
    await expect(stripRow(w, title)).toBeVisible();
    await expect(tabs(w)).toHaveCount(1);

    // ...and back up, to the slot it left
    await stripRow(w, title).click();
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(title),
      expect.anything(),
    ]);

    // ...and down TWO rungs, which is the step the ladder exists for: expanded
    // -> collapsed -> tabbed. The card keeps its panel at `tabbed`, so it is
    // back in the tab strip and out of the collapsed strip.
    await row(w, title).click();
    await w.keyboard.press(`${MOD}+Shift+ArrowDown`); // -> collapsed
    await expect(stripRow(w, title)).toBeVisible();
    await stripRow(w, title).click(); // a collapsed card is not focused; click to get it back
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await w.keyboard.press(`${MOD}+Shift+ArrowDown`); // -> collapsed again
    await expect(stripRow(w, title)).toBeVisible();
  });

  test('the ▁ button in the card header collapses that session', async () => {
    // the one gesture with no keyboard or palette route of its own
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    await addSession(a);
    await expect(tabs(w)).toHaveCount(2);

    await row(w, title).click();
    await w.getByTestId('card-collapse').filter({ visible: true }).click();
    await expect(stripRow(w, title)).toBeVisible();
    await expect(tabs(w)).toHaveCount(1);
  });

  test('a ladder move never rewrites the session GROUP it belongs to', async () => {
    // dockview fires the same events for our moveTo as for a user dragging a
    // tab, and the E12-04 handler on the other end of them writes PERSISTED
    // session data. Left unguarded, tabbing a card adopted its stack-mate's
    // group and expanding it into a fresh group adopted `null` — silently
    // destroying a group the user made. Presentation must never write session
    // data, and the other ladder specs cannot see this: they give every session
    // its own folder precisely so nothing groups.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    // a second session, opened INSIDE the group (the E12-03 path)
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByTitle('New session in this group').click();
    const member = path.basename(dir);
    await expect(row(w, member)).toBeVisible({ timeout: 25_000 });

    const groupOf = async (t: string): Promise<string | null | undefined> => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        groupId?: string | null;
      }>;
      return cards.find((c) => c.title === t)?.groupId ?? null;
    };
    const before = await groupOf(member);
    expect(before, 'the fixture must actually be in a group').toBeTruthy();

    // walk it down to the stack and back up — both directions of the move
    await row(w, member).click();
    await palette(w, 'Stack session with the tabbed sessions');
    await expect(tabs(w)).toHaveCount(2);
    expect(await groupOf(member)).toBe(before);

    await palette(w, 'Expand session to its full card');
    await expect(tabs(w)).toHaveCount(2);
    expect(await groupOf(member)).toBe(before);

    // and the ungrouped neighbour is still ungrouped: the guard must not have
    // simply frozen every adoption
    expect(await groupOf(title)).toBeNull();
  });

  test('tabbed sessions stack into ONE dockview group, and expand back out', async () => {
    // Two cards SIDE BY SIDE, which is the only arrangement in which this rung
    // is observable: new cards all land in one group, so "they ended up
    // stacked" has to start from them not being. Splitting through the UI needs
    // dockview's own drag-and-drop state, so this rewrites the persisted layout
    // — the same supported entry point split.spec.ts uses, and what a real
    // user's workspace restores from anyway.
    a = await twoGroups();
    const w = a.window;
    await expect(groups(w)).toHaveCount(2);
    const [first, second] = await railTitles(w);

    // stack them: the second card has to MOVE out of its own group into the
    // first one's, which is the whole transition
    await row(w, first).click();
    await palette(w, 'Stack session with the tabbed sessions');
    await row(w, second).click();
    await palette(w, 'Stack session with the tabbed sessions');

    // both are still panels — tabbed KEEPS the card, unlike collapsed and
    // hidden — but together they now cost one slot instead of two
    await expect(tabs(w)).toHaveCount(2);
    await expect(groups(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(strip(w)).toHaveCount(0); // tabbed is not a strip row
    // a restored card resumes lazily when it first becomes visible, so this
    // polls rather than reading once — the point is that the MOVE cost nothing
    await expect.poll(() => liveCount(w), { timeout: 25_000 }).toBe(2);

    // expanding takes a tabbed card back OUT of the stack: a rung with no way
    // back up would not be a rung on a ladder
    await row(w, second).click();
    await palette(w, 'Expand session to its full card');
    await expect(groups(w)).toHaveCount(2, { timeout: 15_000 });
    await expect(tabs(w)).toHaveCount(2);
    await expect.poll(() => liveCount(w), { timeout: 25_000 }).toBe(2);
  });

  test('a session that is NOT in the workspace reveals itself on a permission hold', async () => {
    // The item's headline, and §5.8 verbatim: "Reveal triggers: needs-attention
    // (permission / input / done) or user click anywhere."
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);

    const post = await hookPoster(a, 3);

    // hide the MIDDLE card: the slot it has to come back to is between two
    // neighbours, so landing at the end would be visibly wrong
    await row(w, second).click();
    await expect(w.locator('.dv-active-tab')).toContainText(second);
    await palette(w, 'Hide session (keeps it running)');
    await expect(tabs(w)).toHaveCount(2);
    // hidden means hidden: no card AND no collapsed row, only the rail, the
    // lamp and the events list
    await expect(strip(w)).toHaveCount(0);

    // stand somewhere else, so a reveal that stole focus would be obvious
    await row(w, third).click();
    await expect(w.locator('.dv-active-tab')).toContainText(third);

    // now the hidden session blocks on a permission — nobody clicked anything
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    // it comes back on its own, INTO ITS ORIGINAL SLOT
    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(first),
      expect.stringContaining(second),
      expect.stringContaining(third),
    ]);
    // ...without stealing the screen. Showing and focusing are two questions in
    // §5.8, and the second one is E9-10's — a blocked session must not yank the
    // cursor out of the card you are working in.
    await expect(w.locator('.dv-active-tab')).toContainText(third);
    expect(await liveCount(w)).toBe(3);
  });

  test('a collapsed session reveals on a permission hold too, out of the strip', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(w)).toHaveCount(2);
    const post = await hookPoster(a, 2);

    await row(w, second).click();
    await palette(w, 'Collapse session to a strip');
    await expect(stripRow(w, second)).toBeVisible();
    await expect(tabs(w)).toHaveCount(1);

    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    // and it leaves the strip behind — a session cannot be a card AND a row
    await expect(strip(w)).toHaveCount(0);
  });

  test('every rung survives a relaunch (§5.25, the ui blob)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const expanded = path.basename(folder);
    await expect(tabs(a.window)).toHaveCount(1, { timeout: 25_000 });
    const collapsed = await addSession(a);
    const hidden = await addSession(a);
    await expect(tabs(a.window)).toHaveCount(3);

    const tabbed = await addSession(a);
    await expect(tabs(a.window)).toHaveCount(4);

    await row(a.window, tabbed).click();
    await palette(a.window, 'Stack session with the tabbed sessions');
    await row(a.window, collapsed).click();
    await palette(a.window, 'Collapse session to a strip');
    await expect(stripRow(a.window, collapsed)).toBeVisible();
    await row(a.window, hidden).click();
    await palette(a.window, 'Hide session (keeps it running)');
    await expect(tabs(a.window)).toHaveCount(2);

    const home = a.home;
    await a.close();
    a = await launchApp({ home });
    const w = a.window;

    // the workspace comes back exactly as it was left: two cards in the grid
    // (one expanded, one tabbed), one row in the strip, one session that is
    // only in the rail
    await expect(row(w, expanded)).toBeVisible({ timeout: 25_000 });
    await expect(rail(w).locator('[draggable="true"]')).toHaveCount(4);
    await expect(tabs(w)).toHaveCount(2);
    await expect(stripRows(w)).toHaveCount(1);
    await expect(stripRow(w, collapsed)).toBeVisible();

    // The rung of each card, straight out of the ui blob on disk — which is
    // where the item's done-when says it lives. `tabbed` in particular is the
    // rung whose persistence is least obvious: nothing of ours records WHICH
    // dockview group is the stack, so this asserts that the group's own
    // round-trip through the layout JSON is enough to find it again.
    const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      cardId: string;
    }>;
    const idOf = (t: string): string => cards.find((c) => c.title === t)!.cardId;
    const ui = persistedUi(readWorkspaceFile(home));
    const pres = ui.presentation ?? {};
    expect(pres[idOf(tabbed)]?.ladder).toBe('tabbed');
    expect(pres[idOf(collapsed)]?.ladder).toBe('collapsed');
    expect(pres[idOf(hidden)]?.ladder).toBe('hidden');
    // an expanded card is the DEFAULT and is omitted from the blob entirely —
    // an untouched workspace must not accrete a record per card it ever opened
    expect(pres[idOf(expanded)]?.ladder).toBeUndefined();

    // and everything is still one click from coming back
    await stripRow(w, collapsed).click();
    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    await expect(strip(w)).toHaveCount(0);
    await row(w, hidden).click();
    await expect(tabs(w)).toHaveCount(4, { timeout: 25_000 });
  });
});
