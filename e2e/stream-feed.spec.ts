// P2-E18-14 — the Feed, rendered from a DIRECT session's typed messages.
//
// THE GAP THIS FILLS, from the #404 audit: all thirteen `feed.spec.ts` tests
// write JSONL into the isolated home and let the transcript watcher tail it —
// a pipeline that is switched OFF for a stream session (`deriveFeed:
// record.transport !== 'stream'`, `sessions/ipc.ts`). Direct's own builder,
// `feed/stream-feed.ts`, is thoroughly unit-tested and had three thin e2e
// tests, none of which rendered a tool call: nothing on this transport ever
// emitted a `tool_use`, so the Bash box, the Edit diff panes, the TodoWrite
// checklist, the verbosity presets, the tail pin and the #174 keyboard walk
// were all reachable from a file and from no stream anywhere.
//
// The `!tools` and `!bulk` verbs (P2-E18-14, `providers/fake-stream-protocol.ts`)
// are what closed that: a turn of real tool calls in the shape the CLI actually
// emits them, and enough conversation to scroll.
//
// ONE APP FOR THE FILE, `serial`. Four launches of a Direct session cost most
// of the file's runtime and buy isolation these tests do not need: they read
// the same rendered conversation from four angles, in order, and the only one
// that mutates it is the last.
//
// NO `SWITCHBOARD_TRANSPORT` ANYWHERE, deliberately: Direct is the default
// since #381, and a spec about the default must not name it.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir, tabFromFeedToComposer } from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** the feed scroller, found the way feed.spec.ts finds it */
const scrollTop = (w: Page): Promise<number> =>
  w.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
    );
    return el ? Math.round(el.scrollTop) : -1;
  });

/**
 * How far the same scroller is from its tail. `-1` when nothing overflows —
 * a conversation that fits IS at its tail, which is why that reads as pinned.
 * The shape (and the -1) is `feed.spec.ts:200`'s.
 */
const tailGap = (w: Page): Promise<number> =>
  w.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
    );
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
  });

test.describe.configure({ mode: 'serial' });

test.describe('the Feed renders a Direct turn (P2-E18-14)', () => {
  let a: LaunchedApp;
  let title: string;
  let folder: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // NOT `tempProjectFolder()`, and its docblock says why: it REGISTERS the
    // folder with the sweep, and a registered folder is deleted by the first
    // `cleanup()` — which for a file this shape would be the first one anybody
    // adds in an `afterEach`, pulling the ground out from under tests 2-4. This
    // one is registered in `afterAll` instead, the moment it is safe to sweep,
    // so nothing leaks and nothing is swept early.
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-feed-'));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    title = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    // it really is Direct — otherwise every assertion in this file is a
    // transcript test that happens to pass
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!tools');
    await box.press('Enter');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    // registered HERE — see `beforeAll`. `cleanup()` closes the app first and
    // then sweeps, which is the order Windows needs: the session's child holds
    // this folder as its cwd until it is reaped.
    registerTempDir(folder);
    await a?.cleanup();
  });

  test('tool calls render as boxes: Bash IN/OUT, an Edit diff, a plain row, a checklist', async () => {
    const w = a.window;

    // 1. every tool call is its own bordered container, dispatched by CATEGORY
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible();
    await expect(w.locator('[data-feed-box="edit"]')).toBeVisible();
    await expect(w.locator('[data-feed-box="tool"]')).toBeVisible(); // the Read row
    await expect(w.getByText('Stream check')).toBeVisible(); // the Bash description
    await expect(w.getByText('Update Todos')).toBeVisible();
    await expect(w.getByText('first stream step')).toBeVisible();

    // 2. the Edit diff pane, open by default, with its stats subtitle
    await expect(w.getByText('STREAM_NEW')).toBeVisible();
    await expect(w.getByText('+1 / -1 lines')).toBeVisible();

    // 3. the tool RESULT reached the block that asked for it. `tool_result`
    //    arrives on a `user` message here, not on a transcript line — and it
    //    has to find a block whose input came from a DIFFERENT message than the
    //    deltas that opened it, which is the whole of `StreamFeed`'s assembly
    //    rule.
    await expect(w.getByText('▸ OUT')).toBeVisible();
    await w.getByText('▸ OUT').click();
    await expect(w.getByText('STREAM_OUT_LINE2').last()).toBeVisible();

    // 4. ORDER. The prose was emitted after the tools in the same message, and
    //    a block takes its seq when it OPENS — so a builder that ignored the
    //    stream's `content_block_start` and waited for the assistant messages
    //    would render these the other way round.
    const prose = await w.locator('.feed-md', { hasText: 'STREAM_PROSE' }).boundingBox();
    const firstBox = await w.locator('[data-feed-box="bash"]').boundingBox();
    expect(prose!.y).toBeGreaterThan(firstBox!.y);

    // 5. …and exactly once. The stream is the only source for a Direct session;
    //    a card that also derived blocks from the transcript the fake writes
    //    would show every one of these twice.
    await expect(w.locator('[data-feed-box="edit"]')).toHaveCount(1);
    await expect(w.locator('.feed-md', { hasText: 'STREAM_PROSE' })).toHaveCount(1);
  });

  test('verbosity presets switch live on a stream-built feed', async () => {
    const w = a.window;
    await w.getByRole('button', { name: 'quiet', exact: true }).click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(0);
    await expect(w.locator('[data-feed-box="edit"]')).toHaveCount(0);
    await expect(w.locator('.feed-md', { hasText: 'STREAM_PROSE' })).toBeVisible(); // prose stays

    await w.getByRole('button', { name: 'normal', exact: true }).click();
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible();
  });

  // #174 and #196 on this transport. Both are properties of the RENDERER, and
  // that is exactly why they are worth asserting here: the blocks it renders
  // now come from a different builder, and "the same blocks" is the claim
  // `blocks.ts` was extracted to make true.
  test('the conversation is keyboard-operable and names its session (#174/#196)', async () => {
    const w = a.window;
    // the landmark a screen reader lists, looked up the way one would
    await expect(w.getByRole('region', { name: `Conversation — ${title}` })).toBeVisible();

    // every expander is a real button that says whether it is open, and no box
    // lies about being one (a box CONTAINS buttons — role="button" on it would
    // be invalid ARIA, which is the whole reason #174 exists)
    const expanders = w.locator('[data-feed-expander]');
    await expect(expanders).toHaveCount(5); // bash header + IN + OUT, edit header, Read row
    for (const el of await expanders.all()) {
      await expect(el).toHaveJSProperty('tagName', 'BUTTON');
      await expect(el).toHaveAttribute('aria-expanded', /true|false/);
    }
    await expect(w.locator('[data-feed-box][role]')).toHaveCount(0);

    const focusedInfo = (): Promise<{ region: boolean; expander: boolean; label: string }> =>
      w.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          region: !!el?.hasAttribute('data-feed-region'),
          expander: !!el?.hasAttribute('data-feed-expander'),
          label: (el?.textContent ?? '').trim().slice(0, 40),
        };
      });

    // the conversation is ONE tab stop, reachable from the chrome above it
    await w.getByRole('button', { name: 'normal', exact: true }).click();
    await w.keyboard.press('Tab'); // -> firehose
    await w.keyboard.press('Tab'); // -> the conversation region
    expect((await focusedInfo()).region).toBe(true);

    // Up enters at the BOTTOM of the transcript — the Read row, the last
    // expander in the turn
    await w.keyboard.press('ArrowUp');
    const entered = await focusedInfo();
    expect(entered.expander).toBe(true);
    expect(entered.label).toContain('Read');

    // Home walks to the first expander, and Enter operates it
    await w.keyboard.press('Home');
    expect((await focusedInfo()).label).toContain('Stream check');

    // Escape hands focus back to the region, and tabbing out of it reaches the
    // composer: a long conversation must never bury it.
    //
    // #524 — "one more Tab" was true when this was written and is true only on
    // a big enough window. #442's "↓ Jump to latest" sits in that gap by design
    // whenever the feed is unpinned AND overflowing, which the walk's own `Home`
    // makes true at the windows-latest geometry and false on a dev screen; the
    // helper walks whichever order this window is in and refuses any stop that
    // is not that one. The destination is asserted here, unchanged.
    await w.keyboard.press('Escape');
    expect((await focusedInfo()).region).toBe(true);
    await tabFromFeedToComposer(w);
    await expect(w.getByPlaceholder(/Prompt this session/)).toBeFocused();
  });

  // The tail pin, on a feed built from the stream. It matters more here than on
  // the transcript path: a streamed block is UPDATED in place as tokens arrive
  // (same seq, new text), so every delta is a chance to move the scroller under
  // someone who is reading.
  //
  // Last in the file: it is the only test that changes the conversation.
  test('a long Direct conversation pins to the tail, and a reader is not yanked off it', async () => {
    test.setTimeout(120_000);
    const w = a.window;
    const box = w.getByPlaceholder(/Prompt this session/);

    // ARRANGE — a reader who is AT the tail, said out loud instead of inherited.
    //
    // This test used to open on whatever scroll position the three tests above
    // it left behind, and on a shorter window than a dev machine's that is NOT
    // the tail. Measured on the windows CI runner (2026-08-11, PR #430): its
    // desktop is 1024x768, the app window clamps to it, and the feed is 254px
    // tall — so the `!tools` turn (347px with `▸ OUT` open) OVERFLOWS. Playwright
    // scrolls a half-cut-off element into view before clicking it, so test 1's
    // click on `▸ OUT` scrolled the feed UP by 64px, inside that click's own
    // gesture window — which is exactly what FeedView's `lastGesture` rule reads
    // as "the user scrolled up" (a deliberate rule: #112 / Dan 2026-07-26). The
    // tail was unpinned three tests before this one, nothing re-pins an unpinned
    // feed, and 60 blocks then landed under a stationary reader: `SFEED_BLOCK_60`
    // was rendered 2565px down a 655px window and never came on screen. On a
    // 1264x735 window the same turn fits in the 375px feed, nothing scrolls, and
    // the artefact does not exist — which is why this was green here and red
    // there, twice, on the same commit.
    //
    // So take the wheel and land on the bottom, the way a user following the
    // conversation is on it. This does not weaken a thing below: the claim under
    // test is what a NEW block does to a reader who IS at the tail, and that
    // reader is now a precondition the test states rather than one it hopes for.
    await w.locator('[data-feed-region]').hover();
    await w.mouse.wheel(0, 5000);
    await expect.poll(() => tailGap(w), { timeout: 10_000 }).toBeLessThan(40);
    // and let the gesture window (FeedView's GESTURE_MS, 500ms) close before the
    // blocks arrive: a scroll sampled inside it re-derives the pin from raw
    // distance, which is the very trap described above.
    await w.waitForTimeout(600);

    await box.click();
    await box.fill('!bulk 60 SFEED_BLOCK_');
    await box.press('Enter');

    // it lands at the BOTTOM: the tail is on screen and the head is not
    await expect(w.getByText('SFEED_BLOCK_60', { exact: true })).toBeInViewport({
      timeout: 60_000,
    });
    // `toBeAttached` first: `not.toBeInViewport()` is also satisfied by a node
    // that is not there at all, so on its own it would survive the head of the
    // conversation never rendering
    await expect(w.getByText('SFEED_BLOCK_1', { exact: true })).toBeAttached();
    await expect(w.getByText('SFEED_BLOCK_1', { exact: true })).not.toBeInViewport();

    // read something partway up, with a REAL wheel gesture — that is what the
    // scroll handler exists to notice, and it is the path a user takes
    await w.getByText('SFEED_BLOCK_40', { exact: true }).hover();
    await w.mouse.wheel(0, -700);
    await w.waitForTimeout(400); // let the gesture land and unpin the tail
    const parked = await scrollTop(w);
    expect(parked).toBeGreaterThan(0);

    // a block arriving while you are reading must not move you
    await box.click();
    await box.fill('!bulk 1 SFEED_LATE_');
    await box.press('Enter');
    await expect(w.getByText('SFEED_LATE_1', { exact: true })).toBeAttached({ timeout: 60_000 });
    expect(await scrollTop(w)).toBe(parked);
  });
});
