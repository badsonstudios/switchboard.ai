// The pure half of making a worktree (#1506): argv that cannot be turned into
// a flag or a range, the branch list, and the default base.
import { describe, it, expect } from 'vitest';
import { isAbsoluteLocal, parseBranchRefs, pickDefaultBase, worktreeAddArgs } from './worktree-git';

const WIN = 'C:' + String.fromCharCode(92) + 'wt' + String.fromCharCode(92) + 'feat-x';

describe('worktreeAddArgs', () => {
  it('makes a new branch from a base, without tracking it', () => {
    expect(worktreeAddArgs({ target: '/wt/feat-x', branch: 'feat/x', newBranch: true, base: 'origin/main' })).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feat/x',
      '/wt/feat-x',
      'origin/main',
    ]);
  });

  it('checks out an existing branch', () => {
    expect(worktreeAddArgs({ target: WIN, branch: 'feat/x', newBranch: false })).toEqual([
      'worktree',
      'add',
      WIN,
      'feat/x',
    ]);
  });

  it('starts from HEAD when no base is given', () => {
    expect(worktreeAddArgs({ target: '/wt/a', branch: 'a', newBranch: true })).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'a',
      '/wt/a',
    ]);
  });

  it('refuses a branch or base that could become a flag or a range', () => {
    expect(worktreeAddArgs({ target: '/wt/a', branch: '--force', newBranch: true })).toBeNull();
    expect(worktreeAddArgs({ target: '/wt/a', branch: 'a..b', newBranch: true })).toBeNull();
    expect(worktreeAddArgs({ target: '/wt/a', branch: 'a', newBranch: true, base: '--orphan' })).toBeNull();
    expect(worktreeAddArgs({ target: '/wt/a', branch: 'a', newBranch: true, base: 'main..x' })).toBeNull();
    expect(worktreeAddArgs({ target: '/wt/a', branch: 7, newBranch: true })).toBeNull();
  });

  it('refuses a relative or UNC folder', () => {
    expect(worktreeAddArgs({ target: 'wt/a', branch: 'a', newBranch: true })).toBeNull();
    expect(worktreeAddArgs({ target: '//host/share/a', branch: 'a', newBranch: true })).toBeNull();
    const unc = String.fromCharCode(92).repeat(2) + 'host' + String.fromCharCode(92) + 'share';
    expect(worktreeAddArgs({ target: unc, branch: 'a', newBranch: true })).toBeNull();
  });
});

describe('isAbsoluteLocal', () => {
  it('takes either platform spelling, never a UNC path', () => {
    expect(isAbsoluteLocal(WIN)).toBe(true);
    expect(isAbsoluteLocal('C:/x')).toBe(true);
    expect(isAbsoluteLocal('/home/x')).toBe(true);
    expect(isAbsoluteLocal('x/y')).toBe(false);
    expect(isAbsoluteLocal('//h/s')).toBe(false);
    expect(isAbsoluteLocal('')).toBe(false);
    expect(isAbsoluteLocal(null)).toBe(false);
  });
});

describe('parseBranchRefs', () => {
  it('splits local and remote branches and drops origin/HEAD', () => {
    const out = ['refs/heads/main', 'refs/heads/feat/x', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', ''].join(
      '\n'
    );
    expect(parseBranchRefs(out)).toEqual({ local: ['main', 'feat/x'], remote: ['origin/main'] });
  });
});

describe('pickDefaultBase', () => {
  const refs = { local: ['main', 'dev'], remote: ['origin/main', 'origin/trunk'] };
  it("prefers what origin/HEAD points at (the CLI's own default)", () => {
    expect(pickDefaultBase(refs, 'origin/trunk', 'dev')).toBe('origin/trunk');
  });
  it('then origin/main, then a local main, then HEAD', () => {
    expect(pickDefaultBase(refs, null, 'dev')).toBe('origin/main');
    expect(pickDefaultBase({ local: ['master', 'dev'], remote: [] }, null, 'dev')).toBe('master');
    expect(pickDefaultBase({ local: ['dev'], remote: [] }, null, 'dev')).toBe('dev');
    expect(pickDefaultBase({ local: [], remote: [] }, null, null)).toBeNull();
  });
});
