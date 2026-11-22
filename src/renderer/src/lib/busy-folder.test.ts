// The busy-folder prompt's decisions (#1506, decision 6): who counts as
// "already in this checkout", which answer it leans to, and the setting.
import { describe, it, expect } from 'vitest';
import { busyFolderOf, liveInCheckout, recommendWorktree } from './busy-folder';
import type { RailSession } from '../model/types';

const S = (id: string, status: RailSession['status'], autoKey?: string): RailSession => ({
  id,
  title: id,
  status,
  ...(autoKey ? { autoKey } : {}),
});

const TOP = 'C:/Projects/App';

describe('liveInCheckout', () => {
  it('finds running sessions in the same checkout, compared as path keys', () => {
    const sessions = [
      S('a', 'working', 'c:' + String.fromCharCode(92) + 'projects' + String.fromCharCode(92) + 'app'),
      S('b', 'idle', 'C:/Projects/App/'),
      S('other-checkout', 'working', 'C:/wt/app-feature'),
      S('no-key', 'working'),
    ];
    expect(liveInCheckout(sessions, TOP).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('leaves out sessions whose process is gone', () => {
    const sessions = [S('ended', 'ended', TOP), S('susp', 'suspended', TOP), S('crash', 'crashed', TOP)];
    expect(liveInCheckout(sessions, TOP)).toEqual([]);
  });
});

describe('recommendWorktree', () => {
  it('leans to a worktree when another session is working or files are changed', () => {
    expect(recommendWorktree([S('a', 'working', TOP)], 0)).toBe(true);
    expect(recommendWorktree([S('a', 'idle', TOP)], 3)).toBe(true);
  });
  it('leans to sharing for an idle session with a clean folder (or an unknown count)', () => {
    expect(recommendWorktree([S('a', 'idle', TOP)], 0)).toBe(false);
    expect(recommendWorktree([S('a', 'done', TOP)], null)).toBe(false);
  });
});

describe('busyFolderOf', () => {
  it('reads anything unknown as Ask, the default', () => {
    expect(busyFolderOf('share')).toBe('share');
    expect(busyFolderOf('worktree')).toBe('worktree');
    expect(busyFolderOf(undefined)).toBe('ask');
    expect(busyFolderOf('always')).toBe('ask');
  });
});
