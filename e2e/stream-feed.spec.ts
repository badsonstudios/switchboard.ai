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
import path from 'path';
import {
  launchApp,
  launchDirectToolTurn,
  LaunchedApp,
  readWorkspaceFile,
  registerTempDir,
  tabFromFeedToComposer,
} from './fixtures/app';
// The clear tests at the foot of this file launch their own apps rather than
// sharing the `serial` one, so they use the shared folder/teardown helpers.
import { tempProjectFolder, teardown } from './fixtures/stream-session';

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
    // The Direct setup dance, shared with the other Direct-lane specs (#497):
    // mkdtemp rather than `tempProjectFolder()` — which REGISTERS the folder
    // with the sweep, and a registered folder is deleted by the first
    // `cleanup()`, pulling the ground out from under tests 2-4 — no
    // `SWITCHBOARD_TRANSPORT` anywhere, the it-really-is-Direct probe, and the
    // `!tools` turn this whole file reads. See `launchDirectToolTurn`.
    ({ app: a, folder, title } = await launchDirectToolTurn('sb-stream-feed-'));
  });

  test.afterAll(async () => {
    // registered HERE — see `beforeAll`. `cleanup()` closes the app first and
    // then sweeps, which is the order Windows needs: the session's child holds
    // this folder as its cwd until it is reaped.
    // Unset only when the setup threw — which cleaned up after itself.
    if (folder) registerTempDir(folder);
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

// ── Clearing the conversation on Direct (#748, #752) ─────────────────────────
//
// THE COVERAGE GAP THIS CLOSES, and it is the reason #748 reached the user.
// `slash-commands.spec.ts` has a `/clear` test, but it is `[pty]`: that wipe
// rides the transcript watcher's rebind on a new native id. A Direct session's
// Feed is not built from the transcript at all — `feed/stream-feed.ts` builds
// it from typed messages — and NOTHING drove that path end to end, because the
// fake emitted `system:init` with a fixed id every turn and so never rotated
// the conversation. #752 taught it `/clear`; these are what that buys.
//
// Both go through the REAL affordance — ⋯ → Clear conversation → the
// confirmation — rather than typing the command, because a menu route that
// silently stopped delivering is exactly the failure this has to be able to
// catch (#381 was that bug once already).
//
// WHICH TEST PROVES WHAT, because they are not interchangeable. On a stream
// session the transcript watcher's reset is gated off (`sessions/ipc.ts`,
// `isStream`), so `feed/stream-feed.ts` is the ONLY source of the cleared
// marker here — but it has two branches, and each test reaches a different one:
//
//   * the RESUMED test can only be satisfied by `onConversationReset`. No turn
//     has run, so the init backstop has no id to compare against — which IS
//     #748. Verified RED against the pre-#748 code: the replayed history stays
//     on screen and no marker appears.
//   * the ordinary test runs a turn first, so it goes through the backstop and
//     passed before #748 too. It is a guard, not a regression test: the ⋯ → send
//     route on Direct (#381's failure class), the id rotation, and that the
//     session keeps working in the new conversation.
//
// A SEPARATE APP PER TEST, not this file's shared `serial` one: both mutate the
// conversation, and the second pays for a relaunch.
test.describe('Clear conversation on a Direct session', () => {
  // OUT of the file-level serial (`mode: 'serial'` at the top). These two launch
  // their own apps and share nothing with the group above, so inheriting its
  // serial coupling would only mean a failure up there SKIPS them — a test that
  // silently does not run, which is #107's lesson.
  test.describe.configure({ mode: 'default' });

  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  /** ⋯ → Clear conversation → confirm, the way a user does it. */
  const clearFromMenu = async (w: Page): Promise<void> => {
    await w.getByTitle('Session menu').click();
    const clear = w.getByRole('button', { name: 'Clear conversation' });
    // A Direct session is `idle` the moment its transport is up
    // (`transport-ready`), so this is live without waiting for a turn — which
    // is what makes the resumed case below reachable at all.
    await expect(clear).toBeEnabled({ timeout: 15_000 });
    await clear.click();
    await expect(w.getByText(/Clear this conversation\?/)).toBeVisible();
    await w.getByRole('button', { name: 'Clear', exact: true }).click();
  };

  const CLEARED = 'Conversation cleared — context starts fresh';

  /**
   * It really IS Direct — the probe `launchDirectToolTurn` calls load-bearing.
   * Without it a test here could quietly become a transcript test that happens
   * to pass, and the two transports reach the cleared marker by different
   * paths, so which one this is decides what the assertions mean.
   */
  const assertDirect = async (w: Page): Promise<void> => {
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();
  };

  test('wipes the conversation, and the next turn survives', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await assertDirect(w);

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('SFEED_CLEAR_BEFORE');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: SFEED_CLEAR_BEFORE')).toBeVisible({ timeout: 30_000 });

    await clearFromMenu(w);

    await expect(w.getByText(CLEARED)).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('FAKE-REPLY: SFEED_CLEAR_BEFORE')).toHaveCount(0);

    // ⚠️ NOTHING HERE TESTS IDEMPOTENCY, AND NOTHING HERE CAN. Said out loud
    // because two attempts to test it from this file were both worthless, and
    // the second looked convincing:
    //
    //  1. `expect(CLEARED).toHaveCount(1)` cannot fail. `FeedView`'s `cleared`
    //     is a BOOLEAN behind one conditional, so N resets draw one marker.
    //  2. "a turn sent AFTER the clear survives" cannot fail either — VERIFIED
    //     by mutation, not reasoned: adopting `new_conversation_id` in
    //     `stream-feed.ts` (the decoy, which makes the init wipe a second time)
    //     leaves this test GREEN. Both wipes land in the same tick, before this
    //     turn is ever sent, so there is nothing left for the second one to eat.
    //     The fake emits the whole sequence synchronously — `onClear` says so —
    //     so no e2e driven by it can observe a break that spans ticks.
    //
    // Idempotency is pinned where it is observable: `stream-feed.test.ts` →
    // "the measured sequence wipes exactly ONCE", which counts LISTENER CALLS
    // rather than DOM nodes, and is mutation-verified against both the decoy
    // and the keep-the-old-id variant.
    //
    // What this round trip does prove is worth having on its own: the session
    // keeps working after a clear, in the new conversation, and the old content
    // does not come back with it.
    await box.click();
    await box.fill('SFEED_CLEAR_AFTER');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: SFEED_CLEAR_AFTER')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('FAKE-REPLY: SFEED_CLEAR_BEFORE')).toHaveCount(0);
  });

  test('wipes a RESUMED card on the FIRST clear — the #748 bug itself', async () => {
    // THE REGRESSION TEST. A resumed card is the case that failed every single
    // time: `hydrate()` deliberately never sets `conversationId` (seeding it
    // would make a forked `--resume` id look like a clear and wipe the history
    // it just replayed), so the old id-comparison had nothing to compare
    // against and the first clear silently did nothing. The user's second
    // clear was what worked — which is the whole of the report.
    //
    // VERIFIED RED against `main` before #748's fix: without it the replayed
    // history is still on screen and no marker appears.
    //
    // 240s to match the other relaunch specs (`feed-restore-position`,
    // `find-resumed`). It runs in ~4s locally; the budget exists so a slow CI
    // run reports the FAILING ASSERTION rather than a bare "Test timeout" —
    // this test's own step timeouts already sum to ~155s.
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await assertDirect(w);

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('SFEED_RESUMED_HISTORY');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: SFEED_RESUMED_HISTORY')).toBeVisible({ timeout: 30_000 });

    // the id has to be durable before the relaunch can resume on it (#404)
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(typeof card?.nativeSessionId).toBe('string');
    }).toPass({ timeout: 15_000 });
    await first.close();

    // fresh process, same profile, NO seedFolder — seeding again would make a
    // second card and land every assertion below on the wrong one
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w2 = a.window;
    await expect(w2.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    // the replayed history is on screen and NOBODY HAS TYPED ANYTHING — which
    // is precisely the state in which the old code could not detect a clear
    await expect(w2.getByText('FAKE-REPLY: SFEED_RESUMED_HISTORY')).toBeVisible({ timeout: 30_000 });

    await clearFromMenu(w2);

    await expect(w2.getByText(CLEARED)).toBeVisible({ timeout: 15_000 });
    await expect(w2.getByText('FAKE-REPLY: SFEED_RESUMED_HISTORY')).toHaveCount(0);
    await expect(w2.getByText('SFEED_RESUMED_HISTORY', { exact: true })).toHaveCount(0);
    await expect(w2.getByText(CLEARED)).toHaveCount(1);
  });
});
