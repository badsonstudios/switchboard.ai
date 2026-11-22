// The session follows its agent into a worktree (#1616) — in the real app.
//
// A temp repo with one linked worktree, opened as a project, and a Direct
// session in the primary checkout. The fake CLI's `!worktree <path>` plays
// Claude's own `EnterWorktree` (result shape measured against CLI 2.1.322,
// `spike/probes/1616/`). Then: one quiet Feed line, the card's header names
// the worktree, the card moves to the worktree's section of the project card,
// the Changes view reads the worktree's files; `!worktree-exit` undoes all four.
//
// Only the real app can show this end to end: the move is read off the stream
// in main, stored on the card, and every view re-reads it from `sessions:cards`.
import { test, expect, Page, Locator } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';
import { pathKey } from '../src/shared/projects';

test.afterAll(async () => teardown());

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

const row = (within: Page | Locator, title: string): Locator => {
  const page = 'page' in within ? within.page() : within;
  return within.locator('.rail-row').filter({ has: page.locator('[data-rail-title]', { hasText: title }) });
};

test.describe('the session follows its agent into a worktree (#1616)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await teardown(launched);
  });

  test('[direct] EnterWorktree moves the Feed line, the header, the project section and the Changes view', async () => {
    test.setTimeout(150_000);
    const base = tempProjectFolder();
    const repo = path.join(base, 'follow-repo');
    const linked = path.join(base, 'follow-wt');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/follow', linked);
    // a change that exists only in the worktree, so the Changes view can show it
    fs.writeFileSync(path.join(linked, 'ONLY_IN_WORKTREE.txt'), 'x\n');

    a = await launchApp({ seedFolder: repo, env: DIRECT });
    const w = a.window;
    const title = 'follow-repo';
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('[data-feed-region]')).toBeVisible({ timeout: 25_000 });

    // ── open the repo as a project, so the card has worktree sections ──
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, repo);
    await w.locator('[data-rail-open-project]').click();
    const dlg = w.getByTestId('open-project-dialog');
    await dlg.locator('[data-open-project-browse]').click();
    await expect(dlg.locator('[data-open-project-worktrees] > div')).toHaveCount(2, { timeout: 15_000 });
    await dlg.locator('[data-open-project-ok]').click();
    const card = w.locator('[data-project-card]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const sections = card.locator('[data-project-worktree]');
    const primary = sections.filter({ has: w.locator('[data-worktree-primary]') });
    const other = sections.filter({ has: w.locator('[data-worktree-found]') });
    await expect(row(primary, title)).toBeVisible();

    // ── the agent moves itself into the linked worktree ──
    const say = streamPrompter(a);
    await say(title, `!worktree ${linked}`);
    const moved = w.locator('[data-moved-line][data-moved-to="worktree"]');
    await expect(moved).toBeVisible({ timeout: 20_000 });
    await expect(moved).toContainText('Moved to worktree follow-wt');
    await expect(w.getByTestId('card-worktree')).toHaveText('in follow-wt', { timeout: 15_000 });
    // main stored it, and says so on the card
    const workFolder = async (): Promise<string | undefined> => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        workFolder?: string;
      }>;
      return cards.find((c) => c.title === title)?.workFolder;
    };
    await expect.poll(async () => pathKey((await workFolder()) ?? '')).toBe(pathKey(linked));
    // the card moved to the worktree's section
    await expect(row(other, title)).toBeVisible({ timeout: 15_000 });
    await expect(row(primary, title)).toHaveCount(0);
    // the Changes view reads the worktree, where the agent is working
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
    await expect(w.getByText('ONLY_IN_WORKTREE.txt').first()).toBeVisible({ timeout: 15_000 });

    // ── and back ──
    await w.locator('[data-testid="view-tabs"] [data-vtab="feed"]').first().click();
    await say(title, '!worktree-exit');
    await expect(w.locator('[data-moved-line][data-moved-to="folder"]')).toBeVisible({ timeout: 20_000 });
    await expect(w.getByTestId('card-worktree')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(workFolder).toBeUndefined();
    await expect(row(primary, title)).toBeVisible({ timeout: 15_000 });
  });
});
