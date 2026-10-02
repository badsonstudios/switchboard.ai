// VCS decorations for the Files tab (E24 Git v2 item 11).
//
// Pure, so the roll-up rule is tested as a rule. The interesting half is the
// FOLDER: a tree that only marked changed files would be useless on a collapsed
// tree — which is how the tree starts, one level at a time — because every change
// would hide behind an undecorated folder.
import { describe, it, expect } from 'vitest';
import { decorationsFor } from './vcs-decorations';
import type { GitFileDto, GitStatusDto } from './git-status';

const file = (over: Partial<GitFileDto> & { path: string }): GitFileDto => ({
  staged: false,
  unstaged: true,
  untracked: false,
  ...over,
});

const status = (files: GitFileDto[], over: Partial<GitStatusDto> = {}): GitStatusDto => ({
  isRepo: true,
  files,
  ...over,
});

describe('decorationsFor', () => {
  it('decorates a changed file, keyed by its ABSOLUTE path (the done-when)', () => {
    // ⚠️ ABSOLUTE, because the tree and git speak different paths: a row carries
    // an absolute OS path from a directory listing, git reports a forward-slash
    // path relative to the session folder. Converting HERE means the tree never
    // learns what a repository root is.
    const d = decorationsFor('/proj', status([file({ path: 'src/a.ts', xy: '.M' })]));
    expect(d.get('/proj/src/a.ts')).toEqual({ letter: 'M', key: 'modified' });
    // and NOT by the relative path, which is what a row would never match
    expect(d.has('src/a.ts')).toBe(false);
  });

  it('⚠️ decorates every ANCESTOR folder, or a collapsed tree shows nothing', () => {
    const d = decorationsFor('/proj', status([file({ path: 'a/b/c/deep.ts', xy: '.M' })]));
    expect(d.get('/proj/a')).toEqual({ letter: 'M', key: 'modified', rolledUp: true });
    expect(d.get('/proj/a/b')).toMatchObject({ rolledUp: true });
    expect(d.get('/proj/a/b/c')).toMatchObject({ rolledUp: true });
    // The FILE itself is not rolled up — "this changed" and "something under here
    // changed" are different facts and the row draws them differently.
    expect(d.get('/proj/a/b/c/deep.ts')?.rolledUp).toBeUndefined();
    // and the session folder itself is NOT decorated: every row would be.
    expect(d.has('/proj')).toBe(false);
  });

  it('⚠️ the STRONGEST letter under a folder wins, and the order is about the reader', () => {
    // A conflict blocks everything; a deletion is the one nobody expects;
    // untracked is the most harmless thing a folder can hold.
    const d = decorationsFor(
      '/proj',
      status([
        file({ path: 'src/untracked.ts', untracked: true, xy: '??' }),
        file({ path: 'src/added.ts', staged: true, unstaged: false, xy: 'A.' }),
        file({ path: 'src/mod.ts', xy: '.M' }),
      ])
    );
    expect(d.get('/proj/src')?.letter).toBe('M');

    const withDelete = decorationsFor(
      '/proj',
      status([file({ path: 'src/mod.ts', xy: '.M' }), file({ path: 'src/gone.ts', xy: '.D' })])
    );
    expect(withDelete.get('/proj/src')?.letter).toBe('D');

    const withConflict = decorationsFor(
      '/proj',
      status([
        file({ path: 'src/gone.ts', xy: '.D' }),
        file({ path: 'src/c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' }),
      ])
    );
    expect(withConflict.get('/proj/src')?.letter).toBe('!');
  });

  it('⚠️ a folder that is ITSELF changed is not overwritten by a roll-up', () => {
    // A path can be both — a directory replaced by a file, or a submodule. The
    // file's own status is the stronger claim and must survive an ancestor pass.
    const d = decorationsFor(
      '/proj',
      status([file({ path: 'pkg', untracked: true, xy: '??' }), file({ path: 'pkg/inner.ts', xy: '.M' })])
    );
    expect(d.get('/proj/pkg')?.rolledUp).toBeUndefined();
    expect(d.get('/proj/pkg')?.letter).toBe('U');
  });

  it('reads the side the file is actually on', () => {
    const d = decorationsFor(
      '/proj',
      status([
        file({ path: 'staged.ts', staged: true, unstaged: false, xy: 'A.' }),
        file({ path: 'new.ts', untracked: true, xy: '??' }),
        file({ path: 'c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' }),
      ])
    );
    expect(d.get('/proj/staged.ts')?.letter).toBe('A');
    expect(d.get('/proj/new.ts')).toEqual({ letter: 'U', key: 'untracked' });
    expect(d.get('/proj/c.ts')).toEqual({ letter: '!', key: 'conflicted' });
  });

  it('joins with the FOLDER’s own separator, so a Windows path matches a Windows row', () => {
    const d = decorationsFor('C:\\Projects\\p', status([file({ path: 'src/a.ts', xy: '.M' })]));
    expect(d.has('C:\\Projects\\p\\src\\a.ts')).toBe(true);
  });

  it('tolerates a trailing separator on the folder', () => {
    expect(decorationsFor('/proj/', status([file({ path: 'a.ts', xy: '.M' })])).has('/proj/a.ts')).toBe(
      true
    );
  });

  it('⚠️ decorates NOTHING when there is nothing to say', () => {
    // A folder that is not a repository, an unreadable one, no status yet, no
    // folder. A tree with no badges is a tree that works exactly as it did —
    // which is the fail-open shape for a decoration.
    expect(decorationsFor('/proj', null).size).toBe(0);
    expect(decorationsFor('/proj', status([], { isRepo: false })).size).toBe(0);
    expect(decorationsFor(undefined, status([file({ path: 'a.ts' })])).size).toBe(0);
    expect(decorationsFor('/proj', status([])).size).toBe(0);
  });

  it('an UNREADABLE repository still decorates nothing, because it carries no files', () => {
    expect(
      decorationsFor('/proj', status([], { unreadable: 'the repository is damaged' })).size
    ).toBe(0);
  });
});
