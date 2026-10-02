// The renderer's half of the write verbs (E24 Git v2 item 12).
//
// ⚠️ **WHAT THIS FILE IS REALLY ABOUT IS WHAT HAPPENS WHEN A WRITE DOES NOT
// WORK.** The happy path is one `invoke`. The interesting cases are all failure
// cases, and they matter more here than anywhere else in the epic: a write that
// silently did nothing leaves the surface drawing a change it thinks it removed,
// and a refusal mistaken for success leaves it saying "staged" about a file that
// is not.
import { describe, it, expect, afterEach } from 'vitest';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  canWriteGit,
  confirmDiscard,
  discardFiles,
  stageFiles,
  unstageFiles,
} from './git-write';

type Impl = (folder: string, paths: readonly string[]) => Promise<unknown>;

/** Install a fake bridge and record every call. */
function bridge(impl: Impl, only?: 'stage' | 'unstage' | 'discard'): {
  calls: Array<{ verb: string; folder: string; paths: readonly string[] }>;
} {
  const calls: Array<{ verb: string; folder: string; paths: readonly string[] }> = [];
  const wrap =
    (verb: string): Impl =>
    (folder, paths) => {
      calls.push({ verb, folder, paths });
      return impl(folder, paths);
    };
  const git: Record<string, Impl> = {};
  for (const verb of ['stage', 'unstage', 'discard'] as const) {
    if (!only || only === verb) git[verb] = wrap(verb);
  }
  (globalThis as { switchboard?: unknown }).switchboard = { git };
  return { calls };
}

const okResult = { ok: true, applied: 2 };

describe('the write verbs', () => {
  afterEach(() => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
  });

  it('stages, unstages and discards through their own channels (the done-when)', async () => {
    const { calls } = bridge(async () => okResult);
    expect(await stageFiles('/proj', ['a.ts', 'b.ts'])).toEqual(okResult);
    expect(await unstageFiles('/proj', ['a.ts'])).toEqual(okResult);
    expect(await discardFiles('/proj', ['a.ts'])).toEqual(okResult);
    expect(calls.map((c) => c.verb)).toEqual(['stage', 'unstage', 'discard']);
    expect(calls[0]).toMatchObject({ folder: '/proj', paths: ['a.ts', 'b.ts'] });
  });

  it('⚠️ A REFUSAL IS NOT A SUCCESS (#650)', async () => {
    // A channel can answer with a refusal instead of its payload. Read as a value
    // that is `undefined.ok` — or worse, a surface reporting "staged" for
    // something that never ran.
    bridge(async () => ipcRefusal('git:stage', 'capability-not-held'));
    const r = await stageFiles('/proj', ['a.ts']);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.reason).toBeTruthy();
  });

  it('⚠️ A REJECTED INVOKE SAYS SO, rather than looking like it worked', async () => {
    // A handler that threw, or a window torn down mid-call. `answered` never sees
    // this one, so without the catch it is an unhandled rejection AND a button
    // that reports nothing.
    bridge(async () => {
      throw new Error('the bridge is gone');
    });
    const r = await discardFiles('/proj', ['a.ts']);
    expect(r).toMatchObject({ ok: false, applied: 0 });
    expect(r.reason).toContain('could not reach git');
  });

  it('⚠️ A PAYLOAD THAT IS NOT AN OUTCOME IS A FAILURE, not a truthy object', async () => {
    // `answered()` is a brand, not a validation: a reply missing `ok` gets this
    // far. Treating it as success is the shape that would have the surface lie.
    for (const junk of [{}, { applied: 3 }, { ok: 'yes' }, 42, 'done']) {
      bridge(async () => junk);
      expect((await stageFiles('/proj', ['a.ts'])).ok).toBe(false);
    }
  });

  it('⚠️ REPORTS THE COUNT MAIN GIVES BACK, including a PARTIAL one', async () => {
    // A discard is two commands; if the second fails the first really did happen.
    // A result that said `applied: 0` after restoring six files would send the
    // user looking for changes that are gone.
    bridge(async () => ({ ok: false, reason: 'git refused', applied: 6 }));
    expect(await discardFiles('/proj', ['a.ts'])).toEqual({
      ok: false,
      reason: 'git refused',
      applied: 6,
    });
  });

  it('⚠️ NO BRIDGE IS A REPORTED FAILURE AND NEVER A THROW', async () => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
    expect(canWriteGit()).toBe(false);
    const r = await stageFiles('/proj', ['a.ts']);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot change a repository');
  });

  it('⚠️ `canWriteGit` IS ALL THREE OR NONE, so a half-wired build draws no buttons', async () => {
    // The owner's rule: a control that does nothing is worse than no control. A
    // build with stage and no discard would draw a ↶ that cannot work.
    bridge(async () => okResult, 'stage');
    expect(canWriteGit()).toBe(false);
    bridge(async () => okResult);
    expect(canWriteGit()).toBe(true);
  });

  it('refuses the shapes that cannot mean anything, without calling out', async () => {
    const { calls } = bridge(async () => okResult);
    expect((await stageFiles('', ['a.ts'])).ok).toBe(false);
    expect((await stageFiles('/proj', [])).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('what the discard confirm says', () => {
  it('⚠️ NAMES THE FILE for one, and the COUNT for many', () => {
    // Design §4 item 12: "Discard is destructive: confirm, naming the file
    // count." A dialog reading "Discard changes?" over a group heading can mean
    // forty files and the heading does not say which — while a list of forty
    // names in a dialog is a wall nobody reads.
    expect(confirmDiscard(['src/a.ts'])).toEqual({
      key: 'scm.discardOneConfirm',
      values: { count: 1, file: 'src/a.ts' },
    });
    expect(confirmDiscard(['a.ts', 'b.ts', 'c.ts'])).toEqual({
      key: 'scm.discardManyConfirm',
      values: { count: 3, file: 'a.ts' },
    });
  });

  it('returns a KEY, so the catalog owns the words and ICU owns the plural', () => {
    // Not a sentence: a module that built the string would be a second place the
    // app's language lives, and `react/jsx-no-literals` exists to stop exactly
    // that.
    expect(confirmDiscard(['a.ts']).key.startsWith('scm.')).toBe(true);
  });

  it('does not fall over on an empty list, though no caller should reach it', () => {
    expect(confirmDiscard([]).values).toEqual({ count: 0, file: '' });
  });
});
