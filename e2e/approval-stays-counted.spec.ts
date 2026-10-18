// A held approval, and an open question, are counted for as long as they are
// held (#1258).
//
// The owner, twice in a few minutes: "I don't see any notifications up
// anywhere, like '1 needs you' … Just now I needed to do an allow, and a major
// allow, but no notification showed up that it was waiting on me."
//
// His log has it to the second. The approval was held for 35 seconds, and for
// all but the first instant of them the session said "working": the CLI went on
// streaming the rest of its message, the next frame walked the status back,
// the Events list dropped the row, and every "N need you" readout counts from
// that list. 13 of 46 held approvals went that way.
//
// EVERY EARLIER TEST OF THIS WAS GREEN, because the fake CLI's `!perm` asks and
// then says nothing. The stimulus here is `!permstream` / `!askstream`, which
// ask and KEEP STREAMING, every 250 ms, until they are answered (for ten
// seconds at most; nothing below waits that long before answering). So "it is
// still there three seconds later" is a claim about a dozen frames that each
// used to erase it.
//
// Real app, both placements, because the claim is about what is on screen: the
// list's total, the group's own line, the row, the strip's chip, the group's
// entry and the pill.
import { test, expect, Locator, Page } from '@playwright/test';
import path from 'path';
import {
  answerHeldPermissions,
  gridLeafViews,
  hookPoster,
  launchApp,
  LaunchedApp,
  openEventsDrawer,
  persistedLayout,
  readWorkspaceFile,
  rungOf,
  sessionStatuses,
  setPresentationPolicy,
  streamingPermissionHolder,
  streamingQuestionHolder,
  tempProjectFolder,
  writeWorkspaceFile,
} from './fixtures/app';

const row = (w: Page, title: string) => w.locator('nav .rail-row').filter({ hasText: title });
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const railNeed = (w: Page) => w.locator('nav [data-rail-need]');
const strip = (w: Page) => w.getByTestId('sessions-strip');
const stripNeed = (w: Page) => strip(w).locator('[data-strip-need]');
const pill = (w: Page, title: string) =>
  strip(w)
    .locator('[data-strip-pill]')
    .filter({ has: w.locator('[data-strip-pill-title]', { hasText: title }) });
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);
const panes = (w: Page) => w.locator('.dv-groupview');
/** what a held request puts on its card: the approval bar, or the question */
const bar = (w: Page, kind: 'approval' | 'question') =>
  kind === 'approval' ? w.getByText('Allow Write?') : w.getByTestId('question-panel');

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

/**
 * `check` holds, and KEEPS holding, for `ms`.
 *
 * The whole subject. The count used to be right for one frame and wrong from
 * the next, so "it appeared" proves nothing; the fake streams four frames a
 * second and this looks after each of them.
 */
async function staysFor(w: Page, ms: number, check: () => Promise<void>): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await check();
    await w.waitForTimeout(200);
  }
  await check();
}

/**
 * Two sessions in two panes SIDE BY SIDE, which is how the owner works and not
 * how a test session starts: every new card lands as a tab in the first pane.
 * Arranged through the saved layout, as ladder.spec does and for its reason:
 * a split through the UI needs dockview's own drag state.
 */
async function sideBySide(): Promise<{ a: LaunchedApp; left: string; right: string }> {
  const folder = tempProjectFolder();
  const first = await launchApp({ seedFolder: folder });
  await expect(tabs(first.window)).toHaveCount(1, { timeout: 25_000 });
  const right = await addSession(first);
  await expect(tabs(first.window)).toHaveCount(2);
  // the layout is written on a delay: wait for the file to hold both cards
  await expect
    .poll(
      () => {
        try {
          const root = persistedLayout(readWorkspaceFile(first.home)).grid.root.data[0];
          return gridLeafViews(root).length;
        } catch {
          return 0; // not written yet, or caught mid-write
        }
      },
      { timeout: 20_000 }
    )
    .toBe(2);
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
  await expect(panes(a.window)).toHaveCount(2, { timeout: 25_000 });
  return { a, left: path.basename(folder), right };
}

for (const kind of ['approval', 'question'] as const) {
  test.describe(`a held ${kind} stays counted while the CLI keeps streaming (#1258)`, () => {
    let a: LaunchedApp;
    test.afterEach(async () => a?.cleanup());

    test(`"N need you" in the list and on the strip, on the group and on the pill`, async () => {
      test.setTimeout(150_000);
      const folder = tempProjectFolder();
      a = await launchApp({ seedFolder: folder });
      const w = a.window;
      const grouped = path.basename(folder);
      await expect(row(w, grouped)).toBeVisible({ timeout: 25_000 });
      const loose = await addSession(a);
      const here = await addSession(a);
      await expect(tabs(w)).toHaveCount(3);

      // one of the two that will ask is in a GROUP, so the group's own count
      // has something to say; the other is loose, so it is a pill on the strip
      await w.getByTitle('Create a persistent group').click();
      await expect(w.getByText('New group')).toBeVisible();
      await row(w, grouped).click({ button: 'right' });
      await w.getByRole('menuitemradio', { name: 'New group' }).click();
      // (the loose sessions sit in a card of their own, so name the group's)
      await expect(
        w.locator('[data-group-card]').filter({ hasText: 'New group' }).locator('.rail-row')
      ).toHaveCount(1);

      // stand on the third: nothing below is about the session in front
      await row(w, here).click();
      await expect(w.locator('.dv-active-tab')).toContainText(here);
      await expect(railNeed(w)).toHaveCount(0);

      const hold = kind === 'approval' ? streamingPermissionHolder(a) : streamingQuestionHolder(a);
      await hold(grouped);
      await hold(loose);

      // ── the list on the left ──────────────────────────────────────────────
      const leftSaysTwo = async (): Promise<void> => {
        await expect(railNeed(w)).toHaveAttribute('data-rail-need', '2', { timeout: 20_000 });
        await expect(railNeed(w)).toHaveText('2 need you');
        await expect(row(w, grouped)).toHaveAttribute('data-needs-you', 'true');
        await expect(row(w, loose)).toHaveAttribute('data-needs-you', 'true');
        // the group's own line
        await expect(w.locator('[data-group-card]').filter({ hasText: 'New group' })).toContainText(
          '1 need you'
        );
      };
      await leftSaysTwo();
      // …and STILL, a dozen frames later. This is the assertion that failed.
      await staysFor(w, 3000, leftSaysTwo);

      // the session's own word agrees with the count: it is waiting, not working
      const statuses = await sessionStatuses(a);
      expect(statuses.get(grouped)).toBe('needs-permission');
      expect(statuses.get(loose)).toBe('needs-permission');
      expect(statuses.get(here)).not.toBe('needs-permission');

      // the Events list is what every count reads: two rows, both demands
      await openEventsDrawer(w);
      await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(2);
      await w.getByTestId('events-tab').click();
      await expect(w.getByTestId('events-drawer')).toHaveCount(0);

      // ── the strip across the top ──────────────────────────────────────────
      await w.locator('[data-placement="top"]').click();
      await expect(strip(w)).toBeVisible();
      const topSaysTwo = async (): Promise<void> => {
        await expect(stripNeed(w)).toHaveText('2 need you', { timeout: 20_000 });
        // the group's entry carries its one; the loose session is a lit pill
        await expect(strip(w).locator('[data-strip-group]')).toHaveAttribute(
          'data-strip-item-need',
          '1'
        );
        await expect(pill(w, loose)).toHaveAttribute('data-needs-you', 'true');
        await expect(pill(w, here)).toHaveAttribute('data-needs-you', 'false');
      };
      await topSaysTwo();
      await staysFor(w, 2000, topSaysTwo);
      // not counted as finished work, in either number
      await expect(strip(w).locator('[data-strip-finished]')).toHaveCount(0);

      // ── answered: gone, in both ───────────────────────────────────────────
      expect(await answerHeldPermissions(a, 'deny')).toBe(2);
      await expect(stripNeed(w)).toHaveCount(0, { timeout: 20_000 });
      await w.locator('[data-placement="left"]').click();
      await expect(railNeed(w)).toHaveCount(0);
      await expect(row(w, grouped)).toHaveAttribute('data-needs-you', 'false');

      // THE POSITIVE CONTROL: the stream really did go on while it was held.
      // Without this, a fake that had stopped streaming would leave every
      // assertion above true of the old, broken build too.
      await row(w, grouped).click();
      await expect(w.locator('.dv-active-tab')).toContainText(grouped);
      await expect(w.getByText('STREAMING-ON 8', { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    test('a card that was collapsed on submit comes back to its slot, and takes focus from nobody', async () => {
      test.setTimeout(150_000);
      const folder = tempProjectFolder();
      a = await launchApp({ seedFolder: folder });
      const w = a.window;
      const first = path.basename(folder);
      await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
      const second = await addSession(a);
      const third = await addSession(a);
      await expect(tabs(w)).toHaveCount(3);

      await setPresentationPolicy(w, 'Collapse on submit');
      await row(w, second).click();
      await expect(w.locator('.dv-active-tab')).toContainText(second);
      await composer(w).click();
      await composer(w).fill('!hang');
      await w.keyboard.press('Enter');
      await expect(tabs(w)).toHaveCount(2, { timeout: 15_000 });
      await expect.poll(() => rungOf(w, second)).toBe('collapsed');

      // stand somewhere else, so a reveal that stole the screen would show
      await row(w, third).click();
      await expect(w.locator('.dv-active-tab')).toContainText(third);

      const hold = kind === 'approval' ? streamingPermissionHolder(a) : streamingQuestionHolder(a);
      await hold(second);

      // back, in the slot it left, and it stays back while the stream goes on
      const back = async (): Promise<void> => {
        await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
        expect(await tabs(w).allInnerTexts()).toEqual([
          expect.stringContaining(first),
          expect.stringContaining(second),
          expect.stringContaining(third),
        ]);
        await expect(w.locator('.dv-active-tab')).toContainText(third);
        await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1');
      };
      await back();
      await staysFor(w, 2000, back);
      expect(await rungOf(w, second)).toBe('expanded');

      expect(await answerHeldPermissions(a, 'deny')).toBe(1);
      await expect(railNeed(w)).toHaveCount(0, { timeout: 20_000 });
    });
    test('from a pane of its own, it comes back in a pane of its own, with what it asked showing', async () => {
      test.setTimeout(180_000);
      const made = await sideBySide();
      a = made.a;
      const w = a.window;
      const { left, right } = made;

      await setPresentationPolicy(w, 'Collapse on submit');
      await row(w, left).click();
      await expect(composer(w).first()).toBeVisible();
      // its own composer: the one in the pane whose tab is this session
      const paneOf = (title: string) => panes(w).filter({ has: w.locator('.dv-tab', { hasText: title }) });
      await paneOf(left).getByPlaceholder(/Prompt this session/).click();
      await paneOf(left).getByPlaceholder(/Prompt this session/).fill('!hang');
      await w.keyboard.press('Enter');
      // alone in its pane, so the pane goes with it
      await expect(panes(w)).toHaveCount(1, { timeout: 15_000 });
      await expect.poll(() => rungOf(w, left)).toBe('collapsed');

      // be in the middle of typing somewhere else
      const draft = paneOf(right).getByPlaceholder(/Prompt this session/);
      await draft.click();
      await draft.fill('half a sentence');
      await expect(draft).toBeFocused();

      const hold = kind === 'approval' ? streamingPermissionHolder(a) : streamingQuestionHolder(a);
      await hold(left);

      const back = async (): Promise<void> => {
        // a pane again, not a tab behind the card being typed in...
        await expect(panes(w)).toHaveCount(2, { timeout: 25_000 });
        await expect(paneOf(right).locator('.dv-tab')).toHaveCount(1);
        // ...and it is still the pane IN FRONT: the selected row, the card the
        // keyboard commands act on. A new pane makes itself that by default.
        await expect(paneOf(right)).toHaveClass(/dv-active-group/);
        await expect(paneOf(left)).not.toHaveClass(/dv-active-group/);
        // ...with the thing it came back to show ON SCREEN
        await expect(bar(w, kind)).toBeVisible({ timeout: 15_000 });
        await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1');
        // ...and the cursor exactly where it was
        await expect(draft).toBeFocused();
        await expect(draft).toHaveValue('half a sentence');
      };
      await back();
      await staysFor(w, 2000, back);

      expect(await answerHeldPermissions(a, 'deny')).toBe(1);
      await expect(railNeed(w)).toHaveCount(0, { timeout: 20_000 });
    });

    test('the only card there is comes back showing, not as a tab over a blank pane', async () => {
      test.setTimeout(120_000);
      const folder = tempProjectFolder();
      a = await launchApp({ seedFolder: folder });
      const w = a.window;
      const only = path.basename(folder);
      await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });

      await setPresentationPolicy(w, 'Collapse on submit');
      await composer(w).click();
      await composer(w).fill('!hang');
      await w.keyboard.press('Enter');
      await expect(tabs(w)).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => rungOf(w, only)).toBe('collapsed');

      const hold = kind === 'approval' ? streamingPermissionHolder(a) : streamingQuestionHolder(a);
      await hold(only);

      await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
      // measured before the fix: the tab came back and this did not
      await expect(bar(w, kind)).toBeVisible({ timeout: 15_000 });
      await staysFor(w, 1500, async () => {
        await expect(bar(w, kind)).toBeVisible();
        await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1');
      });
      expect(await answerHeldPermissions(a, 'deny')).toBe(1);
    });

    test('the prompt that collapses the card is the one that asks: it is not left collapsed', async () => {
      test.setTimeout(120_000);
      const folder = tempProjectFolder();
      a = await launchApp({ seedFolder: folder });
      const w = a.window;
      await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
      const second = await addSession(a);
      await addSession(a);
      await expect(tabs(w)).toHaveCount(3);

      await setPresentationPolicy(w, 'Collapse on submit');
      await row(w, second).click();
      await expect(w.locator('.dv-active-tab')).toContainText(second);
      await composer(w).click();
      await composer(w).fill(kind === 'approval' ? '!permstream x.sh' : '!askstream');
      await w.keyboard.press('Enter');

      // Either it never left, or it left and came back. What it may not be is
      // gone with a request on it: measured at one run in three before the fix.
      await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1', { timeout: 20_000 });
      await staysFor(w, 2500, async () => {
        await expect(tabs(w)).toHaveCount(3, { timeout: 10_000 });
        expect(await rungOf(w, second)).toBe('expanded');
        await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1');
      });
      expect(await answerHeldPermissions(a, 'deny')).toBe(1);
    });
  });
}

test.describe('finished work is its own number, in both placements (#1258)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('"N finished" is not drawn as a demand, in the list or on the strip', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    await addSession(a);
    await expect(tabs(w)).toHaveCount(2);
    const post = await hookPoster(a, 2);

    // we stand on the second; the first finishes behind us
    await post(first, { hook_event_name: 'Stop' });
    await expect(w.locator('nav [data-rail-finished]')).toHaveText('1 finished', {
      timeout: 20_000,
    });
    await expect(railNeed(w)).toHaveCount(0);
    await expect(row(w, first)).toHaveAttribute('data-finished', 'true');
    await expect(row(w, first)).toHaveAttribute('data-needs-you', 'false');

    await w.locator('[data-placement="top"]').click();
    await expect(strip(w).locator('[data-strip-finished]')).toHaveText('1 finished');
    await expect(stripNeed(w)).toHaveCount(0);
    await expect(pill(w, first)).toHaveAttribute('data-finished', 'true');
    await expect(pill(w, first)).toHaveAttribute('data-needs-you', 'false');
    // and it stands for no demand where the strip adds its pills up
    await expect(pill(w, first)).toHaveAttribute('data-strip-item-need', '0');
  });

  // The owner, a day after the first report: "the Needs Attention pill that
  // shows there should say how many need attention. It should not be replaced
  // by a Done one. Anything done or green should be in a separate pill to the
  // right of it … they shouldn't replace each other."
  test('the two numbers are two pills, side by side, and neither takes the place of the other', async () => {
    test.setTimeout(150_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const asks = path.basename(folder);
    await expect(row(w, asks)).toBeVisible({ timeout: 25_000 });
    const finishes = await addSession(a);
    const here = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);
    const post = await hookPoster(a, 3);
    await row(w, here).click();
    await expect(w.locator('.dv-active-tab')).toContainText(here);

    await streamingQuestionHolder(a)(asks);
    await post(finishes, { hook_event_name: 'Stop' });

    /** `need` is drawn, `finished` is drawn, and need is the one on the left */
    const sideBySideIn = async (need: Locator, finished: Locator): Promise<void> => {
      await expect(need).toBeVisible({ timeout: 20_000 });
      await expect(finished).toBeVisible({ timeout: 20_000 });
      // FIRST in reading order, always; and to the LEFT whenever the two are on
      // one line (a narrow list with wide fonts may wrap the second under it)
      const follows = await need.evaluate(
        (n, f) => (n.compareDocumentPosition(f!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        await finished.elementHandle()
      );
      expect(follows, 'need-you comes before finished').toBe(true);
      const n = (await need.boundingBox())!;
      const f = (await finished.boundingBox())!;
      if (Math.abs(n.y - f.y) < n.height / 2) expect(n.x + n.width).toBeLessThanOrEqual(f.x + 1);
    };

    // the list on the left
    const railFinished = w.locator('nav [data-rail-finished]');
    const left = async (): Promise<void> => {
      await sideBySideIn(railNeed(w), railFinished);
      await expect(railNeed(w)).toHaveText('1 need you');
      await expect(railFinished).toHaveText('1 finished');
    };
    await left();
    await staysFor(w, 2500, left);

    // the strip across the top
    await w.locator('[data-placement="top"]').click();
    const stripFinished = strip(w).locator('[data-strip-finished]');
    const top = async (): Promise<void> => {
      await sideBySideIn(stripNeed(w), stripFinished);
      await expect(stripNeed(w)).toHaveText('1 needs you');
      await expect(stripFinished).toHaveText('1 finished');
    };
    await top();
    await staysFor(w, 2500, top);

    // answering the question takes ITS pill away and leaves the other alone
    expect(await answerHeldPermissions(a, 'deny')).toBe(1);
    await expect(stripNeed(w)).toHaveCount(0, { timeout: 20_000 });
    // (two now: a refused question ends that session's turn, so it finished too)
    await expect(stripFinished).toHaveText('2 finished');
  });

  // The other half of the same report: "one of my other sessions that was
  // running popped up with a green one … it only showed for a fraction of a
  // second, then disappeared again." Measured before the fix, in exactly this
  // arrangement: on screen for under 150 ms. The session that finished makes
  // itself the pane in front (the default: "jump if its card is on screen"),
  // and that was read as the owner having gone to look at it.
  test('a session that finishes in the pane BESIDE yours stays "finished" until you look', async () => {
    test.setTimeout(180_000);
    const made = await sideBySide();
    a = made.a;
    const w = a.window;
    const { left, right } = made;
    await expect(row(w, left)).toBeVisible({ timeout: 25_000 });
    const paneOf = (title: string) => panes(w).filter({ has: w.locator('.dv-tab', { hasText: title }) });
    const draft = paneOf(right).getByPlaceholder(/Prompt this session/);
    // resolved BEFORE the typing: the old build cleared the count only for
    // somebody who had used the window in the last two seconds, so anything
    // slow between the keystrokes and the Stop would let it pass by accident
    const post = await hookPoster(a, 2);
    await draft.click();
    await draft.pressSequentially('in the middle of something');

    await post(left, { hook_event_name: 'Stop' });

    const railFinished = w.locator('nav [data-rail-finished]');
    const counted = async (): Promise<void> => {
      await expect(railFinished).toHaveText('1 finished', { timeout: 20_000 });
      await expect(row(w, left)).toHaveAttribute('data-finished', 'true');
    };
    await counted();
    // typing on, as he was: being busy in the window is not looking at it
    await draft.pressSequentially(' and still typing');
    await staysFor(w, 3000, counted);

    // LOOKING at it is what clears it: a click inside that card
    await paneOf(left).getByPlaceholder(/Prompt this session/).click();
    await expect(railFinished).toHaveCount(0, { timeout: 15_000 });
  });

  // Found in review. A collapsed session that FINISHES comes back in a pane of
  // its own, and a new pane makes itself the one in front unless told not to:
  // the session nobody went to was then "the card in front", and its finished
  // count was cleared in the same frame, by the other road.
  test('a collapsed session that finishes comes back counted, and the pane you are in stays in front', async () => {
    test.setTimeout(180_000);
    const made = await sideBySide();
    a = made.a;
    const w = a.window;
    const { left, right } = made;
    await expect(row(w, left)).toBeVisible({ timeout: 25_000 });
    const paneOf = (title: string) => panes(w).filter({ has: w.locator('.dv-tab', { hasText: title }) });
    const post = await hookPoster(a, 2);

    await setPresentationPolicy(w, 'Collapse on submit');
    await paneOf(left).getByPlaceholder(/Prompt this session/).click();
    await paneOf(left).getByPlaceholder(/Prompt this session/).fill('!hang');
    await w.keyboard.press('Enter');
    await expect(panes(w)).toHaveCount(1, { timeout: 15_000 });

    const draft = paneOf(right).getByPlaceholder(/Prompt this session/);
    await draft.click();
    await draft.pressSequentially('busy here');
    await post(left, { hook_event_name: 'Stop' });

    const railFinished = w.locator('nav [data-rail-finished]');
    const back = async (): Promise<void> => {
      await expect(panes(w)).toHaveCount(2, { timeout: 25_000 });
      await expect(railFinished).toHaveText('1 finished', { timeout: 20_000 });
      await expect(paneOf(right)).toHaveClass(/dv-active-group/);
      await expect(draft).toBeFocused();
    };
    await back();
    await staysFor(w, 2500, back);
  });
});

// #1268 — Stop with a request still held. MEASURED on the PATH CLI (2.1.288,
// `spike/findings/1268-held-request-on-interrupt.md`): an interrupt makes the
// CLI take the held request back (`control_cancel_request`) before it ends the
// turn, and the fake now does exactly that. Before, it dropped the request
// silently, so nothing could show the bar closing and the count going down.
//
// THROUGH THE BRIDGE, NOT THE BUTTON, and on purpose: the Stop button renders
// only while a card is `working`, and a held request pins it at
// `needs-permission` (#1258), so there is no button to press. The call is the
// one the button makes (`sessions.interrupt`), so main, the provider, the fake
// and everything after are the real path.
for (const kind of ['approval', 'question'] as const) {
  test.describe(`Stop with a ${kind} held closes it and stops counting it (#1268)`, () => {
    let a: LaunchedApp;
    test.afterEach(async () => a?.cleanup());

    test('the bar goes, "need you" goes back to none, and the turn is over', async () => {
      test.setTimeout(120_000);
      const folder = tempProjectFolder();
      a = await launchApp({ seedFolder: folder });
      const w = a.window;
      const only = path.basename(folder);
      await expect(row(w, only)).toBeVisible({ timeout: 25_000 });

      const hold = kind === 'approval' ? streamingPermissionHolder(a) : streamingQuestionHolder(a);
      await hold(only);
      await expect(bar(w, kind)).toBeVisible({ timeout: 20_000 });
      await expect(railNeed(w)).toHaveAttribute('data-rail-need', '1', { timeout: 20_000 });

      const held = (await w.evaluate(() => window.switchboard.sessions.pendingPermissions())) as Array<{
        sessionId: string;
      }>;
      expect(held).toHaveLength(1);
      expect(await w.evaluate((id) => window.switchboard.sessions.interrupt(id), held[0].sessionId)).toBe(true);

      // the interrupt really reached the CLI and ended the turn (the fake's own
      // marker) — without this, a build that never sent it would pass below
      await expect(w.getByText('INTERRUPTED', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(bar(w, kind)).toHaveCount(0, { timeout: 15_000 });
      await expect(railNeed(w)).toHaveCount(0, { timeout: 15_000 });
      await expect(row(w, only)).toHaveAttribute('data-needs-you', 'false');
      expect(await w.evaluate(() => window.switchboard.sessions.pendingPermissions())).toEqual([]);
      expect((await sessionStatuses(a)).get(only)).toBe('done');
      // and nothing late puts it back (a light check: once the request is
      // gone the fake stops streaming, so this guards a re-raise, not the stream)
      await staysFor(w, 1500, async () => {
        await expect(bar(w, kind)).toHaveCount(0);
        await expect(railNeed(w)).toHaveCount(0);
      });
    });
  });
}
