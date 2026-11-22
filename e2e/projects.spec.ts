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

  // ── step 2 (#1506): make a worktree from the project, and the busy-folder prompt ──
  test('project settings, then ＋ builds a worktree outside the repo and starts its session', async () => {
    test.setTimeout(180_000);
    const base = tempProjectFolder();
    const repo = path.join(base, 'mk-repo');
    const wtRoot = path.join(base, 'wt-root');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nlocal.cfg\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'local.cfg'), 'x=1\n');

    a = await launchApp({ seedFolder: repo });
    const w = a.window;
    await expect(row(w, 'mk-repo')).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, repo);
    await w.locator('[data-rail-open-project]').click();
    const open = w.getByTestId('open-project-dialog');
    await open.locator('[data-open-project-browse]').click();
    await expect(open.locator('[data-open-project-status]')).toHaveAttribute('data-open-project-status', 'repo', {
      timeout: 15_000,
    });
    await open.locator('[data-open-project-ok]').click();
    const card = w.locator('[data-project-card]');
    await expect(card).toBeVisible({ timeout: 15_000 });

    // ── 1. Project settings: a folder outside the repo, copy, share, setup ──
    await card.locator('[data-project-menu]').click();
    await w.getByTestId('project-menu').getByRole('menuitem', { name: 'Project settings…' }).click();
    const settings = w.getByTestId('project-settings-dialog');
    await expect(settings).toBeVisible();
    await settings.locator('[data-project-settings-root]').fill(wtRoot);
    await settings.locator('[data-project-settings-copy]').fill('local.cfg');
    // README.md is tracked: main refuses to share it and says so
    await settings.locator('[data-project-settings-share]').fill('node_modules\nREADME.md');
    await settings.locator('[data-project-settings-setup]').fill('node -e "1"');
    await settings.locator('[data-project-settings-save]').click();
    await expect(settings.locator('[data-project-settings-problems]')).toContainText('README.md');
    await settings.locator('[data-project-settings-share]').fill('node_modules');
    await settings.locator('[data-project-settings-save]').click();
    await expect(settings).toBeHidden({ timeout: 10_000 });

    // ── 2. ＋ on the project: the dialog closes at once, the build shows, the session starts ──
    await card.locator('[data-project-new-worktree]').click();
    const dlg = w.getByTestId('new-worktree-dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-new-worktree-purpose]').fill('e2e work');
    await expect(dlg.locator('[data-new-worktree-branch]')).toHaveValue('e2e-work');
    await dlg.locator('[data-new-worktree-ok]').click();
    await expect(dlg).toBeHidden();

    const made = card.locator('[data-project-worktree]').filter({
      has: w.locator('[data-worktree-branch]', { hasText: 'e2e-work' }),
    });
    await expect(made).toHaveCount(1, { timeout: 60_000 });
    // made by the app: no FOUND tag
    await expect(made.locator('[data-worktree-found]')).toHaveCount(0);
    await expect(row(made, 'e2e work')).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('[data-worktree-job]')).toHaveCount(0);

    const folder = path.join(wtRoot, 'mk-repo', 'e2e-work');
    expect(fs.readFileSync(path.join(folder, 'local.cfg'), 'utf8')).toBe('x=1\n');
    expect(fs.lstatSync(path.join(folder, 'node_modules')).isSymbolicLink()).toBe(true);
    // unlink before anything deletes the temp folder (#916)
    fs.unlinkSync(path.join(folder, 'node_modules'));
    expect(fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  test('a plain session in a checkout another session is using asks first', async () => {
    test.setTimeout(150_000);
    const base = tempProjectFolder();
    const repo = path.join(base, 'busy-repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    a = await launchApp({ seedFolder: repo });
    const w = a.window;
    await expect(row(w, 'busy-repo')).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, repo);

    await w.locator('[data-rail-add-session]').click();
    const busy = w.getByTestId('busy-folder-dialog');
    await expect(busy).toBeVisible({ timeout: 15_000 });
    await expect(busy).toContainText('busy-repo');
    // "Share folder" carries on to the ordinary start
    await busy.locator('[data-busy-folder-share]').click();
    await expect(busy).toBeHidden();
    const name = w.getByTestId('name-session-dialog');
    if (await name.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await name.locator('[data-name-session-ok]').click();
    }
    await expect(w.locator('nav .rail-row')).toHaveCount(2, { timeout: 25_000 });

    // "New worktree…" opens the new-worktree dialog (opening the repo as a project), never a silent create
    await w.locator('[data-rail-add-session]').click();
    await expect(busy).toBeVisible({ timeout: 15_000 });
    await busy.locator('[data-busy-folder-worktree]').click();
    await expect(w.getByTestId('new-worktree-dialog')).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-project-card]')).toHaveCount(1);
    await w.getByTestId('new-worktree-dialog').locator('[data-new-worktree-cancel]').click();
    await expect(w.locator('nav .rail-row')).toHaveCount(2);
  });
});
