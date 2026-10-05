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
import { launchApp, LaunchedApp, preparedStreamPrompt, registerTempDir } from './fixtures/app';

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

/** what the page itself saw, on the clock `FeedView` reads its gesture window from */
interface Pin967Timing {
  /** the pointer-down that opened the window */
  down: number;
  /** the first block of the REPLY reaching the conversation */
  first: number;
  /** the first scroll event after it — the instant `FeedView` reads its window */
  sampled: number;
  stop?: () => void;
}

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

  // #967, the owner dogfooding: *"When it's doing a lot of things — Claude is
  // working constantly — it doesn't always keep the session scrolled to the
  // bottom."*
  //
  // The mechanism, and why this test looks the way it does: `onPointerDown` on
  // the scroller marks a gesture, and it fires for ANY click in the conversation
  // — expanding a tool block, pressing Copy, clicking to focus. The old rule then
  // treated every scroll for the next 500ms as the user's and re-derived the pin
  // from raw distance, which under sustained streaming is large. One click plus
  // one unattributed scroll and the feed stopped following its own session.
  //
  // So the test does the thing the owner was doing: click IN the feed, without
  // scrolling, while output keeps arriving.
  //
  // ⚠️ AND IT DOES NOT DISCRIMINATE THE FIX. Said here rather than left to be
  // assumed, because a test that looks like proof and is not is worse than no test.
  // MEASURED, by deleting the `delta === 0` branch from `lib/feed-pin.ts` and running
  // this file: 6 passed, with one block and with two hundred. The bug needs the tail
  // to be FAR from the viewport at the instant a stray scroll event is sampled, and
  // the fake emits a whole `!bulk` turn synchronously — the pin catches up before
  // anything can be misread. `stream-feed.spec.ts` records the same limitation for
  // the same reason ("no e2e driven by it can observe a break that spans ticks").
  //
  // What IS the proof is `lib/feed-pin.test.ts`, which runs the OLD rule beside the
  // new one on the same input and shows the two answers differing. What this test is
  // worth is the coarse guard: a regression that unpins on a click outright, or that
  // stops following at all, fails here.
  test('a click in the conversation does not stop it following (#967)', async () => {
    const w = a.window;
    await wheelToBottom(w);
    await expect(jump(w)).toHaveCount(0);

    // ⚠️ EVERYTHING THAT CAN BE DONE BEFORE THE CLICK IS DONE BEFORE THE CLICK
    // (#1079). The window this test has to land inside is 500ms and it opens at
    // the pointer-down, so nothing may sit between that and the prompt except the
    // prompt: the session is looked up here, the timing probe is installed here,
    // and the pointer is already where it is going to press.
    const name = `PIN967_`;
    const send = await preparedStreamPrompt(a, path.basename(folder));
    await w.evaluate((prefix) => {
      const feed = document.querySelector('[data-feed-region]');
      if (!feed) throw new Error('no conversation region to time');
      const seen: Pin967Timing = { down: 0, first: 0, sampled: 0 };
      (window as unknown as { __pin967?: Pin967Timing }).__pin967 = seen;
      // capture phase, so this is stamped before React's `onPointerDown` and the
      // measured window is never SHORTER than the one `FeedView` opened
      feed.addEventListener('pointerdown', () => (seen.down = Date.now()), {
        capture: true,
        once: true,
      });
      // ⚠️ A DIGIT AFTER THE PREFIX, AND ONLY INSIDE THE CONVERSATION (review). The
      // prompt is echoed into the feed as the user's own bubble — `!bulk 200
      // PIN967_` — a mutation ahead of the reply, and a bare prefix match stopped
      // the clock on THAT. `PIN967_1` is something only the reply can say.
      const reply = new RegExp(`${prefix}\\d`);
      const watch = new MutationObserver((records) => {
        for (const r of records) {
          const nodes = r.type === 'characterData' ? [r.target] : [...r.addedNodes];
          if (nodes.some((n) => reply.test(n.textContent ?? ''))) {
            seen.first = Date.now();
            watch.disconnect();
            return;
          }
        }
      });
      watch.observe(feed, { childList: true, subtree: true, characterData: true });
      // The window is not read when a block is drawn: it is read in `onScroll`, a
      // frame or more later, when the pin moves the scroller. THAT is the instant
      // that has to fall inside 500ms, so that is the instant recorded.
      const onScroll = (): void => {
        if (seen.first && !seen.sampled) seen.sampled = Date.now();
      };
      feed.addEventListener('scroll', onScroll, { capture: true });
      seen.stop = () => {
        watch.disconnect();
        feed.removeEventListener('scroll', onScroll, { capture: true });
      };
    }, name);
    const region = await w.locator('[data-feed-region]').boundingBox();
    if (!region) throw new Error('the conversation region has no box to click in');
    await w.mouse.move(region.x + 5, region.y + 5);

    // A click that is emphatically NOT a scroll. On the region itself rather than
    // a control, so nothing expands and the only thing this can be testing is the
    // pointer-down → gesture-window path.
    //
    // …and the session talks INSIDE the gesture window, which is the whole point.
    //
    // ⚠️ THE PROMPT GOES OUT BETWEEN THE PRESS AND THE RELEASE, THROUGH THE BRIDGE.
    // Two earlier versions were each passing or failing for the wrong reason, and
    // the premise assertion below is how both were found:
    //
    //   * typed into the composer — click, fill, Enter, a CDP round trip each — and
    //     the block landed ~900ms after the click, well past `GESTURE_MS`. Green,
    //     because the window had closed and the old rule would have kept the pin too.
    //   * `locator.click()` then `streamPrompter` (#1079) — the release, the click's
    //     own bookkeeping and a `sessions.cards()` lookup all ran on the clock before
    //     the prompt left. ~200ms on a dev machine; 500-572ms on windows-latest,
    //     which reddened two runs in four.
    //
    // Now ONE round trip separates the gesture from the prompt.
    //
    // 200 blocks, not one: the bug needs the tail to be FAR AWAY at the moment the
    // scroll event is sampled, which is what "Claude is working constantly" means.
    // One block lands and the pin catches up before anything can be misread —
    // measured: the mutation test below passes with a single block, i.e. a
    // one-block stimulus cannot tell the fix from its absence.
    await w.mouse.down();
    try {
      await send(`!bulk 200 ${name}`);
    } finally {
      // one app for the whole serial file: a refused prompt must not leave it
      // with a button held for every test after this one
      await w.mouse.up();
    }
    await expect(w.getByText(`${name}200`, { exact: true })).toBeAttached({ timeout: 60_000 });
    await w.waitForTimeout(700); // the pin lands on the next frame; give it several
    expect(await tailGap(w)).toBeLessThan(40);

    // and a second one, because the failure is intermittent by nature and one block
    // landing right is the weaker half of the claim
    expect(await blockFollowed(w)).toBe(true);
    // it never offered a way back, because it never left
    await expect(jump(w)).toHaveCount(0);

    // ⚠️ ASSERT THE PREMISE, OR THIS TEST CAN STOP TESTING ANYTHING (found in
    // review). Everything above only discriminates while the FIRST block lands
    // inside `GESTURE_MS` — 500ms, `FeedView`'s constant. On a loaded runner the
    // round trip and the fake's reply can exceed that, the window closes, and the
    // OLD rule would have repinned too: green for the wrong reason, silently, for
    // ever. So the test says out loud what it needed rather than hoping for it.
    //
    // ⚠️ MEASURED IN THE RENDERER, ON `FeedView`'S OWN CLOCK (#1079). This used to
    // be two `Date.now()` calls in the TEST process, the second taken after
    // Playwright had polled its way to block 200 of 200 — so it timed the click's
    // release, 200 renders and a poll interval, and called the total "the first
    // block". The window is `Date.now() - lastGesture`, evaluated inside the page's
    // `onScroll`; this is that subtraction, from the pointer-down the page saw to
    // the first scroll event after the reply's first block was drawn.
    const seen = await w.evaluate(() => {
      const holder = window as unknown as { __pin967?: Pin967Timing };
      const t = holder.__pin967;
      t?.stop?.();
      delete holder.__pin967;
      return t ? { down: t.down, first: t.first, sampled: t.sampled } : null;
    });
    if (!seen) throw new Error('the timing probe was never installed');
    expect(seen.down, 'the page never saw the pointer-down this test is about').toBeGreaterThan(0);
    expect(seen.first, 'the page never saw the first block of the reply').toBeGreaterThan(0);
    expect(seen.sampled, 'the conversation never scrolled after the reply began').toBeGreaterThan(0);
    // printed on a green run too: the margin is the thing to watch on a slow runner
    console.log(
      `#967 premise: first block ${seen.first - seen.down}ms after the pointer-down, ` +
        `window read at ${seen.sampled - seen.down}ms (limit 500)`
    );
    expect(
      seen.sampled - seen.down,
      'the first block landed after the 500ms gesture window had closed, so this ' +
        'test no longer exercises the #967 path at all — it is passing for the wrong ' +
        'reason. Make the stimulus faster rather than relaxing this.'
    ).toBeLessThan(500);
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

    // ...and it does not BURY the composer, which is #174's standing promise
    // about this gap. One more Tab and you are typing — the control costs a
    // keystroke on the way out of an unpinned feed, and nothing more.
    //
    // #524 lives here. `stream-feed.spec.ts` and `feed.spec.ts` both walked
    // "Escape, Tab, composer" — written before this control existed, and true
    // only while the feed is pinned or fits. On windows-latest it neither fits
    // nor stays pinned (this file's geometry, the walk's own `Home`), so the
    // Tab landed HERE and the composer assertion failed with "inactive" five
    // times in two days. Both orders are correct; the walks now go through
    // `tabFromFeedToComposer`, and this is the case that pins the two-stop one
    // down on every machine rather than on whichever one has a small screen.
    await w.keyboard.press('Tab');
    await expect(w.getByPlaceholder(/Prompt this session/)).toBeFocused();
    // Shift+Tab comes back to it — the other half of the placement claim in
    // `FeedView.tsx`, and how the Enter below gets its target back.
    await w.keyboard.press('Shift+Tab');
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
