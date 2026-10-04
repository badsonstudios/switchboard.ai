// Which branch a mentioned folder is on, found out in time or not at all (#1092).
import { describe, it, expect, vi } from 'vitest';
import { createMentionGitLookup, gitFactsFrom, type GitStatusLike } from './mention-git';

const repo = (over: Partial<GitStatusLike> = {}): GitStatusLike => ({
  isRepo: true,
  branch: 'main',
  files: [],
  ...over,
});

describe('gitFactsFrom — what a status may be repeated as', () => {
  it('counts tracked changes and untracked files apart', () => {
    expect(
      gitFactsFrom(repo({ files: [{ untracked: false }, { untracked: true }, { untracked: true }] }))
    ).toEqual({ branch: 'main', changed: 1, untracked: 2 });
  });

  it('a DETACHED checkout has no branch — git’s placeholder is not a name', () => {
    // porcelain v2 prints the literal `(detached)`; repeating it as a branch
    // would be the app stating something false.
    expect(gitFactsFrom(repo({ branch: '(detached)' }))).toEqual({ changed: 0, untracked: 0 });
    expect(gitFactsFrom(repo({ branch: undefined }))).toEqual({ changed: 0, untracked: 0 });
  });

  it('says NOTHING for a folder that is not a repository, or one git could not read', () => {
    expect(gitFactsFrom({ isRepo: false, files: [] })).toBeUndefined();
    expect(gitFactsFrom(repo({ unreadable: 'dubious ownership' }))).toBeUndefined();
    expect(gitFactsFrom(undefined)).toBeUndefined();
  });
});

describe('createMentionGitLookup', () => {
  it('answers each folder once, however often it is named', async () => {
    const status = vi.fn(async (folder: string) => repo({ branch: `b-${folder}` }));
    const got = await createMentionGitLookup(status).lookup(['a', 'b', 'a']);
    expect(status).toHaveBeenCalledTimes(2);
    expect(got.get('a')).toEqual({ branch: 'b-a', changed: 0, untracked: 0 });
    expect(got.get('b')?.branch).toBe('b-b');
  });

  it('a folder that does not answer inside the budget is simply ABSENT — and nothing waits past it', async () => {
    vi.useFakeTimers();
    const status = (folder: string): Promise<GitStatusLike> =>
      folder === 'slow' ? new Promise(() => {}) : Promise.resolve(repo());
    const pending = createMentionGitLookup(status, 1_500).lookup(['slow', 'fast']);
    await vi.advanceTimersByTimeAsync(1_500);
    const got = await pending;
    expect([...got.keys()]).toEqual(['fast']);
  });

  it('two sends waiting on one slow folder share ONE read of it', async () => {
    let release: (s: GitStatusLike) => void = () => {};
    const status = vi.fn(
      () =>
        new Promise<GitStatusLike>((resolve) => {
          release = resolve;
        })
    );
    const git = createMentionGitLookup(status, 60_000);
    const first = git.lookup(['repo']);
    const second = git.lookup(['repo']);
    // let both reach the status call before it answers
    await Promise.resolve();
    await Promise.resolve();
    release(repo({ branch: 'shared' }));
    expect((await first).get('repo')?.branch).toBe('shared');
    expect((await second).get('repo')?.branch).toBe('shared');
    expect(status).toHaveBeenCalledTimes(1);
    // …and once it has answered, the next send asks afresh — nothing is cached
    void git.lookup(['repo']);
    await Promise.resolve();
    await Promise.resolve();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('never rejects: a status that throws, or rejects, is a folder with no facts', async () => {
    const got = await createMentionGitLookup((folder) => {
      if (folder === 'throws') throw new Error('spawn failed');
      return Promise.reject(new Error('git exploded'));
    }).lookup(['throws', 'rejects']);
    expect(got.size).toBe(0);
  });

  it('no folders, no work', async () => {
    const status = vi.fn(async () => repo());
    expect((await createMentionGitLookup(status).lookup([])).size).toBe(0);
    expect(status).not.toHaveBeenCalled();
  });
});
