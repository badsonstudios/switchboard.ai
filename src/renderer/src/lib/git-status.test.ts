// What the Changes tab says about a folder (#785).
//
// WHY THIS IS A LIB TEST AND NOT A COMPONENT TEST
// ----------------------------------------------
// The decision used to be three conditions inline in `DiffPane`, which builds a
// Monaco diff editor on mount. Testing the three branches through that
// component means standing Monaco up in jsdom to assert on a `<div>` that never
// touches it — so the decision moved out here, where it can be asked directly.
// The pane renders from `gitPaneState` and from nothing else; that is the whole
// contract between the two files.
import { describe, it, expect } from 'vitest';
import { gitPaneState, type GitStatusDto } from './git-status';

const status = (over: Partial<GitStatusDto> = {}): GitStatusDto => ({
  isRepo: true,
  files: [],
  ...over,
});

const FILE = { path: 'a.ts', xy: '.M', staged: false, unstaged: true, untracked: false };

describe('gitPaneState (#785)', () => {
  it('says nothing at all before an answer has landed', () => {
    // First mount, and the fail-open after a refusal: an EMPTY pane. Not
    // "clean", not "not a repository" — both of those are claims about a
    // working tree nobody has read yet.
    expect(gitPaneState(null)).toBeNull();
    expect(gitPaneState(undefined)).toBeNull();
  });

  it('draws the ordinary answers unchanged', () => {
    expect(gitPaneState(status({ isRepo: false }))).toEqual({ kind: 'not-repo' });
    expect(gitPaneState(status())).toEqual({ kind: 'clean' });
    expect(gitPaneState(status({ files: [FILE] }))).toEqual({ kind: 'files' });
  });

  it('⚠️ AN UNREADABLE REPOSITORY IS NOT A CLEAN ONE — the branch order is the point', () => {
    // The trap this whole helper exists for. `unreadable` arrives with
    // `isRepo: true` and `files: []` on the guard and status branches, which is
    // byte for byte the shape of a repository with nothing uncommitted. Checked
    // in the other order, #785 would have replaced "Not a git repository" with
    // "Working tree clean" — a worse lie, invented by the fix.
    const s = gitPaneState(status({ unreadable: 'git could not be started' }));
    expect(s).toEqual({ kind: 'unreadable', reason: 'git could not be started' });
  });

  it('…and it beats "not a repository" too, for the probe that never got an answer', () => {
    // `isRepo: false` here is "we never got far enough to say", not a verdict:
    // git would not start, or the folder is gone. Drawing the verdict would be
    // the original bug with extra steps.
    const s = gitPaneState(status({ isRepo: false, unreadable: 'that folder no longer exists' }));
    expect(s).toEqual({ kind: 'unreadable', reason: 'that folder no longer exists' });
  });

  it('an empty reason is not a reason, and falls back to the plain answers', () => {
    // A string field off a `Promise<unknown>` IPC reply. `''` cannot be
    // rendered into "switchboard couldn't read this project's git — " with
    // nothing after the dash, so it is treated as absent.
    expect(gitPaneState(status({ isRepo: false, unreadable: '' }))).toEqual({ kind: 'not-repo' });
    expect(gitPaneState(status({ unreadable: '' }))).toEqual({ kind: 'clean' });
  });
});
