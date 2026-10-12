// A compaction's summary is not a prompt (#1026), in the real app.
//
// When Claude Code compacts a conversation it writes the summary that replaces
// the history as a `user` message nobody typed: "This session is being
// continued from a previous conversation that ran out of context…". The app
// drew it as one of YOUR prompts, under a NEW PROMPT divider.
//
// The CLI marks it two different ways, and this spec walks both:
//
//   * LIVE, on the stream, it is `isSynthetic: true` (measured on CLI 2.1.288:
//     `spike/findings/1026-not-for-the-live-view.md`);
//   * AFTER A RESTART it is read back from the saved conversation, where the
//     same message carries `isCompactSummary` and `isVisibleInTranscriptOnly`
//     instead.
//
// The fake CLI's `/compact` emits the measured frames and writes the measured
// transcript lines (`fake-stream-protocol.test.ts` pins both).
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);
const SUMMARY = 'This session is being continued from a previous conversation';

async function say(w: Page, text: string): Promise<void> {
  await composer(w).click();
  await composer(w).fill(text);
  await composer(w).press('Enter');
}

test.describe('a compaction summary is not shown as a prompt (#1026)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('live, and again after a restart: two prompts, and no summary between them', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    let w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });

    await say(w, 'BEFORE the compaction');
    await expect(w.getByText('FAKE-REPLY: BEFORE the compaction')).toBeVisible({ timeout: 60_000 });
    await say(w, '/compact');
    // LET IT LAND before the next prompt is typed. Sent on its heels, the two
    // are one burst and the summary never shows even in a build without the
    // rule (measured: this spec passed against one), so the wait is what makes
    // the assertion below mean anything.
    await w.waitForTimeout(1500);
    await say(w, 'AFTER the compaction');
    await expect(w.getByText('FAKE-REPLY: AFTER the compaction')).toBeVisible({ timeout: 60_000 });

    // ── LIVE ────────────────────────────────────────────────────────────────
    const prompts = w.locator('[data-feed-block="user"]');
    await expect(prompts.filter({ hasText: 'BEFORE the compaction' })).toHaveCount(1);
    await expect(prompts.filter({ hasText: 'AFTER the compaction' })).toHaveCount(1);
    // the summary is nowhere in the conversation, as a prompt or as anything else
    await expect(w.locator('[data-feed-region]').getByText(SUMMARY)).toHaveCount(0);
    await expect(w.locator('[data-feed-region]').getByText('FAKE-COMPACT-SUMMARY')).toHaveCount(0);
    // ...and nothing was wiped: the turn before the compaction is still there
    await expect(w.getByText('FAKE-REPLY: BEFORE the compaction')).toBeVisible();

    // ── AFTER A RESTART ─────────────────────────────────────────────────────
    // the conversation is replayed from the file, where the flags are different
    const home = a.home;
    await a.close();
    a = await launchApp({ home, env: DIRECT });
    w = a.window;
    await expect(w.getByText('FAKE-REPLY: AFTER the compaction')).toBeVisible({ timeout: 60_000 });
    await expect(w.getByText('FAKE-REPLY: BEFORE the compaction')).toBeVisible();
    await expect(w.locator('[data-feed-region]').getByText(SUMMARY)).toHaveCount(0);
    await expect(w.locator('[data-feed-region]').getByText('FAKE-COMPACT-SUMMARY')).toHaveCount(0);
  });
});
