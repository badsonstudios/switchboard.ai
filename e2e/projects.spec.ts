// Projects in the Sessions list (E42 step 1, #1637) — in the real app.
//
// A temp repo with one linked worktree. Opened as a project, the card must show
// both worktrees with the seeded session under the primary one; the ⊕ on the
// linked worktree starts a session THERE, and it lands under that worktree;
// removing the project stops no session and puts both back in the plain list.
//
// Only the real app can show this: the card's membership comes from `git
// rev-parse --git-common-dir` in main, the worktrees from `git worktree list`,
// and the new session's folder from the worktree row, through the ordinary
// new-session flow.
import { test, expect, Page, Locator } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

/** a session's row, inside `within` (the page, or one worktree section) */
const row = (within: Page | Locator, title: string): Locator => {
  const page = 'page' in within ? within.page() : within;
  return within
    .locator('.rail-row')
    .filter({ has: page.locator('[data-rail-title]', { hasText: title }) });
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

test.describe('projects (#1637)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await teardown(launched);
  });

  test('open a repo as a project, start a session in a worktree, remove the project', async () => {
    test.setTimeout(150_000);
    const base = tempProjectFolder();
    const repo = path.join(base, 'proj-repo');
    const linked = path.join(base, 'proj-wt');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/e2e', linked);

    a = await launchApp({ seedFolder: repo });
    const w = a.window;
    await expect(row(w, 'proj-repo')).toBeVisible({ timeout: 25_000 });

    // ── 1. Open project: the dialog reads the repo and lists both worktrees ──
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, repo);
    await w.locator('[data-rail-open-project]').click();
    const dlg = w.getByTestId('open-project-dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-open-project-browse]').click();
    await expect(dlg.locator('[data-open-project-status]')).toHaveAttribute(
      'data-open-project-status',
      'repo',
      { timeout: 15_000 }
    );
    await expect(dlg.locator('[data-open-project-worktrees] > div')).toHaveCount(2);
    await expect(dlg).toContainText('1 open session in this repo moves into the project');
    await dlg.locator('[data-open-project-ok]').click();
    await expect(dlg).toBeHidden();

    // ── 2. The card: two worktrees, the seeded session under the primary ──
    const card = w.locator('[data-project-card]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('[data-project-name]')).toHaveText('proj-repo');
    const sections = card.locator('[data-project-worktree]');
    await expect(sections).toHaveCount(2);
    const primary = sections.filter({ has: w.locator('[data-worktree-primary]') });
    const other = sections.filter({ has: w.locator('[data-worktree-found]') });
    await expect(primary.locator('[data-worktree-branch]')).toContainText('main');
    await expect(other.locator('[data-worktree-branch]')).toContainText('feat/e2e');
    await expect(row(primary, 'proj-repo')).toBeVisible();
    await expect(other.locator('[data-worktree-empty]')).toBeVisible();

    // ── 3. ⊕ on the linked worktree starts a session in ITS folder ──
    await other.locator('[data-worktree-new-session]').click();
    const name = w.getByTestId('name-session-dialog');
    if (await name.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await name.locator('[data-name-session-input]').fill('in the worktree');
      await name.locator('[data-name-session-ok]').click();
    }
    await expect(other.locator('.rail-row')).toHaveCount(1, { timeout: 25_000 });
    await expect(other.locator('[data-worktree-empty]')).toHaveCount(0);

    // ── 4. Remove the project: the card goes, the sessions stay ──
    await card.locator('[data-project-menu]').click();
    await w.getByTestId('project-menu').getByRole('menuitem', { name: 'Remove project from the list' }).click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await expect(row(w, 'proj-repo')).toBeVisible();
    await expect(w.locator('nav .rail-row')).toHaveCount(2);
  });
});
