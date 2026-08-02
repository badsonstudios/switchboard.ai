// The zero-capability path, proved through the REAL wiring (P2-E15-01).
//
// `start-plan.test.ts` pins the decisions; this pins that `registerSessionIpc`
// obeys them. Both are needed: a pure function nobody calls correctly is still
// a Claude-shaped session start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSessionIpc, SessionIpcDeps } from './ipc';
import { ProviderCapabilities } from '../extensibility/contributions';
import { PersistedSession } from '../workspace/store';
import { SessionIdentity } from './session-manager';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

/** Capture what `registerSessionIpc` registers, so a channel can be called. */
function fakeBroker(): { broker: SessionIpcDeps['broker']; call: (c: string, ...a: unknown[]) => unknown } {
  const handlers = new Map<string, Handler>();
  const put = (channel: string, fn: Handler): void => {
    // `handle` and `on` share one map here; a channel registered on both would
    // otherwise be silently overwritten and the test would assert the wrong one
    if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
    handlers.set(channel, fn);
  };
  const broker = {
    handle: put,
    on: put,
    send: () => {},
  } as unknown as SessionIpcDeps['broker'];
  return {
    broker,
    call: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`nothing registered on ${channel}`);
      return fn({}, ...args);
    },
  };
}

/** Everything else the module subscribes to at registration time. Explicit
 *  where a return value matters; a no-op elsewhere. */
function harness(
  capabilities: ProviderCapabilities | undefined,
  folder: string,
  opts: {
    prior?: PersistedSession;
    registered?: string[];
    autoTrust?: boolean;
    /** the watcher refuses a root it cannot poll safely */
    watchAccepts?: boolean;
    /** live session ids the manager should claim to know (P2-E18-08b) */
    liveIds?: string[];
  } = {}
) {
  const created: Array<{
    identity: SessionIdentity;
    settingsFor?: unknown;
    resumeSessionId?: string;
    transport?: string;
  }> = [];
  const upserted: PersistedSession[] = [];
  const watched: Array<{ sessionId: string; projectsRoot?: string }> = [];
  const buildHookSettings = vi.fn(() => ({ hooks: {} }));
  const warn = vi.fn();
  const askedFor: string[] = [];
  const watchAccepts = opts.watchAccepts ?? true;
  const { broker, call } = fakeBroker();

  const record = {
    id: 'live-1',
    identity: { title: 't', folder, providerId: 'generic' },
    status: 'starting',
    createdAt: '',
    exitCode: null,
  };

  const deps = {
    manager: {
      onNativeSessionId: () => {},
      onStatusChange: () => {},
      onSessionExit: () => {},
      list: () => [],
      get: (id: string) => (opts.liveIds?.includes(id) ? { ...record, id } : undefined),
      create: (
        identity: SessionIdentity,
        o: { settingsFor?: unknown; resumeSessionId?: string; transport?: string }
      ) => {
        created.push({
          identity,
          settingsFor: o?.settingsFor,
          resumeSessionId: o?.resumeSessionId,
          transport: o?.transport,
        });
        return { ...record, identity };
      },
    },
    ptys: {},
    hooks: {
      onPermissionRequest: () => {},
      onPermissionResolved: () => {},
      buildHookSettings,
    },
    transcripts: {
      onUpdate: () => {},
      onBlock: () => {},
      onReset: () => {},
      watch: (sessionId: string, s: { projectsRoot?: string }) => {
        watched.push({ sessionId, projectsRoot: s.projectsRoot });
        return watchAccepts;
      },
    },
    feed: { onEvent: () => {}, ingest: () => {}, list: () => [] },
    log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    getWindow: () => null,
    broker,
    autoTrust: () => opts.autoTrust ?? false,
    persist: {
      list: () => (opts.prior ? [opts.prior] : []),
      upsert: (s: PersistedSession) => upserted.push(s),
      remove: () => {},
    },
    capabilitiesOf: (id: string) => {
      askedFor.push(id); // which provider was asked about is the wiring itself
      return capabilities;
    },
    isRegisteredProvider: (id: string) => (opts.registered ?? ['generic']).includes(id),
    defaultProviderId: () => 'generic',
    repoRoot: async () => null,
    slashCommands: async () => [],
  } as unknown as SessionIpcDeps;

  registerSessionIpc(deps);
  return { call, created, upserted, watched, buildHookSettings, warn, askedFor };
}

/** A persisted card, the way the workspace store hands it back. */
function priorCard(over: Partial<PersistedSession> & { folder: string }): PersistedSession {
  return {
    id: 'card-1',
    identity: { title: 't', folder: over.folder, providerId: 'generic' },
    layoutSlot: 0,
    suspendedAt: '',
    ...over,
  } as PersistedSession;
}

describe('registerSessionIpc — provider capabilities (P2-E15-01)', () => {
  let folder: string;

  beforeEach(() => {
    // a real directory: session creation reads it to detect the project type
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-'));
  });
  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('a provider declaring ZERO capabilities spawns a PTY-only session', () => {
    const h = harness(undefined, folder);

    const rec = h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' }) as {
      id: string;
    };

    // it still starts — degrading is not failing
    expect(rec.id).toBe('live-1');
    // no settings file: the manager is given nothing to build
    expect(h.created[0].settingsFor).toBeUndefined();
    // no hook token registered either — buildHookSettings is what registers it
    expect(h.buildHookSettings).not.toHaveBeenCalled();
    // no transcript watch at all
    expect(h.watched).toHaveLength(0);
    // and no resume attempted
    expect(h.created[0].resumeSessionId).toBeUndefined();
  });

  it('a provider declaring transcripts is watched under ITS root, not ours', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/somewhere/else' } }, folder);

    h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

    expect(h.watched).toEqual([{ sessionId: 'live-1', projectsRoot: '/somewhere/else' }]);
    expect(h.buildHookSettings).not.toHaveBeenCalled(); // still no hooks
  });

  it('a provider declaring hooks gets the host wiring, shaped by the adapter', () => {
    const settingsFor = vi.fn((id: string, host: { buildHookSettings(i: string): unknown }) => ({
      wrapped: host.buildHookSettings(id),
    }));
    const h = harness({ hooks: { settingsFor } }, folder);

    h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

    const build = h.created[0].settingsFor as (id: string) => unknown;
    expect(build).toBeTypeOf('function');
    // lazy: the session id does not exist until the manager mints it
    expect(h.buildHookSettings).not.toHaveBeenCalled();
    expect(build('live-1')).toEqual({ wrapped: { hooks: {} } });
    expect(settingsFor).toHaveBeenCalledOnce();
    expect(h.watched).toHaveLength(0); // still no transcripts
  });

  describe('preparing the folder belongs to the provider', () => {
    it('auto-trust on + a trust capability: asked once, for this folder', () => {
      const ensureTrusted = vi.fn(() => true);
      const h = harness({ trust: { ensureTrusted } }, folder, { autoTrust: true });

      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

      expect(ensureTrusted).toHaveBeenCalledExactlyOnceWith(folder);
    });

    it('auto-trust on + NO trust capability: the folder is left alone', () => {
      // a provider that has never heard of ~/.claude.json must not have it
      // written on its behalf — this is the assumption that used to be
      // unconditional
      const h = harness(undefined, folder, { autoTrust: true });
      expect(() =>
        h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' })
      ).not.toThrow();
      expect(h.created).toHaveLength(1);
    });

    it('auto-trust off: the capability is never called', () => {
      const ensureTrusted = vi.fn(() => true);
      const h = harness({ trust: { ensureTrusted } }, folder);
      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });
      expect(ensureTrusted).not.toHaveBeenCalled();
    });

    it('a trust failure is reported rather than swallowed', () => {
      const h = harness({ trust: { ensureTrusted: () => false } }, folder, { autoTrust: true });
      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });
      expect(h.warn).toHaveBeenCalledWith('auto-trust failed — the provider may prompt in the terminal', {
        cardId: 'card-1',
        folder,
      });
    });
  });

  it('a refused transcripts root is reported against the CARD', () => {
    // a warning keyed by a live session id, in the transcripts log, is not
    // something anyone can connect to "the Session tab is empty"
    const h = harness({ transcripts: { projectsRoot: () => 'relative/path' } }, folder, {
      watchAccepts: false,
    });

    h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

    expect(h.warn).toHaveBeenCalledWith('provider declares transcripts but the root was refused', {
      cardId: 'card-1',
      root: 'relative/path',
    });
  });

  it('a capability that throws LATER is still reported', () => {
    // buildSettings runs inside the session manager, after the create handler
    // has returned its plan — the failure has to reach a log from there
    const h = harness(
      {
        hooks: {
          settingsFor: () => {
            throw new Error('adapter is broken');
          },
        },
      },
      folder
    );

    h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });
    const build = h.created[0].settingsFor as (id: string) => unknown;
    expect(build('live-1')).toEqual({}); // degraded, not crashed

    expect(h.warn).toHaveBeenCalledWith(
      'session start degraded',
      expect.objectContaining({ cardId: 'card-1' })
    );
  });

  describe('a card that already exists', () => {
    it('keeps its own provider, and resumes when that provider says it can', () => {
      const h = harness(
        { resume: { canResume: () => true } },
        folder,
        {
          prior: priorCard({
            folder,
            identity: { title: 't', folder, providerId: 'codex' },
            nativeSessionId: 'native-7',
          }),
          registered: ['generic', 'codex'],
        }
      );

      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

      expect(h.created).toHaveLength(1);
      expect(h.created[0].identity.providerId).toBe('codex');
      // and the capabilities consulted were ITS provider's, not the default's
      expect(h.askedFor).toEqual(['codex']);
      expect(h.created[0].resumeSessionId).toBe('native-7');
      expect(h.upserted[0].nativeSessionId).toBe('native-7');
    });

    it('declining a resume CLEARS the stale id rather than persisting it again', () => {
      const h = harness({ resume: { canResume: () => false } }, folder, {
        prior: priorCard({ folder, nativeSessionId: 'stale-id' }),
      });

      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

      expect(h.created[0].resumeSessionId).toBeUndefined();
      // keeping it would make every future start retry a conversation that is
      // not there; the fresh session's own id arrives via onNativeSessionId
      expect(h.upserted[0].nativeSessionId).toBeUndefined();
    });

    it('whose provider is GONE falls back to the default instead of bricking', () => {
      // spawning resolves the adapter and throws when it is missing, so a card
      // persisted under a since-removed adapter could never start again
      const h = harness(undefined, folder, {
        prior: priorCard({
          folder,
          identity: { title: 't', folder, providerId: 'codex' },
          nativeSessionId: 'native-7',
        }),
        registered: ['generic'],
      });

      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

      expect(h.created[0].identity.providerId).toBe('generic');
      // the DEFAULT provider's capabilities decide, not the dead one's
      expect(h.askedFor).toEqual(['generic']);
      expect(h.warn).toHaveBeenCalledWith(
        'session start degraded',
        expect.objectContaining({ cardId: 'card-1' })
      );
    });

    it('with an empty provider id falls back too', () => {
      const h = harness(undefined, folder, {
        prior: priorCard({ folder, identity: { title: 't', folder, providerId: '' } }),
      });

      h.call('sessions:create', { cardId: 'card-1', folder, title: 'x' });

      expect(h.created[0].identity.providerId).toBe('generic');
    });
  });
});

// ---------------------------------------------------------------------------
// P2-E18-08b — the per-card transport setting.
//
// The refusal is the interesting half: a RUNNING CLI cannot change how we talk
// to it, so accepting the click would store an answer that disagrees with the
// process actually running, and the user would believe they had switched.
describe('per-card transport (P2-E18-08b)', () => {
  const CARD = 'card-1';
  let dir: string;
  let prior: PersistedSession;
  beforeEach(() => {
    // a real directory: session creation reads it to detect the project type
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tr-'));
    prior = {
      id: CARD,
      identity: { title: 't', folder: dir, providerId: 'generic' },
      layoutSlot: 0,
      suspendedAt: '',
    };
  });

  it('stores the choice on the card', async () => {
    const h = harness(undefined, dir, { prior });

    const res = await h.call('sessions:setTransport', CARD, 'stream');

    expect(res).toEqual({ ok: true, pending: false });
    expect(h.upserted.at(-1)?.transport).toBe('stream');
  });

  it('switches back again', async () => {
    const h = harness(undefined, dir, { prior: { ...prior, transport: 'stream' } });

    await h.call('sessions:setTransport', CARD, 'pty');

    expect(h.upserted.at(-1)?.transport).toBe('pty');
  });

  // The first version REFUSED here, and it was wrong twice over — Dan hit both
  // within minutes: it contradicted `setAutonomy` directly below it in the same
  // menu, which has the IDENTICAL constraint and simply applies on next spawn,
  // and it told the user to "stop this session first" when a live session has
  // no stop control at all. A dead end dressed as a safety check.
  it('ACCEPTS while a session is live, and reports the change as pending', async () => {
    const h = harness(undefined, dir, { prior, liveIds: ['live-1'] });
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });
    h.upserted.length = 0;

    const res = await h.call('sessions:setTransport', CARD, 'stream');

    // stored, so the NEXT start uses it...
    expect(h.upserted.at(-1)?.transport).toBe('stream');
    // ...and flagged, so the UI says so rather than implying it took effect
    expect(res).toEqual({ ok: true, pending: true });
  });

  it('is NOT pending when no session is running', async () => {
    const h = harness(undefined, dir, { prior });
    expect(await h.call('sessions:setTransport', CARD, 'stream')).toEqual({
      ok: true,
      pending: false,
    });
  });

  it('rejects a value that is not a transport', async () => {
    const h = harness(undefined, dir, { prior });
    expect(await h.call('sessions:setTransport', CARD, 'carrier-pigeon')).toEqual({
      ok: false,
      reason: 'bad-value',
    });
  });

  it('rejects an unknown card rather than inventing one', async () => {
    const h = harness(undefined, dir, {});
    expect(await h.call('sessions:setTransport', 'nope', 'stream')).toEqual({
      ok: false,
      reason: 'unknown-card',
    });
  });

  // The card's stored choice must WIN over the env default, or the setting
  // would be decorative on a machine that has the escape hatch set.
  it("a new session asks for the CARD's transport", async () => {
    const h = harness(undefined, dir, { prior: { ...prior, transport: 'stream' } });

    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    expect(h.created[0].transport).toBe('stream');
  });
});
