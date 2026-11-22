// Finishing a worktree (#1638) against a REAL git, a bare "remote" on disk and
// the real file system. `gh` is a stand-in that records what it was asked, so
// nothing here touches the network or anyone's GitHub account.
//
// The done-when: each action works on a temp repo with a bare remote; removal
// refuses dirty work, keeps unmerged branches, and never deletes through a
// link into a shared folder (a junction on Windows).
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GitService } from '../git/git-service';
import { WorktreeFinisher } from './worktree-finish';
import { linkDir, isLink } from './worktree-links';
import type { GhRun, GhRunner } from './gh-cli';
import { pathKey, type ProjectRecord, type WorktreeInfo } from '../../shared/projects';
import type { Logger } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';

const gitSvc = new GitService();
const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(cwd: string, file: string, text: string, msg: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

let base: string;
let remote: string;
let repo: string;
let records: ProjectRecord[];
let ghCalls: Array<{ args: string[]; input?: string }>;
let ghAnswer: (args: string[]) => GhRun;

const gh: GhRunner = async (args, _cwd, opts) => {
  ghCalls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
  return ghAnswer(args);
};

function finisher(): WorktreeFinisher {
  return new WorktreeFinisher({
    git: gitSvc,
    gh,
    log,
    store: {
      listProjects: () => records.map((p) => ({ ...p })),
      upsertProject: (p) => {
        records = records.map((x) => (x.id === p.id ? { ...p } : x));
        return true;
      },
    },
  });
}

/** git's own spelling of a folder (8.3 short temp names on Windows CI come back long) */
const gitPath = (folder: string): string => path.normalize(git(folder, 'rev-parse', '--show-toplevel'));

function addWorktree(branch: string, from = 'origin/main'): string {
  const p = path.join(base, 'wts', branch.replace(/\//g, '-'));
  git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, p, from);
  return gitPath(p);
}

beforeEach(() => {
  base = tempDir('sb-wtfin-');
  remote = path.join(base, 'remote.git');
  repo = path.join(base, 'myrepo');
  fs.mkdirSync(repo);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  records = [
    {
      id: 'p1',
      name: 'myrepo',
      color: '#5e9fe6',
      commonDir: path.join(repo, '.git'),
      primaryPath: repo,
      hiddenWorktrees: [],
      sharedDirs: ['node_modules'],
    },
  ];
  ghCalls = [];
  ghAnswer = () => ({ ok: true, out: '[]', err: '' });
});

/** move main on (in the primary checkout) and publish it */
function advanceMain(file = 'b.txt', text = 'bee\n'): void {
  commit(repo, file, text, `main: ${file}`);
  git(repo, 'push', '-q', 'origin', 'main');
}

describe('WorktreeFinisher', { timeout: 60_000 }, () => {
  it('counts ahead / behind and the lines a worktree changes, committed or not', async () => {
    const wt = addWorktree('feat/stats');
    commit(wt, 'c.txt', 'x\ny\n', 'two lines');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\nthree\n'); // uncommitted: +1 -1
    advanceMain();
    git(repo, 'fetch', '-q');
    const stats = await finisher().stats('p1');
    expect(stats).toMatchObject({ projectId: 'p1', hasRemote: true, base: 'origin/main' });
    const s = stats?.worktrees.find((x) => pathKey(x.path) === pathKey(wt));
    expect(s).toMatchObject({ base: 'origin/main', ahead: 1, behind: 1, added: 3, removed: 1 });
  });

  it('Update from main merges the base in, and says when there is nothing to bring', async () => {
    const wt = addWorktree('feat/update');
    commit(wt, 'c.txt', 'mine\n', 'mine');
    advanceMain();
    const f = finisher();
    const r = await f.update('p1', wt);
    expect(r).toEqual({ kind: 'merged', base: 'origin/main', commits: 1 });
    expect(fs.readFileSync(path.join(wt, 'b.txt'), 'utf8')).toBe('bee\n');
    // a merge, not a rebase: the branch's own commit is still its own
    expect(git(wt, 'log', '--format=%s', '-1', 'HEAD^2')).toBe('main: b.txt');
    expect(await f.update('p1', wt)).toEqual({ kind: 'up-to-date', base: 'origin/main' });
  });

  it('Update refuses uncommitted work and lists the files; nothing is stashed or touched', async () => {
    const wt = addWorktree('feat/dirty');
    advanceMain();
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    const r = await finisher().update('p1', wt);
    expect(r).toMatchObject({ kind: 'refused', code: 'dirty', files: ['a.txt'] });
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(fs.existsSync(path.join(wt, 'b.txt'))).toBe(false);
  });

  it('on conflicts the folder is LEFT mid-merge with the files listed, and Abort puts it back', async () => {
    const wt = addWorktree('feat/clash');
    commit(wt, 'a.txt', 'one\nmine\nthree\n', 'mine');
    advanceMain('a.txt', 'one\ntheirs\nthree\n');
    const f = finisher();
    const r = await f.update('p1', wt);
    expect(r).toEqual({ kind: 'conflicts', base: 'origin/main', files: ['a.txt'] });
    // never resolved silently: git's markers are in the file, the merge is open
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await gitSvc.mergeInProgress(wt)).toBe(true);
    // a second update says a merge is already stopped there, and which files
    expect(await f.update('p1', wt)).toMatchObject({ kind: 'refused', code: 'merge-in-progress', files: ['a.txt'] });
    expect(await f.abortUpdate('p1', wt)).toBe(true);
    expect(await gitSvc.mergeInProgress(wt)).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('one\nmine\nthree\n');
  });

  it('refuses a folder that is not one of the project’s worktrees', async () => {
    const f = finisher();
    expect(await f.update('p1', path.join(base, 'elsewhere'))).toMatchObject({ kind: 'refused', code: 'no-worktree' });
    expect(await f.update('nope', repo)).toMatchObject({ kind: 'refused', code: 'no-worktree' });
    expect(await f.update('p1', 'relative/path')).toMatchObject({ kind: 'refused', code: 'no-worktree' });
    expect(await f.removeCheck('p1', repo)).toBeNull(); // the primary checkout is never removable
  });

  describe('Push & open pull request', () => {
    it('checks gh FIRST: missing or signed out pushes nothing', async () => {
      const wt = addWorktree('feat/nogh');
      commit(wt, 'c.txt', 'x\n', 'x');
      ghAnswer = () => ({ ok: false, out: '', err: '', failure: 'missing' });
      const r = await finisher().openPr({ projectId: 'p1', path: wt, title: 'T', body: 'B', draft: false });
      expect(r).toMatchObject({ kind: 'refused', code: 'gh-missing' });
      expect(() => git(remote, 'rev-parse', '--verify', 'refs/heads/feat/nogh')).toThrow();

      ghAnswer = () => ({ ok: false, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login', failure: 'auth' });
      expect(await finisher().openPr({ projectId: 'p1', path: wt, title: 'T', body: 'B', draft: false })).toMatchObject({
        kind: 'refused',
        code: 'gh-auth',
      });
    });

    it('pushes the branch with an upstream, then asks gh for a PR into the base with the body on stdin', async () => {
      const wt = addWorktree('feat/pr');
      commit(wt, 'c.txt', 'x\n', 'x');
      let created = false;
      ghAnswer = (args) => {
        if (args[1] === 'create') {
          created = true;
          return { ok: true, out: 'https://github.com/o/r/pull/7\n', err: '' };
        }
        return {
          ok: true,
          out: created ? JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true }]) : '[]',
          err: '',
        };
      };
      const body = 'Line "one"\n$HOME and 100%\n';
      const r = await finisher().openPr({ projectId: 'p1', path: wt, title: 'Fix it', body, draft: true });
      expect(r).toEqual({ kind: 'opened', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', draft: true } });
      // on the remote, and tracking it
      expect(git(remote, 'rev-parse', 'refs/heads/feat/pr')).toBe(git(wt, 'rev-parse', 'HEAD'));
      expect(git(wt, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat/pr');
      const create = ghCalls.find((c) => c.args[1] === 'create')!;
      expect(create.args).toEqual([
        'pr', 'create', '--head', 'feat/pr', '--base', 'main', '--title', 'Fix it', '--body-file', '-', '--draft',
      ]);
      expect(create.input).toBe(body);
    });

    it('an open PR for the branch is answered as it is, never a second one', async () => {
      const wt = addWorktree('feat/has-pr');
      const open = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false };
      ghAnswer = () => ({ ok: true, out: JSON.stringify([open]), err: '' });
      const f = finisher();
      expect((await f.prContext('p1', wt))?.existing?.number).toBe(3);
      const r = await f.openPr({ projectId: 'p1', path: wt, title: 'T', body: '', draft: false });
      expect(r).toMatchObject({ kind: 'opened', pr: { number: 3 } });
      expect(ghCalls.some((c) => c.args[1] === 'create')).toBe(false);
      expect(() => git(remote, 'rev-parse', '--verify', 'refs/heads/feat/has-pr')).toThrow();
    });

    it('refuses a title with nothing in it', async () => {
      const wt = addWorktree('feat/notitle');
      expect(await finisher().openPr({ projectId: 'p1', path: wt, title: '  ', body: '', draft: false })).toMatchObject({
        kind: 'refused',
        code: 'bad-request',
      });
    });
  });

  describe('Merge into main locally', () => {
    it('is refused while the repo has a remote (a PR is the merge)', async () => {
      const wt = addWorktree('feat/local');
      expect(await finisher().mergeLocal('p1', wt)).toMatchObject({ kind: 'refused', code: 'has-remote' });
    });

    it('without a remote, merges the branch into main in the primary checkout', async () => {
      git(repo, 'remote', 'remove', 'origin');
      const wt = addWorktree('feat/local', 'main');
      commit(wt, 'c.txt', 'x\n', 'feature');
      const r = await finisher().mergeLocal('p1', wt);
      expect(r).toEqual({ kind: 'merged', base: 'main' });
      expect(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('x\n');
      expect(git(repo, 'log', '--format=%s', '-1', 'HEAD^2')).toBe('feature');
    });

    it('a conflict is aborted, never left in the primary checkout, and the files are named', async () => {
      git(repo, 'remote', 'remove', 'origin');
      const wt = addWorktree('feat/local', 'main');
      commit(wt, 'a.txt', 'one\nmine\nthree\n', 'mine');
      commit(repo, 'a.txt', 'one\ntheirs\nthree\n', 'theirs');
      const r = await finisher().mergeLocal('p1', wt);
      expect(r).toMatchObject({ kind: 'refused', code: 'conflicts', files: ['a.txt'] });
      expect(await gitSvc.mergeInProgress(repo)).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntheirs\nthree\n');
    });
  });

  describe('Remove worktree', () => {
    it('refuses uncommitted work and lists it, unless the user insists', async () => {
      const wt = addWorktree('feat/rm-dirty');
      fs.writeFileSync(path.join(wt, 'new.txt'), 'unsaved\n');
      const f = finisher();
      const check = await f.removeCheck('p1', wt);
      expect(check?.dirty).toEqual(['new.txt']);
      expect(await f.remove({ projectId: 'p1', path: wt, force: false, keepBranch: true })).toMatchObject({
        kind: 'refused',
        code: 'dirty',
        files: ['new.txt'],
      });
      expect(fs.existsSync(path.join(wt, 'new.txt'))).toBe(true);
      const r = await f.remove({ projectId: 'p1', path: wt, force: true, keepBranch: true });
      expect(r).toMatchObject({ kind: 'removed', branchKept: 'feat/rm-dirty' });
      expect(fs.existsSync(wt)).toBe(false);
    });

    it('says when the branch has commits not on main and no merged PR, and keeps it by default', async () => {
      const wt = addWorktree('feat/rm-unmerged');
      commit(wt, 'c.txt', 'x\n', 'not on main');
      ghAnswer = () => ({ ok: true, out: '[]', err: '' });
      const f = finisher();
      const check = await f.removeCheck('p1', wt);
      expect(check).toMatchObject({ unmerged: 1, mergedPr: false, branch: 'feat/rm-unmerged', base: 'main' });
      const r = await f.remove({ projectId: 'p1', path: wt, force: false, keepBranch: true });
      expect(r).toMatchObject({ kind: 'removed', branchDeleted: false, branchKept: 'feat/rm-unmerged' });
      // the folder went; the commits stayed
      expect(git(repo, 'log', '--format=%s', '-1', 'feat/rm-unmerged')).toBe('not on main');
      expect((await gitSvc.worktreeList(repo))?.some((w) => pathKey(w.path) === pathKey(wt))).toBe(false);
    });

    it('a merged PR is reported (a squash leaves the commits "not on main" for ever)', async () => {
      const wt = addWorktree('feat/rm-merged');
      commit(wt, 'c.txt', 'x\n', 'squashed elsewhere');
      ghAnswer = () => ({
        ok: true,
        out: JSON.stringify([{ number: 9, url: 'https://github.com/o/r/pull/9', state: 'MERGED', isDraft: false }]),
        err: '',
      });
      expect(await finisher().removeCheck('p1', wt)).toMatchObject({ unmerged: 1, mergedPr: true });
    });

    it('deletes the branch only when the user unticks Keep', async () => {
      const wt = addWorktree('feat/rm-delete');
      commit(wt, 'c.txt', 'x\n', 'x');
      const r = await finisher().remove({ projectId: 'p1', path: wt, force: false, keepBranch: false });
      expect(r).toMatchObject({ kind: 'removed', branchDeleted: true });
      expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/feat/rm-delete')).toThrow();
    });

    it('UNLINKS the shared folder before deleting anything: the primary’s node_modules survives (#916)', async () => {
      const wt = addWorktree('feat/rm-linked');
      await linkDir(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
      // and one more link, deeper, that the settings do not name
      await linkDir(path.join(repo, 'node_modules'), path.join(wt, 'deep', 'er', 'mods'));
      expect(await isLink(path.join(wt, 'node_modules'))).toBe(true);
      const f = finisher();
      expect((await f.removeCheck('p1', wt))?.links).toEqual(expect.arrayContaining(['node_modules', 'deep/er/mods']));
      // the deep link sits in an untracked folder: that is uncommitted work
      const r = await f.remove({ projectId: 'p1', path: wt, force: true, keepBranch: true });
      expect(r).toMatchObject({ kind: 'removed' });
      expect(fs.existsSync(wt)).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    });

    it('refuses when a different checkout now sits at that path', async () => {
      const wt = addWorktree('feat/rm-swapped');
      fs.rmSync(wt, { recursive: true, force: true });
      fs.mkdirSync(wt, { recursive: true });
      git(wt, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(wt, 'precious.txt'), 'not ours\n');
      const r = await finisher().remove({ projectId: 'p1', path: wt, force: true, keepBranch: true });
      expect(r).toMatchObject({ kind: 'refused', code: 'other-checkout' });
      expect(fs.readFileSync(path.join(wt, 'precious.txt'), 'utf8')).toBe('not ours\n');
    });

    it('forgets the app’s records of it (made, hidden, what it was for)', async () => {
      const wt = addWorktree('feat/rm-records');
      const k = pathKey(wt);
      records[0] = { ...records[0], made: [k], hiddenWorktrees: [k], purposes: { [k]: 'Fix it' } };
      await finisher().remove({ projectId: 'p1', path: wt, force: false, keepBranch: true });
      expect(records[0].made).toBeUndefined();
      expect(records[0].hiddenWorktrees).toEqual([]);
      expect(records[0].purposes).toBeUndefined();
    });
  });

  it('notices a worktree removed outside the app: its section and its records go', async () => {
    const wt = addWorktree('feat/gone');
    const k = pathKey(wt);
    const ghost = pathKey(path.join(base, 'wts', 'never-listed'));
    records[0] = { ...records[0], made: [k, ghost], purposes: { [k]: 'Gone', [ghost]: 'Ghost' } };
    fs.rmSync(wt, { recursive: true, force: true }); // deleted by hand: git now calls it prunable
    const list = (await gitSvc.worktreeList(repo)) as WorktreeInfo[];
    expect(list.find((w) => pathKey(w.path) === k)?.prunable).toBe(true);
    const shown = finisher().noticeGone('p1', list);
    expect(shown.some((w) => pathKey(w.path) === k)).toBe(false);
    expect(shown.some((w) => w.primary)).toBe(true);
    expect(records[0].made).toBeUndefined();
    expect(records[0].purposes).toBeUndefined();
  });
});
