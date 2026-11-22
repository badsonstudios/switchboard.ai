// `railOrder`'s fifth input: projects (E42 step 1, #1637).
//
// A session whose repo key is a project's lands in that project, in the
// worktree its folder is in, and nowhere else: not in the group it is filed in,
// not in an automatic folder group. Projects come first in `flat`, which is
// what Ctrl+1..9 counts.
import { describe, it, expect } from 'vitest';
import { projectBucket, railOrder, type ProjectForOrder } from './groups';
import { bucketLabel } from './rail-order';
import { NO_PINS } from './pinning';
import { NO_ORDER } from './rail-order';
import { NO_LINEAGE } from './dispatch-lineage';
import { pathKey } from '../../../shared/projects';

const REPO = 'C:\\Projects\\Switchboard.ai';
const COMMON = `${REPO}\\.git`;
const WT1 = 'C:\\Projects\\sb-wt-1';
const WT2 = 'C:\\Projects\\sb-wt-2';

const project = (over: Partial<ProjectForOrder> = {}): ProjectForOrder => ({
  id: 'p1',
  commonDir: COMMON,
  hiddenWorktrees: [],
  worktrees: [
    { path: REPO, primary: true, branch: 'main', head: 'a', detached: false },
    { path: WT1, primary: false, branch: 'feat/x', head: 'b', detached: false },
    { path: WT2, primary: false, branch: 'feat/y', head: 'c', detached: false },
  ],
  ...over,
});

const inRepo = (id: string, folder: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder,
  repoKey: pathKey(COMMON),
  autoKey: folder.toLowerCase(),
  ...extra,
});

const order = (sessions: Parameters<typeof railOrder>[0], projects: ProjectForOrder[], groups = [] as { id: string }[]) =>
  railOrder(sessions, groups, NO_PINS, NO_ORDER, NO_LINEAGE, projects);

describe('railOrder with projects', () => {
  it('puts each session under the worktree its folder is in', () => {
    const r = order(
      [inRepo('a', REPO), inRepo('b', WT1), inRepo('c', `${WT1}\\src`), { id: 'z', folder: 'C:\\elsewhere' }],
      [project()]
    );
    expect(r.projects).toHaveLength(1);
    const byPath = new Map(r.projects[0].worktrees.map((w) => [w.path, w.members.map((m) => m.id)]));
    expect(byPath.get(REPO)).toEqual(['a']);
    expect(byPath.get(WT1)).toEqual(['b', 'c']);
    expect(byPath.get(WT2)).toEqual([]); // an empty worktree is still drawn
    expect(r.loose.map((s) => s.id)).toEqual(['z']);
  });

  it('draws projects first in flat, so Ctrl+1..9 counts them first', () => {
    const r = order([{ id: 'z', folder: 'C:\\elsewhere' }, inRepo('b', WT1), inRepo('a', REPO)], [project()]);
    expect(r.flat.map((s) => s.id)).toEqual(['a', 'b', 'z']);
  });

  it('wins over a group the session is filed in, and over the automatic folder group', () => {
    const r = order(
      [
        inRepo('a', REPO, { groupId: 'g1' }),
        inRepo('b', REPO), // with `a`, would have made an automatic group
        { id: 'c', folder: 'C:\\other', groupId: 'g1' },
      ],
      [project()],
      [{ id: 'g1' }]
    );
    expect(r.projects[0].worktrees[0].members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(r.groups[0].members.map((m) => m.id)).toEqual(['c']);
    expect(r.autoGroups).toEqual([]);
  });

  it('leaves out a hidden worktree, unless a session is in it', () => {
    const hidden = project({ hiddenWorktrees: [pathKey(WT1), pathKey(WT2)] });
    const r = order([inRepo('b', WT2)], [hidden]);
    expect(r.projects[0].worktrees.map((w) => w.path)).toEqual([REPO, WT2]);
  });

  it('still lists a project whose worktrees cannot be read, with its sessions unplaced', () => {
    const r = order([inRepo('a', REPO), inRepo('b', WT1)], [project({ worktrees: null })]);
    expect(r.projects[0].worktrees).toHaveLength(1);
    expect(r.projects[0].worktrees[0]).toMatchObject({ path: '', info: null });
    expect(r.projects[0].worktrees[0].members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('gives every worktree its own reorder bucket', () => {
    const r = order([inRepo('a', WT1), inRepo('b', WT1)], [project()]);
    const bucket = projectBucket('p1', WT1);
    expect(r.bucketOf.get('a')).toBe(bucket);
    expect(r.buckets.get(bucket)).toEqual(['a', 'b']);
  });

  it('draws one card for two records of the same repo (the first wins)', () => {
    const r = order([inRepo('a', REPO)], [project(), project({ id: 'p2' })]);
    expect(r.projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('changes nothing for sessions with no repo key, or with no projects at all', () => {
    const sessions = [inRepo('a', REPO), inRepo('b', REPO), { id: 'c', folder: 'C:\\x' }];
    const without = railOrder(sessions, [], NO_PINS, NO_ORDER, NO_LINEAGE);
    expect(without.projects).toEqual([]);
    expect(without.autoGroups.map((g) => g.members.map((m) => m.id))).toEqual([['a', 'b']]);
  });
});

describe('bucketLabel for a project worktree', () => {
  it('names the worktree folder', () => {
    expect(bucketLabel(projectBucket('p1', WT1), [], 'Ungrouped')).toBe('sb-wt-1');
  });
  it('falls back for the unplaced section', () => {
    expect(bucketLabel(projectBucket('p1', ''), [], 'Ungrouped')).toBe('Ungrouped');
  });
});
