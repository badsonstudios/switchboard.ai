// Reopening a conversation whose folder is gone (#1643) — in the real app.
//
// A repo opened as a project, and a conversation on disk that ran in a worktree
// of that repo which no longer exists. History marks the row "folder removed";
// picking it asks where to reopen it and offers the project's main folder; the
// card made there resumes the conversation (its history replays into the Feed),
// and does so again after a restart.
//
// Only the real app can show the whole chain: the mark comes from main's stat
// of the row's folder, the suggestion from the project records, the resume from
// the start plan looking where the conversation is filed, and the restart from
// the card having recorded it.
import { test, expect, Page, Locator } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
/** `slugForCwd`, restated — see `session-history.spec.ts` for why it is a copy. */
const slug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};
const row = (within: Page | Locator, title: string): Locator => {
  const page = 'page' in within ? within.page() : within;
  return within.locator('.rail-row').filter({ has: page.locator('[data-rail-title]', { hasText: title }) });
};

const TITLE = 'Work done in the removed worktree';
const ASK = 'the opening ask from the removed worktree';

test.describe('reopening a conversation whose folder is gone (#1643)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await teardown(launched);
  });

  test('[direct] History marks it, offers the main folder, and the card keeps resuming it', async () => {
    test.setTimeout(180_000);
    const base = tempProjectFolder();
    const repo = path.join(base, 'gone-repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    // the worktree it ran in is gone: only its conversation is left
    const gone = path.join(repo, '.claude', 'worktrees', 'removed');
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-gone-')));
    const conversation = '16431643-aaaa-4bbb-8ccc-dddddddddddd';
    const dir = path.join(home, '.claude', 'projects', slug(gone));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${conversation}.jsonl`),
      [
        JSON.stringify({ type: 'user', isSidechain: false, cwd: gone, message: { role: 'user', content: ASK }, uuid: 'u1' }),
        JSON.stringify({ type: 'ai-title', aiTitle: TITLE, sessionId: conversation }),
      ].join('\n') + '\n'
    );

    a = await launchApp({ seedFolder: repo, home, env: DIRECT });
    const first = a;
    const w = first.window;
    await expect(row(w, 'gone-repo')).toBeVisible({ timeout: 25_000 });

    // ── the repo is a project, so main knows the gone folder was its worktree ──
    await first.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, repo);
    await w.locator('[data-rail-open-project]').click();
    const dlg = w.getByTestId('open-project-dialog');
    await dlg.locator('[data-open-project-browse]').click();
    await expect(dlg.locator('[data-open-project-status]')).toHaveAttribute('data-open-project-status', 'repo', {
      timeout: 15_000,
    });
    await dlg.locator('[data-open-project-ok]').click();
    await expect(w.locator('[data-project-card]')).toBeVisible({ timeout: 15_000 });

    // ── History, all projects: the row says its folder is gone ──
    await w.locator('[data-testid="card-history"]').first().click();
    await w.locator('[data-history-scope]').click();
    await expect(w.locator('[data-history-scope]')).toHaveAttribute('data-history-scope', 'all');
    const listed = w.locator('[data-history-row]').filter({ hasText: TITLE });
    await expect(listed).toBeVisible({ timeout: 15_000 });
    await expect(listed.locator('[data-history-gone]')).toHaveText('folder removed');

    // ── picking it asks where, and offers the project's main folder ──
    await listed.click();
    const ok = w.locator('[data-history-confirm-ok]');
    await expect(ok).toHaveText('Reopen in gone-repo');
    await expect(w.locator('[data-history-confirm-alt]')).toHaveText('Choose a folder…');
    await ok.click();
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0);

    // ── a second card, in the main folder, carrying the conversation on ──
    await expect(w.locator('nav .rail-row')).toHaveCount(2, { timeout: 25_000 });
    await expect(w.getByText(ASK).first()).toBeVisible({ timeout: 25_000 });

    // ── and again after a restart, from the card alone ──
    await w.waitForTimeout(900); // debounced store save
    await first.close();
    a = await launchApp({ home: first.home, env: DIRECT });
    await expect(a.window.locator('nav .rail-row')).toHaveCount(2, { timeout: 25_000 });
    await expect(a.window.getByText(ASK).first()).toBeVisible({ timeout: 30_000 });
  });
});
