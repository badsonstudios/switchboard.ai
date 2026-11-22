// Building a worktree (#1506) against a REAL git and the real file system:
// where it lands, the branch it starts from, copy / share / setup, what a
// failure leaves behind, and the unlink-before-delete guarantee on the one
// cleanup path this step has (discarding a build whose setup failed).
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GitService } from '../git/git-service';
import { runSetupCommand, WorktreeJobs, worktreeRootFor } from './worktree-jobs';
import { isLink } from './worktree-links';
import { pathKey, type ProjectRecord, type WorktreeJob } from '../../shared/projects';
import type { Logger } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';

const gitSvc = new GitService();
const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let repo: string;
let root: string;
let project: ProjectRecord;
let records: ProjectRecord[];
let events: WorktreeJob[];

function makeJobs(runSetup = runSetupCommand): WorktreeJobs {
  return new WorktreeJobs({
    git: gitSvc,
    store: {
      listProjects: () => records.map((p) => ({ ...p })),
      upsertProject: (p) => {
        records = records.map((x) => (x.id === p.id ? { ...p } : x));
        return true;
      },
    },
    root: () => root,
    log,
    emit: (j) => events.push(j),
    runSetup,
  });
}

/** resolves once the job reaches a resting phase */
async function settle(jobs: WorktreeJobs, id: string): Promise<WorktreeJob> {
  const resting = ['ready', 'failed', 'setup-failed'];
  for (let i = 0; i < 600; i++) {
    const j = jobs.list().find((x) => x.id === id);
    if (j && resting.includes(j.phase)) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job never settled');
}

beforeEach(() => {
  const base = tempDir('sb-wtjob-');
  repo = path.join(base, 'myrepo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export {};\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  // the ignored files a fresh worktree is missing
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  root = tempDir('sb-wtroot-');
  project = {
    id: 'p1',
    name: 'myrepo',
    color: '#5e9fe6',
    commonDir: path.join(repo, '.git'),
    primaryPath: repo,
    hiddenWorktrees: [],
    copyFiles: ['.env', 'missing.txt'],
    sharedDirs: ['node_modules', 'src'],
  };
  records = [project];
  events = [];
});

describe('WorktreeJobs', { timeout: 30_000 }, () => {
  it('builds a new branch from the base, outside the repo, with copy and share, then hands it over once', async () => {
    const jobs = makeJobs();
    const started = await jobs.start({
      projectId: 'p1',
      branch: 'feat/one',
      newBranch: true,
      base: 'main',
      title: 'One',
      runSetup: true,
    });
    expect(started?.phase).toBe('creating');
    const done = await settle(jobs, started!.id);
    expect(done.phase).toBe('ready');
    // where it landed: <root>/<repo name>/<branch slug>
    expect(pathKey(done.path)).toBe(pathKey(path.join(root, 'myrepo', 'feat-one')));
    expect(git(done.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/one');
    expect(git(done.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    // no upstream: a later push must not look like a push to main
    expect(() => git(done.path, 'rev-parse', '--abbrev-ref', '@{u}')).toThrow();
    // copy: the ignored .env arrived; the missing file is a warning, not a failure
    expect(fs.readFileSync(path.join(done.path, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(done.warnings).toContainEqual({ code: 'copy-missing', entry: 'missing.txt' });
    // share: node_modules is a link; the TRACKED src folder was refused
    expect(await isLink(path.join(done.path, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(done.path, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(done.warnings).toContainEqual({ code: 'share-not-ignored', entry: 'src' });
    expect(await isLink(path.join(done.path, 'src'))).toBe(false);
    // recorded as made by the app, so the card drops FOUND
    expect(records[0].made).toEqual([pathKey(done.path)]);
    // the window starts the session exactly once
    expect(jobs.claim(done.id)?.title).toBe('One');
    expect(jobs.claim(done.id)).toBeNull();
    expect(jobs.list()).toEqual([]);
    expect(events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(['creating', 'copying', 'linking', 'ready', 'done'])
    );
  });

  it('checks out an existing branch', async () => {
    git(repo, 'branch', 'old-work');
    const jobs = makeJobs();
    const j = await jobs.start({ projectId: 'p1', branch: 'old-work', newBranch: false, runSetup: false });
    const done = await settle(jobs, j!.id);
    expect(done.phase).toBe('ready');
    expect(git(done.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('old-work');
  });

  it("reports git's own words when it refuses, and leaves nothing behind", async () => {
    git(repo, 'branch', 'taken');
    const jobs = makeJobs();
    const j = await jobs.start({ projectId: 'p1', branch: 'taken', newBranch: true, base: 'main', runSetup: false });
    const done = await settle(jobs, j!.id);
    expect(done.phase).toBe('failed');
    expect(done.detail).toMatch(/already exists/);
    expect(fs.existsSync(done.path)).toBe(false);
    expect(records[0].made).toBeUndefined();
    expect(jobs.dismiss(done.id)).toBe(true);
    expect(jobs.list()).toEqual([]);
  });

  it('never reuses a folder: the next free name beside it', async () => {
    fs.mkdirSync(path.join(root, 'myrepo', 'feat-two'), { recursive: true });
    const jobs = makeJobs();
    const j = await jobs.start({ projectId: 'p1', branch: 'feat/two', newBranch: true, runSetup: false });
    const done = await settle(jobs, j!.id);
    expect(path.basename(done.path)).toBe('feat-two-2');
  });

  it('refuses a worktree folder inside the repo (decision 2)', async () => {
    records = [{ ...project, worktreeRoot: path.join(repo, 'wts') }];
    const jobs = makeJobs();
    expect(await jobs.start({ projectId: 'p1', branch: 'x', newBranch: true, runSetup: false })).toBeNull();
    expect(worktreeRootFor(records[0], root)).toBeNull();
  });

  it('refuses a branch that could become a flag', async () => {
    const jobs = makeJobs();
    expect(await jobs.start({ projectId: 'p1', branch: '-b', newBranch: true, runSetup: false })).toBeNull();
    expect(await jobs.start({ projectId: 'nope', branch: 'x', newBranch: true, runSetup: false })).toBeNull();
  });

  it('a failed setup keeps the worktree; discarding it unlinks node_modules FIRST and the real one survives', async () => {
    records = [{ ...project, setupCommand: 'node -e "process.exit(3)"' }];
    const jobs = makeJobs();
    const j = await jobs.start({ projectId: 'p1', branch: 'feat/bad', newBranch: true, base: 'main', runSetup: true });
    const failed = await settle(jobs, j!.id);
    expect(failed.phase).toBe('setup-failed');
    expect(failed.detail).toMatch(/code 3/);
    expect(await isLink(path.join(failed.path, 'node_modules'))).toBe(true);

    expect(await jobs.discard(failed.id)).toBe(true);
    expect(fs.existsSync(failed.path)).toBe(false);
    // #916: the real node_modules the worktree linked to is untouched
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toContain('module.exports');
    // the brand-new branch had nothing on it, so it went too
    expect(git(repo, 'branch', '--list', 'feat/bad')).toBe('');
    expect(records[0].made ?? []).toEqual([]);
    expect(jobs.list()).toEqual([]);
  });

  it('a failed setup can still start the session (claim), keeping the worktree', async () => {
    const jobs = makeJobs(async () => ({ ok: false, detail: 'setup exited with code 1: boom' }));
    records = [{ ...project, setupCommand: 'anything' }];
    const j = await jobs.start({ projectId: 'p1', branch: 'feat/anyway', newBranch: true, runSetup: true });
    const failed = await settle(jobs, j!.id);
    expect(failed.phase).toBe('setup-failed');
    expect(jobs.claim(failed.id)?.path).toBe(failed.path);
    expect(fs.existsSync(failed.path)).toBe(true);
  });

  it('skips setup when the dialog unticked it', async () => {
    let ran = false;
    const jobs = makeJobs(async () => {
      ran = true;
      return { ok: true, detail: '' };
    });
    records = [{ ...project, setupCommand: 'npm ci' }];
    const j = await jobs.start({ projectId: 'p1', branch: 'feat/quick', newBranch: true, runSetup: false });
    expect((await settle(jobs, j!.id)).phase).toBe('ready');
    expect(ran).toBe(false);
  });
});
