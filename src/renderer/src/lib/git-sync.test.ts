// Branch and sync, from the renderer (E24 Git v2 item 15).
//
// ⚠️ **THE INTERESTING CASE IS THE ONE WHERE GIT REFUSES**, because for these
// five verbs git's refusal is usually the most useful thing on screen: *"Not
// possible to fast-forward"*, *"has no upstream branch"*, *"Could not resolve
// host"*. Passing those through verbatim is most of the feature.
import { describe, it, expect, afterEach } from 'vitest';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  canSync,
  checkoutBranch,
  createBranch,
  fetchRemote,
  needsUpstream,
  pullRemote,
  pushRemote,
} from './git-sync';

type Any = (...args: unknown[]) => Promise<unknown>;

function bridge(impl: Partial<Record<string, Any>>, only?: string[]): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const verbs = only ?? ['fetch', 'pull', 'push', 'checkout', 'createBranch'];
  const git: Record<string, Any> = {};
  for (const v of verbs) {
    git[v] = (...args: unknown[]) => {
      calls.push([v, ...args]);
      return (impl[v] ?? (async () => ({ ok: true, applied: 1 })))(...args);
    };
  }
  (globalThis as { switchboard?: unknown }).switchboard = { git };
  return { calls };
}

describe('the five verbs', () => {
  afterEach(() => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
  });

  it('each calls its own channel (the done-when)', async () => {
    const { calls } = bridge({});
    expect(await fetchRemote('/proj')).toEqual({ ok: true, applied: 1 });
    await pullRemote('/proj');
    await pushRemote('/proj');
    await checkoutBranch('/proj', 'main');
    await createBranch('/proj', 'side', 'abc1234');
    expect(calls.map((c) => c[0])).toEqual([
      'fetch',
      'pull',
      'push',
      'checkout',
      'createBranch',
    ]);
    expect(calls[3]).toEqual(['checkout', '/proj', 'main']);
    expect(calls[4]).toEqual(['createBranch', '/proj', 'side', 'abc1234']);
  });

  it('⚠️ `setUpstream` IS PASSED ONLY WHEN ASKED, never added on a retry', async () => {
    // A push that failed for want of an upstream is a different thing from one
    // that failed because somebody else pushed first — and quietly adding the
    // flag would PUBLISH a branch the user had not decided to publish.
    const { calls } = bridge({});
    await pushRemote('/proj');
    // ⚠️ AND IT IS *ABSENT*, not `false`: main reads it as `=== true`, so an
    // explicit `false` would be the same thing said twice — and a flag that is
    // always present is one somebody can flip by mistake.
    expect(calls[0]).toEqual(['push', '/proj', {}]);
    await pushRemote('/proj', { setUpstream: true });
    expect(calls[1]).toEqual(['push', '/proj', { setUpstream: true }]);
  });

  it('⚠️ GIT’S OWN REFUSAL COMES BACK VERBATIM, because it is the useful part', async () => {
    bridge({
      pull: async () => ({
        ok: false,
        applied: 0,
        reason: 'fatal: Not possible to fast-forward, aborting.',
      }),
    });
    expect((await pullRemote('/proj')).reason).toBe('fatal: Not possible to fast-forward, aborting.');
  });

  it('a channel refusal is not a success', async () => {
    bridge({ push: async () => ipcRefusal('git:push', 'capability-not-held') });
    const r = await pushRemote('/proj');
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
  });

  it('a rejected invoke says so rather than looking like it worked', async () => {
    bridge({
      fetch: async () => {
        throw new Error('gone');
      },
    });
    expect((await fetchRemote('/proj')).reason).toContain('could not reach git');
  });

  it('a payload that is not an outcome is a failure', async () => {
    for (const junk of [{}, { applied: 1 }, { ok: 'yes' }, 42, null]) {
      bridge({ fetch: async () => junk });
      expect((await fetchRemote('/proj')).ok).toBe(false);
    }
  });

  it('⚠️ NO BRIDGE IS A REPORTED FAILURE AND NEVER A THROW', async () => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
    expect(canSync()).toBe(false);
    const r = await pullRemote('/proj');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot reach a remote');
  });

  it('⚠️ ALL FIVE OR NONE, so a half-wired build draws no sync buttons', async () => {
    // A build with `push` and no `pull` would draw a ↓ that cannot work, which is
    // the owner's rule about a control that does nothing.
    bridge({}, ['fetch', 'pull', 'push']);
    expect(canSync()).toBe(false);
    bridge({});
    expect(canSync()).toBe(true);
  });

  it('refuses the shapes that cannot mean anything, without calling out', async () => {
    const { calls } = bridge({});
    expect((await fetchRemote('')).ok).toBe(false);
    expect((await checkoutBranch('/proj', '')).ok).toBe(false);
    expect((await createBranch('/proj', '')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('spotting an unpublished branch', () => {
  it('⚠️ MATCHES GIT’S OWN PHRASE, which is how the surface knows to offer a publish', () => {
    // git says "The current branch x has no upstream branch" and then suggests
    // `--set-upstream` itself. Reading that is how the surface knows to offer the
    // second press rather than making the user guess.
    expect(
      needsUpstream('fatal: The current branch side has no upstream branch.')
    ).toBe(true);
  });

  it('⚠️ AND IS NARROW ENOUGH NOT TO MISFIRE ON ANOTHER FAILURE', () => {
    // A wrong match in this direction would offer to publish a branch over
    // somebody else's rejected push, which is worse than not offering at all.
    for (const other of [
      'fatal: Could not resolve host: github.com',
      'error: failed to push some refs',
      'Everything up-to-date',
      'fatal: Not possible to fast-forward',
      undefined,
      '',
    ]) {
      expect(needsUpstream(other), `${String(other)} matched`).toBe(false);
    }
  });
});
