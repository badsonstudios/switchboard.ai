// #1271 — MCP calls, web calls and edits to one file fold too.
//
// The owner: "We did a good job on bundling together different bash commands,
// but MCP plugin commands are still not grouped. I see in a session right now
// at least 20 MCP plugin calls in a row for Atlassian."
//
// The rules are unit tested in `lib/feed-folds.test.ts` and what the row says
// in `FeedView.folds.test.tsx`. What is left for the real app:
//
//   * THE WHOLE WAY, from the tool name the CLI writes: main reads the server
//     off `mcp__plugin_atlassian_atlassian__getJiraIssue`, the window folds on
//     it, and a conversation rebuilt from the transcript after a restart says
//     the same. (`feed-folds.spec.ts` makes the same journey for a failed
//     command, and for the same reason.)
//   * what jsdom cannot see: that twenty calls take one row's height, and that
//     a long list of tools does not push the conversation sideways.
//   * a call that is still waiting stays on screen, outside the closed row.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const ATL = 'mcp__plugin_atlassian_atlassian__';
const PROMPT = 'triage the board';

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

/**
 * One turn, as the fake CLI will play it: twenty Atlassian calls with one that
 * fails and one that creates something; three calls to another server; a burst
 * on the web; five edits to one file and then two to another.
 */
function script(folder: string): Record<string, unknown> {
  let n = 0;
  const call = (name: string, input: Record<string, unknown>, more: Partial<Call> = {}): Call => ({
    id: `toolu_kinds_${++n}`,
    name,
    input,
    result: `RESULT_${n}`,
    ...more,
  });
  const file = path.join(folder, 'src', 'FeedView.tsx');
  const other = path.join(folder, 'src', 'other.ts');
  const edit = (f: string, i: number): Call =>
    call('Edit', { file_path: f, old_string: `OLD_${i}`, new_string: `NEW_${i}` });
  return {
    [PROMPT]: {
      say: 'Reading the board.',
      tools: [
        ...Array.from({ length: 9 }, (_, i) => call(`${ATL}getJiraIssue`, { issueIdOrKey: `SB-${i}` })),
        call(`${ATL}getJiraIssue`, { issueIdOrKey: 'SB-404' }, { result: 'ISSUE_NOT_FOUND', isError: true }),
        ...Array.from({ length: 5 }, (_, i) => call(`${ATL}searchJiraIssuesUsingJql`, { jql: `q${i}` })),
        call(`${ATL}createJiraIssue`, { summary: 'A new one' }),
        ...Array.from({ length: 4 }, (_, i) => call(`${ATL}getJiraIssue`, { issueIdOrKey: `SB-9${i}` })),
        // a second server straight after: its own run
        ...Array.from({ length: 3 }, (_, i) => call('mcp__github__get_issue', { number: i })),
        // the web
        call('WebSearch', { query: 'jira jql order by' }),
        call('WebFetch', { url: 'https://www.atlassian.com/software/jira/guides', prompt: 'read it' }),
        call('WebFetch', { url: 'https://support.atlassian.com/jira/kb/jql', prompt: 'read it' }),
        call('WebFetch', { url: 'https://www.atlassian.com/blog', prompt: 'read it' }),
        // one file, five times; then another, twice
        ...[1, 2, 3, 4, 5].map((i) => edit(file, i)),
        ...[6, 7].map((i) => edit(other, i)),
      ],
      then: 'KINDS_DONE all of it.',
    },
  };
}

test.describe('MCP calls, web calls and same-file edits fold (#1271)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  const folds = (w: Page, kind: string) => w.locator(`[data-feed-fold][data-feed-fold-kind="${kind}"]`);

  test('from main, live and after a restart: one row per server, per burst and per file', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    const scriptFile = path.join(folder, 'fake-script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(folder)), 'utf8');
    const env = { ...DIRECT, SWITCHBOARD_FAKE_SCRIPT: scriptFile };
    const first = await launchApp({ seedFolder: folder, env });
    a = first;
    const w1 = first.window;
    await expect(w1.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    const box = w1.getByPlaceholder(/^Message .+…$/);
    await box.click();
    await box.fill(PROMPT);
    await box.press('Enter');
    await expect(w1.getByText('KINDS_DONE').first()).toBeAttached({ timeout: 60_000 });

    const check = async (w: Page): Promise<void> => {
      // ── MCP: nine, the one that FAILED, ten; then the other server ─────────
      const mcp = folds(w, 'mcp');
      await expect(mcp).toHaveCount(3, { timeout: 60_000 });
      await expect(mcp.nth(0).locator('[data-feed-fold-title]')).toHaveText('Atlassian');
      await expect(mcp.nth(0)).toContainText('9 calls');
      await expect(mcp.nth(0).locator('[data-feed-fold-parts]')).toHaveText('getJiraIssue ×9');
      // the second Atlassian run: the call that made something leads the list
      await expect(mcp.nth(1).locator('[data-feed-fold-title]')).toHaveText('Atlassian');
      await expect(mcp.nth(1)).toContainText('10 calls');
      await expect(mcp.nth(1).locator('[data-feed-fold-parts]')).toHaveText(
        'createJiraIssue, getJiraIssue ×4, searchJiraIssuesUsingJql ×5'
      );
      // two servers never share a row
      await expect(mcp.nth(2).locator('[data-feed-fold-title]')).toHaveText('Github');
      await expect(mcp.nth(2)).toContainText('3 calls');
      // the failed call is on screen without opening anything
      const failed = w.locator('[data-feed-failed]');
      await expect(failed).toHaveCount(1);
      await expect(w.locator('[data-feed-block]').filter({ has: failed })).toContainText('getJiraIssue');

      // ── the web ───────────────────────────────────────────────────────────
      const web = folds(w, 'web');
      await expect(web).toHaveCount(1);
      await expect(web.locator('[data-feed-fold-title]')).toHaveText('Searched the web');
      await expect(web).toContainText('1 search, 3 pages');
      await expect(web.locator('[data-feed-fold-parts]')).toHaveText(
        'jira jql order by, atlassian.com ×2, support.atlassian.com'
      );

      // ── edits: five to one file fold; two to another do not ───────────────
      const edits = folds(w, 'edit');
      await expect(edits).toHaveCount(1);
      await expect(edits.locator('[data-feed-fold-title]')).toHaveText('Edited FeedView.tsx');
      await expect(edits).toContainText('5 changes');
      await expect(w.locator('[data-feed-block]').filter({ hasText: 'other.ts' })).toHaveCount(2);

      // ── opening the edits shows every one, with its diff ──────────────────
      await edits.locator('button[data-feed-expander]').click();
      for (const i of [1, 2, 3, 4, 5]) {
        await expect(w.getByText(`NEW_${i}`, { exact: false }).first()).toBeAttached();
      }
      await edits.locator('button[data-feed-expander]').click();
      await expect(w.getByText('NEW_3', { exact: false })).toHaveCount(0);
    };
    await check(w1);

    // quit and come back: the conversation is rebuilt from the transcript on
    // disk, a different path through main, and must say the same
    await first.close();
    a = await launchApp({ home: first.home, env });
    await expect(a.window.getByText('KINDS_DONE').first()).toBeAttached({ timeout: 60_000 });
    await check(a.window);
  });

  // ── the claims about the window itself: blocks injected on the live channel ─
  interface Block {
    seq: number;
    kind: string;
    sidechain: boolean;
    text?: string;
    tool?: Record<string, unknown>;
  }
  const say = (seq: number, text: string, kind = 'assistant'): Block => ({ seq, kind, sidechain: false, text });
  const mcpBlock = (seq: number, tool: string, over: Record<string, unknown> = {}): Block => ({
    seq,
    kind: 'tool',
    sidechain: false,
    tool: {
      name: `${ATL}${tool}`,
      category: 'other',
      summary: '',
      detail: `{"n":${seq}}`,
      out: `RESULT_${seq}`,
      mcp: { server: 'plugin_atlassian_atlassian', tool },
      ...over,
    },
  });

  async function open(width = 1100): Promise<{ w: Page; inject: (blocks: Block[]) => Promise<void> }> {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const app = a;
    const w = app.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await app.app.evaluate(({ BrowserWindow }, wd) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: wd, height: 760 });
    }, width);
    const liveId = await pollAsync(async () => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        liveId?: string;
      }>;
      return cards.find((c) => c.title === title)?.liveId ?? null;
    }, 'no live session to stream into');
    await expect(w.locator('[data-feed-region]')).toBeVisible({ timeout: 25_000 });
    const inject = (blocks: Block[]): Promise<void> =>
      app.app.evaluate(
        ({ BrowserWindow }, { id, list }) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          for (const block of list) wc.send('sessions:feedBlock', { sessionId: id, block });
        },
        { id: liveId, list: blocks }
      );
    return { w, inject };
  }

  test('twenty Atlassian calls take one row, and the sentences around them are both on screen', async () => {
    const { w, inject } = await open();
    await inject([say(101, 'triage the board', 'user'), say(102, 'BEFORE_THE_BURST reading issues.')]);
    await inject([
      ...Array.from({ length: 14 }, (_, i) => mcpBlock(103 + i, 'getJiraIssue')),
      ...Array.from({ length: 6 }, (_, i) => mcpBlock(117 + i, 'searchJiraIssuesUsingJql')),
    ]);
    await inject([say(123, 'AFTER_THE_BURST here is what I found.')]);
    await expect(w.getByText('AFTER_THE_BURST')).toBeVisible({ timeout: 15_000 });

    const fold = folds(w, 'mcp');
    await expect(fold).toHaveCount(1);
    await expect(fold.locator('[data-feed-fold-title]')).toHaveText('Atlassian');
    await expect(fold).toContainText('20 calls');
    await expect(fold.locator('[data-feed-fold-parts]')).toHaveText(
      'searchJiraIssuesUsingJql ×6, getJiraIssue ×14'
    );
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
    expect((await fold.boundingBox())!.height).toBeLessThan(60);
    await expect(w.getByText('BEFORE_THE_BURST')).toBeInViewport();
    await expect(w.getByText('AFTER_THE_BURST')).toBeInViewport();

    // open: all twenty, and the row you clicked is where you clicked it
    const before = (await fold.boundingBox())!;
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(20);
    expect(Math.abs((await fold.boundingBox())!.y - before.y)).toBeLessThan(4);
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
  });

  test('a call still waiting on its result is a row of its own under the fold, and joins when it is in', async () => {
    const { w, inject } = await open();
    await inject([say(101, 'triage the board', 'user')]);
    await inject([103, 104, 105].map((seq) => mcpBlock(seq, 'getJiraIssue')));
    const fold = folds(w, 'mcp');
    await expect(fold).toContainText('3 calls', { timeout: 15_000 });

    // asked, not answered: this is what a call held for approval looks like
    await inject([mcpBlock(106, 'createJiraIssue', { out: undefined })]);
    const waiting = w.locator('[data-feed-seq="106"]');
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText('createJiraIssue');
    await expect(fold).toContainText('3 calls');
    await expect(fold).not.toContainText('createJiraIssue');

    // its result arrives (the block is sent again with it): now it folds
    await inject([mcpBlock(106, 'createJiraIssue')]);
    await expect(fold).toContainText('4 calls');
    await expect(fold.locator('[data-feed-fold-parts]')).toHaveText('createJiraIssue, getJiraIssue ×3');
    await expect(waiting).toHaveCount(0);
  });

  test('a long list of tools on a narrow card is cut short, not spilled: nothing scrolls sideways', async () => {
    // the narrowest the window goes (main holds it at 800)
    const { w, inject } = await open(800);
    await inject([say(101, 'triage the board', 'user')]);
    const tools = Array.from({ length: 12 }, (_, i) => `aVeryLongAtlassianToolNameNumber${i}`);
    await inject(tools.map((t, i) => mcpBlock(103 + i, t)));
    const fold = folds(w, 'mcp');
    await expect(fold).toContainText('12 calls', { timeout: 15_000 });

    const sizes = await w.locator('[data-feed-region]').evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
    // every one of them is still there to be read, one hover away
    const parts = fold.locator('[data-feed-fold-parts]');
    expect(await parts.getAttribute('title')).toBe(tools.join(', '));
    // the row spells out eight and counts the rest
    await expect(parts).toContainText('and 4 more');
    // and the server's name and the count, which matter most, are not what gave way
    await expect(fold.locator('[data-feed-fold-title]')).toBeVisible();
    const title = (await fold.locator('[data-feed-fold-title]').boundingBox())!;
    expect(title.width).toBeGreaterThan(40);

    // A LONG SERVER NAME (found in review): the name shortens itself, and
    // "12 calls" is never cut to "12 c…" to make room for it
    const longServer = `team_${'x'.repeat(90)}_tools`;
    await inject([say(200, 'and the other one', 'user')]);
    await inject(
      tools.map((t, i) => mcpBlock(201 + i, t, { name: `mcp__${longServer}__${t}`, mcp: { server: longServer, tool: t } }))
    );
    const second = folds(w, 'mcp').nth(1);
    await expect(second).toContainText('12 calls', { timeout: 15_000 });
    const count = second.locator('[data-feed-fold-count]');
    await expect(count).toHaveText('12 calls');
    const clipped = await count.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clipped).toBeLessThanOrEqual(1);
    expect(await second.locator('[data-feed-fold-title]').getAttribute('title')).toBe(longServer);
    const after = await w.locator('[data-feed-region]').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(after).toBeLessThanOrEqual(1);
  });
});
