// Path comparison and worktree membership for projects (E42 step 1, #1637).
import { describe, it, expect } from 'vitest';
import { baseBranchName, isInside, pathKey, prefillPullRequest, worktreeFor } from './projects';

describe('baseBranchName (#1638)', () => {
  it('names the branch a PR targets', () => {
    expect(baseBranchName('origin/main')).toBe('main');
    expect(baseBranchName('origin/release/2')).toBe('release/2');
    expect(baseBranchName('main')).toBe('main');
    expect(baseBranchName('upstream/main')).toBe('upstream/main');
  });
});

describe('prefillPullRequest (#1638)', () => {
  it('takes the purpose for the title and lists the sessions with their task labels', () => {
    const r = prefillPullRequest({
      purpose: 'Fix the closed-session queue',
      branch: 'fix/1634-closed-session',
      sessions: [
        { title: 'Queue fix', taskLabel: 'writing the test' },
        { title: 'Reviewer', taskLabel: 'Reviewer' },
      ],
      sessionsHeading: 'Sessions:',
    });
    expect(r.title).toBe('Fix the closed-session queue');
    expect(r.body).toBe('Sessions:\n\n- Queue fix: writing the test\n- Reviewer\n');
  });

  it('falls back to the first session name, then the branch in words', () => {
    expect(prefillPullRequest({ branch: 'b', sessions: [{ title: 'Alpha' }], sessionsHeading: 'S' }).title).toBe('Alpha');
    const r = prefillPullRequest({ branch: 'feat/new-thing_here', sessions: [], sessionsHeading: 'S' });
    expect(r).toEqual({ title: 'new thing here', body: '' });
  });
});

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
