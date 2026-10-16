// Cross-AI dispatch, end to end (E40 item 13, #1296, screen 6): a Code Reviewer
// dispatched from a Claude session ONTO A DIFFERENT AI, whose findings come back
// to the Claude session exactly as a same-AI review's do (`dispatch.spec.ts`).
//
// THE LAUNCH: `SWITCHBOARD_FAKE_PROVIDER=both` registers the Claude fake FIRST
// (so the seeded author card is on `claude-code`, the default, as Claude is on a
// real launch with Codex beside it) and the fake ACP agent AFTER it — the second
// AI. Both hermetic: no login, no network, no tokens.
//
// WHAT ONLY THIS CAN SEE:
//  * "Run it on" is offered, with the author's own AI first and selected;
//  * the dispatched card really starts on the chosen provider (`fake-acp`), not
//    the default — the `defaultProviderId` pin this item removed;
//  * the reviewer gets the Session Bus through THAT provider's own MCP wiring
//    (ACP `session/new` `mcpServers`). The task line carries the fake's `!mcp`
//    directive, so the reviewer's reply NAMES the servers its `session/new` was
//    handed — and `switchboard` (BUS_SERVER_NAME) is the bus. The fake is not an
//    MCP client, so it reports the attachment rather than calling a tool; a real
//    tool call through Codex was measured in #1285 (question 2) and is the
//    owner's hand test;
//  * that reply makes the round trip: a result row on the AUTHOR, one click, and
//    the reviewer's words waiting in the author's composer.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  openEventsDrawer,
  pollAsync,
  registerTempDir,
  sessionStatuses,
} from './fixtures/app';

const FILE = 'total.js';
const COMMITTED = 'export function total(items) {\n  return items.length;\n}\n';
const MARKER = 'CROSS_AI_MARKER';
const WORKING = `export function total(items) {\n  // ${MARKER}\n  return items.length - 1;\n}\n`;

/** A throwaway repo with one uncommitted edit — `dispatch.spec.ts`'s fixture. */
function tempGitProject(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-xai-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  fs.writeFileSync(path.join(dir, FILE), COMMITTED);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(dir, FILE), WORKING);
  return dir;
}

test.describe.configure({ mode: 'serial' });

test.describe('dispatching a Code Reviewer onto another AI (#1296)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  const dialog = (w: Page) => w.locator('[data-testid="dispatch-dialog"]');

  async function liveSessions(
    w: Page
  ): Promise<Array<{ id: string; title: string; providerId: string }>> {
    return await w.evaluate(async () => {
      const rows = (await window.switchboard.sessions.list()) as Array<{
        id: string;
        identity: { title: string; providerId: string };
      }>;
      return rows.map((r) => ({ id: r.id, title: r.identity.title, providerId: r.identity.providerId }));
    });
  }

  test('Run it on: a Claude session’s review runs on the second AI and reports back', async () => {
    test.setTimeout(240_000);
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const w = a.window;
    const project = path.basename(folder);

    await expect(w.getByText(project).first()).toBeVisible({ timeout: 25_000 });
    await pollAsync(async () => {
      const s = await sessionStatuses(a);
      return s.size >= 1 && [...s.values()].every((v) => v !== 'suspended');
    }, 'the author session never came up live', 60_000);

    const before = await liveSessions(w);
    expect(before).toHaveLength(1);
    // The author is on the CLAUDE fake — the default, registered first.
    expect(before[0].providerId).toBe('claude-code');
    const author = before[0];

    // ── the gesture, and the picker ────────────────────────────────────────
    await w.getByTitle('Session menu').click();
    const row = w.getByTestId('card-menu').getByTestId('card-dispatch');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(dialog(w)).toBeVisible({ timeout: 20_000 });

    const runOn = w.getByTestId('dispatch-run-on');
    await expect(runOn).toBeVisible();
    // the author's own AI first, named as such, and the default
    const same = runOn.locator('[data-dispatch-ai="claude-code"]');
    await expect(same).toContainText('Same as this session');
    await expect(same).toHaveAttribute('aria-checked', 'true');
    const other = runOn.locator('[data-dispatch-ai="fake-acp"]');
    await expect(other).toContainText('Fake ACP');
    // nothing is known to be logged out, so nothing is dimmed
    await expect(runOn.locator('[data-dispatch-ai-dimmed]')).toHaveCount(0);
    await other.click();
    await expect(other).toHaveAttribute('aria-checked', 'true');

    // `!mcp`: the fake's reply names the MCP servers `session/new` handed it
    await w.locator('[data-testid="dispatch-task"]').fill('Review total(). !mcp');
    await w.locator('[data-testid="dispatch-go"]').click();
    await expect(dialog(w)).toBeHidden({ timeout: 20_000 });

    // ── A SECOND SESSION, ON THE CHOSEN AI ─────────────────────────────────
    await pollAsync(
      async () => (await liveSessions(w)).length >= 2,
      'the dispatch never produced a second live session',
      90_000
    );
    const reviewer = (await liveSessions(w)).find((s) => s.id !== author.id)!;
    expect(reviewer.title).toContain('Code Reviewer');
    // ⚠️ THE POINT: not the default provider — the one the user picked.
    expect(reviewer.providerId).toBe('fake-acp');

    // ── THE BRIEFING WAS ITS FIRST TURN, and the bus was attached ─────────
    const reviewerFeed = w.locator('[data-feed-region][aria-label*="Code Reviewer"]');
    // The Session Bus, attached through the ACP provider's own `mcpServers`.
    await expect(reviewerFeed.getByText('MCP: switchboard').first()).toBeVisible({ timeout: 60_000 });
    const first = reviewerFeed.locator('[data-feed-block="user"]').first();
    const expander = first.locator('[data-feed-expander]').first();
    if ((await expander.count()) > 0) await expander.click();
    else await first.click();
    const briefing = (await first.innerText()).replace(/\s+/g, ' ');
    // the same clean-room bundle a same-AI review gets: the real diff, the role
    expect(briefing).toContain('clean-room');
    expect(briefing).toContain(MARKER);
    expect(briefing).toContain('You are reviewing a change you did not write');

    // ── THE ROUND TRIP, exactly as `dispatch.spec.ts` asserts it ──────────
    await openEventsDrawer(w);
    const resultRow = w.locator(`[data-event-dispatch="${reviewer.id}"]`);
    await expect(resultRow).toBeVisible({ timeout: 90_000 });
    const authorRow = w.locator(`.event-row[data-event-kind="dispatch-result"]`).first();
    await expect(authorRow).toContainText(author.title);
    await expect(authorRow).toContainText('Code Reviewer');

    await w.locator(`[data-event-inject="${reviewer.id}"]`).click();
    await expect(authorRow).toContainText('waiting in this session', { timeout: 30_000 });

    const authorCard = await pollAsync(async () => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        cardId: string;
        liveId?: string;
      }>;
      return cards.find((c) => c.liveId === author.id)?.cardId ?? null;
    }, 'the author card never reported a live id');
    await w.locator(`[data-rail-open="${authorCard}"]`).click();

    // THE OTHER AI'S OWN WORDS, waiting in the CLAUDE session's composer.
    const held = w.locator('[data-sibling-message]');
    await expect(held).toBeVisible({ timeout: 30_000 });
    await expect(held).toContainText('MCP: switchboard', { timeout: 30_000 });
    await expect(held).toContainText('From @');
    // …and nothing ran: §5.4's rule, unchanged by the reviewer being another AI.
    expect((await sessionStatuses(a)).get(project)).toBe('idle');
  });
});
