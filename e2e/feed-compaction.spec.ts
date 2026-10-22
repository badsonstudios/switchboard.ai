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
//
// #1259: what the summary pill USED to show by accident (where the compaction
// happened) is now a divider drawn from the CLI's own `compact_boundary` frame,
// live from the stream and after a restart from the saved conversation. Its
// counts are the fake's measured ones: 32,516 -> 4,760 tokens, `manual`.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);
const SUMMARY = 'This session is being continued from a previous conversation';
const DIVIDER = 'Conversation compacted — 33k → 4.8k tokens (you asked)';
const divider = (w: Page) => w.locator('[data-feed-block="compaction"]');

/**
 * Type a slash command and SEND it (#1259, found writing it).
 *
 * Typing `/compact` opens the command popup, and an Enter that lands while it
 * is still opening is LOST: the box keeps `/compact`, the popup appears, and
 * nothing is sent. With the popup open, Enter on a command typed in full sends
 * it (`slash-commands.spec.ts`). This spec used to send blind and pass anyway,
 * having never compacted, so it now waits for the popup and then proves the
 * send by the box emptying.
 */
async function command(w: Page, cmd: string): Promise<void> {
  await composer(w).click();
  await composer(w).fill(cmd);
  await expect(w.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
  await composer(w).press('Enter');
  await expect(composer(w)).toHaveValue('');
}

/** The feed's blocks, in order, as their kinds — where the divider SITS. */
async function order(w: Page): Promise<string[]> {
  return w.locator('[data-feed-block]').evaluateAll((els) => els.map((e) => e.getAttribute('data-feed-block') ?? ''));
}

/** The divider is exactly one, says the counts and who asked, and sits between the two prompts. */
async function expectDividerBetweenThePrompts(w: Page): Promise<void> {
  await expect(divider(w)).toHaveCount(1);
  await expect(divider(w).getByRole('separator', { name: DIVIDER })).toBeVisible();
  const kinds = await order(w);
  const at = kinds.indexOf('compaction');
  const users = kinds.flatMap((k, i) => (k === 'user' ? [i] : []));
  expect(users).toHaveLength(2);
  expect(users[0]).toBeLessThan(at);
  expect(at).toBeLessThan(users[1]);
}

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
    await command(w, '/compact');
    // the CLI's boundary frame has been drawn: the compaction really happened
    await expect(divider(w)).toHaveCount(1, { timeout: 30_000 });
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
    // #1259: and WHERE it happened is marked
    await expectDividerBetweenThePrompts(w);

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
    // #1259: the same divider, in the same place, read back from the file
    await expectDividerBetweenThePrompts(w);
  });

  // The other door (#1259's "by the Compact button"): the composer row's own
  // Compact sends the same `/compact`, and the divider follows.
  test('the Compact button draws the divider too', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });
    await say(w, 'BEFORE the button');
    await expect(w.getByText('FAKE-REPLY: BEFORE the button')).toBeVisible({ timeout: 60_000 });
    await w.getByTestId('composer-compact').click();
    await expect(divider(w).getByRole('separator', { name: DIVIDER })).toBeVisible({ timeout: 30_000 });
    await expect(divider(w)).toHaveCount(1);
    await expect(w.locator('[data-feed-block="user"]')).toHaveCount(1);
  });
});
