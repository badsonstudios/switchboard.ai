import { describe, beforeEach, it, expect, vi } from 'vitest';
import { planSessionStart, StartPlanInput } from './start-plan';
import { OrphanQuery, ProviderCapabilities, ResumeQuery } from '../extensibility/contributions';

/** Ids the host was asked to release, so the undo half is assertable (#470). */
const released: string[] = [];
const host = {
  buildHookSettings: (id: string) => ({ hooks: { seen: id } }),
  releaseHookSettings: (id: string) => {
    released.push(id);
  },
};

/** An adapter that declares everything, the way Claude does. */
function fullCaps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    transcripts: { projectsRoot: () => '/roots/claude' },
    hooks: { settingsFor: (id, h) => h.buildHookSettings(id) },
    resume: { canResume: () => true },
    trust: { ensureTrusted: () => true },
    ...over,
  };
}

/** One registered provider, `p`, unless the test says otherwise. */
function input(over: Partial<StartPlanInput> = {}): StartPlanInput {
  return {
    capabilitiesOf: () => undefined,
    isRegistered: (id) => id === 'p',
    defaultProviderId: () => 'p',
    folder: '/work/app',
    // no other card holds anything, unless the test says so (#484)
    claimedNativeIds: () => [],
    ...over,
  };
}

const plan = (over: Partial<StartPlanInput> = {}) => planSessionStart(input(over), host);

/** Plan + everything reported through the sink, which is the channel the only
 *  production caller actually reads. */
function planWithSink(over: Partial<StartPlanInput> = {}) {
  const reported: string[] = [];
  const p = planSessionStart(input({ onDegraded: (r) => reported.push(r), ...over }), host);
  return { plan: p, reported };
}

beforeEach(() => {
  released.length = 0;
});

describe('planSessionStart', () => {
  describe('a provider that declares NOTHING degrades to PTY-only', () => {
    it('injects no settings', () => {
      // undefined, not an empty object: the manager skips settingsFor entirely,
      // so no file is written AND no hook token is registered
      expect(plan({ prior: { nativeSessionId: 'native-1' } }).buildSettings).toBeUndefined();
    });
    it('starts no transcript watch', () => {
      expect(plan().transcriptsRoot).toBeUndefined();
    });
    it('does nothing to the project folder', () => {
      expect(plan().ensureTrusted).toBeUndefined();
    });
    it('does not resume, even with a native id on the card', () => {
      expect(plan({ prior: { nativeSessionId: 'native-1' } }).resumeSessionId).toBeUndefined();
    });
    it('still names a provider to spawn, and warns about nothing', () => {
      const p = plan();
      expect(p.providerId).toBe('p');
      expect(p.warnings).toEqual([]);
    });
  });

  it('an empty capabilities object is the same as none', () => {
    const p = plan({ capabilitiesOf: () => ({}), prior: { nativeSessionId: 'n' } });
    expect(p.buildSettings).toBeUndefined();
    expect(p.transcriptsRoot).toBeUndefined();
    expect(p.resumeSessionId).toBeUndefined();
    expect(p.ensureTrusted).toBeUndefined();
  });

  it('a fully-capable provider gets all four', () => {
    const p = plan({ capabilitiesOf: () => fullCaps(), prior: { nativeSessionId: 'native-1' } });
    expect(p.transcriptsRoot).toBe('/roots/claude');
    expect(p.resumeSessionId).toBe('native-1');
    expect(p.buildSettings?.('sess-9')).toEqual({ hooks: { seen: 'sess-9' } });
    expect(p.ensureTrusted).toBeTypeOf('function');
  });

  describe('each capability is independent', () => {
    it('transcripts without hooks writes nothing', () => {
      const p = plan({ capabilitiesOf: () => ({ transcripts: { projectsRoot: () => '/r' } }) });
      expect(p.transcriptsRoot).toBe('/r');
      expect(p.buildSettings).toBeUndefined();
    });

    it('hooks without transcripts watches nothing', () => {
      const p = plan({
        capabilitiesOf: () => ({ hooks: { settingsFor: (id, h) => h.buildHookSettings(id) } }),
      });
      expect(p.transcriptsRoot).toBeUndefined();
      expect(p.buildSettings).toBeTypeOf('function');
    });

    it('a provider that cannot say WHERE its transcripts are is not watched', () => {
      // an empty root would poll a directory that does not exist for ever and
      // report nothing — that reads as a bug, not as "no transcripts"
      const p = plan({ capabilitiesOf: () => ({ transcripts: { projectsRoot: () => '' } }) });
      expect(p.transcriptsRoot).toBeUndefined();
    });
  });

  describe('resume asks the provider rather than assuming', () => {
    it('no resume capability means a fresh session even with a native id', () => {
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: undefined }),
        prior: { nativeSessionId: 'native-1' },
      });
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('the provider saying "that conversation is gone" falls back to fresh', () => {
      // a stale id is not harmless — the CLI exits at spawn and the card
      // crashes, which is why this is checked before it is used
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: { canResume: () => false } }),
        prior: { nativeSessionId: 'native-1' },
      });
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('no native id means the provider is never even asked', () => {
      const canResume = vi.fn(() => true);
      const p = plan({ capabilitiesOf: () => fullCaps({ resume: { canResume } }) });
      expect(p.resumeSessionId).toBeUndefined();
      expect(canResume).not.toHaveBeenCalled();
    });

    it('asks with the folder and the id it is deciding about', () => {
      const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
      plan({
        capabilitiesOf: () => fullCaps({ resume: { canResume } }),
        prior: { nativeSessionId: 'native-1' },
      });
      expect(canResume).toHaveBeenCalledWith({
        projectsRoot: '/roots/claude',
        folder: '/work/app',
        nativeSessionId: 'native-1',
      });
    });

    describe('...and about the ONE root this plan declares (#432)', () => {
      // Eligibility and #395's resumed-history replay must read the same
      // directory. Two independent declarations agree by coincidence: an adapter
      // answering "yes" from a root the host never reads passes this check and
      // then replays nothing — the blank-resume symptom #395 fixed, one
      // abstraction up.
      it('is asked about exactly the root the session will watch and replay from', () => {
        const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
        const p = plan({
          capabilitiesOf: () =>
            fullCaps({
              transcripts: { projectsRoot: () => '/roots/somewhere-else' },
              resume: { canResume },
            }),
          prior: { nativeSessionId: 'native-1' },
        });
        expect(p.transcriptsRoot).toBe('/roots/somewhere-else');
        expect(canResume.mock.calls[0][0].projectsRoot).toBe(p.transcriptsRoot);
      });

      it('a provider with no transcripts is handed no root, not a made-up one', () => {
        // it may still resume — resumability that has nothing to do with a local
        // transcript is the adapter's own knowledge to report
        const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
        const p = plan({
          capabilitiesOf: () => ({ resume: { canResume } }),
          prior: { nativeSessionId: 'native-1' },
        });
        expect(canResume).toHaveBeenCalledWith({
          projectsRoot: '',
          folder: '/work/app',
          nativeSessionId: 'native-1',
        });
        expect(p.resumeSessionId).toBe('native-1');
      });

      it('a transcripts capability that THREW hands over "", not a stale root', () => {
        const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
        const p = plan({
          capabilitiesOf: () =>
            fullCaps({
              transcripts: {
                projectsRoot: () => {
                  throw new Error('adapter is broken');
                },
              },
              resume: { canResume },
            }),
          prior: { nativeSessionId: 'native-1' },
        });
        expect(p.transcriptsRoot).toBeUndefined();
        expect(canResume.mock.calls[0][0].projectsRoot).toBe('');
      });

      it('an unusable empty root is "" here too — the plan and the query agree', () => {
        const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
        const p = plan({
          capabilitiesOf: () =>
            fullCaps({ transcripts: { projectsRoot: () => '' }, resume: { canResume } }),
          prior: { nativeSessionId: 'native-1' },
        });
        expect(p.transcriptsRoot).toBeUndefined();
        expect(canResume.mock.calls[0][0].projectsRoot).toBe('');
      });
    });
  });

  describe('which provider a card runs on', () => {
    it('a new card takes the default', () => {
      expect(plan().providerId).toBe('p');
    });

    it('an EXISTING card keeps its own provider over the default', () => {
      // otherwise changing the default would silently migrate every existing
      // card onto a different CLI — and its persisted native session id would
      // belong to a provider that never wrote it
      const p = plan({
        isRegistered: () => true,
        prior: { providerId: 'codex' },
      });
      expect(p.providerId).toBe('codex');
      expect(p.warnings).toEqual([]);
    });

    it('an empty provider id on the card falls back rather than spawning ""', () => {
      expect(plan({ prior: { providerId: '' } }).providerId).toBe('p');
    });

    it('a card whose provider is GONE falls back instead of becoming unstartable', () => {
      // spawning resolves the adapter and throws when it is missing, so keeping
      // the dead id would brick this card for ever — one degraded card beats a
      // card that can never start again
      const p = plan({ prior: { providerId: 'codex', nativeSessionId: 'native-1' } });
      expect(p.providerId).toBe('p');
      expect(p.warnings).toHaveLength(1);
      expect(p.warnings[0]).toMatch(/codex/);
    });

    it('a card that falls back is judged by the DEFAULT provider capabilities', () => {
      // the native id belongs to a provider that is gone; the fallback provider
      // decides whether it means anything
      const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => false);
      const p = plan({
        capabilitiesOf: (id) => (id === 'p' ? fullCaps({ resume: { canResume } }) : undefined),
        prior: { providerId: 'codex', nativeSessionId: 'native-1' },
      });
      // the fallback provider's root as well as its verdict — a card judged by
      // one provider must not be resumed out of another's directory
      expect(canResume).toHaveBeenCalledWith({
        projectsRoot: '/roots/claude',
        folder: '/work/app',
        nativeSessionId: 'native-1',
      });
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('does not reach for the default when the card already names a live one', () => {
      const defaultProviderId = vi.fn(() => 'p');
      plan({ isRegistered: () => true, defaultProviderId, prior: { providerId: 'codex' } });
      expect(defaultProviderId).not.toHaveBeenCalled();
    });
  });

  // #484 — a card's id is recorded when the CLI announces one, and the CLI
  // writes no transcript for a conversation until a real turn happens (S-07).
  // A session that got no prompt therefore leaves the card pointing at a file
  // that will never exist, over the top of the id that has the history. Resume
  // walks the CHAIN, not one id.
  describe('resume falls back through the lineage (#484)', () => {
    const onlyOnDisk = (...present: string[]) =>
      fullCaps({ resume: { canResume: ({ nativeSessionId }) => present.includes(nativeSessionId) } });

    it('takes the head when the head is really there', () => {
      const p = plan({
        capabilitiesOf: () => onlyOnDisk('b', 'a'),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
      });
      expect(p.resumeSessionId).toBe('b');
      expect(p.resumedVia).toBe('stored');
    });

    it('falls back to the ancestor when the head has no transcript', () => {
      // THE bug, as a single assertion: new id announced, quit without
      // prompting, relaunch
      const p = plan({
        capabilitiesOf: () => onlyOnDisk('a'),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
      });
      expect(p.resumeSessionId).toBe('a');
      expect(p.resumedVia).toBe('lineage');
    });

    it('walks the whole chain, nearest ancestor first', () => {
      const canResume = vi.fn<(q: ResumeQuery) => boolean>(({ nativeSessionId }) => nativeSessionId === 'a');
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: { canResume } }),
        prior: { nativeSessionId: 'd', nativeSessionLineage: ['c', 'b', 'a'] },
      });
      expect(canResume.mock.calls.map((c) => c[0].nativeSessionId)).toEqual(['d', 'c', 'b', 'a']);
      expect(p.resumeSessionId).toBe('a');
    });

    it('stops asking as soon as one answers yes', () => {
      const canResume = vi.fn<(q: ResumeQuery) => boolean>(() => true);
      plan({
        capabilitiesOf: () => fullCaps({ resume: { canResume } }),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
      });
      expect(canResume).toHaveBeenCalledTimes(1);
    });

    it('a chain with nothing on disk starts fresh, as it always did', () => {
      const p = plan({
        capabilitiesOf: () => onlyOnDisk(),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
      });
      expect(p.resumeSessionId).toBeUndefined();
      expect(p.resumedVia).toBeUndefined();
    });

    it('a capability that throws is reported ONCE, not once per ancestor', () => {
      // `safely` reports on every call, so a broken adapter would otherwise post
      // eleven identical warnings for one fault
      const canResume = vi.fn(() => {
        throw new Error('adapter is broken');
      });
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps({ resume: { canResume } }),
        prior: { nativeSessionId: 'd', nativeSessionLineage: ['c', 'b', 'a'] },
      });
      expect(canResume).toHaveBeenCalledTimes(1);
      expect(reported.filter((r) => r.includes('resume.canResume'))).toHaveLength(1);
      expect(p.resumeSessionId).toBeUndefined();
    });
  });

  // The other half of #484: cards orphaned BEFORE the lineage existed carry an
  // id with no transcript, no ancestors, and their real history under an id
  // nothing now refers to. The chain prevents the next one; only a look in the
  // folder recovers the ones already made.
  describe('a card whose whole chain is gone can be reattached (#484)', () => {
    const gone = { canResume: () => false };

    it('adopts the conversation the provider found, and says so', () => {
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned: () => 'orphan-1' } }),
        prior: { nativeSessionId: 'announced-never-written' },
      });
      expect(p.resumeSessionId).toBe('orphan-1');
      expect(p.resumedVia).toBe('adopted');
      // a recovery the user might disagree with is never silent
      expect(reported.join()).toMatch(/orphan-1/);
    });

    it('is NEVER offered to a card that has no conversation to lose', () => {
      // the whole safety of the guess: a brand-new session in a folder full of
      // old transcripts cannot adopt a stranger's
      const findOrphaned = vi.fn(() => 'orphan-1');
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned } }),
        prior: {},
      });
      expect(findOrphaned).not.toHaveBeenCalled();
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('is NEVER offered to a card whose only conversation was CEDED (#539)', () => {
      // The kind-looking widening, and the reason it is wrong: this card's
      // conversation is not missing, it is someone else's. `ownIds` would be
      // empty, so the adapter's own absence check goes vacuous at the same
      // moment — and the newest unclaimed transcript in a busy folder is almost
      // certainly a stranger's. It starts fresh; the notice is the way back.
      const findOrphaned = vi.fn(() => 'orphan-1');
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned } }),
        prior: { cededNativeIds: ['someone-elses-conversation'] },
      });
      expect(findOrphaned).not.toHaveBeenCalled();
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('does not put a ceded id in ownIds for a card that still has a chain', () => {
      // `ownIds` is the list the adapter re-verifies as definitively ABSENT, and
      // a ceded conversation is present and someone else's — listing it there
      // would make the adapter decline every repair for this card.
      const asked: OrphanQuery[] = [];
      const findOrphaned = (q: OrphanQuery): string => {
        asked.push(q);
        return 'orphan-1';
      };
      plan({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned } }),
        prior: { nativeSessionId: 'mine', cededNativeIds: ['ceded'] },
      });
      expect(asked[0].ownIds).toEqual(['mine']);
      expect(asked[0].ownIds).not.toContain('ceded');
    });

    it('is not reached at all when the chain resolved', () => {
      const findOrphaned = vi.fn(() => 'orphan-1');
      const p = plan({
        capabilitiesOf: () =>
          fullCaps({ resume: { canResume: ({ nativeSessionId }) => nativeSessionId === 'a', findOrphaned } }),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
      });
      expect(findOrphaned).not.toHaveBeenCalled();
      expect(p.resumeSessionId).toBe('a');
    });

    it('hands over other cards ids and its OWN separately', () => {
      const findOrphaned =
        vi.fn<(q: { claimed: string[]; ownIds: string[] }) => string | null>(() => null);
      plan({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned } }),
        prior: { nativeSessionId: 'b', nativeSessionLineage: ['a'] },
        claimedNativeIds: () => ['someone-elses', 'b'],
      });
      // Split, not merged: both are unofferable, but only `ownIds` is the list
      // the provider must RE-VERIFY before answering — `canResume` said no,
      // which does not distinguish "not there" from "could not look" — and
      // merged in it could not tell which ids were the card's own.
      const q = findOrphaned.mock.calls[0][0];
      expect(q.claimed).toEqual(['someone-elses']);
      expect(q.ownIds).toEqual(['b', 'a']);
    });

    it('is skipped entirely when the claimed list cannot be read', () => {
      // that list is the guarantee that two cards cannot end up in one
      // conversation. Performing the repair with it silently empty would be a
      // guarantee in the comments only.
      const findOrphaned = vi.fn(() => 'orphan-1');
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps({ resume: { ...gone, findOrphaned } }),
        prior: { nativeSessionId: 'b' },
        claimedNativeIds: () => {
          throw new Error('the workspace would not read');
        },
      });
      expect(findOrphaned).not.toHaveBeenCalled();
      expect(p.resumeSessionId).toBeUndefined();
      expect(reported.join()).toMatch(/claimedNativeIds/);
    });

    it('a provider that does not offer the capability simply starts fresh', () => {
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: gone }),
        prior: { nativeSessionId: 'b' },
      });
      expect(p.resumeSessionId).toBeUndefined();
    });

    it('is not attempted when the resume CHECK broke — a guess needs a real no', () => {
      // `canResume` threw, so we never learned that the chain is missing. Asking
      // for a replacement on the strength of an error is how a working card gets
      // moved into someone else's conversation.
      const findOrphaned = vi.fn(() => 'orphan-1');
      plan({
        capabilitiesOf: () =>
          fullCaps({
            resume: {
              canResume: () => {
                throw new Error('adapter is broken');
              },
              findOrphaned,
            },
          }),
        prior: { nativeSessionId: 'b' },
      });
      expect(findOrphaned).not.toHaveBeenCalled();
    });

    it('a finder that throws degrades to a fresh start, not a failed session', () => {
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () =>
          fullCaps({
            resume: {
              ...gone,
              findOrphaned: () => {
                throw new Error('adapter is broken');
              },
            },
          }),
        prior: { nativeSessionId: 'b' },
      });
      expect(p.resumeSessionId).toBeUndefined();
      expect(p.providerId).toBe('p'); // still startable
      expect(reported.join()).toMatch(/resume.findOrphaned/);
    });

    it('asks about the one root this plan declares, like every other resume question', () => {
      const findOrphaned = vi.fn<(q: { projectsRoot: string; folder: string }) => string | null>(
        () => null
      );
      const p = plan({
        capabilitiesOf: () =>
          fullCaps({
            transcripts: { projectsRoot: () => '/roots/somewhere-else' },
            resume: { ...gone, findOrphaned },
          }),
        prior: { nativeSessionId: 'b' },
      });
      expect(findOrphaned.mock.calls[0][0]).toMatchObject({
        projectsRoot: p.transcriptsRoot,
        folder: '/work/app',
      });
    });
  });

  describe('a contributor that throws degrades that capability, not the session', () => {
    const boom = () => {
      throw new Error('adapter is broken');
    };

    it('resume', () => {
      const p = plan({
        capabilitiesOf: () => fullCaps({ resume: { canResume: boom } }),
        prior: { nativeSessionId: 'native-1' },
      });
      expect(p.resumeSessionId).toBeUndefined();
      expect(p.providerId).toBe('p'); // still startable
      expect(p.warnings.join()).toMatch(/resume.canResume/);
    });

    it('transcripts', () => {
      const p = plan({ capabilitiesOf: () => fullCaps({ transcripts: { projectsRoot: boom } }) });
      expect(p.transcriptsRoot).toBeUndefined();
      expect(p.warnings.join()).toMatch(/transcripts.projectsRoot/);
    });

    it('hooks — lazily, and the report reaches the SINK, not a drained array', () => {
      // buildSettings runs inside the session manager, long after the caller
      // read the plan — a warnings list would be empty by then
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps({ hooks: { settingsFor: boom } }),
      });
      expect(reported).toEqual([]); // nothing has gone wrong yet
      // empty settings, not a crashed spawn: the session starts without hooks
      expect(p.buildSettings?.('sess-1')).toEqual({});
      expect(reported.join()).toMatch(/hooks.settingsFor/);
    });

    it('trust — also lazily, also through the sink', () => {
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps({ trust: { ensureTrusted: boom } }),
      });
      expect(reported).toEqual([]);
      expect(p.ensureTrusted?.('/work/app')).toBe(false); // the caller can say so
      expect(reported.join()).toMatch(/trust.ensureTrusted/);
    });

    it('isRegistered — and the reason does not claim the provider is missing', () => {
      // "not registered" when the CHECK blew up sends the next reader hunting
      // for a registration bug that does not exist
      const { plan: p, reported } = planWithSink({
        isRegistered: boom,
        prior: { providerId: 'codex' },
      });
      expect(p.providerId).toBe('p');
      expect(reported.join()).toMatch(/could not tell/);
    });

    it('a default provider that is not registered either is called out', () => {
      const { plan: p, reported } = planWithSink({ isRegistered: () => false });
      expect(p.providerId).toBe('p'); // still the best answer available
      expect(reported.join()).toMatch(/default provider "p" is not registered/);
    });

    it('capabilitiesOf itself', () => {
      const p = plan({ capabilitiesOf: boom });
      expect(p.providerId).toBe('p');
      expect(p.buildSettings).toBeUndefined();
      expect(p.warnings.join()).toMatch(/capabilitiesOf/);
    });
  });

  it('hook settings are built lazily, per session id', () => {
    // the id does not exist until the manager mints it, so this must be a
    // function and not a value computed here
    const settingsFor = vi.fn((id: string) => ({ id }));
    const p = plan({ capabilitiesOf: () => ({ hooks: { settingsFor } }) });
    expect(settingsFor).not.toHaveBeenCalled();
    expect(p.buildSettings?.('late-id')).toEqual({ id: 'late-id' });
    expect(settingsFor).toHaveBeenCalledWith('late-id', host);
  });

  // #470: building settings registers a token against the id, so the plan has
  // to carry the way to give it back — for the start that throws before there
  // is a session to end.
  describe('the undo of buildSettings travels with it (#470)', () => {
    it('a provider with no hooks capability offers neither half', () => {
      const p = plan({ capabilitiesOf: () => ({ transcripts: { projectsRoot: () => '/r' } }) });
      expect(p.buildSettings).toBeUndefined();
      expect(p.releaseSettings).toBeUndefined();
    });

    it('declaring hooks gets both halves', () => {
      const p = plan({ capabilitiesOf: () => fullCaps() });
      expect(p.buildSettings).toBeTypeOf('function');
      expect(p.releaseSettings).toBeTypeOf('function');
    });

    it('releases against the HOST, not the adapter — the token is the host’s', () => {
      // The adapter only ever shaped what the host had already registered, so
      // an adapter that translates settings has nothing to undo. Pinned with a
      // capability whose settingsFor never touches the host at all.
      const p = plan({ capabilitiesOf: () => ({ hooks: { settingsFor: () => ({ mine: 1 }) } }) });
      p.releaseSettings?.('sess-9');
      expect(released).toEqual(['sess-9']);
    });

    it('a host that throws is reported, not propagated — this runs on a failure path', () => {
      const { plan: p, reported } = planWithSink({
        capabilitiesOf: () => fullCaps(),
      });
      const boomHost = {
        buildHookSettings: () => ({}),
        releaseHookSettings: () => {
          throw new Error('nope');
        },
      };
      const withBoom = planSessionStart(input({ capabilitiesOf: () => fullCaps() }), boomHost);
      expect(() => withBoom.releaseSettings?.('sess-9')).not.toThrow();
      // named as the HOST's fault, not the provider's: the release never went
      // near the adapter, and `safely`'s "provider capability" wording would
      // send the next reader hunting through an adapter with no code in it
      expect(withBoom.warnings.join()).toMatch(/hook host "releaseHookSettings" threw/);
      expect(withBoom.warnings.join()).not.toMatch(/provider capability/);
      // and the ordinary host says nothing
      p.releaseSettings?.('sess-9');
      expect(reported).toEqual([]);
    });
  });
});

// P2-E7-06: `titles` is the fifth capability, and the reason it is one is that
// a session on an adapter without it must start NO title watch at all.
describe('titles (P2-E7-06, §5.11)', () => {
  const line = { type: 'ai-title', aiTitle: 'Wire up the parser' };

  it('hands the caller a reader when the adapter declares one', () => {
    const p = plan({
      capabilitiesOf: () => fullCaps({ titles: { titleFrom: () => 'Wire up the parser' } }),
    });
    expect(p.readTitle?.(line)).toBe('Wire up the parser');
  });

  it('hands back NOTHING when it does not — no reader, no watch, no dead path', () => {
    const p = plan({ capabilitiesOf: () => fullCaps({ titles: undefined }) });
    expect(p.readTitle).toBeUndefined();
  });

  it('an adapter that declares nothing at all gets no reader either', () => {
    expect(plan().readTitle).toBeUndefined();
  });

  it('a reader that throws degrades titles for the session — reported ONCE', () => {
    // The only capability asked per transcript LINE. Reporting each throw would
    // grow an unbounded warning list and flood the log at transcript speed, so
    // the first one switches it off for the rest of the session.
    const onDegraded = vi.fn();
    const p = plan({
      onDegraded,
      capabilitiesOf: () =>
        fullCaps({
          titles: {
            titleFrom: () => {
              throw new Error('boom');
            },
          },
        }),
    });
    for (let i = 0; i < 50; i++) expect(p.readTitle?.(line)).toBeUndefined();
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded.mock.calls[0][0]).toContain('titles.titleFrom');
  });

  it('a throwing reader costs the session nothing else', () => {
    const p = plan({
      capabilitiesOf: () =>
        fullCaps({
          titles: {
            titleFrom: () => {
              throw new Error('boom');
            },
          },
        }),
    });
    p.readTitle?.(line);
    expect(p.transcriptsRoot).toBe('/roots/claude'); // the transcript is untouched
    expect(p.buildSettings).toBeDefined();
    expect(p.ensureTrusted).toBeDefined();
  });
});
