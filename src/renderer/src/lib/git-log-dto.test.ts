// The History tab's arithmetic, tested without React (E24 Git v2 item 2).
//
// Pure functions in their own file for the reason `lib/git-status.ts` gives: the
// alternative is testing five mutually-exclusive states through a component, and
// the ORDER those states are checked in is the thing most likely to be wrong.
import { describe, it, expect } from 'vitest';
import {
  commitMatches,
  currentBranch,
  historyPaneState,
  isDetached,
  relativeTime,
  syncCounts,
  type GitCommitDto,
  type GitRefDto,
} from './git-log-dto';

function commit(over: Partial<GitCommitDto> = {}): GitCommitDto {
  return {
    id: 'b2723f662bfbcea739dd6d0d4849ef4166531d43',
    parentIds: ['dc77cc0f4424df6372b9a554b1198aeb9f54b8d7'],
    displayId: 'b2723f66',
    subject: 'docs: a subject',
    message: 'docs: a subject\n\nwith a body',
    author: 'danheinz',
    authorEmail: 'dan@example.com',
    timestamp: 1_790_000_000,
    committedTimestamp: 1_790_000_000,
    stats: { files: 2, insertions: 10, deletions: 3 },
    references: [],
    ...over,
  };
}

const ref = (over: Partial<GitRefDto>): GitRefDto => ({
  kind: 'branch',
  name: 'main',
  full: 'refs/heads/main',
  ...over,
});

describe('historyPaneState', () => {
  it('has not learned anything yet before the first answer', () => {
    // NOT `empty`. A pane that has not asked and a pane that asked and got
    // nothing must not look the same, or the first render of every History tab
    // announces that the project has no history.
    expect(historyPaneState(null)).toEqual({ kind: 'loading' });
    expect(historyPaneState(undefined)).toEqual({ kind: 'loading' });
  });

  it('⚠️ `unreadable` WINS over everything, and that order is the whole point', () => {
    // An unreadable answer carries `commits: []` and `isRepo: true` — exactly the
    // shape of a repository whose history we simply have not fetched. Checked in
    // the wrong order, the tab greets a damaged repository with "No commits yet":
    // a claim about the user's project, and the specific claim this epic exists
    // to stop making.
    expect(
      historyPaneState({ isRepo: true, unreadable: 'git exploded', commits: [] })
    ).toEqual({ kind: 'unreadable', reason: 'git exploded' });
    // It wins over `unborn` too, which is the sharper case: a corrupt branch ref
    // can produce both-looking evidence, and main works hard to tell them apart.
    expect(
      historyPaneState({ isRepo: true, unborn: true, unreadable: 'ref is damaged', commits: [] })
    ).toEqual({ kind: 'unreadable', reason: 'ref is damaged' });
    // And over `isRepo: false`, which is how the no-exec branch answers.
    expect(
      historyPaneState({ isRepo: false, unreadable: 'git is not installed', commits: [] })
    ).toEqual({ kind: 'unreadable', reason: 'git is not installed' });
  });

  it('an unborn repository is its own state, not an error and not a bare folder', () => {
    expect(historyPaneState({ isRepo: true, unborn: true, commits: [] })).toEqual({ kind: 'unborn' });
  });

  it('a folder that is not a repository says so plainly', () => {
    expect(historyPaneState({ isRepo: false, commits: [] })).toEqual({ kind: 'not-repo' });
  });

  it('commits are commits, including zero of them in a repo we read fine', () => {
    expect(historyPaneState({ isRepo: true, commits: [] })).toEqual({ kind: 'commits' });
    expect(historyPaneState({ isRepo: true, commits: [commit()] })).toEqual({ kind: 'commits' });
  });
});

describe('commitMatches', () => {
  it('an empty query matches everything', () => {
    expect(commitMatches(commit(), '')).toBe(true);
    expect(commitMatches(commit(), '   ')).toBe(true);
  });

  it('matches the subject, case-blind', () => {
    expect(commitMatches(commit({ subject: 'Fix the Thing' }), 'thing')).toBe(true);
    expect(commitMatches(commit({ subject: 'Fix the Thing' }), 'THE')).toBe(true);
    expect(commitMatches(commit({ subject: 'Fix the Thing' }), 'elephant')).toBe(false);
  });

  it('matches the author', () => {
    expect(commitMatches(commit({ author: 'Dan Heinz' }), 'heinz')).toBe(true);
  });

  it('⚠️ matches a sha on a PREFIX, because that is how a human has one', () => {
    const c = commit();
    expect(commitMatches(c, 'b2723f')).toBe(true);
    expect(commitMatches(c, c.id)).toBe(true);
    // The MIDDLE of a sha is not a thing anyone types.
    expect(commitMatches(c, '662bfb')).toBe(false);
  });

  it('matches a ref name, because "which commit is v0.8.3" is a real question', () => {
    expect(commitMatches(commit({ references: [ref({ kind: 'tag', name: 'v0.8.3' })] }), 'v0.8')).toBe(true);
  });

  it('⚠️ does NOT search the whole message, and that is a decision', () => {
    // This repository's commit bodies are essays. A body search makes nearly
    // every query match nearly every row, and a filter that matches everything
    // is indistinguishable from a filter that is broken.
    const c = commit({ subject: 'short', message: 'short\n\nthe body mentions aardvarks' });
    expect(commitMatches(c, 'aardvarks')).toBe(false);
  });
});

describe('relativeTime', () => {
  const t = 1_790_000_000;
  const at = (secondsLater: number): string => relativeTime(t, (t + secondsLater) * 1000);

  it('counts up through the units', () => {
    expect(at(0)).toBe('now');
    expect(at(59)).toBe('now');
    expect(at(60)).toBe('1m');
    expect(at(59 * 60)).toBe('59m');
    expect(at(60 * 60)).toBe('1h');
    expect(at(23 * 3600)).toBe('23h');
    expect(at(24 * 3600)).toBe('1d');
    expect(at(29 * 86400)).toBe('29d');
  });

  it('⚠️ stops at days and switches to the DATE, because "427d" is not a unit', () => {
    expect(at(30 * 86400)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(at(400 * 86400)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('⚠️ a commit dated in the FUTURE clamps to "now" rather than counting down', () => {
    // Real, and not rare: a wrong clock on another machine, or a rebase. "in 3
    // hours" is noise on a history row.
    expect(at(-3600)).toBe('now');
  });

  it('⚠️ an unparseable timestamp renders as NOTHING, never "NaNd"', () => {
    expect(relativeTime(Number.NaN, t * 1000)).toBe('');
    expect(relativeTime(Number.POSITIVE_INFINITY, t * 1000)).toBe('');
  });

  it('⚠️ A MISSING DATE IS NOT 1 JANUARY 1970, and `0` is the case that proves it', () => {
    // THE REVIEW FINDING. git prints `%at` as an EMPTY LINE for a commit whose
    // author date is out of range, and `Number('')` is `0` — finite, positive-
    // looking, and a real date. So the `isFinite` guard this function was proud of
    // never fired and the row drew `1970-01-01` with a matching tooltip: a
    // confident wrong fact about the user's project, in the tab built to stop
    // making those. Main sends `null` now and this refuses non-positive as well,
    // so neither layer is the only thing standing between the two.
    expect(relativeTime(null, t * 1000)).toBe('');
    expect(relativeTime(0, t * 1000)).toBe('');
    expect(relativeTime(-1, t * 1000)).toBe('');
  });

  it('⚠️ the date branch is LOCAL, so the row and its tooltip cannot disagree', () => {
    // `toISOString()` is UTC and the row's tooltip is `toLocaleString()`; for a
    // commit near local midnight the two named different days about one commit.
    const old = Date.UTC(2025, 0, 15, 12, 0, 0) / 1000;
    const nowMs = (old + 200 * 86400) * 1000;
    const shown = relativeTime(old, nowMs);
    const d = new Date(old * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    expect(shown).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  });
});

describe('currentBranch / isDetached', () => {
  it('reads the checked-out branch off `%D` rather than asking git twice', () => {
    const commits = [
      commit({ id: 'a'.repeat(40), references: [] }),
      commit({ id: 'b'.repeat(40), references: [ref({ isHead: true, name: 'feature/x', full: 'refs/heads/feature/x' })] }),
    ];
    expect(currentBranch(commits)).toBe('feature/x');
    expect(isDetached(commits)).toBe(false);
  });

  it('a detached HEAD has no branch, and the two answers are different', () => {
    // `undefined` branch and `detached: true` together are what let the toolbar
    // say something true. "No branch" and "we do not know" must not look alike.
    const commits = [commit({ references: [{ kind: 'head', name: 'HEAD', full: 'HEAD', isHead: true }] })];
    expect(currentBranch(commits)).toBeUndefined();
    expect(isDetached(commits)).toBe(true);
  });

  it('no refs at all means no branch and not detached — we simply cannot see one', () => {
    expect(currentBranch([commit()])).toBeUndefined();
    expect(isDetached([commit()])).toBe(false);
    expect(currentBranch([])).toBeUndefined();
  });

  it('a remote-tracking ref is not the current branch', () => {
    const commits = [commit({ references: [ref({ kind: 'remote', name: 'origin/main', full: 'refs/remotes/origin/main' })] })];
    expect(currentBranch(commits)).toBeUndefined();
  });
});

describe('syncCounts', () => {
  it('⚠️ NO UPSTREAM and LEVEL WITH THE UPSTREAM are different answers', () => {
    // git omits `# branch.ab` entirely when there is no upstream. Collapsing the
    // two would make "this branch tracks nothing" indistinguishable from "tracks
    // something and is level with it" — and a future surface offering to set an
    // upstream needs exactly that difference.
    expect(syncCounts({})).toEqual({ hasUpstream: false });
    expect(syncCounts(null)).toEqual({ hasUpstream: false });
    expect(syncCounts(undefined)).toEqual({ hasUpstream: false });
    expect(syncCounts({ ahead: 0, behind: 0 })).toEqual({ ahead: 0, behind: 0, hasUpstream: true });
  });

  it('carries both counts', () => {
    expect(syncCounts({ ahead: 3, behind: 1 })).toEqual({ ahead: 3, behind: 1, hasUpstream: true });
  });

  it('one field present is enough to mean there IS an upstream', () => {
    expect(syncCounts({ ahead: 2 })).toEqual({ ahead: 2, behind: 0, hasUpstream: true });
    expect(syncCounts({ behind: 2 })).toEqual({ ahead: 0, behind: 2, hasUpstream: true });
  });
});
