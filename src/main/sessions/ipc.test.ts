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
import { StreamCommands } from './stream-commands';
import { StreamFeed } from '../feed/stream-feed';
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
    /** the Feed built from typed messages (P2-E18-10) — the real class, again */
    streamFeed?: StreamFeed;
    /** the transport the manager reports for a live session (P2-E18-10) */
    transport?: 'pty' | 'stream';
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

  const deps = {
    manager: {
      onNativeSessionId: () => {},
      onStatusChange: () => {},
      onSessionExit: () => {},
      list: () => [],
      remove: () => {},
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
      unregisterSession: () => {},
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
        return watchAccepts;
      },
      blocks: (id: string) => [{ seq: 1, kind: 'assistant', text: `transcript block for ${id}` }],
      unwatch: () => {},
    },
    feed: { onEvent: () => {}, ingest: () => {}, list: () => [], forget: () => {} },
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
    slashCommands: async () => opts.known ?? [],
    streamCommands: opts.streamCommands,
    streamFeed: opts.streamFeed,
  } as unknown as SessionIpcDeps;

  registerSessionIpc(deps);
  return { call, created, upserted, watched, buildHookSettings, warn, askedFor, pushed, resets };
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-keep-'));
  });

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-slash-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-feed-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-reset-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
