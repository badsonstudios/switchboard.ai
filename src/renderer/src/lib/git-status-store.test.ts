// The shared git status (E24 Git v2 item 11).
//
// ⚠️ **THE WHOLE POINT OF THIS MODULE IS "ONE FETCH", so that is what most of
// these tests are about.** Design §4 item 11's acceptance bar is that the Files
// tab and the Changes tab read the SAME status source — and the failure mode it
// guards against is not a crash, it is two tabs quietly disagreeing about whether
// a file is modified, which nobody would report as a bug against either one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  getGitStatus,
  putGitStatus,
  refreshGitStatus,
  resetGitStatusStore,
  subscribeGitStatus,
} from './git-status-store';
import type { GitStatusDto } from './git-status';

type StatusFn = (folder: string, withStats?: boolean) => Promise<unknown>;

/** Install a fake bridge and record every call. */
function bridge(impl: StatusFn): { calls: Array<{ folder: string; withStats?: boolean }> } {
  const calls: Array<{ folder: string; withStats?: boolean }> = [];
  (globalThis as { switchboard?: unknown }).switchboard = {
    git: {
      status: (folder: string, withStats?: boolean) => {
        calls.push({ folder, withStats });
        return impl(folder, withStats);
      },
    },
  };
  return { calls };
}

const ok = (files: string[]): GitStatusDto => ({
  isRepo: true,
  files: files.map((path) => ({ path, staged: false, unstaged: true, untracked: false })),
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the shared git status', () => {
  beforeEach(() => resetGitStatusStore());
  afterEach(() => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
    resetGitStatusStore();
  });

  it('fetches once and answers every reader (the done-when)', async () => {
    const { calls } = bridge(async () => ok(['a.ts']));
    refreshGitStatus('/proj');
    await settle();
    expect(calls).toHaveLength(1);
    expect(getGitStatus('/proj')?.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('⚠️ TWO TABS MOUNTING IN ONE FRAME PRODUCE ONE `git status`', () => {
    // The thing a `useEffect` in each component gets wrong, and the reason this
    // is a module rather than two hooks.
    const { calls } = bridge(async () => ok(['a.ts']));
    refreshGitStatus('/proj');
    refreshGitStatus('/proj');
    refreshGitStatus('/proj');
    expect(calls).toHaveLength(1);
  });

  it('answers the SECOND asker from cache rather than re-reading', async () => {
    const { calls } = bridge(async () => ok(['a.ts']));
    refreshGitStatus('/proj');
    await settle();
    refreshGitStatus('/proj');
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('`force` is how a refresh asks again — and it is what ⟲ and the tab flip use', async () => {
    const { calls } = bridge(async () => ok(['a.ts']));
    refreshGitStatus('/proj');
    await settle();
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('two folders are two reads, keyed apart', async () => {
    const { calls } = bridge(async (folder) => ok([`${folder}/x.ts`]));
    refreshGitStatus('/a');
    refreshGitStatus('/b');
    await settle();
    expect(calls.map((c) => c.folder).sort()).toEqual(['/a', '/b']);
    expect(getGitStatus('/a')).not.toEqual(getGitStatus('/b'));
  });

  it('⚠️ ONCE ANY READER WANTS THE NUMBERS, EVERY READER GETS THEM', async () => {
    // The correct direction for the trade: a shared cache that answered one
    // reader with stats and another without would make the second reader's answer
    // depend on whether the first had mounted.
    const { calls } = bridge(async () => ok(['a.ts']));
    refreshGitStatus('/proj', { stats: true });
    await settle();
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(calls.map((c) => c.withStats)).toEqual([true, true]);
  });

  it('notifies subscribers, and stops when they unsubscribe', async () => {
    bridge(async () => ok(['a.ts']));
    let seen = 0;
    const off = subscribeGitStatus(() => void seen++);
    refreshGitStatus('/proj');
    await settle();
    expect(seen).toBe(1);
    off();
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(seen).toBe(1);
  });

  it('⚠️ A REFUSAL LEAVES THE LAST GOOD ANSWER STANDING', async () => {
    // Fail-open: the Files tab's job is to list files, and decorations are a
    // decoration. A tree that blanked because git refused would be our breakage
    // costing a session.
    let answer: unknown = ok(['a.ts']);
    bridge(async () => answer);
    refreshGitStatus('/proj');
    await settle();
    answer = ipcRefusal('git:status', 'capability-not-held');
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(getGitStatus('/proj')?.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('a REJECTED read does the same, and does not latch `pending`', async () => {
    let fail = false;
    bridge(async () => {
      if (fail) throw new Error('the bridge is gone');
      return ok(['a.ts']);
    });
    refreshGitStatus('/proj');
    await settle();
    fail = true;
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(getGitStatus('/proj')?.files.map((f) => f.path)).toEqual(['a.ts']);
    // …and a later read still works, which it would not if `pending` had stuck.
    fail = false;
    refreshGitStatus('/proj', { force: true });
    await settle();
    expect(getGitStatus('/proj')).not.toBeNull();
  });

  it('⚠️ a SUPERSEDED read is dropped rather than written over a fresher one', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    bridge(() => new Promise((r) => resolvers.push(r)));
    refreshGitStatus('/proj');
    refreshGitStatus('/proj', { force: true });
    expect(resolvers).toHaveLength(2);
    // The SECOND answers first, then the stale first arrives.
    resolvers[1](ok(['fresh.ts']));
    await settle();
    resolvers[0](ok(['stale.ts']));
    await settle();
    expect(getGitStatus('/proj')?.files.map((f) => f.path)).toEqual(['fresh.ts']);
  });

  it('⚠️ NO BRIDGE IS NOT A THROW', () => {
    // `window.switchboard` is installed by the preload, so a module-level reader
    // can run before it exists. Three `FileTree` tests failed with
    // `Cannot read properties of undefined` the moment this store was wired in,
    // which is the suite catching a real fail-open gap.
    delete (globalThis as { switchboard?: unknown }).switchboard;
    expect(() => refreshGitStatus('/proj')).not.toThrow();
    expect(getGitStatus('/proj')).toBeNull();
  });

  it('`putGitStatus` is how the Changes tab SHARES ITS MOMENT, not just its shape', async () => {
    // That tab's read includes the per-file numbers; handing the answer over means
    // the tree's badges and the sidebar's rows cannot disagree, and no second
    // `git status` is spent.
    const { calls } = bridge(async () => ok(['from-the-store.ts']));
    let seen = 0;
    subscribeGitStatus(() => void seen++);
    putGitStatus('/proj', ok(['from-the-tab.ts']));
    expect(seen).toBe(1);
    expect(getGitStatus('/proj')?.files.map((f) => f.path)).toEqual(['from-the-tab.ts']);
    // …and the next reader is answered from that, rather than fetching.
    refreshGitStatus('/proj');
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('nothing is learned about an absent folder', () => {
    bridge(async () => ok(['a.ts']));
    expect(() => refreshGitStatus(undefined)).not.toThrow();
    expect(getGitStatus(undefined)).toBeNull();
    expect(() => putGitStatus(undefined, ok([]))).not.toThrow();
  });
});
