// The zero-capability path, proved through the REAL wiring (P2-E15-01).
//
// `start-plan.test.ts` pins the decisions; this pins that `registerSessionIpc`
// obeys them. Both are needed: a pure function nobody calls correctly is still
// a Claude-shaped session start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { registerSessionIpc, SessionIpcDeps } from './ipc';
import { ProviderCapabilities } from '../extensibility/contributions';
import { PersistedSession } from '../workspace/store';
import { SessionIdentity } from './session-manager';
import { StreamCommands } from './stream-commands';
import { StreamPermissions } from './stream-permissions';
import { StreamFeed } from '../feed/stream-feed';
import { Logger } from '../log/logger';
import { SlashCommand } from '../../shared/slash-commands';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

/** Capture what `registerSessionIpc` registers, so a channel can be called. */
function fakeBroker(): {
  broker: SessionIpcDeps['broker'];
  call: (c: string, ...a: unknown[]) => unknown;
  /** everything PUSHED to the renderer, so a routing decision is assertable */
  pushed: Array<{ channel: string; payload: unknown }>;
} {
  const handlers = new Map<string, Handler>();
  const pushed: Array<{ channel: string; payload: unknown }> = [];
  const put = (channel: string, fn: Handler): void => {
    // `handle` and `on` share one map here; a channel registered on both would
    // otherwise be silently overwritten and the test would assert the wrong one
    if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
    handlers.set(channel, fn);
  };
  const broker = {
    handle: put,
    on: put,
    send: (_win: unknown, channel: string, payload: unknown) => pushed.push({ channel, payload }),
  } as unknown as SessionIpcDeps['broker'];
  return {
    broker,
    pushed,
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
    /** what the `.claude/` scan + curated builtins return (P2-E18-09) */
    known?: SlashCommand[];
    /** the CLI's own list, off the stream (P2-E18-09) — the real class, so the
     *  test exercises the real wiring rather than a stand-in for it */
    streamCommands?: StreamCommands;
    /** the stream transport's approval router (P2-E18-07) — the real class too.
     *  Absent from this harness until #202, which meant `tearDownLive`'s call to
     *  it was a no-op in every test in this file. */
    streamPermissions?: StreamPermissions;
    /** the Feed built from typed messages (P2-E18-10) — the real class, again */
    streamFeed?: StreamFeed;
    /** the transport the manager reports for a live session (P2-E18-10) */
    transport?: 'pty' | 'stream';
    /** exit codes per session id — a session listed here is DEAD but still has
     *  a record, which is exactly what a crash leaves behind (#187) */
    exitCodes?: Record<string, number>;
    /** the ids successive `manager.create` calls mint, in order. Defaults to
     *  'live-1' for ever, which is what every pre-#187 test assumes. */
    spawnIds?: string[];
    /** make this session's teardown BLOW UP, to prove the spawn path fails open
     *  rather than turning a teardown bug into an unstartable card (#187) */
    throwOnUnwatch?: string;
    /** the same, from the FIRST step of the teardown — `deps.feed.forget`. The
     *  one that used to skip every release after it, the approval denial
     *  included (#219). */
    throwOnForgetEvent?: string;
    /** and from the step immediately before the approval denial (#219) */
    throwOnUnregister?: string;
  } = {}
) {
  const created: Array<{
    identity: SessionIdentity;
    settingsFor?: unknown;
    resumeSessionId?: string;
    transport?: string;
  }> = [];
  const upserted: PersistedSession[] = [];
  const watched: Array<{ sessionId: string; projectsRoot?: string; deriveFeed?: boolean }> = [];
  const buildHookSettings = vi.fn(() => ({ hooks: {} }));
  const warn = vi.fn();
  const askedFor: string[] = [];
  /** the watcher's reset listeners, so a test can fire one (P2-E18-10) */
  const resets: Array<(sessionId: string, cause?: string) => void> = [];
  const watchAccepts = opts.watchAccepts ?? true;
  const { broker, call, pushed } = fakeBroker();

  const record = {
    id: 'live-1',
    identity: { title: 't', folder, providerId: 'generic' },
    status: 'starting',
    createdAt: '',
    exitCode: null,
    transport: opts.transport ?? 'pty',
  };

  // The session ids the manager knows about. Seeded from `liveIds`, then MOVED
  // by the real handlers: `create` adds the id it mints and `remove` drops it,
  // so a test can play a whole spawn -> crash -> respawn sequence rather than
  // describing its end state (#187).
  const knownIds = new Set(opts.liveIds ?? []);
  const spawnIds = [...(opts.spawnIds ?? [])];
  const exitCodeOf = (id: string): number | null => opts.exitCodes?.[id] ?? null;
  const asRecord = (id: string): Record<string, unknown> => ({
    ...record,
    id,
    exitCode: exitCodeOf(id),
  });
  /** every live session the IPC layer tore down, in order */
  const removed: string[] = [];
  const unwatched: string[] = [];
  const unregistered: string[] = [];
  const forgottenEvents: string[] = [];
  /** every card id the workspace store was told to drop (`sessions:closeCard`) */
  const removedCards: string[] = [];
  /**
   * ONE ordered log across the calls whose RELATIVE order is the behaviour —
   * `watch` and `unwatch` above all. Separate arrays can each be right while
   * the sequence they describe is wrong: the reap moving below
   * `transcripts.watch` would leave two watchers briefly co-existing and every
   * per-call assertion would still pass (#187 review).
   */
  const trace: string[] = [];

  const deps = {
    manager: {
      onNativeSessionId: () => {},
      onStatusChange: () => {},
      onSessionExit: () => {},
      // Driven by the same set `get` answers from, so a test cannot be told two
      // different things about which sessions exist (#170 needs `list` — it is
      // what the `sessions:cards` join reads). Note what this is NOT: a spawn
      // log. These ids read live from the moment the harness is built, before
      // any `sessions:create`, which is what lets a test assert the SUSPENDED
      // reading first — the join is keyed off `cardOfLive`, not off this.
      list: () => [...knownIds].map(asRecord),
      remove: (id: string) => {
        removed.push(id);
        knownIds.delete(id);
      },
      get: (id: string) => (knownIds.has(id) ? asRecord(id) : undefined),
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
        const id = spawnIds.shift() ?? record.id;
        knownIds.add(id);
        return { ...asRecord(id), identity };
      },
    },
    ptys: {},
    hooks: {
      onPermissionRequest: () => {},
      onPermissionResolved: () => {},
      // the hook half of `sessions:pendingPermissions` — always empty here, so
      // what that channel replays is entirely the stream router's (#202)
      pendingRequests: () => [],
      unregisterSession: (id: string) => {
        if (id === opts.throwOnUnregister) throw new Error('unregister exploded');
        unregistered.push(id);
      },
      buildHookSettings,
    },
    transcripts: {
      onUpdate: () => {},
      onBlock: () => {},
      onReset: (l: (sessionId: string, cause?: string) => void) => {
        resets.push(l);
      },
      watch: (sessionId: string, s: { projectsRoot?: string; deriveFeed?: boolean }) => {
        watched.push({ sessionId, projectsRoot: s.projectsRoot, deriveFeed: s.deriveFeed });
        trace.push(`watch:${sessionId}`);
        return watchAccepts;
      },
      blocks: (id: string) => [{ seq: 1, kind: 'assistant', text: `transcript block for ${id}` }],
      unwatch: (id: string) => {
        if (id === opts.throwOnUnwatch) throw new Error('teardown exploded');
        unwatched.push(id);
        trace.push(`unwatch:${id}`);
      },
    },
    feed: {
      onEvent: () => {},
      ingest: () => {},
      list: () => [],
      forget: (id: string) => {
        if (id === opts.throwOnForgetEvent) throw new Error('forgetting the event exploded');
        forgottenEvents.push(id);
      },
    },
    log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    getWindow: () => null,
    broker,
    autoTrust: () => opts.autoTrust ?? false,
    persist: {
      list: () => (opts.prior ? [opts.prior] : []),
      upsert: (s: PersistedSession) => upserted.push(s),
      // recorded since #219: `sessions:closeCard` runs this AFTER the teardown,
      // so a teardown that threw used to skip it and the "closed" card came
      // back on the next boot
      remove: (cardId: string) => removedCards.push(cardId),
    },
    capabilitiesOf: (id: string) => {
      askedFor.push(id); // which provider was asked about is the wiring itself
      return capabilities;
    },
    isRegisteredProvider: (id: string) => (opts.registered ?? ['generic']).includes(id),
    defaultProviderId: () => 'generic',
    repoRoot: async () => null,
    slashCommands: async () => opts.known ?? [],
    streamCommands: opts.streamCommands,
    streamPermissions: opts.streamPermissions,
    streamFeed: opts.streamFeed,
  } as unknown as SessionIpcDeps;

  registerSessionIpc(deps);
  return {
    call,
    created,
    upserted,
    watched,
    buildHookSettings,
    warn,
    askedFor,
    pushed,
    resets,
    trace,
    removed,
    unwatched,
    unregistered,
    forgottenEvents,
    removedCards,
  };
}

/**
 * The REAL approval router, wired to a fake transport so a test can read what
 * the CLI was told (#202). Both halves of a teardown are visible through it: the
 * parked request must be ANSWERED — dropping it silently leaves the CLI blocked
 * for ever — and the renderer must be told the bar can go.
 */
function streamPerms(): {
  perms: StreamPermissions;
  /** every `control_response` the router pushed back down the stream */
  sent: Array<{ sessionId: string; msg: Record<string, unknown> }>;
} {
  const sent: Array<{ sessionId: string; msg: Record<string, unknown> }> = [];
  const perms = new StreamPermissions(
    (sessionId, msg) => {
      sent.push({ sessionId, msg: msg as Record<string, unknown> });
      return true;
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
  );
  return { perms, sent };
}

/** A `can_use_tool` control request, trimmed to the fields the router reads. */
function canUseTool(requestId: string): Record<string, unknown> {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: 'src/app.ts', content: 'x' },
    },
  };
}

/** What the router sends the CLI when a session is torn down under it. */
function autoDenial(requestId: string): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'deny', message: 'session closed' },
    },
  };
}

/** the request ids the renderer was told to stop showing (#202) */
function resolved(h: { pushed: Array<{ channel: string; payload: unknown }> }): string[] {
  return h.pushed
    .filter((p) => p.channel === 'sessions:permissionResolved')
    .map((p) => (p.payload as { requestId: string }).requestId);
}

/** the approval bars the renderer was told to raise (#202) */
function asked(h: { pushed: Array<{ channel: string; payload: unknown }> }): unknown[] {
  return h.pushed.filter((p) => p.channel === 'sessions:permissionRequest').map((p) => p.payload);
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
    folder = tempDir('sb-ipc-');
  });
  afterEach(() => cleanupTempDirs());

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

    // deriveFeed true: a PTY session's Feed is still built from its transcript
    // (P2-E18-10 changed the source only for stream sessions)
    expect(h.watched).toEqual([
      { sessionId: 'live-1', projectsRoot: '/somewhere/else', deriveFeed: true },
    ]);
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
    dir = tempDir('sb-tr-');
    prior = {
      id: CARD,
      identity: { title: 't', folder: dir, providerId: 'generic' },
      layoutSlot: 0,
      suspendedAt: '',
    };
  });
  afterEach(() => cleanupTempDirs()); // this block had none — 8 dirs a run (#213)

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

  // A CRASHED session keeps its record so the card can show the overlay, and
  // "has a record" used to be the whole liveness test here — so after a crash
  // the menu told the user their change was waiting on a process that had
  // already died, and there was nothing they could do to make it apply (#187).
  it('a CRASHED session is not something to be pending on', async () => {
    const exitCodes: Record<string, number> = {};
    const h = harness(undefined, dir, { prior, exitCodes });
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });
    expect(await h.call('sessions:setTransport', CARD, 'stream')).toEqual({
      ok: true,
      pending: true,
    });

    exitCodes['live-1'] = 1; // ...and the CLI dies

    expect(await h.call('sessions:setTransport', CARD, 'pty')).toEqual({
      ok: true,
      pending: false,
    });
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

// P2 #153 follow-up — starting a session must not FORGET the card.
//
// The create-time upsert rebuilt the record field by field, so every
// PersistedSession field added later had to be remembered there. `transport`
// was not, and it was therefore wiped on EVERY session start — including the
// one at app launch, which is why Direct mode could not survive a relaunch.
//
// These tests are about the CLASS, not the one field: they assert that starting
// a session preserves what the card already knew.
describe('starting a session preserves the card (#153 follow-up)', () => {
  const CARD = 'card-1';
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-keep-');
  });
  afterEach(() => cleanupTempDirs()); // this block had none — 4 dirs a run (#213)

  function priorWith(over: Partial<PersistedSession>): PersistedSession {
    return {
      id: CARD,
      identity: { title: 't', folder: dir, providerId: 'generic' },
      layoutSlot: 3,
      suspendedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    } as PersistedSession;
  }

  it('keeps the transport across a session start — the relaunch case', async () => {
    const h = harness(undefined, dir, { prior: priorWith({ transport: 'stream' }) });

    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    expect(h.upserted.at(-1)?.transport).toBe('stream');
    // and it was actually USED for the spawn, not merely re-saved
    expect(h.created[0].transport).toBe('stream');
  });

  it('keeps usage, model, task label and group membership too', async () => {
    const h = harness(undefined, dir, {
      prior: priorWith({
        usage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        model: 'claude-x',
        taskLabel: 'refactor the thing',
        groupId: 'group-9',
      }),
    });

    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    const saved = h.upserted.at(-1)!;
    expect(saved.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreate: 4 });
    expect(saved.model).toBe('claude-x');
    expect(saved.taskLabel).toBe('refactor the thing');
    expect(saved.groupId).toBe('group-9');
    expect(saved.layoutSlot).toBe(3);
  });

  // The one field a start DOES deliberately replace: a stale conversation id we
  // just declined to resume must not be carried forward.
  it('still replaces the native session id rather than carrying a stale one', async () => {
    const h = harness(undefined, dir, {
      prior: priorWith({ nativeSessionId: 'old-conversation' }),
    });

    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    // no transcripts capability => no resume planned => the id is cleared
    expect(h.upserted.at(-1)?.nativeSessionId).toBeUndefined();
  });

  it('a brand-new card with no prior still saves cleanly', async () => {
    const h = harness(undefined, dir, {});

    await h.call('sessions:create', { cardId: 'fresh', folder: dir, title: 't' });

    const saved = h.upserted.at(-1)!;
    expect(saved.id).toBe('fresh');
    expect(saved.transport).toBeUndefined();
    expect(saved.layoutSlot).toBe(0);
  });
});

// P2-E18-09 — where the composer's command list comes from.
//
// Through the REAL handler and the REAL StreamCommands, because the whole item
// is a wiring decision: which of two lists reaches the popup, and when.
describe('registerSessionIpc — slash commands (P2-E18-09)', () => {
  let dir: string;
  const curated: SlashCommand[] = [
    { name: 'clear', source: 'builtin', description: 'Clear conversation history' },
    { name: 'curated-only', source: 'builtin', description: 'Only in the curated list' },
    { name: 'startup', source: 'project-skill', description: 'Load project context' },
  ];
  const init = (names: string[]): Record<string, unknown> => ({
    type: 'system',
    subtype: 'init',
    slash_commands: names,
  });

  beforeEach(() => {
    dir = tempDir('sb-slash-');
  });
  afterEach(() => cleanupTempDirs());

  it('falls back to the curated list before the CLI has said anything', async () => {
    // The NORMAL state of a fresh stream session, not an edge case: the CLI
    // emits nothing at spawn (S-11), so `init` only lands after a first prompt.
    const h = harness(undefined, dir, {
      liveIds: ['live-1'],
      known: curated,
      streamCommands: new StreamCommands(),
    });

    const list = (await h.call('sessions:slashCommands', 'live-1')) as SlashCommand[];

    expect(list.map((c) => c.name)).toEqual(['clear', 'curated-only', 'startup']);
  });

  it('uses the CLI list once it arrives, keeping our descriptions and badges', async () => {
    const streamCommands = new StreamCommands();
    const h = harness(undefined, dir, { liveIds: ['live-1'], known: curated, streamCommands });

    streamCommands.offer('live-1', init(['clear', 'startup', 'cli-only']));
    const list = (await h.call('sessions:slashCommands', 'live-1')) as SlashCommand[];

    // `curated-only` is GONE — the CLI does not advertise it
    expect(list.map((c) => c.name)).toEqual(['clear', 'cli-only', 'startup']);
    // and what we know about the survivors survives with them
    expect(list.find((c) => c.name === 'startup')).toEqual({
      name: 'startup',
      source: 'project-skill',
      description: 'Load project context',
    });
    // a name we cannot classify still shows up — that is the point of asking
    expect(list.find((c) => c.name === 'cli-only')!.source).toBe('builtin');
  });

  it('a session with no stream list is unaffected by another session that has one', async () => {
    const streamCommands = new StreamCommands();
    const h = harness(undefined, dir, {
      liveIds: ['live-1', 'live-2'],
      known: curated,
      streamCommands,
    });

    streamCommands.offer('live-2', init(['cli-only']));

    const pty = (await h.call('sessions:slashCommands', 'live-1')) as SlashCommand[];
    const stream = (await h.call('sessions:slashCommands', 'live-2')) as SlashCommand[];
    expect(pty.map((c) => c.name)).toContain('curated-only');
    expect(stream.map((c) => c.name)).toEqual(['cli-only']);
  });

  // Same answer for both, and deliberately so: the store keeps "nothing has
  // arrived" and "an empty list arrived" apart because they are different
  // facts, but the done-when is "falls back … rather than showing nothing", and
  // an empty popup is empty whichever fact produced it.
  it('an EMPTY advertised list falls back too, not just a missing one', async () => {
    const streamCommands = new StreamCommands();
    const h = harness(undefined, dir, { liveIds: ['live-1'], known: curated, streamCommands });

    streamCommands.offer('live-1', init([]));
    const list = (await h.call('sessions:slashCommands', 'live-1')) as SlashCommand[];

    expect(list.map((c) => c.name)).toEqual(['clear', 'curated-only', 'startup']);
  });

  // Nothing pinned this wiring: deleting the `forgetSession` call left every
  // suite green. A live id is never reused, so the cost of the leak is small —
  // but "small and untested" is how a leak becomes permanent.
  it('drops a session list when its live session is dropped', async () => {
    const streamCommands = new StreamCommands();
    const h = harness(undefined, dir, { liveIds: ['live-1'], known: curated, streamCommands });
    await h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 't' });
    streamCommands.offer('live-1', init(['cli-only']));
    expect(streamCommands.commandsFor('live-1')).not.toBeNull();

    // the restart path, which is what actually churns live ids
    await h.call('sessions:dropLive', 'card-1');

    expect(streamCommands.commandsFor('live-1')).toBeNull();
  });

  it('an unknown live id returns nothing rather than a stray list', async () => {
    const h = harness(undefined, dir, { liveIds: ['live-1'], known: curated });

    expect(await h.call('sessions:slashCommands', 'nobody')).toEqual([]);
    expect(await h.call('sessions:slashCommands', 42)).toEqual([]);
  });

  it('works with no StreamCommands wired at all — the PTY-only wiring', async () => {
    const h = harness(undefined, dir, { liveIds: ['live-1'], known: curated });

    const list = (await h.call('sessions:slashCommands', 'live-1')) as SlashCommand[];

    expect(list.map((c) => c.name)).toEqual(['clear', 'curated-only', 'startup']);
  });
});

// P2-E18-10 (#140). Two sources feed one Feed: a PTY session's blocks come
// from its JSONL transcript, a stream session's from its typed messages. The
// renderer must not be able to tell them apart — and, more importantly, exactly
// ONE source may be live for a given session or every block renders twice.
describe('the Feed has two sources and one channel (P2-E18-10)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-ipc-feed-');
  });
  afterEach(() => cleanupTempDirs());

  const caps = { transcripts: { projectsRoot: () => '/root' } };

  it('a STREAM session tells the watcher not to derive blocks for it', () => {
    const h = harness(caps, dir, { transport: 'stream', streamFeed: new StreamFeed() });

    h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    // still watched — usage, the native id for --resume, and drift all still
    // want the transcript, and the CLI writes one in stream mode (S-10)
    expect(h.watched).toEqual([{ sessionId: 'live-1', projectsRoot: '/root', deriveFeed: false }]);
  });

  it('the backlog for a stream session comes from the stream, not the transcript', () => {
    const streamFeed = new StreamFeed();
    const h = harness(caps, dir, { transport: 'stream', liveIds: ['live-1'], streamFeed });
    streamFeed.offer('live-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from the stream' }] },
      parent_tool_use_id: null,
    });

    const blocks = h.call('transcripts:blocks', 'live-1') as Array<{ text: string }>;

    expect(blocks.map((b) => b.text)).toEqual(['from the stream']);
  });

  it('a PTY session still reads its backlog from the transcript', () => {
    const h = harness(caps, dir, { transport: 'pty', liveIds: ['live-1'], streamFeed: new StreamFeed() });

    const blocks = h.call('transcripts:blocks', 'live-1') as Array<{ text: string }>;

    expect(blocks.map((b) => b.text)).toEqual(['transcript block for live-1']);
  });

  it('a stream session\'s blocks are forgotten when its live session is dropped', () => {
    const streamFeed = new StreamFeed();
    const h = harness(caps, dir, { transport: 'stream', liveIds: ['live-1'], streamFeed });
    h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });
    streamFeed.offer('live-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old turn' }] },
      parent_tool_use_id: null,
    });
    expect(streamFeed.blocks('live-1')).toHaveLength(1);

    h.call('sessions:dropLive', 'card-1');

    expect(streamFeed.blocks('live-1')).toEqual([]);
  });

  it('the PTY-only wiring works with no StreamFeed at all', () => {
    const h = harness(caps, dir, { liveIds: ['live-1'] });

    expect(() => h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' })).not.toThrow();
    expect(h.call('transcripts:blocks', 'live-1')).toHaveLength(1);
  });
});

// The watcher keeps watching a stream session (usage, the native id, drift), so
// it still corrects mis-binds and still notices a /clear. Its RESET must not be
// routed there: the renderer would drop a Feed the transcript never built, and
// nothing would replay it. Found in review; nothing else pins it.
describe('a transcript reset never blanks a stream session (P2-E18-10)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-ipc-reset-');
  });
  afterEach(() => cleanupTempDirs());

  const caps = { transcripts: { projectsRoot: () => '/root' } };
  const feedResets = (h: { pushed: Array<{ channel: string }> }): number =>
    h.pushed.filter((p) => p.channel === 'sessions:feedReset').length;

  it('a PTY session still gets its reset', () => {
    const h = harness(caps, dir, { transport: 'pty', liveIds: ['live-1'] });

    for (const l of h.resets) l('live-1', 'clear');

    expect(feedResets(h)).toBe(1);
  });

  it('a STREAM session does not', () => {
    const h = harness(caps, dir, { transport: 'stream', liveIds: ['live-1'], streamFeed: new StreamFeed() });

    for (const l of h.resets) l('live-1', 'clear');

    expect(feedResets(h)).toBe(0);
  });

  it('…but its OWN reset still reaches the renderer', () => {
    const streamFeed = new StreamFeed();
    const h = harness(caps, dir, { transport: 'stream', liveIds: ['live-1'], streamFeed });

    // the CLI minting a new conversation: a second init with a different id
    streamFeed.offer('live-1', { type: 'system', subtype: 'init', session_id: 'conv-1' });
    streamFeed.offer('live-1', { type: 'system', subtype: 'init', session_id: 'conv-2' });

    expect(feedResets(h)).toBe(1);
  });
});

// #170 — resuming a suspended session never refreshed its status.
//
// `sessions:cards` is a JOIN: the persisted card, plus the live session under
// it if there is one. The renderer re-reads that join when something PUSHES.
// A live session's own movements do push (`sessions:status`, `sessions:exited`)
// — the card gaining or losing its live session did not, so after Resume the
// rail and the urgency strip went on reading the pre-resume `suspended`.
//
// These pin the binding as an event, at the source. Note what is NOT asserted:
// nothing here reads a rail or a lamp, because the fix is not in either — both
// render from this one list.
describe('a card gaining or losing its live session announces itself (#170)', () => {
  const CARD = 'card-1';
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-resume-');
  });
  afterEach(() => cleanupTempDirs());

  const cardsPushes = (h: { pushed: Array<{ channel: string }> }): number =>
    h.pushed.filter((p) => p.channel === 'sessions:cardsChanged').length;
  const statusOf = async (h: { call: (c: string, ...a: unknown[]) => unknown }): Promise<string> => {
    const cards = (await h.call('sessions:cards')) as Array<{ cardId: string; status: string }>;
    return cards.find((c) => c.cardId === CARD)!.status;
  };

  /** a card persisted but not running — exactly what a suspend leaves behind */
  const suspendedCard = (): PersistedSession => priorCard({ folder: dir, id: CARD });

  it('the suspend -> resume round trip ends with a LIVE status, unprompted', async () => {
    const h = harness(undefined, dir, { prior: suspendedCard(), liveIds: ['live-1'] });

    // restored-but-not-yet-resumed: the join has no live half
    expect(await statusOf(h)).toBe('suspended');

    // resume-on-focus spawns (or --resumes) the session for the card
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    // ...and SAID so, which is the whole bug: no status has changed yet, and on
    // a PTY session the first one may be minutes away (it takes a submitted
    // prompt), so this push is the only thing that can move the rail.
    expect(cardsPushes(h)).toBe(1);
    expect(await statusOf(h)).toBe('starting');
  });

  it('losing the live session announces itself too — suspend, then resume again', async () => {
    const h = harness(undefined, dir, { prior: suspendedCard(), liveIds: ['live-1'] });
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    // the popout window closed: keep the card, drop the session (E8-04)
    await h.call('sessions:dropLive', CARD);
    expect(cardsPushes(h)).toBe(2);
    expect(await statusOf(h)).toBe('suspended');

    // and back again — the round trip is repeatable, not a one-shot
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });
    expect(cardsPushes(h)).toBe(3);
    expect(await statusOf(h)).toBe('starting');
  });

  it('adopting an already-live session says NOTHING — the binding did not move', async () => {
    // revealing a hidden card re-mounts its panel over a session that is still
    // running (P2-E15-08). That is not a change, and a push here would be a
    // refresh for every reveal, for ever.
    const h = harness(undefined, dir, { prior: suspendedCard(), liveIds: ['live-1'] });
    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });
    const before = cardsPushes(h);

    await h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

    expect(h.created).toHaveLength(1); // adopted, not spawned twice
    expect(cardsPushes(h)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// #187 — one `cardOfLive` binding per card, on the crash-respawn path too.
//
// A crashed session keeps its record (the card shows an overlay from it) and
// used to keep its BINDING as well, because the binding is what `dropLive`
// follows to tear its hooks/transcript/feed down — unbinding without that
// teardown would have leaked all of it. So a card that respawned over a corpse
// briefly held two bindings, and the newer one won only because `sessions:cards`
// iterates the Map and the last write survives: true by spec, but unstated and
// unpinned, and the dead session's transcript watch went on polling beside the
// new one's until something dropped the card.
//
// Reaping the corpse — the full teardown, then the unbind — retires the rule
// rather than documenting it. These pin the reap, and the invariant it buys.
describe('a card respawning over a crashed session reaps it (#187)', () => {
  const CARD = 'card-1';
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-reap-');
  });
  afterEach(() => cleanupTempDirs());

  const card = (): PersistedSession => priorCard({ folder: dir, id: CARD });
  const start = (h: { call: (c: string, ...a: unknown[]) => unknown }): unknown =>
    h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

  /**
   * Spawn, crash, reveal. The reveal is the second `sessions:create`: the
   * panel's exited state is component-local, so remounting it re-arms the lazy
   * spawn without going through `restartSelf`'s `dropLive` — which is precisely
   * how a card reaches a second spawn with the first still bound.
   */
  const crashThenReveal = (): ReturnType<typeof harness> => {
    const exitCodes: Record<string, number> = {};
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
    });
    start(h);
    exitCodes['live-1'] = 1; // the CLI dies
    start(h);
    return h;
  };

  it('tears the dead session down in full rather than leaving it bound', () => {
    const h = crashThenReveal();

    expect(h.created).toHaveLength(2); // a corpse is replaced, never adopted
    // every registration taken out in the dead session's name goes with it —
    // the transcript watch above all, which polls on until it is unwatched
    expect(h.removed).toEqual(['live-1']);
    expect(h.unwatched).toEqual(['live-1']);
    expect(h.unregistered).toEqual(['live-1']);
    expect(h.forgottenEvents).toEqual(['live-1']);
  });

  // THE ORDER IS THE FIX. Reaping after the new session is watched would leave
  // two watchers on one card, briefly polling the same root and both writing
  // usage against it — and every per-call assertion above would still pass,
  // because they cannot see a sequence. Moving the reap below
  // `transcripts.watch` is the mutation this is here to catch.
  it('unwatches the dead session BEFORE watching the new one', () => {
    const exitCodes: Record<string, number> = {};
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
    });

    start(h);
    exitCodes['live-1'] = 1;
    start(h);

    expect(h.trace).toEqual(['watch:live-1', 'unwatch:live-1', 'watch:live-2']);
  });

  it('announces both halves of the swap — the loss and the gain', () => {
    const h = crashThenReveal();

    // three, not two: the first spawn's bind, then the reap's unbind, then the
    // new bind. Both of the second pair are true statements, and neither can be
    // read half-applied — the renderer's pull is async and `sessions:create` has
    // no await in it, so the list it eventually reads is the settled one.
    expect(h.pushed.filter((p) => p.channel === 'sessions:cardsChanged')).toHaveLength(3);
  });

  it('leaves the card holding exactly ONE binding — the new session', async () => {
    const h = crashThenReveal();

    const cards = (await h.call('sessions:cards')) as Array<{
      cardId: string;
      liveId?: string;
      status: string;
    }>;
    const row = cards.find((c) => c.cardId === CARD)!;
    expect(row.liveId).toBe('live-2');
    expect(row.status).toBe('starting');

    // and the count is the invariant itself. `dropLive` tears down every
    // session bound to the card, so what it finds IS the binding count — one,
    // because the corpse was already reaped when the new session was bound.
    // Asserted as a delta rather than on the whole list: the corpse gets torn
    // down either way in the end, and only the TIMING says which of the two
    // designs is running.
    const beforeDrop = h.removed.length;
    await h.call('sessions:dropLive', CARD);
    expect(h.removed.slice(beforeDrop)).toEqual(['live-2']);
  });

  it("takes the dead session's Feed blocks and CLI command list with it", () => {
    // the reap is the SAME teardown `dropLive` runs, not a subset of it — so a
    // stream session's blocks and its advertised slash commands go too, and the
    // new session starts from nothing rather than inheriting a dead CLI's answers
    const streamFeed = new StreamFeed();
    const streamCommands = new StreamCommands();
    const exitCodes: Record<string, number> = {};
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      transport: 'stream',
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
      streamFeed,
      streamCommands,
    });
    start(h);
    streamFeed.offer('live-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'before the crash' }] },
      parent_tool_use_id: null,
    });
    streamCommands.offer('live-1', {
      type: 'system',
      subtype: 'init',
      slash_commands: ['cli-only'],
    } as unknown as Record<string, unknown>);
    expect(streamFeed.blocks('live-1')).toHaveLength(1);
    expect(streamCommands.commandsFor('live-1')).not.toBeNull();

    exitCodes['live-1'] = 1;
    start(h);

    expect(streamFeed.blocks('live-1')).toEqual([]);
    expect(streamCommands.commandsFor('live-1')).toBeNull();
  });

  // P6. The teardown chain runs on the SPAWN path now, so a bug anywhere in it
  // would come out of `sessions:create`; the renderer reads a rejection as
  // "spawn failed" and paints the dead-session overlay. Clearing the last
  // session away badly must never become "this card can never start again".
  it('starts the new session even if reaping the old one throws', async () => {
    const exitCodes: Record<string, number> = {};
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
      throwOnUnwatch: 'live-1',
    });
    start(h);
    exitCodes['live-1'] = 1;

    const rec = start(h) as { id: string };

    // a fresh session, NOT the corpse. The reap is where a teardown bug meets
    // the spawn path, and a rejected `sessions:create` is the dead-session
    // overlay — "this card can never start again".
    expect(rec.id).toBe('live-2');
    // WHERE the fail-open lives moved in #219: `tearDownLive` isolates each
    // step and no longer throws, so the reap's own catch does not fire and the
    // warning names the step that failed instead of the reap that contained it.
    // The outer catch stays as the backstop — see the comment at the reap.
    expect(h.warn).toHaveBeenCalledWith(
      'a session teardown step failed; releasing the rest anyway',
      expect.objectContaining({ sessionId: 'live-1', step: 'transcripts.unwatch' })
    );

    // ...and the rail agrees. Before #219 this was the one state in which a card
    // could still hold two bindings (the throw skipped `unbindLive`), and it was
    // the proof that the reverse lookup picks by liveness rather than by Map
    // insertion order. The isolated teardown unbinds regardless, so the state is
    // now unreachable and this is a backstop for the invariant, not a live path.
    const cards = (await h.call('sessions:cards')) as Array<{ cardId: string; liveId?: string }>;
    expect(cards.find((c) => c.cardId === CARD)?.liveId).toBe('live-2');
  });

  it('never reaps a session that is still RUNNING — that one is adopted', () => {
    // the guard on the reap: hiding and revealing a healthy card must not kill
    // the CLI underneath it (P2-E15-08), and the reap runs on the same line the
    // adopt check does
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
    });

    start(h);
    start(h);

    expect(h.created).toHaveLength(1);
    expect(h.removed).toEqual([]);
    expect(h.unwatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #202 — the third stream service `tearDownLive` retires.
//
// `streamFeed` and `streamCommands` were modelled in this harness; the approval
// router was not wired in at all, so `tearDownLive`'s
// `streamPermissions?.forgetSession(...)` ran against `undefined` in every test
// in this file and deleting the line left the whole suite green. Found by the
// #187 worker and its reviewer.
//
// It is the costliest of the three to leak, and the only one that is not merely
// stale state: a `can_use_tool` request is a question the CLI is BLOCKED on, and
// the renderer is showing an approval bar for it. Forgetting a session DENIES
// what is outstanding rather than dropping it — a refused tool call the user can
// ask for again, instead of a wedged session and a bar for a process that no
// longer exists.
//
// So each test asserts the whole of a teardown, not just the forget: the router
// has nothing pending, the CLI got its answer, and the renderer was told to take
// the bar down.
describe('a retired session takes its parked approvals with it (#202)', () => {
  const CARD = 'card-1';
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-perm-ipc-');
  });
  afterEach(() => cleanupTempDirs());

  const card = (): PersistedSession => priorCard({ folder: dir, id: CARD });
  const start = (h: { call: (c: string, ...a: unknown[]) => unknown }, cardId = CARD): unknown =>
    h.call('sessions:create', { cardId, folder: dir, title: 't' });

  it('the restart path — dropLive answers the parked request and clears the bar', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);

    perms.offer('live-1', canUseTool('req-1'));
    // the router really is wired into this registration, tagged with the card
    // the bar belongs to — without this the rest could pass against a router
    // the IPC layer has never heard of
    expect(asked(h)).toEqual([
      expect.objectContaining({ requestId: 'stream:live-1:req-1', cardId: CARD, tool: 'Write' }),
    ]);

    h.call('sessions:dropLive', CARD);

    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // Same helper underneath (`dropLiveForCard`), so this is about the CHANNEL:
  // closing a card is the one teardown the user cannot undo, and a version of
  // `sessions:closeCard` that forgot the record without retiring the session
  // would pass every test above.
  it('the close path — closing the card does the same', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    h.call('sessions:closeCard', CARD);

    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // The reap (#187) runs the SAME teardown, so this follows — but it is the path
  // where the leak actually showed: a card whose CLI died mid-approval kept its
  // bar, and the fresh session underneath had no idea what it was for.
  it('the crash-respawn reap does too — the new session starts with no stale bar', () => {
    const { perms, sent } = streamPerms();
    const exitCodes: Record<string, number> = {};
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
      streamPermissions: perms,
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    expect(perms.pendingRequests()).toHaveLength(1);

    exitCodes['live-1'] = 1; // the CLI dies mid-approval
    start(h); // revealing the card re-arms the lazy spawn

    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // The forget is per SESSION, and one router serves every card on the machine.
  it("leaves every other session's question alone", () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      streamPermissions: perms,
    });
    start(h);
    start(h, 'card-2');
    perms.offer('live-1', canUseTool('req-1'));
    perms.offer('live-2', canUseTool('req-2'));

    h.call('sessions:dropLive', CARD);

    expect(perms.pendingRequests().map((r) => r.requestId)).toEqual(['stream:live-2:req-2']);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // A push can be missed (the window was reloading, the panel had not mounted),
  // so the renderer re-reads the outstanding list when it comes back. That
  // replay is the second way a leaked request reaches the UI, and it would hand
  // a fresh renderer a bar for a session that ended some time ago.
  it('and the replay a remounting renderer reads no longer offers it', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    expect(h.call('sessions:pendingPermissions')).toEqual([
      expect.objectContaining({ requestId: 'stream:live-1:req-1', cardId: CARD }),
    ]);

    h.call('sessions:dropLive', CARD);

    expect(h.call('sessions:pendingPermissions')).toEqual([]);
  });

  it('the PTY-only wiring works with no StreamPermissions at all', () => {
    const h = harness(undefined, dir, { prior: card() });
    start(h);

    expect(() => h.call('sessions:dropLive', CARD)).not.toThrow();
    expect(h.call('sessions:pendingPermissions')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #219 — a teardown step that throws must not take the rest of the teardown
// with it.
//
// `tearDownLive` was a straight line of independent releases, so the first one
// to throw skipped every one after it. The reap's fail-open catch (#187) then
// swallowed the throw and the respawn carried on, which is right — but the
// releases that never ran were gone silently. The costliest sits in the middle
// of the list: `streamPermissions.forgetSession` DENIES the `can_use_tool` the
// CLI is blocked on and pushes `sessions:permissionResolved` so the bar comes
// down. Skipping it leaves a card showing an approval bar for a session that no
// longer exists, over a CLI parked on a question nothing will answer — the
// exact leak #202 proved the teardown fixes, reintroduced by an unrelated
// failure two lines earlier.
//
// The fix is per-step try/catch, not reordering: reordering makes no step safe,
// it only re-picks which ones get skipped. These tests are the difference — each
// blows a step up and asserts that everything AFTER it still happened.
describe('a teardown step that throws releases the rest anyway (#219)', () => {
  const CARD = 'card-1';
  let dir: string;
  beforeEach(() => {
    dir = tempDir('sb-teardown-');
  });
  afterEach(() => cleanupTempDirs());

  const card = (): PersistedSession => priorCard({ folder: dir, id: CARD });
  const start = (h: { call: (c: string, ...a: unknown[]) => unknown }): unknown =>
    h.call('sessions:create', { cardId: CARD, folder: dir, title: 't' });

  // The FIRST step of the teardown, on the path that has a fail-open catch over
  // it. Before #219 this one throw skipped all eight releases behind it.
  it('a throw in the first step still denies the parked approval on the reap path', () => {
    const { perms, sent } = streamPerms();
    const exitCodes: Record<string, number> = {};
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes,
      streamPermissions: perms,
      throwOnForgetEvent: 'live-1',
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    expect(asked(h)).toHaveLength(1); // the bar really went up

    exitCodes['live-1'] = 1; // the CLI dies mid-approval
    const rec = start(h) as { id: string }; // revealing the card re-arms the spawn

    // the two halves of the claim: the CLI got its answer, and the bar came down
    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    // and every later step ran too — the record dropped, the binding released
    expect(h.removed).toEqual(['live-1']);
    expect(h.unwatched).toEqual(['live-1']);
    expect(h.unregistered).toEqual(['live-1']);
    // …with the spawn path still failing open (#187): the card starts
    expect(rec.id).toBe('live-2');
  });

  // The step immediately BEFORE the denial, on a path that never had a catch at
  // all — `sessions:dropLive` is the renderer's Restart, and a throw out of it
  // reads as "restart failed" for a session that was in fact torn down.
  it('a throw one step before the denial does not reach the renderer or the router', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, {
      prior: card(),
      streamPermissions: perms,
      throwOnUnregister: 'live-1',
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    expect(() => h.call('sessions:dropLive', CARD)).not.toThrow();

    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    // the replay a remounting renderer reads is clean too — the second route a
    // leaked request has to the UI (#202)
    expect(h.call('sessions:pendingPermissions')).toEqual([]);
  });

  // `sessions:closeCard` does something AFTER the teardown: it forgets the
  // persisted card. A throw out of `tearDownLive` skipped that, so the card the
  // user closed came back on the next boot — a second casualty of the same hole,
  // and the reason the fail-open belongs in the shared function rather than in
  // the one caller that happened to have a catch.
  it('closing a card still forgets it when a teardown step throws', () => {
    const { perms, sent } = streamPerms();
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      streamPermissions: perms,
      throwOnUnwatch: 'live-1',
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    h.call('sessions:closeCard', CARD);

    expect(h.removedCards).toEqual([CARD]); // it does not come back on next boot
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // No step depends on any other, so failing several is not a harder case than
  // failing one — it is the proof that the isolation is per STEP and not a
  // single catch that resumes at a fixed point.
  it('three failing steps still leave a fully retired session', () => {
    const { perms, sent } = streamPerms();
    const streamFeed = new StreamFeed();
    const streamCommands = new StreamCommands();
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      transport: 'stream',
      streamPermissions: perms,
      streamFeed,
      streamCommands,
      throwOnForgetEvent: 'live-1',
      throwOnUnregister: 'live-1',
      throwOnUnwatch: 'live-1',
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    streamFeed.offer('live-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mid-approval' }] },
      parent_tool_use_id: null,
    });
    streamCommands.offer('live-1', {
      type: 'system',
      subtype: 'init',
      slash_commands: ['cli-only'],
    } as unknown as Record<string, unknown>);

    h.call('sessions:dropLive', CARD);

    // every release downstream of the three failures
    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    expect(streamFeed.blocks('live-1')).toEqual([]);
    expect(streamCommands.commandsFor('live-1')).toBeNull();
    expect(h.removed).toEqual(['live-1']);
    // the binding too, which is what makes a half-reaped corpse unreachable
    // rather than merely tolerated by the adopt pass (#187)
    expect(h.pushed.filter((p) => p.channel === 'sessions:cardsChanged')).toHaveLength(2);
  });

  // A swallowed failure that says nothing is a worse bug than the one it hides,
  // so the step NAME is part of the contract: it is what tells you which release
  // was lost. The old reap-level catch could only say "the teardown threw".
  it('names the step that failed, once per failure', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      throwOnForgetEvent: 'live-1',
      throwOnUnwatch: 'live-1',
    });
    start(h);

    h.call('sessions:dropLive', CARD);

    const steps = h.warn.mock.calls
      .filter((c) => c[0] === 'a session teardown step failed; releasing the rest anyway')
      .map((c) => (c[1] as { sessionId: string; step: string }).step);
    expect(steps).toEqual(['feed.forget', 'transcripts.unwatch']);
    // the rest of the payload is the diagnostic too: whose session, and what
    // actually went wrong
    expect(h.warn).toHaveBeenCalledWith(
      'a session teardown step failed; releasing the rest anyway',
      expect.objectContaining({
        sessionId: 'live-1',
        step: 'feed.forget',
        error: expect.stringContaining('forgetting the event exploded'),
      })
    );
  });

  // ...and the isolation must be silent when nothing is wrong: a try/catch round
  // every step is exactly the shape that starts logging on the happy path.
  it('says nothing at all on a clean teardown', () => {
    const { perms } = streamPerms();
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      streamPermissions: perms,
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    h.call('sessions:dropLive', CARD);

    expect(h.warn).not.toHaveBeenCalled();
  });
});
