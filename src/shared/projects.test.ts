// Path comparison and worktree membership for projects (E42 step 1, #1637).
import { describe, it, expect } from 'vitest';
import { isInside, pathKey, worktreeFor } from './projects';

describe('pathKey', () => {
  it('makes native and git spellings of one folder compare equal', () => {
    expect(pathKey('C:\\Projects\\Switchboard.ai\\')).toBe(pathKey('C:/Projects/Switchboard.ai'));
    expect(pathKey('C:/Projects/Switchboard.ai/.git')).toBe('c:/projects/switchboard.ai/.git');
  });
});

describe('isInside', () => {
  it('is true for the folder itself and anything under it', () => {
    expect(isInside('C:\\p\\repo', 'C:/p/repo')).toBe(true);
    expect(isInside('C:\\p\\repo\\src\\main', 'C:/p/repo')).toBe(true);
  });

  it('is false for a sibling that only shares a prefix', () => {
    // `sb-wt-1` must not count as inside `sb-wt-10`, nor `repo2` inside `repo`
    expect(isInside('C:/p/repo2', 'C:/p/repo')).toBe(false);
    expect(isInside('C:/p/sb-wt-10', 'C:/p/sb-wt-1')).toBe(false);
  });
});

describe('worktreeFor', () => {
  const worktrees = [
    { path: 'C:\\Projects\\Switchboard.ai' },
    { path: 'C:\\Projects\\Switchboard.ai\\.claude\\worktrees\\x' },
    { path: 'C:\\Projects\\sb-wt-1' },
  ];

  it('places a session in the worktree whose folder it is in', () => {
    expect(worktreeFor('C:\\Projects\\sb-wt-1', worktrees)).toBe('C:\\Projects\\sb-wt-1');
    expect(worktreeFor('C:\\Projects\\Switchboard.ai\\src', worktrees)).toBe('C:\\Projects\\Switchboard.ai');
  });

  it('picks the deepest worktree when one sits inside another', () => {
    expect(worktreeFor('C:\\Projects\\Switchboard.ai\\.claude\\worktrees\\x\\src', worktrees)).toBe(
      'C:\\Projects\\Switchboard.ai\\.claude\\worktrees\\x'
    );
  });

  it('answers null for a folder in none of them', () => {
    expect(worktreeFor('C:\\Projects\\Ashenfall', worktrees)).toBeNull();
  });
});
