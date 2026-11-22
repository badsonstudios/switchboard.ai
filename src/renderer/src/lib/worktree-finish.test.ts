// Which sessions live in a worktree, and who gets the conflicts (#1638).
import { describe, it, expect } from 'vitest';
import { conflictFileLines, handOffSession, sessionsInWorktree } from './worktree-finish';
import type { RailSession } from '../model/types';
import type { WorktreeInfo } from '../../../shared/projects';

const wts: WorktreeInfo[] = [
  { path: '/r', primary: true, branch: 'main', head: 'a', detached: false },
  { path: '/r/.claude/worktrees/x', primary: false, branch: 'x', head: 'b', detached: false },
  { path: '/wt/feat', primary: false, branch: 'feat', head: 'c', detached: false },
];
const s = (id: string, folder: string, liveId?: string): RailSession => ({
  id,
  title: id,
  folder,
  ...(liveId ? { liveId } : {}),
});

describe('sessionsInWorktree', () => {
  const all = [s('a', '/r'), s('b', '/r/.claude/worktrees/x/src'), s('c', '/wt/feat'), s('d', '/elsewhere')];
  it('places each session in the DEEPEST worktree holding it', () => {
    expect(sessionsInWorktree(all, wts, '/r').map((x) => x.id)).toEqual(['a']);
    expect(sessionsInWorktree(all, wts, '/r/.claude/worktrees/x').map((x) => x.id)).toEqual(['b']);
    expect(sessionsInWorktree(all, wts, '/wt/feat/').map((x) => x.id)).toEqual(['c']);
  });
  it('without a worktree list, falls back to "inside the folder"', () => {
    expect(sessionsInWorktree(all, null, '/wt/feat').map((x) => x.id)).toEqual(['c']);
  });
});

describe('handOffSession', () => {
  it('prefers the focused live session, else the first live one, never a stopped one', () => {
    const here = [s('a', '/wt'), s('b', '/wt', 'L-b'), s('c', '/wt', 'L-c')];
    expect(handOffSession(here, 'c')?.id).toBe('c');
    expect(handOffSession(here, 'a')?.id).toBe('b');
    expect(handOffSession([s('a', '/wt')], null)).toBeNull();
  });
});

describe('conflictFileLines', () => {
  it('lists one file a line and says how many more past the cap', () => {
    expect(conflictFileLines(['a', 'b'], (n) => `+${n}`)).toBe('- a\n- b');
    expect(conflictFileLines(['a', 'b', 'c'], (n) => `and ${n} more`, 2)).toBe('- a\n- b\n- and 1 more');
  });
});
