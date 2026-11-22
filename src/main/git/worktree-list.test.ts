// `git worktree list --porcelain`, pinned without a git (E42 step 1, #1637).
import { describe, it, expect } from 'vitest';
import { parseWorktreeList } from './worktree-list';

describe('parseWorktreeList', () => {
  it('reads the primary checkout first and linked worktrees after it', () => {
    const out = [
      'worktree C:/Projects/Switchboard.ai',
      'HEAD 0db39b9b0000000000000000000000000000000a',
      'branch refs/heads/main',
      '',
      'worktree C:/Projects/sb-wt-1',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/feature/1637-projects-rail',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      {
        path: 'C:/Projects/Switchboard.ai',
        primary: true,
        branch: 'main',
        head: '0db39b9b0000000000000000000000000000000a',
        detached: false,
      },
      {
        path: 'C:/Projects/sb-wt-1',
        primary: false,
        branch: 'feature/1637-projects-rail',
        head: '1111111111111111111111111111111111111111',
        detached: false,
      },
    ]);
  });

  it('reads detached, locked and prunable entries, and CRLF line ends', () => {
    const out = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /wt/detached',
      'HEAD bbbb',
      'detached',
      '',
      'worktree /wt/locked',
      'HEAD cccc',
      'branch refs/heads/x',
      'locked moved to a USB stick',
      '',
      'worktree /wt/gone',
      'HEAD dddd',
      'branch refs/heads/y',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\r\n');
    const list = parseWorktreeList(out);
    expect(list.map((w) => w.path)).toEqual(['/repo', '/wt/detached', '/wt/locked', '/wt/gone']);
    expect(list[1]).toMatchObject({ branch: null, detached: true, head: 'bbbb' });
    expect(list[2]).toMatchObject({ branch: 'x', locked: true });
    expect(list[3]).toMatchObject({ branch: 'y', prunable: true });
  });

  it('reads a bare repo as the first entry', () => {
    const list = parseWorktreeList('worktree /srv/repo.git\nbare\n\nworktree /wt/a\nHEAD e\nbranch refs/heads/a\n');
    expect(list[0]).toMatchObject({ path: '/srv/repo.git', primary: true, bare: true, branch: null });
    expect(list[1]).toMatchObject({ path: '/wt/a', primary: false, branch: 'a' });
  });

  it('keeps paths with spaces whole', () => {
    const list = parseWorktreeList('worktree C:/Users/A Person/My Repo\nHEAD f\nbranch refs/heads/main\n');
    expect(list[0].path).toBe('C:/Users/A Person/My Repo');
  });

  it('ignores keys a newer git adds, and lines before the first record', () => {
    const list = parseWorktreeList('stray\nworktree /r\nHEAD 1\nbranch refs/heads/main\nshiny-new-key value\n');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: '/r', branch: 'main' });
  });

  it('answers an empty list for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
