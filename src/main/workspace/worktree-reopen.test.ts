// Where a conversation whose folder is gone is offered to reopen (#1643).
import path from 'path';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import { longSpelling, reopenFolderIn } from './worktree-jobs';
import type { ProjectRecord } from '../../shared/projects';

const ROOT = path.resolve('/tmp/sb-1643');
const REPO = path.join(ROOT, 'repo');
const APP_ROOT = path.join(ROOT, 'switchboard-worktrees');
const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'p1',
  name: 'repo',
  color: 'var(--accent-1)',
  commonDir: path.join(REPO, '.git'),
  primaryPath: REPO,
  hiddenWorktrees: [],
  ...over,
});
const there = (): boolean => true;
// the default spelling asks the real disk; these paths do not exist, so it
// would hand them back unchanged anyway — said explicitly, per call below
const asIs = (p: string): string => p;

describe('reopenFolderIn', () => {
  it("a worktree the app made, in the project's worktree folder, reopens in the main folder", () => {
    expect(reopenFolderIn(path.join(APP_ROOT, 'repo', 'feat-x'), [project()], APP_ROOT, there, asIs)).toBe(REPO);
  });

  it("a worktree the CLI made inside the repo (.claude/worktrees) does too", () => {
    expect(reopenFolderIn(path.join(REPO, '.claude', 'worktrees', 'probe'), [project()], APP_ROOT, there, asIs)).toBe(REPO);
  });

  it("a project's own worktree folder setting is honoured", () => {
    const own = path.join(ROOT, 'elsewhere');
    expect(reopenFolderIn(path.join(own, 'repo', 'b'), [project({ worktreeRoot: own })], APP_ROOT, there, asIs)).toBe(REPO);
  });

  it('a folder from no known project offers nothing — the user picks', () => {
    expect(reopenFolderIn(path.join(ROOT, 'random', 'x'), [project()], APP_ROOT, there, asIs)).toBeUndefined();
    expect(reopenFolderIn(path.join(APP_ROOT, 'repo', 'x'), [], APP_ROOT, there, asIs)).toBeUndefined();
  });

  it('the main folder itself gone offers nothing, and the deepest match wins', () => {
    expect(reopenFolderIn(REPO, [project()], APP_ROOT, there, asIs)).toBeUndefined();
    expect(reopenFolderIn(path.join(APP_ROOT, 'repo', 'x'), [project()], APP_ROOT, () => false, asIs)).toBeUndefined();
    const inner = project({ id: 'p2', primaryPath: path.join(REPO, 'nested'), commonDir: path.join(REPO, 'nested', '.git') });
    expect(reopenFolderIn(path.join(REPO, 'nested', '.claude', 'worktrees', 'w'), [project(), inner], APP_ROOT, there, asIs)).toBe(
      path.join(REPO, 'nested')
    );
  });
});

describe('longSpelling', () => {
  it("spells a missing folder through its deepest existing ancestor, as the disk does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1643-spell-'));
    try {
      const missing = path.join(dir, 'removed', 'wt');
      expect(longSpelling(missing)).toBe(path.join(fs.realpathSync.native(dir), 'removed', 'wt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
