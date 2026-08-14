// #442 — the feed's tail pin, and the way back to it.
//
// WHY THIS FILE EXISTS AT ALL, AND WHY IT SETS THE WINDOW SIZE
//
// The whole class of behaviour here only exists when the conversation
// OVERFLOWS its pane, which on a dev machine's 2560x1440 desktop it rarely
// does — the windows CI runner found it first (PR #430: desktop 1024x768, app
// inner 1008x655, feed 254px, and the `!tools` turn alone at 347px). So this
// file states the geometry instead of inheriting the machine's: it sizes the
// window to the runner's, so the test measures the same thing on Dan's screen,
// on windows-latest and on ubuntu-latest.
//
// WHAT WAS MEASURED (2026-08-13, this file's own harness, window inner
// 1010x657, feed scroller 288px, conversation 2,313px):
//
//   * a pinned tail follows a new block:                    gap 0
//   * enter the #174 keyboard walk (ArrowUp, then Home):    scrollTop 2113 → 0
//     ...and a block arriving after it does NOT move the view: gap 2201
//     i.e. THE KEYBOARD WALK UNPINS. `onFeedKeyDown` marks a gesture and the
//     browser's focus scroll is then read as the user's own — the pin rule
//     working exactly as written (#112 / Dan 2026-07-26), not a bug.
//   * `End` INSIDE the walk moves to the last EXPANDER, not the last block:
//     scrollTop stayed 0 of 2,201. There is no key inside the walk that
//     returns to the tail.
//   * `End` (or PageDown) with focus on the REGION does re-pin: gap → 0.
//   * controls in and around the feed while unpinned, before this item:
//     quiet / normal / firehose, the expanders, the send button, the autonomy
//     chip. No way back, and nothing saying the view had stopped following.
//   * the same walk unpins at dev geometry too (1250x837, feed 481px) — the
//     conversation only has to be longer than the pane.
//
// So: the unpin is correct and stays. What ships is the missing exit — a
// "↓ Jump to latest" control that exists only while the feed is unpinned AND
// overflowing, one Tab from the conversation (§5.32).
//
// NO `[pty]` TAG: this runs on Direct, the app's default transport since #381.
// It is a renderer property and would hold on either, but the stream fake is
// what can produce 60 blocks on demand (`!bulk`, P2-E18-14).
//
// It does not contradict `stream-feed.spec.ts`'s pin tests (#416) — it extends
// them: they pin what a NEW BLOCK does to a reader (nothing), this pins what
// the reader can do about it.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** the CI runner's desktop, to the pixel (measured on windows-latest, PR #430) */
const RUNNER_WINDOW = { x: 0, y: 0, width: 1024, height: 720 };

/** the feed scroller, found the way `feed.spec.ts` and `stream-feed.spec.ts` find it */
const tailGap = (w: Page): Promise<number> =>
  w.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
    );
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
  });

const jump = (w: Page) => w.locator('[data-feed-jump-latest]');

test.describe.configure({ mode: 'serial' });

// ONE app for the file, shared by the two groups below — the second is the
// same card with a conversation in it, and re-launching to get there would
// double the file's runtime for nothing.
let a: LaunchedApp;
let folder: string;
let sent = 0;

/** send one block and answer the only question that matters: did the view follow? */
const blockFollowed = async (w: Page): Promise<boolean> => {
  sent += 1;
  const name = `TAIL_${sent}_`;
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(`!bulk 1 ${name}`);
  await box.press('Enter');
  await expect(w.getByText(`${name}1`, { exact: true })).toBeAttached({ timeout: 60_000 });
  await w.waitForTimeout(700); // the pin lands on the next frame; give it several
  return (await tailGap(w)) < 40;
};

/** wheel back to the bottom by hand — the mouse path, which has always worked */
const wheelToBottom = async (w: Page): Promise<void> => {
  await w.locator('[data-feed-region]').hover();
  await w.mouse.wheel(0, 8000);
  await expect.poll(() => tailGap(w), { timeout: 10_000 }).toBeLessThan(40);
  await w.waitForTimeout(600); // let the 500ms gesture window close
};

/** the #174 walk: into the conversation, then to the first expander (top) */
const walkToTheTop = async (w: Page): Promise<void> => {
  await w.locator('[data-feed-region]').focus();
  await w.keyboard.press('ArrowUp'); // enters the walk at the last expander
  await w.waitForTimeout(200);
  await w.keyboard.press('Home'); // ...and up to the first
  await w.waitForTimeout(400);
};

test.describe('the feed has a way back to the tail (#442)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // NOT `tempProjectFolder()` — registered in `afterAll` instead, so the
    // sweep cannot pull the folder out from under a serial file (the
    // `stream-feed.spec.ts` shape, and its docblock says why).
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tail-pin-'));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(box);
    }, RUNNER_WINDOW);
    await w.waitForTimeout(500);
  });

  // FIRST, while the card is still empty — the one state in this file that has
  // no conversation in it, and the cheapest possible proof that the control is
  // not clutter.
  test('a conversation that fits its pane never offers a way back', async () => {
    const w = a.window;
    await expect(w.getByText('No conversation yet')).toBeVisible({ timeout: 25_000 });
    await expect(jump(w)).toHaveCount(0);
    // ...and a scroll gesture on a pane that cannot scroll conjures nothing:
    // a view you cannot move IS at its tail.
    await w.locator('[data-feed-region]').hover();
    await w.mouse.wheel(0, -800);
    await w.waitForTimeout(400);
    await expect(jump(w)).toHaveCount(0);
  });
});

test.describe('the feed has a way back to the tail — with a conversation (#442)', () => {
  // Same app, same window, declared second: the nested arrange below runs after
  // the empty-feed test above and never has to undo it.
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const w = a.window;
    // A turn with EXPANDERS (the #174 walk needs something to walk between),
    // then enough prose to overflow several times over. Order matters: the
    // expanders end up at the TOP, so walking to them is a walk away from the
    // tail — which is the situation being measured.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!tools');
    await box.press('Enter');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 60_000 });
    await box.click();
    await box.fill('!bulk 60 TP_');
    await box.press('Enter');
    await expect(w.getByText('TP_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await w.waitForTimeout(1_000);
  });

  test('a pinned feed follows the conversation, and offers no way back it does not need', async () => {
    const w = a.window;
    await wheelToBottom(w);
    // the control is not clutter: while the view IS following, there is nowhere
    // to go and nothing to say
    await expect(jump(w)).toHaveCount(0);
    expect(await blockFollowed(w)).toBe(true);
    await expect(jump(w)).toHaveCount(0);
  });

  test('the #174 keyboard walk unpins the tail — and now that is visible', async () => {
    const w = a.window;
    await wheelToBottom(w);
    await expect(jump(w)).toHaveCount(0);

    await walkToTheTop(w);

    // MEASURED, not assumed: the walk moves the scroller off the tail...
    expect(await tailGap(w)).toBeGreaterThan(40);
    // ...the pin really is gone — a block arriving now leaves the reader where
    // they are, which is the behaviour that has to STAY (nobody wants to be
    // yanked to the bottom mid-read)...
    expect(await blockFollowed(w)).toBe(false);
    // ...and the state finally announces itself instead of being a ref only
    // the component can see.
    await expect(jump(w)).toBeVisible();
  });

  test('the way back re-pins the feed, and the next block is followed again', async () => {
    const w = a.window;
    // (still unpinned from the previous test — serial, deliberately)
    await expect(jump(w)).toBeVisible();
    await jump(w).click();

    await expect.poll(() => tailGap(w), { timeout: 5_000 }).toBeLessThan(40);
    await expect(jump(w)).toHaveCount(0); // its own job done, it leaves
    // the real claim: FOLLOWING, not just "scrolled once"
    expect(await blockFollowed(w)).toBe(true);
    await expect(jump(w)).toHaveCount(0);
  });

  test('it is reachable and operable from the keyboard alone (§5.32)', async () => {
    const w = a.window;
    await wheelToBottom(w);
    await walkToTheTop(w);
    await expect(jump(w)).toBeVisible();

    // Escape hands focus back to the conversation region (#174), and the
    // control is the VERY NEXT tab stop — one press, from the surface the user
    // is already on. That placement is the whole reason it renders here rather
    // than in the header strip.
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-feed-region]')).toBeFocused();
    await w.keyboard.press('Tab');
    await expect(jump(w)).toBeFocused();

    // it is a real button, so Enter operates it
    await w.keyboard.press('Enter');
    await expect.poll(() => tailGap(w), { timeout: 5_000 }).toBeLessThan(40);
    await expect(jump(w)).toHaveCount(0);

    // ...and the focus it was holding is not dropped on the floor when it
    // removes itself: it goes back to the conversation, so the next Tab is the
    // composer rather than the top of the window.
    await expect(w.locator('[data-feed-region]')).toBeFocused();
    await w.keyboard.press('Tab');
    await expect(w.getByPlaceholder(/Prompt this session/)).toBeFocused();
  });

  test.afterAll(async () => {
    registerTempDir(folder);
    await a?.cleanup();
  });
});
