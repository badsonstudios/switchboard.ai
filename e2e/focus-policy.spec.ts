// P2-E9-10 — §5.8's focus-stealing policy (i3 `focus_on_window_activation`).
//
// The four modes govern one thing: what a session that finishes or needs a
// human is allowed to do to the screen you are looking at. The rules themselves
// are pure and unit-tested (lib/focus-policy, lib/ladder); this file proves the
// wiring against the REAL status machine — the hook listener, dockview's own
// idea of what is on screen, and the ui blob on disk.
//
// The done-when, in the item's own words:
//   • under `urgent` nothing ever steals focus (lamp only);
//   • under `smart` a visible card focuses while a hidden one only marks urgent;
//   • the setting persists.
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
  openEventsDrawer,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const groups = (w: Page) => w.locator('.dv-groupview');
const lamp = (w: Page, title: string) =>
  w.getByTestId('urgency-strip').locator(`[data-urgency-lamp][title^="${title}"]`);
const eventRows = (w: Page) => w.locator('[data-event-kind]');
const nextUp = (w: Page) => w.locator('[data-event-kind][data-next="true"]');

/** The session the workspace is FOCUSED on — the rail marks its row current,
 *  from dockview's own active panel, so this is the app's answer not the
 *  test's. Same handle `a11y-keyboard.spec.ts` reads. */
const focused = (w: Page) => rail(w).locator('[data-rail-open][aria-current="true"]');

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

/** the rail's session titles, in rail order */
async function railTitles(w: Page): Promise<string[]> {
  const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
    title: string;
  }>;
  return cards.map((c) => c.title);
}

/** Set ONE session's focus-stealing override from the rail's context menu. */
async function setSessionFocusPolicy(w: Page, title: string, value: string): Promise<void> {
  await row(w, title).click({ button: 'right' });
  await w.locator(`[data-focus-item="${value}"]`).click();
}

/**
 * Two REAL session cards in two side-by-side dockview groups — the only
 * arrangement in which "its card is visible" and "its card exists" differ, and
 * therefore the only one in which `smart` can be told from `urgent` at all.
 *
 * Arranged by rewriting the persisted layout rather than performed, for the
 * reason ladder.spec.ts gives: splitting through the UI needs dockview's own
 * drag-and-drop state, which a synthetic dragstart does not produce.
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

test.describe('focus-stealing policy (E9-10)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('smart: a card you can SEE takes focus; one behind a tab does not', async () => {
    // The done-when's first half, and the distinction the whole default turns
    // on. "Visible" is dockview's answer, not a rung — by default every card
    // lands in ONE group, so a rung test would call three stacked sessions
    // visible when two of them show nothing but a tab label, and the default
    // mode would flip the tab out from under whatever you were typing in.
    a = await twoGroups();
    const w = a.window;
    await expect(groups(w)).toHaveCount(2);
    const [first, second] = await railTitles(w);
    const post = await hookPoster(a, 2);

    // stand in the first card; the second is beside it, on screen
    await row(w, first).click();
    await expect(focused(w)).toHaveText(new RegExp(first));

    // it finishes. Both cards are on screen, so `smart` jumps.
    await post(second, { hook_event_name: 'Stop' });
    await expect(focused(w)).toHaveText(new RegExp(second), { timeout: 20_000 });

    // Now a THIRD session, which lands in the first group and pushes `first`
    // behind a tab — a card that still has a panel but shows nothing.
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    await expect(focused(w)).toHaveText(new RegExp(third), { timeout: 20_000 });

    // the hidden-behind-a-tab session finishes: the lamp says so and NOTHING
    // else moves. This is the case the naive rung test gets wrong.
    await post(first, { hook_event_name: 'Stop' });
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'true', { timeout: 20_000 });
    await expect(focused(w)).toHaveText(new RegExp(third));
    await expect(tabs(w)).toHaveCount(3); // and no card was rearranged
  });

  test('urgent: nothing ever steals focus (lamp only) — and `focus` always does', async () => {
    // The done-when's headline, and its opposite in the same launch, so the two
    // are proved against the same workspace rather than two similar ones.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(w)).toHaveCount(2);
    const post = await hookPoster(a, 2);

    await palette(w, 'When any session needs you: never jump, just light its lamp');

    // take the second session out of the workspace entirely, then stand in the
    // first: anything that moved would be unmistakable
    await row(w, second).click();
    await palette(w, 'Hide session (keeps it running)');
    await expect(tabs(w)).toHaveCount(1);
    await row(w, first).click();
    await expect(focused(w)).toHaveText(new RegExp(first));

    // it blocks on a permission. Under `urgent` the lamp is the WHOLE response:
    // no focus, and the workspace is not rearranged either — E9-05's reveal is
    // itself a rearrangement, and "never steal" cannot coexist with it.
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'true', { timeout: 20_000 });
    await expect(tabs(w)).toHaveCount(1);
    await expect(focused(w)).toHaveText(new RegExp(first));

    // ...and at the other end of the ladder, `focus` brings a session that is
    // not even in the workspace all the way back, and hands it the cursor.
    await palette(w, 'When any session needs you: always jump to it');
    await post(second, { hook_event_name: 'UserPromptSubmit' }); // answer the hold
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'false', { timeout: 20_000 });
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(tabs(w)).toHaveCount(2, { timeout: 20_000 });
    await expect(focused(w)).toHaveText(new RegExp(second));
  });

  test('a per-session `none` override stays silent, and survives a relaunch', async () => {
    // §5.8 names `none` without glossing it; i3's own manual is the reference
    // the bullet cites, and there `none` means the request is ignored — neither
    // focused nor marked urgent. Here that is: nothing moves, and the session
    // does not join the attention queue. It is still in the LOG, because §5.12
    // draws that line and a silenced session must not become an invisible one.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(w)).toHaveCount(2);
    const post = await hookPoster(a, 2);

    await setSessionFocusPolicy(w, second, 'none');
    await row(w, first).click();
    await expect(focused(w)).toHaveText(new RegExp(first));

    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    // the event lands — the log still has it, and so does the rail. The drawer
    // is collapsed by default (P2-E14-01), and this test reads BOTH a presence
    // and an absence off its rows, so it has to be open for either to mean
    // anything.
    await openEventsDrawer(w);
    await expect(eventRows(w)).toHaveCount(1, { timeout: 20_000 });
    // ...but nothing is next up, so Ctrl+Space has nowhere to go and the count
    // that enables it is zero
    await expect(nextUp(w)).toHaveCount(0);
    await expect(focused(w)).toHaveText(new RegExp(first));

    // the OTHER session is not silenced, and proves the filter is per session
    await post(first, { hook_event_name: 'Stop' });
    await expect(nextUp(w)).toHaveCount(1, { timeout: 20_000 });

    // and the choice is in the blob, and comes back saying the same thing
    const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      cardId: string;
    }>;
    const cardId = cards.find((c) => c.title === second)!.cardId;
    const home = a.home;
    await a.close();
    const ui = persistedUi(readWorkspaceFile(home));
    expect(ui.focusPolicy?.cards?.[cardId]).toBe('none');
    // the global was never touched, so it writes nothing at all: an untouched
    // setting must not accrete a record
    expect(ui.focusPolicy?.global).toBeUndefined();

    a = await launchApp({ home });
    await expect(row(a.window, second)).toBeVisible({ timeout: 25_000 });
    await row(a.window, second).click({ button: 'right' });
    await expect(a.window.locator('[data-focus-item="none"]')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
