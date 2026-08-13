// The zero-capability path, proved through the REAL wiring (P2-E15-01).
//
// `start-plan.test.ts` pins the decisions; this pins that `registerSessionIpc`
// obeys them. Both are needed: a pure function nobody calls correctly is still
// a Claude-shaped session start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
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
import { readAiTitle } from '../providers/claude';
import { REPEAT_HEAVY, REVISED, titlesOf } from '../transcripts/fixtures/ai-title';
import { slugForCwd } from '../transcripts/paths';

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
    /** auto task labels (P2-E7-06) — defaults ON, which is the shipped default */
    autoLabels?: boolean;
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
    /** the app-wide env override of which transport to ask for (#381) */
    preferredTransport?: () => 'pty' | 'stream' | undefined;
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
    /** hook-transport permission requests the listener is holding, by session
     *  (#271). The fake models the ONE behaviour under test — `pendingRequests`
     *  is what `sessions:pendingPermissions` replays, and `unregisterSession`
     *  is what empties it — so the hook half of that channel is assertable
     *  instead of being a constant `[]`. */
    hookPending?: Array<{ requestId: string; sessionId: string }>;
    /** which transcript each live id is bound to, for `transcripts:search`
     *  (P2-E17-01). Absent means the watcher has nothing bound for it. */
    transcriptFiles?: Record<string, string | null>;
    /** make `SessionManager.create` BLOW UP, the way it really does for a
     *  provider adapter it does not have, a transport it cannot resolve, or a
     *  `spawn` that fails. `sessions:create` must answer `null` rather than
     *  rejecting the renderer's promise (#347). */
    throwOnSpawn?: boolean;
  } = {}
) {
  const created: Array<{
    identity: SessionIdentity;
    settingsFor?: unknown;
    resumeSessionId?: string;
    transport?: string;
  }> = [];
  const upserted: PersistedSession[] = [];
  /** every transcript-snapshot listener the module registered (P2-E7-06) */
  const snapshots: Array<(snap: Record<string, unknown>) => void> = [];
  /** the persisted store as it stands NOW, as opposed to every write ever made */
  const cards: PersistedSession[] = opts.prior ? [{ ...opts.prior }] : [];
  let autoLabels = opts.autoLabels ?? true;
  const watched: Array<{
    sessionId: string;
    projectsRoot?: string;
    deriveFeed?: boolean;
    readTitle?: (line: Record<string, unknown>) => string | undefined;
  }> = [];
  const buildHookSettings = vi.fn(() => ({ hooks: {} }));
  const warn = vi.fn();
  /** a start that should have worked and did not is an `error`, not a `warn` (#347) */
  const logError = vi.fn();
  /** every live rename the IPC layer asked the manager for (#347) */
  const renamed: Array<{ id: string; title: string }> = [];
  const askedFor: string[] = [];
  /** live ids the HOOK listener was told to allow-all (#319) */
  const allowedAll: string[] = [];
  /** the watcher's reset listeners, so a test can fire one (P2-E18-10) */
  const resets: Array<(sessionId: string, cause?: string) => void> = [];
  /** the IPC layer's `manager.onNativeSessionId` subscriber, so a test can
   *  teach a live session its conversation id the way the manager does (#404) */
  const nativeIdListeners: Array<(liveId: string, nativeId: string, cause?: 'clear') => void> = [];
  /** every native id the transcript watcher was told, with its cause */
  const nativeIdsSet: Array<{ sessionId: string; nativeId: string; cause?: string }> = [];
  const watchAccepts = opts.watchAccepts ?? true;
  const { broker, call, pushed } = fakeBroker();

  const record = {
    id: 'live-1',
    identity: { title: 't', folder, providerId: 'generic' },
    status: 'starting',
    createdAt: '',
    exitCode: null,
    // What the fake manager REPORTS a live session is on, which is independent
    // of what the seam ASKED for — since #381 the ask defaults to `stream`
    // while this still answers `pty`, a pairing a stream-capable adapter could
    // not produce in production. That is fine for the channels under test here
    // (they read the record, not the request), but do not read a transport
    // claim about the real app out of a test that leaves this at its default.
    transport: opts.transport ?? 'pty',
  };

  // The session ids the manager knows about. Seeded from `liveIds`, then MOVED
  // by the real handlers: `create` adds the id it mints and `remove` drops it,
  // so a test can play a whole spawn -> crash -> respawn sequence rather than
  // describing its end state (#187).
  const knownIds = new Set(opts.liveIds ?? []);
  /** the IPC layer's `manager.onSessionExit` subscriber, so a test can kill a
   *  session the way the transport does — the self-exit path (#271) */
  const exitListeners: Array<(e: { sessionId: string; code: number; crashed: boolean }) => void> =
    [];
  /** ids whose process has already died — a corpse's transport does not fire
   *  `onExit` a second time when the manager later removes it */
  const alreadyExited = new Set<string>();
  const fireExit = (sessionId: string, code = 0): void => {
    alreadyExited.add(sessionId);
    for (const l of exitListeners) l({ sessionId, code, crashed: code !== 0 });
  };
  /** the hook listener's held requests, keyed the way the real one holds them */
  const hookPending = [...(opts.hookPending ?? [])];
  /** every verdict the HOOK router was handed, whatever surface sent it (E14-04) */
  const hookDecisions: Array<{ requestId: string; decision: string; reason?: string }> = [];
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
  /** every live session whose transcript watch was told its process died (#200) */
  const exitedNoted: string[] = [];
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
      onNativeSessionId: (l: (liveId: string, nativeId: string, cause?: 'clear') => void) => {
        nativeIdListeners.push(l);
      },
      onStatusChange: () => {},
      onSessionExit: (l: (e: { sessionId: string; code: number; crashed: boolean }) => void) => {
        exitListeners.push(l);
      },
      // Driven by the same set `get` answers from, so a test cannot be told two
      // different things about which sessions exist (#170 needs `list` — it is
      // what the `sessions:cards` join reads). Note what this is NOT: a spawn
      // log. These ids read live from the moment the harness is built, before
      // any `sessions:create`, which is what lets a test assert the SUSPENDED
      // reading first — the join is keyed off `cardOfLive`, not off this.
      list: () => [...knownIds].map(asRecord),
      remove: (id: string) => {
        removed.push(id);
        // Modelled after the real `SessionManager.remove` (#271): it drops the
        // record and then tears the transport down, and the exit listeners fire
        // either way because they live in the onExit closure and never consult
        // the map. Without this the fake silently made every teardown a
        // single-release path, which is the one shape a "no double-release"
        // claim must not be tested against.
        //
        // Only for a session that is still RUNNING, which is the same condition
        // reality applies: a crashed session's onExit fired when it crashed, and
        // killing an already-dead process fires nothing. Reaping a corpse
        // (#187) must not synthesise a second exit it would never get.
        //
        // DELIBERATELY NOT FAITHFUL ON TIMING, and the harsher of the two. Both
        // transports' `remove()` end at `kill()` — a signal — so in production
        // the exit lands on a LATER turn of the loop, after `tearDownLive` has
        // returned and `unbindLive` has run. Here it lands in the middle of the
        // teardown, which is a stricter test of idempotency and a WRONG model of
        // push ordering: do not read `sessions:exited`-vs-`cardsChanged` order
        // out of this fake.
        const wasLive = knownIds.delete(id);
        if (wasLive && !alreadyExited.has(id) && exitCodeOf(id) === null) fireExit(id, 0);
      },
      get: (id: string) => (knownIds.has(id) ? asRecord(id) : undefined),
      // Modelled on the real `SessionManager.rename` (#347): it drops a rename
      // for an id it does not know and a blank title, and it never throws for
      // either. What the IPC layer then answers comes from `get`, so a dumb
      // recorder here is enough to read the channel's contract off.
      rename: (id: string, title: string) => renamed.push({ id, title }),
      create: (
        identity: SessionIdentity,
        o: { settingsFor?: unknown; resumeSessionId?: string; transport?: string }
      ) => {
        if (opts.throwOnSpawn) throw new Error('spawn exploded');
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
      // the hook half of `sessions:pendingPermissions`. Empty unless a test
      // seeds `hookPending` (#271); until then what that channel replays is
      // entirely the stream router's (#202).
      pendingRequests: () => [...hookPending],
      unregisterSession: (id: string) => {
        if (id === opts.throwOnUnregister) throw new Error('unregister exploded');
        unregistered.push(id);
        // A RESTATEMENT of what `HookListener.unregisterSession` does to its
        // held requests ("a session closed mid-hold must not leave the CLI
        // hanging (fail-open)") — so a test can read the hook half of
        // `sessions:pendingPermissions` rather than a constant. It is not
        // evidence about that implementation: if the real sweep stopped
        // releasing holds, only `hook-listener.test.ts` would catch it. What
        // these tests pin is that the exit path CALLS it.
        for (let i = hookPending.length - 1; i >= 0; i--) {
          if (hookPending[i].sessionId === id) hookPending.splice(i, 1);
        }
      },
      // The hook half of the app's ONE decision path (P2-E14-04). Recorded and
      // real (it drops the request) rather than a no-op, because the claim
      // under test is that `SessionIpcHandle.decidePermission` — what an OS
      // toast's Allow/Deny button calls, with no window in the loop — lands in
      // the same routers `sessions:decidePermission` does, and answers FALSE
      // for a request nobody holds.
      decide: (requestId: string, decision: string, reason?: string) => {
        const i = hookPending.findIndex((r) => r.requestId === requestId);
        if (i < 0) return false;
        hookPending.splice(i, 1);
        hookDecisions.push({ requestId, decision, reason });
        return true;
      },
      // the hook half of "Allow all (this session)" (#319). Recorded rather
      // than no-op'd because the claim under test is that ONE click reaches
      // BOTH channels — a fake that swallowed it could only prove the stream
      // half, which is the half that was already there.
      setAllowAll: (id: string) => allowedAll.push(id),
      buildHookSettings,
    },
    transcripts: {
      onUpdate: (l: (snap: Record<string, unknown>) => void) => {
        snapshots.push(l);
      },
      onBlock: () => {},
      setNativeSessionId: (sessionId: string, nativeId: string, cause?: string) => {
        nativeIdsSet.push({ sessionId, nativeId, cause });
      },
      onReset: (l: (sessionId: string, cause?: string) => void) => {
        resets.push(l);
      },
      watch: (
        sessionId: string,
        s: {
          projectsRoot?: string;
          deriveFeed?: boolean;
          readTitle?: (line: Record<string, unknown>) => string | undefined;
        }
      ) => {
        watched.push({
          sessionId,
          projectsRoot: s.projectsRoot,
          deriveFeed: s.deriveFeed,
          readTitle: s.readTitle,
        });
        trace.push(`watch:${sessionId}`);
        return watchAccepts;
      },
      blocks: (id: string) => [{ seq: 1, kind: 'assistant', text: `transcript block for ${id}` }],
      // Which file a session is bound to — how `transcripts:search` turns a
      // session id into something to scan (P2-E17-01). `null` is the ordinary
      // answer for a session nobody has prompted yet.
      transcriptFile: (id: string) => opts.transcriptFiles?.[id] ?? null,
      unwatch: (id: string) => {
        if (id === opts.throwOnUnwatch) throw new Error('teardown exploded');
        unwatched.push(id);
        trace.push(`unwatch:${id}`);
      },
      // #200: the watch is TOLD the process died; it is not torn down. In the
      // trace beside `watch`/`unwatch` because the claim under test is a
      // sequence — the exit notice must not be mistaken for, or reordered
      // with, the reap's teardown of the same session.
      noteSessionExited: (id: string) => {
        exitedNoted.push(id);
        trace.push(`noteExited:${id}`);
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
    log: { info: vi.fn(), warn, error: logError, debug: vi.fn() },
    getWindow: () => null,
    broker,
    autoTrust: () => opts.autoTrust ?? false,
    // Auto task labels (P2-E7-06). ON by default here, because off is the
    // degraded path and a harness that defaults to it would let every label
    // assertion pass for the wrong reason. `setAutoLabels` writes through, so
    // the switch test drives the real handler rather than a stub of it.
    autoLabels: () => autoLabels,
    setAutoLabels: (on: boolean) => {
      autoLabels = on;
    },
    persist: {
      // A store that REMEMBERS. The label loop reads the card back after every
      // write — "has this title already been stored?" is the de-dupe — so a
      // list frozen at `opts.prior` would answer "no" for ever and make a
      // repeat-heavy transcript look free when it was not.
      list: () => cards,
      upsert: (s: PersistedSession) => {
        upserted.push(s);
        const i = cards.findIndex((c) => c.id === s.id);
        if (i < 0) cards.push(s);
        else cards[i] = s;
      },
      // recorded since #219: `sessions:closeCard` runs this AFTER the teardown,
      // so a teardown that threw used to skip it and the "closed" card came
      // back on the next boot
      remove: (cardId: string) => {
        removedCards.push(cardId);
        const i = cards.findIndex((c) => c.id === cardId);
        if (i >= 0) cards.splice(i, 1);
      },
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
    preferredTransport: opts.preferredTransport,
  } as unknown as SessionIpcDeps;

  const ipc = registerSessionIpc(deps);
  return {
    /** what the bootstrap gets back — the toast's route to a card's label */
    labelFor: ipc.labelFor,
    /** …and the two halves an ACTIONABLE toast needs (P2-E14-04) */
    pendingPermissionFor: ipc.pendingPermissionFor,
    decidePermission: ipc.decidePermission,
    hookDecisions,
    call,
    created,
    upserted,
    nativeIdsSet,
    fireNativeId: (liveId: string, nativeId: string, cause?: 'clear') => {
      for (const l of nativeIdListeners) l(liveId, nativeId, cause);
    },
    watched,
    cards,
    /**
     * Play the transcript watcher: push a snapshot for a live session.
     *
     * `lines` defaults to 1 because a snapshot that has ingested nothing is
     * ignored by design (it says nothing about usage) — passing 0 tests that
     * rule, not the label.
     */
    fireSnapshot: (snap: {
      sessionId: string;
      title?: string;
      lines?: number;
      usage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
      model?: string;
    }) => {
      const full = {
        lines: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        ...snap,
      };
      for (const l of snapshots) l(full);
    },
    buildHookSettings,
    warn,
    logError,
    renamed,
    askedFor,
    allowedAll,
    pushed,
    resets,
    trace,
    removed,
    unwatched,
    exitedNoted,
    unregistered,
    forgottenEvents,
    removedCards,
    /** kill a live session the way its transport does — no teardown, no card
     *  close, nothing but the process going away (#271) */
    fireExit,
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
    // #310's third collaborator. These tests are about the RELEASE half, which
    // deliberately applies nothing (see `forgetSession`), so a no-op here is
    // the honest stand-in — `stream-permissions.test.ts` owns the assertions.
    () => {},
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

/**
 * What the router sends the CLI when a session is torn down under it.
 *
 * The message is parameterized since #271: a session the USER closed and a
 * session that died on its own say different and true things, and that string
 * is what the CLI prints.
 */
function autoDenial(requestId: string, why = 'session closed'): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'deny', message: why },
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

/**
 * A fresh REAL directory per test — session creation reads it to detect the
 * project type — plus the cleanup that goes with it. Every describe in this file
 * carried its own copy of both, and two shipped without the `afterEach` and
 * leaked a directory per test (#213); one definition makes that impossible.
 *
 * The block keeps its own `dir` variable, because the directory does not exist
 * until `beforeEach` has run: this hands it back through `set` rather than
 * returning it.
 */
function tempDirEach(prefix: string, set: (dir: string) => void): void {
  beforeEach(() => set(tempDir(prefix)));
  afterEach(() => cleanupTempDirs());
}

/**
 * The two helpers a card-centric block works through: the persisted card, and
 * the `sessions:create` the renderer sends when that card's panel mounts.
 *
 * Copied verbatim into the #187, #202 and #219 blocks — and under another name
 * into #170's — because each closed over its OWN block's `dir` (#236). That
 * directory is the only thing that varied, so it is what is parameterized: a
 * GETTER, read when the helper is CALLED rather than when it is built, which is
 * what lets one definition outlive the `beforeEach` that forced the copies.
 */
function cardHelpers(
  dir: () => string,
  cardId = 'card-1'
): {
  card: () => PersistedSession;
  start: (h: { call: (c: string, ...a: unknown[]) => unknown }, id?: string) => unknown;
} {
  return {
    card: () => priorCard({ folder: dir(), id: cardId }),
    start: (h, id = cardId) => h.call('sessions:create', { cardId: id, folder: dir(), title: 't' }),
  };
}

describe('registerSessionIpc — provider capabilities (P2-E15-01)', () => {
  let folder: string;
  tempDirEach('sb-ipc-', (d) => (folder = d));

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
  tempDirEach('sb-tr-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  it('stores the choice on the card', async () => {
    const h = harness(undefined, dir, { prior: card() });

    const res = await h.call('sessions:setTransport', CARD, 'stream');

    expect(res).toEqual({ ok: true, pending: false });
    expect(h.upserted.at(-1)?.transport).toBe('stream');
  });

  it('switches back again', async () => {
    const h = harness(undefined, dir, { prior: { ...card(), transport: 'stream' } });

    await h.call('sessions:setTransport', CARD, 'pty');

    expect(h.upserted.at(-1)?.transport).toBe('pty');
  });

  // The first version REFUSED here, and it was wrong twice over — Dan hit both
  // within minutes: it contradicted `setAutonomy` directly below it in the same
  // menu, which has the IDENTICAL constraint and simply applies on next spawn,
  // and it told the user to "stop this session first" when a live session has
  // no stop control at all. A dead end dressed as a safety check.
  it('ACCEPTS while a session is live, and reports the change as pending', async () => {
    const h = harness(undefined, dir, { prior: card(), liveIds: ['live-1'] });
    await start(h);
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
    const h = harness(undefined, dir, { prior: card(), exitCodes });
    await start(h);
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
    const h = harness(undefined, dir, { prior: card() });
    expect(await h.call('sessions:setTransport', CARD, 'stream')).toEqual({
      ok: true,
      pending: false,
    });
  });

  it('rejects a value that is not a transport', async () => {
    const h = harness(undefined, dir, { prior: card() });
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

  // The card's stored choice must reach the spawn, or the setting is
  // decorative.
  //
  // Asserted with `pty` since #381: with Direct as the default, a card storing
  // `stream` proved nothing here — deleting `prior?.transport ??` from the seam
  // left this green. `pty` is the value the default can never supply.
  it("a new session asks for the CARD's transport", async () => {
    const h = harness(undefined, dir, { prior: { ...card(), transport: 'pty' } });

    await start(h);

    expect(h.created[0].transport).toBe('pty');
  });
});

// #381 — Direct is what a session starts on unless something says otherwise.
//
// Dan, 2026-08-09: "all sessions default to direct mode. not terminal". The
// three populations these tests separate are the whole of the change:
//
//  1. a card that has never chosen (including every card that predates the
//     setting) follows the default, and the default is now Direct;
//  2. a card that explicitly chose keeps its choice — Terminal included, which
//     is the promise that makes flipping the default safe;
//  3. the env override sits between the two, so a whole app instance can be
//     aimed at one transport without touching anybody's card.
describe('Direct is the default transport (#381)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-tr-default-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  it('a card that never chose starts in Direct', async () => {
    const h = harness(undefined, dir, { prior: card() });

    await start(h);

    expect(h.created[0].transport).toBe('stream');
  });

  it('a brand-new card with no record at all starts in Direct', async () => {
    const h = harness(undefined, dir, {});

    await start(h, 'fresh');

    expect(h.created[0].transport).toBe('stream');
  });

  // The promise in the issue, and the reason this is a default and not a
  // migration: a session that was deliberately put on the terminal stays there.
  it('a card that explicitly chose Terminal keeps Terminal', async () => {
    const h = harness(undefined, dir, { prior: { ...card(), transport: 'pty' } });

    await start(h);

    expect(h.created[0].transport).toBe('pty');
  });

  // ...and the default is not written back onto the card, so a card that never
  // chose keeps following the default rather than freezing today's answer. This
  // is what makes population 1 move on one line — and what would make it move
  // back if the default ever changed again.
  it('does not record the default as if the user had chosen it', async () => {
    const h = harness(undefined, dir, { prior: card() });

    await start(h);

    expect(h.upserted.at(-1)?.transport).toBeUndefined();
  });

  it('the env override decides for a card that never chose', async () => {
    const h = harness(undefined, dir, { prior: card(), preferredTransport: () => 'pty' });

    await start(h);

    expect(h.created[0].transport).toBe('pty');
  });

  it("a card's own choice still beats the env override", async () => {
    const h = harness(undefined, dir, {
      prior: { ...card(), transport: 'stream' },
      preferredTransport: () => 'pty',
    });

    await start(h);

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
  tempDirEach('sb-keep-', (d) => (dir = d));
  const { start } = cardHelpers(() => dir, CARD);

  function priorWith(over: Partial<PersistedSession>): PersistedSession {
    return {
      id: CARD,
      identity: { title: 't', folder: dir, providerId: 'generic' },
      layoutSlot: 3,
      suspendedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    } as PersistedSession;
  }

  // `pty` and not `stream` since #381, and deliberately: Direct is the default
  // now, so a card storing `stream` would spawn on `stream` even if the field
  // were dropped on the way — the second assertion, the one about the spawn,
  // would have passed on the very bug this test exists for.
  it('keeps the transport across a session start — the relaunch case', async () => {
    const h = harness(undefined, dir, { prior: priorWith({ transport: 'pty' }) });

    await start(h);

    expect(h.upserted.at(-1)?.transport).toBe('pty');
    // and it was actually USED for the spawn, not merely re-saved
    expect(h.created[0].transport).toBe('pty');
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

    await start(h);

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

    await start(h);

    // no transcripts capability => no resume planned => the id is cleared
    expect(h.upserted.at(-1)?.nativeSessionId).toBeUndefined();
  });

  it('a brand-new card with no prior still saves cleanly', async () => {
    const h = harness(undefined, dir, {});

    await start(h, 'fresh');

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
  tempDirEach('sb-slash-', (d) => (dir = d));
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
  tempDirEach('sb-ipc-feed-', (d) => (dir = d));

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

// #395 — a RESUMED Direct session gets its history back.
//
// The two facts above collide here: a stream session is told `deriveFeed:
// false`, and `--resume` re-sends nothing over the stream. So a resumed Direct
// card had NO source of history at all and opened blank — which is what every
// pre-existing card did on the first launch after #381. `sessions:create` now
// replays the conversation's own transcript into the stream Feed, once, before
// the first message can arrive.
describe('a resumed Direct session replays its history (#395)', () => {
  let dir: string;
  tempDirEach('sb-ipc-replay-', (d) => (dir = d));
  let root: string;
  tempDirEach('sb-ipc-replay-root-', (d) => (root = d));

  const NATIVE = '00000000-conv-4000-8000-000000000000';
  const capsWith = (rootDir: () => string): ProviderCapabilities =>
    ({
      transcripts: { projectsRoot: () => rootDir() },
      resume: { canResume: () => true },
    }) as unknown as ProviderCapabilities;

  /** the conversation, where the CLI would have written it */
  function seedTranscript(id = NATIVE): void {
    const d = path.join(root, slugForCwd(dir));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, `${id}.jsonl`),
      [
        { type: 'user', sessionId: id, cwd: dir, message: { role: 'user', content: [{ type: 'text', text: 'before the relaunch' }] } },
        { type: 'assistant', sessionId: id, cwd: dir, message: { role: 'assistant', content: [{ type: 'text', text: 'the reply you already read' }] } },
      ]
        .map((l) => JSON.stringify(l) + '\n')
        .join('')
    );
  }

  it('the prior conversation is in the Feed before the CLI says anything', () => {
    seedTranscript();
    const streamFeed = new StreamFeed();
    const h = harness(capsWith(() => root), dir, {
      transport: 'stream',
      liveIds: ['live-1'],
      streamFeed,
      prior: priorCard({ folder: dir, nativeSessionId: NATIVE }),
    });

    h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    expect(streamFeed.blocks('live-1').map((b) => b.text)).toEqual([
      'before the relaunch',
      'the reply you already read',
    ]);
    // and it is what the mounting panel pulls, on the one channel there is
    expect((h.call('transcripts:blocks', 'live-1') as Array<{ text: string }>).map((b) => b.text)).toEqual([
      'before the relaunch',
      'the reply you already read',
    ]);
  });

  it('a TERMINAL session is left alone — the watcher replays it, as it always did', () => {
    seedTranscript();
    const streamFeed = new StreamFeed();
    harness(capsWith(() => root), dir, {
      transport: 'pty',
      liveIds: ['live-1'],
      streamFeed,
      prior: priorCard({ folder: dir, nativeSessionId: NATIVE }),
    }).call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    expect(streamFeed.blocks('live-1')).toEqual([]);
  });

  it('a session that is NOT resuming starts empty, whatever is on disk', () => {
    seedTranscript();
    const streamFeed = new StreamFeed();
    const h = harness(
      { transcripts: { projectsRoot: () => root }, resume: { canResume: () => false } } as unknown as ProviderCapabilities,
      dir,
      { transport: 'stream', liveIds: ['live-1'], streamFeed, prior: priorCard({ folder: dir, nativeSessionId: NATIVE }) }
    );

    h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    expect(streamFeed.blocks('live-1')).toEqual([]);
  });

  it('a resumed card whose transcript is gone still starts — empty, not broken', () => {
    // nothing seeded: `canResume` said yes and the file is not there
    const streamFeed = new StreamFeed();
    const h = harness(capsWith(() => root), dir, {
      transport: 'stream',
      liveIds: ['live-1'],
      streamFeed,
      prior: priorCard({ folder: dir, nativeSessionId: NATIVE }),
    });

    const record = h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    expect(record).not.toBeNull();
    expect(streamFeed.blocks('live-1')).toEqual([]);
  });

  it('does not read a root the watcher just refused', () => {
    seedTranscript();
    const streamFeed = new StreamFeed();
    const h = harness(capsWith(() => root), dir, {
      transport: 'stream',
      liveIds: ['live-1'],
      streamFeed,
      // the watcher refuses a root it cannot poll safely (§5.29). A refusal has
      // to mean the same thing on both paths, or "unusable root" quietly stops
      // being a decision anyone can rely on.
      watchAccepts: false,
      prior: priorCard({ folder: dir, nativeSessionId: NATIVE }),
    });

    h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

    expect(streamFeed.blocks('live-1')).toEqual([]);
  });

  it('replays nothing when there is no StreamFeed wired at all', () => {
    seedTranscript();
    const h = harness(capsWith(() => root), dir, {
      transport: 'stream',
      liveIds: ['live-1'],
      prior: priorCard({ folder: dir, nativeSessionId: NATIVE }),
    });

    expect(() => h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' })).not.toThrow();
  });
});

// The watcher keeps watching a stream session (usage, the native id, drift), so
// it still corrects mis-binds and still notices a /clear. Its RESET must not be
// routed there: the renderer would drop a Feed the transcript never built, and
// nothing would replay it. Found in review; nothing else pins it.
describe('a transcript reset never blanks a stream session (P2-E18-10)', () => {
  let dir: string;
  tempDirEach('sb-ipc-reset-', (d) => (dir = d));

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
  tempDirEach('sb-resume-', (d) => (dir = d));
  // `card()` is the suspended case here — a card persisted but not running,
  // which is exactly what a suspend leaves behind.
  const { card, start } = cardHelpers(() => dir, CARD);

  const cardsPushes = (h: { pushed: Array<{ channel: string }> }): number =>
    h.pushed.filter((p) => p.channel === 'sessions:cardsChanged').length;
  const statusOf = async (h: { call: (c: string, ...a: unknown[]) => unknown }): Promise<string> => {
    const cards = (await h.call('sessions:cards')) as Array<{ cardId: string; status: string }>;
    return cards.find((c) => c.cardId === CARD)!.status;
  };

  it('the suspend -> resume round trip ends with a LIVE status, unprompted', async () => {
    const h = harness(undefined, dir, { prior: card(), liveIds: ['live-1'] });

    // restored-but-not-yet-resumed: the join has no live half
    expect(await statusOf(h)).toBe('suspended');

    // resume-on-focus spawns (or --resumes) the session for the card
    await start(h);

    // ...and SAID so, which is the whole bug: no status has changed yet, and on
    // a PTY session the first one may be minutes away (it takes a submitted
    // prompt), so this push is the only thing that can move the rail.
    expect(cardsPushes(h)).toBe(1);
    expect(await statusOf(h)).toBe('starting');
  });

  it('losing the live session announces itself too — suspend, then resume again', async () => {
    const h = harness(undefined, dir, { prior: card(), liveIds: ['live-1'] });
    await start(h);

    // the popout window closed: keep the card, drop the session (E8-04)
    await h.call('sessions:dropLive', CARD);
    expect(cardsPushes(h)).toBe(2);
    expect(await statusOf(h)).toBe('suspended');

    // and back again — the round trip is repeatable, not a one-shot
    await start(h);
    expect(cardsPushes(h)).toBe(3);
    expect(await statusOf(h)).toBe('starting');
  });

  it('adopting an already-live session says NOTHING — the binding did not move', async () => {
    // revealing a hidden card re-mounts its panel over a session that is still
    // running (P2-E15-08). That is not a change, and a push here would be a
    // refresh for every reveal, for ever.
    const h = harness(undefined, dir, { prior: card(), liveIds: ['live-1'] });
    await start(h);
    const before = cardsPushes(h);

    await start(h);

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
  tempDirEach('sb-reap-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

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
  tempDirEach('sb-perm-ipc-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

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
  tempDirEach('sb-teardown-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

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

// ---------------------------------------------------------------------------
// #271 — a session that dies ON ITS OWN was the one path that released nothing.
//
// `manager.onSessionExit` did exactly one thing: push `sessions:exited`. Every
// release lives in `tearDownLive`, and a plain self-exit reaches it only if
// something ELSE happens afterwards — the user closes the card, hits Restart, or
// reveals it so the reap runs. Until then main went on holding the CLI's parked
// `PreToolUse` HTTP response and its 300s timer, went on holding an unanswered
// `can_use_tool`, and went on ADVERTISING both through
// `sessions:pendingPermissions` to any card that mounted meanwhile.
//
// Nobody was left to answer either question: the process is gone, so the parked
// response has no reader and the control_response has nowhere to go. That is
// precisely why they must be released rather than kept — a hold that cannot be
// resolved is a leak with a UI attached, and `unregisterSession`'s own comment
// ("a session closed mid-hold must not leave the CLI hanging") is the guarantee
// this path skipped.
//
// The harness change these tests rest on is in `manager.remove`: the real one
// tears the transport down and `onExit` follows from the process actually
// dying — both transports end at `kill()`, a signal, NOT a synchronous
// callback (#288 corrected the same overstatement in session-manager.ts) —
// so the restart paths run BOTH releases, eventually and in either order.
// That is what makes idempotency a requirement here and not a nicety.
describe('a session that exits on its own releases what it was holding (#271)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-selfexit-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  /** the exits the renderer was told about — the push that was already there */
  const exits = (h: { pushed: Array<{ channel: string; payload: unknown }> }): unknown[] =>
    h.pushed.filter((p) => p.channel === 'sessions:exited').map((p) => p.payload);

  it('answers the parked stream request and takes the bar down', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    expect(asked(h)).toHaveLength(1); // the bar really went up

    h.fireExit('live-1', 1); // the CLI dies mid-approval. Nothing else happens.

    expect(perms.pendingRequests()).toEqual([]);
    // "exited", not "closed": the two are different events and the log is where
    // the difference is read. This harness's `SendToSession` has no dead-child
    // gate, so what the assertion pins is the reason the router RECORDED — the
    // real transport refuses the write, which is exactly why the hold must go.
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1', 'session exited') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    // …and the push that was already there still happens, behind the release
    expect(exits(h)).toEqual([{ sessionId: 'live-1', code: 1, crashed: true }]);
  });

  it('drops the hook registration, which releases the parked HTTP response', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [{ requestId: 'hook-1', sessionId: 'live-1' }],
    });
    start(h);

    h.fireExit('live-1', 0);

    // `unregisterSession` is where the parked response, its 300s timer and the
    // session's token all go — see `hook-listener.test.ts`, which pins that it
    // releases in-flight holds fail-open. Here the claim is that the exit path
    // CALLS it, which is the half that was missing.
    expect(h.unregistered).toEqual(['live-1']);
  });

  // THE REMOUNT RACE, and the reason the fix belongs in main. A card's approval
  // effect runs whether or not the card is visible, while its spawn effect
  // early-returns when it is not — so a renderer that remounts into a background
  // tab replays `sessions:pendingPermissions` with no live id bound and nothing
  // that could later prune what it takes. The renderer cannot close that hole
  // without a set of retired ids that grows for ever. Main simply stops saying
  // the request exists.
  it('stops advertising it to a renderer that remounts afterwards', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, {
      prior: card(),
      streamPermissions: perms,
      hookPending: [{ requestId: 'hook-1', sessionId: 'live-1' }],
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    // BOTH transports are in that replay, so both have to stop being in it
    expect(h.call('sessions:pendingPermissions')).toEqual([
      expect.objectContaining({ requestId: 'hook-1', cardId: CARD }),
      expect.objectContaining({ requestId: 'stream:live-1:req-1', cardId: CARD }),
    ]);

    h.fireExit('live-1', 1);

    expect(h.call('sessions:pendingPermissions')).toEqual([]);
  });

  // One router and one hook listener serve every card on the machine, so the
  // sweep being per-session is not a detail — the opposite bug would answer a
  // question the user is still looking at, on a card that is perfectly alive.
  it("leaves a living session's question alone", () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      streamPermissions: perms,
      hookPending: [
        { requestId: 'hook-1', sessionId: 'live-1' },
        { requestId: 'hook-2', sessionId: 'live-2' },
      ],
    });
    start(h);
    start(h, 'card-2');
    perms.offer('live-1', canUseTool('req-1'));
    perms.offer('live-2', canUseTool('req-2'));

    h.fireExit('live-1', 1);

    expect(perms.pendingRequests().map((r) => r.requestId)).toEqual(['stream:live-2:req-2']);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1', 'session exited') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    expect(
      (h.call('sessions:pendingPermissions') as Array<{ requestId: string }>).map(
        (r) => r.requestId
      )
    ).toEqual(['hook-2', 'stream:live-2:req-2']);
  });

  // The release is NOT a teardown, deliberately. An exited session keeps its
  // record and its card binding (#187): the reap in `sessions:create` decides
  // what happens to the corpse, and unbinding here would take the card's live
  // half away underneath it. A version of this fix that called `tearDownLive`
  // would pass every test above and break that.
  it('does not retire the session — the corpse stays bound for the reap', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, { prior: card() });
    start(h);
    const bindings = h.pushed.filter((p) => p.channel === 'sessions:cardsChanged').length;

    h.fireExit('live-1', 1);

    expect(h.removed).toEqual([]);
    expect(h.unwatched).toEqual([]);
    expect(h.forgottenEvents).toEqual([]);
    expect(h.pushed.filter((p) => p.channel === 'sessions:cardsChanged')).toHaveLength(bindings);
  });

  // #200. The watch is the ONE thing here that hears about the death directly,
  // and the distinction is the whole item: TOLD, not torn down. A dead CLI
  // writes no more transcript lines, so polling for them is pure waste — but
  // `transcripts.unwatch` drops the entry that holds the Feed backlog and the
  // binding state, which is precisely what the crashed card shows when the user
  // comes back to it. Freezing lives in the watcher (`noteSessionExited`);
  // what this pins is that main routes the exit to it at all, and does not
  // "fix" the leak by reaching for `unwatch`.
  it('tells the transcript watch the process is gone, and does NOT unwatch it', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, { prior: card() });
    start(h);

    h.fireExit('live-1', 1);

    expect(h.exitedNoted).toEqual(['live-1']);
    expect(h.unwatched).toEqual([]);
    // the crashed card's Feed still has something to replay when its pane mounts
    expect(h.call('transcripts:blocks', 'live-1')).toEqual([
      { seq: 1, kind: 'assistant', text: 'transcript block for live-1' },
    ]);
  });

  // The two paths meet on every Restart: `tearDownLive` unwatches, and the kill
  // it asks for lands as an exit afterwards (this fake's `remove` fires it
  // early, which is the harsher order). Neither may undo or duplicate the
  // other's work — `noteSessionExited` is a no-op for an id that is already
  // unwatched, and the reap unwatching a frozen session must still be exactly
  // one teardown.
  it('the reap and the exit notice cannot trip over each other', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      prior: card(),
      spawnIds: ['live-1', 'live-2'],
      exitCodes: { 'live-1': 1 },
    });
    start(h); // spawns live-1, which is then crashed by `exitCodes`
    h.fireExit('live-1', 1);
    start(h); // Restart: the reap retires the corpse, then live-2 is watched

    expect(h.trace).toEqual([
      'watch:live-1',
      'noteExited:live-1',
      'unwatch:live-1',
      'watch:live-2',
    ]);
    expect(h.unwatched).toEqual(['live-1']);
    expect(h.exitedNoted).toEqual(['live-1']);
  });

  // IDEMPOTENCY, in the order the restart paths actually produce it: Restart
  // runs `tearDownLive`, whose `manager.remove` fires this very listener before
  // it returns. So the release runs twice on every Restart and every card close
  // of a RUNNING session, and a second denial down the stream — or a second
  // `sessions:permissionResolved` for a request id already resolved — would be a
  // regression shipped by the fix itself.
  it('releases exactly once when Restart tears the session down under it', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    h.call('sessions:dropLive', CARD);

    expect(sent).toHaveLength(1);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
    // the teardown's own call and the exit listener's — both really did run
    expect(h.unregistered).toEqual(['live-1', 'live-1']);
  });

  // …and in the other order: the session died first, then the card was revealed
  // and the reap tore the corpse down. The second pass has nothing left to find.
  it('releases exactly once when the reap follows the exit', () => {
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

    exitCodes['live-1'] = 1;
    h.fireExit('live-1', 1); // the CLI dies mid-approval — released here
    start(h); // revealing the card re-arms the spawn, which reaps live-1

    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1', 'session exited') }]);
    expect(resolved(h)).toEqual(['stream:live-1:req-1']);
  });

  // Fail-open (P6) on the new path too. The two releases are independent, and a
  // throw out of the first one is the exact shape #219 closed for the teardown:
  // it would skip the denial the CLI is blocked on, and skip the exit push with
  // it. (`SessionManager` wraps each exit listener in its own try/catch, so a
  // throw would not reach the other subscribers — the blast radius is this
  // handler, which is quite enough: the renderer would never hear the session
  // ended.) The warn naming the step is the other half: a swallowed failure that
  // says nothing is worse than the one it hides.
  it('a throwing unregister still denies the stream request and still reports the exit', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, {
      prior: card(),
      streamPermissions: perms,
      throwOnUnregister: 'live-1',
    });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    expect(() => h.fireExit('live-1', 1)).not.toThrow();

    expect(perms.pendingRequests()).toEqual([]);
    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoDenial('req-1', 'session exited') }]);
    expect(exits(h)).toEqual([{ sessionId: 'live-1', code: 1, crashed: true }]);
    // and it says which release was lost, rather than swallowing it
    expect(h.warn).toHaveBeenCalledWith(
      'a session teardown step failed; releasing the rest anyway',
      expect.objectContaining({ sessionId: 'live-1', step: 'hooks.unregisterSession' })
    );
  });

  // The PTY-only wiring has no router to call, so the hook release is the whole
  // of it — asserted here rather than only the absence of a throw, which every
  // `tearDownStep` guarantees for free and would make this vacuous.
  it('the PTY-only wiring releases its hook half with no StreamPermissions at all', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [{ requestId: 'hook-1', sessionId: 'live-1' }],
    });
    start(h);

    expect(() => h.fireExit('live-1', 1)).not.toThrow();

    expect(h.unregistered).toEqual(['live-1']);
    expect(h.call('sessions:pendingPermissions')).toEqual([]);
    // …and the optional-chained router is a no-op, not a logged failure
    expect(h.warn).not.toHaveBeenCalled();
  });
});

// P2-E14-04. The OS toast's Allow/Deny answers from the MAIN process, with no
// window in the loop — so the two things it needs (what is being asked, and how
// to answer it) come back on `SessionIpcHandle` rather than over IPC. What is
// pinned here is that they are the SAME routers `sessions:decidePermission`
// reaches: a toast with its own route to the CLI would be a second opinion
// about what "allow" means, and the two would drift the first time either
// changed.
describe('a toast can name and answer a held permission (P2-E14-04)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-toastperm-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  it('names the OLDEST request the live session is holding — what the bar answers', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [
        { requestId: 'hook-1', sessionId: 'live-1' },
        { requestId: 'hook-2', sessionId: 'live-1' },
      ],
    });
    start(h);
    // FIFO, because the approval bar's buttons act on `cardQueue[0]`. A toast
    // that answered the newest while the bar answered the oldest would make the
    // two surfaces disagree about which question is on screen.
    expect(h.pendingPermissionFor('live-1')?.requestId).toBe('hook-1');
  });

  it('answers null for a session holding nothing, and for one that never existed', () => {
    const h = harness(undefined, dir, { prior: card() });
    start(h);
    expect(h.pendingPermissionFor('live-1')).toBeNull();
    expect(h.pendingPermissionFor('no-such-session')).toBeNull();
  });

  it('sees BOTH transports — a Direct session holds on the stream router', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));
    expect(h.pendingPermissionFor('live-1')?.requestId).toBe('stream:live-1:req-1');
  });

  it('decidePermission reaches the hook router, exactly as the channel does', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [{ requestId: 'hook-1', sessionId: 'live-1' }],
    });
    start(h);

    expect(h.decidePermission('hook-1', 'deny')).toBe(true);

    expect(h.hookDecisions).toEqual([
      { requestId: 'hook-1', decision: 'deny', reason: undefined },
    ]);
    // and the request really is gone — the bar and the replay agree with the toast
    expect(h.pendingPermissionFor('live-1')).toBeNull();
    expect(h.call('sessions:pendingPermissions')).toEqual([]);
  });

  it('decidePermission reaches the STREAM router too', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    perms.offer('live-1', canUseTool('req-1'));

    expect(h.decidePermission('stream:live-1:req-1', 'allow')).toBe(true);

    expect(sent).toHaveLength(1);
    expect(h.pendingPermissionFor('live-1')).toBeNull();
  });

  // The dead-session half of the issue's done-when, at the seam the toast
  // actually calls: nothing holds it, so nothing is decided and the caller is
  // told so rather than being left to assume it worked.
  it('answers FALSE for a request nobody holds, and for a nonsense verdict', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [{ requestId: 'hook-1', sessionId: 'live-1' }],
    });
    start(h);

    expect(h.decidePermission('gone', 'allow')).toBe(false);
    expect(h.decidePermission('hook-1', 'maybe')).toBe(false);
    expect(h.decidePermission('', 'allow')).toBe(false);

    expect(h.hookDecisions).toEqual([]); // nothing reached a router
    expect(h.pendingPermissionFor('live-1')?.requestId).toBe('hook-1'); // still held
  });

  it('the channel and the handle are the same function — one path, two callers', () => {
    const h = harness(undefined, dir, {
      prior: card(),
      hookPending: [
        { requestId: 'hook-1', sessionId: 'live-1' },
        { requestId: 'hook-2', sessionId: 'live-1' },
      ],
    });
    start(h);

    h.call('sessions:decidePermission', 'hook-1', 'allow', 'from the bar');
    h.decidePermission('hook-2', 'allow', 'from the toast');

    // Same shape, same clamping, same router — the only difference is who
    // called. (`reason` is passed straight through by both.)
    expect(h.hookDecisions).toEqual([
      { requestId: 'hook-1', decision: 'allow', reason: 'from the bar' },
      { requestId: 'hook-2', decision: 'allow', reason: 'from the toast' },
    ]);
  });
});

// #294. The rail now refuses an empty rename at the field — but the field is
// one caller, and it is the renderer. This is the half of the rule that
// survives a restart: `manager.rename` already declines a blank, and only for
// the LIVE record, which is not the one the next boot reads. Without a guard
// here `''` stayed a legal persisted title and every reader downstream had to
// keep its own "empty counts as absent" fallback honest forever.
describe('a card cannot be renamed to nothing (#294)', () => {
  let folder: string;
  tempDirEach('sb-rename-', (d) => (folder = d));

  /** rename a persisted, non-live card and report what the store was handed */
  const rename = (title: string): PersistedSession[] => {
    const h = harness(undefined, folder, { prior: priorCard({ folder, id: 'card-1' }) });
    h.call('sessions:renameCard', 'card-1', title);
    return h.upserted;
  };

  it('refuses an empty title, leaving the persisted name alone', () => {
    expect(rename('')).toEqual([]);
  });

  it('refuses a whitespace-only title for the same reason', () => {
    expect(rename('   \t ')).toEqual([]);
  });

  it('trims the title it does accept — so "blank" is one rule and not two', () => {
    expect(rename('  renamed  ').map((s) => s.identity.title)).toEqual(['renamed']);
  });

  it('still caps a long title at 120 characters', () => {
    expect(rename('W'.repeat(200)).map((s) => s.identity.title)).toEqual(['W'.repeat(120)]);
  });
});

// #319 — "Allow all (this session)" has to reach BOTH permission channels.
//
// It told `HookListener` and nothing else. That is the whole of the promise for
// a PTY session and none of it for a Direct one: `HookListener.maybeHold`
// returns 'pass' for a stream session BEFORE it consults its allow-all set, so
// the grant sat in a set that could never match. Stream allow-all therefore
// lived only in the renderer — every gated call still had to reach a live
// window, still raised `permission-held` on the way (beep, taskbar flash,
// Events row), and a session whose window was closed could not run a gated tool
// at all.
//
// These use the REAL `StreamPermissions`, so what is asserted is the wiring end
// to end: one IPC call in, a `control_response` on the transport out, and
// nothing pushed at the renderer in between.
describe('allow-all is granted on both channels (#319)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-allowall-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  /** the allow the router sends the CLI when the session answers for itself */
  function autoAllow(requestId: string): Record<string, unknown> {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: { file_path: 'src/app.ts', content: 'x' } },
      },
    };
  }

  it('one click reaches the hook listener AND the stream router', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);

    h.call('sessions:allowAllSession', 'live-1');

    expect(h.allowedAll).toEqual(['live-1']);
    expect(perms.isAllowAll('live-1')).toBe(true);
  });

  // The behaviour the grant is FOR, through the real router: the CLI is
  // answered here, and the renderer is never told there was a question.
  it('a gated call is then answered at the server, with no bar raised', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    h.call('sessions:allowAllSession', 'live-1');

    perms.offer('live-1', canUseTool('req-1'));

    expect(sent).toEqual([{ sessionId: 'live-1', msg: autoAllow('req-1') }]);
    expect(asked(h)).toEqual([]); // no sessions:permissionRequest
    expect(perms.pendingRequests()).toEqual([]); // and nothing left holding
  });

  it('without the grant the same call still raises a bar', () => {
    const { perms, sent } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);

    perms.offer('live-1', canUseTool('req-1'));

    expect(sent).toEqual([]);
    expect(asked(h)).toHaveLength(1);
  });

  // Keyed by LIVE id, so the session that replaces this one asks again — the
  // renderer's semantics (`sessionStore.allowAllByLive`) and the hook
  // listener's, now shared by the third holder of the same fact.
  it('closing the card ends the grant', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);
    h.call('sessions:allowAllSession', 'live-1');

    h.call('sessions:closeCard', CARD);

    expect(perms.isAllowAll('live-1')).toBe(false);
  });

  it('a non-string id grants nothing anywhere', () => {
    const { perms } = streamPerms();
    const h = harness(undefined, dir, { prior: card(), streamPermissions: perms });
    start(h);

    h.call('sessions:allowAllSession', 42 as unknown as string);

    expect(h.allowedAll).toEqual([]);
    expect(perms.isAllowAll('live-1')).toBe(false);
  });

  // The PTY-only wiring has to survive it: `streamPermissions` is optional in
  // these deps and was undefined in every test in this file until #202.
  it('works with no stream router at all', () => {
    const h = harness(undefined, dir, { prior: card() });
    start(h);

    expect(() => h.call('sessions:allowAllSession', 'live-1')).not.toThrow();
    expect(h.allowedAll).toEqual(['live-1']);
  });
});

// HOW THIS SEAM SAYS NO (issue 347) — the sessions-family twin of what issue 326
// did for `groups:*`.
//
// `sessions:create` and `sessions:rename` were the two channels in this file
// that refused by THROWING, and a throw out of a handler rejects the renderer's
// promise. Every bridge call in the renderer is a bare `void x().then(...)`;
// `SessionGrid`'s spawn effect happens to catch, so the visible behaviour of a
// card that cannot start is unchanged — but `sessions:rename` has no caller at
// all yet, and would have handed the first one written both a TypeError (a
// non-string title reaching `title.trim()`) and a throw (an unknown id reaching
// `mustGet`).
//
// They answer now: `null` means "nothing happened", and the reason is a line in
// the app log — which is where it never used to be, because the broker does not
// catch handler throws and Electron printed them to stderr instead. The refusal
// assertions below are therefore "answered null AND started nothing AND said
// so", which is strictly more than "threw".
describe('a refused sessions call answers null and says why — it never throws (issue 347)', () => {
  let dir: string;
  tempDirEach('sb-ipc-refuse-', (d) => (dir = d));

  /** the refusal warnings, in order, as they land in the app log */
  const refusals = (h: { warn: { mock: { calls: unknown[][] } } }): string[] =>
    h.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('refused'));

  describe('sessions:create', () => {
    it('refuses a call with no cardId or folder, and starts nothing', () => {
      const h = harness(undefined, dir);

      expect(h.call('sessions:create', { title: 'x' })).toBeNull();

      expect(h.created).toEqual([]); // no session asked for
      expect(h.upserted).toEqual([]); // no card written
      expect(h.watched).toEqual([]); // no transcript watched
      expect(refusals(h)).toEqual(['sessions:create refused: cardId and folder are required']);
    });

    it.each([
      ['nothing at all', undefined],
      ['a non-string cardId', { cardId: 7, folder: 'anything', title: 'x' }],
      ['a non-string folder', { cardId: 'card-1', folder: 7, title: 'x' }],
      ['no folder', { cardId: 'card-1', title: 'x' }],
    ])('does not throw on %s', (_what, arg) => {
      const h = harness(undefined, dir);
      expect(() => h.call('sessions:create', arg)).not.toThrow();
      expect(h.call('sessions:create', arg)).toBeNull();
      expect(h.created).toEqual([]);
    });

    // THE REACHABLE ONE. Nothing has to go wrong for a user to arrive here: a
    // card is persisted with its folder, and that folder can be renamed,
    // deleted, or sitting on a drive that is not plugged in by the time the card
    // is looked at again. It used to reach `throw new Error('folder is not a
    // directory')`.
    it('refuses a folder that is not there — the card whose folder moved', () => {
      const h = harness(undefined, dir);
      const gone = path.join(dir, 'this-folder-was-deleted');

      expect(h.call('sessions:create', { cardId: 'card-1', folder: gone, title: 'x' })).toBeNull();

      expect(h.created).toEqual([]);
      expect(h.upserted).toEqual([]);
      // the folder is IN the log line's fields, which is the point of logging it
      // here rather than leaving it to Electron's stderr
      expect(h.warn).toHaveBeenCalledWith('sessions:create refused: folder is not a directory', {
        cardId: 'card-1',
        folder: gone,
      });
    });

    it('refuses a FILE that is not a directory, for the same reason', () => {
      const h = harness(undefined, dir);
      const file = path.join(dir, 'a-file.txt');
      fs.writeFileSync(file, 'not a folder');

      expect(h.call('sessions:create', { cardId: 'card-1', folder: file, title: 'x' })).toBeNull();
      expect(h.created).toEqual([]);
    });

    // The other half: the input was fine and the SPAWN failed. The manager throws
    // for a provider adapter it does not have, a transport it cannot resolve and
    // a spawn that fails — correct for its main-process callers, and something
    // this handler has to turn into an answer.
    it('answers null when the spawn itself fails, and binds or persists nothing', () => {
      const h = harness(undefined, dir, { throwOnSpawn: true });

      expect(h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' })).toBeNull();

      expect(h.upserted).toEqual([]); // no card record for a session that never started
      expect(h.watched).toEqual([]); // nothing watched
      // and the renderer was NOT told a card gained a live session
      expect(h.pushed.filter((p) => p.channel === 'sessions:cardsChanged')).toEqual([]);
    });

    it('logs a failed spawn as an ERROR with the reason — a warning is for input we declined', () => {
      const h = harness(undefined, dir, { throwOnSpawn: true });

      h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' });

      expect(h.logError).toHaveBeenCalledTimes(1);
      const [msg, fields] = h.logError.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toContain('sessions:create');
      expect(fields.cardId).toBe('card-1');
      expect(fields.folder).toBe(dir);
      expect(String(fields.error)).toContain('spawn exploded');
      expect(refusals(h)).toEqual([]); // not a refusal — a failure
    });

    it('a failed spawn does not throw, so a later look at the card can still start it', () => {
      // fail-open (P6): one bad start does not poison the card
      const h = harness(undefined, dir, { throwOnSpawn: true });
      expect(() =>
        h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' })
      ).not.toThrow();
    });

    it('still starts a session it accepts, and warns about nothing', () => {
      const h = harness(undefined, dir);

      const rec = h.call('sessions:create', { cardId: 'card-1', folder: dir, title: 'x' }) as {
        id: string;
      };

      expect(rec.id).toBe('live-1');
      expect(h.created).toHaveLength(1);
      expect(refusals(h)).toEqual([]);
    });
  });

  describe('sessions:rename', () => {
    it('refuses a non-string session id and renames nothing', () => {
      const h = harness(undefined, dir, { liveIds: ['live-1'] });

      expect(h.call('sessions:rename', 42, 'new name')).toBeNull();

      expect(h.renamed).toEqual([]);
      expect(refusals(h)).toEqual(['sessions:rename refused: session id must be a string']);
    });

    it('refuses a non-string title — the TypeError that used to come out of trim()', () => {
      const h = harness(undefined, dir, { liveIds: ['live-1'] });

      expect(h.call('sessions:rename', 'live-1', 42)).toBeNull();

      expect(h.renamed).toEqual([]);
      expect(refusals(h)).toEqual(['sessions:rename refused: title must be a string']);
    });

    // The `session-manager.ts` throw issue 326's worker reported: `mustGet`. The
    // id can be stale for honest reasons — a session that exited while a rename
    // was in flight — so it is answered, not thrown.
    it('answers null for a session it does not know, without throwing', () => {
      const h = harness(undefined, dir);

      expect(() => h.call('sessions:rename', 'ghost', 'new name')).not.toThrow();
      expect(h.call('sessions:rename', 'ghost', 'new name')).toBeNull();
      expect(h.upserted).toEqual([]);
    });

    it('still renames a session it knows, and answers the record', () => {
      const h = harness(undefined, dir, { liveIds: ['live-1'] });

      const rec = h.call('sessions:rename', 'live-1', 'a better name') as { id: string };

      expect(rec.id).toBe('live-1');
      expect(h.renamed).toEqual([{ id: 'live-1', title: 'a better name' }]);
      expect(refusals(h)).toEqual([]);
    });

    it('a blank title is not a refusal to shout about — the manager drops it', () => {
      // `sessions:renameCard` applies the same rule (#294): a blank rename is an
      // edit that went nowhere, not bad input
      const h = harness(undefined, dir, { liveIds: ['live-1'] });

      h.call('sessions:rename', 'live-1', '   ');

      expect(refusals(h)).toEqual([]);
    });
  });
});

// #404 — the seam a session's resume identity rides through. The manager
// learns `nativeSessionId` from two writers (a hook's SessionStart, and since
// #404 the stream's own `system:init`); HERE is where the learned id becomes
// durable: persisted onto the card for the next boot's `--resume`, and handed
// to the transcript watcher so a /clear rebinds with its cause. Untested until
// #404 — the fake manager swallowed the subscription, so nothing pinned that
// the listener was wired at all.
describe('a learned native id reaches the card and the watcher (#404)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-nativeid-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  it('persists the id onto the card, so --resume survives a relaunch', () => {
    const h = harness(undefined, dir, { prior: card() });
    start(h);

    h.fireNativeId('live-1', 'native-9');

    expect(h.upserted.at(-1)?.nativeSessionId).toBe('native-9');
  });

  it("tells the transcript watcher, cause included — the /clear rebind's whole input", () => {
    const h = harness(undefined, dir, { prior: card() });
    start(h);

    h.fireNativeId('live-1', 'native-9');
    h.fireNativeId('live-1', 'native-10', 'clear');

    expect(h.nativeIdsSet).toEqual([
      { sessionId: 'live-1', nativeId: 'native-9', cause: undefined },
      { sessionId: 'live-1', nativeId: 'native-10', cause: 'clear' },
    ]);
  });

  it('an id with no card behind it still reaches the watcher, and throws nothing', () => {
    const h = harness(undefined, dir);

    expect(() => h.fireNativeId('live-ghost', 'native-9')).not.toThrow();

    expect(h.nativeIdsSet).toEqual([
      { sessionId: 'live-ghost', nativeId: 'native-9', cause: undefined },
    ]);
    expect(h.upserted).toEqual([]); // no card to write
  });
});

// Session find (P2-E17-01, §5.31). The engine has its own test file; what is
// pinned here is the WIRING — the scope arrives as session ids, and main is what
// turns an id into a file. A renderer that could name the path would be able to
// read a transcript no card is showing.
describe('transcripts:search resolves a scope of sessions to files', () => {
  let dir: string;
  tempDirEach('sb-ipc-find-', (d) => (dir = d));

  const caps = { transcripts: { projectsRoot: () => '/root' } };
  const line = (text: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  const write = (name: string, texts: string[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, texts.map(line).join('\n') + '\n');
    return file;
  };

  it('scans the transcript the watcher says the session is bound to', async () => {
    const file = write('a.jsonl', ['nothing here', 'the FOUNDLING is here']);
    const h = harness(caps, dir, { liveIds: ['live-1'], transcriptFiles: { 'live-1': file } });

    const r = (await h.call('transcripts:search', {
      sessionIds: ['live-1'],
      query: { term: 'FOUNDLING' },
    })) as { total: number; hits: Array<{ sessionId: string; blockIndex: number }> };

    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: 'live-1', blockIndex: 2 });
  });

  it('answers a session with no bound transcript with an empty, unsearched group', async () => {
    const h = harness(caps, dir, { liveIds: ['live-1'] });

    const r = (await h.call('transcripts:search', {
      sessionIds: ['live-1'],
      query: { term: 'anything' },
    })) as { total: number; groups: Array<{ searched: boolean }> };

    expect(r.total).toBe(0);
    expect(r.groups[0].searched).toBe(false);
  });

  it('takes a LIST — the scope §10 extends rather than replaces', async () => {
    const a = write('a.jsonl', ['SHARED once']);
    const b = write('b.jsonl', ['SHARED twice', 'and SHARED again']);
    const h = harness(caps, dir, {
      liveIds: ['live-1', 'live-2'],
      transcriptFiles: { 'live-1': a, 'live-2': b },
    });

    const r = (await h.call('transcripts:search', {
      sessionIds: ['live-1', 'live-2'],
      query: { term: 'SHARED' },
    })) as { total: number; groups: Array<{ sessionId: string; hits: number }> };

    expect(r.total).toBe(3);
    expect(r.groups.map((g) => [g.sessionId, g.hits])).toEqual([
      ['live-1', 1],
      ['live-2', 2],
    ]);
  });

  it('survives a caller that sends nonsense, the way every channel here does', async () => {
    const h = harness(caps, dir, { liveIds: ['live-1'] });

    for (const bad of [undefined, null, 'a string', 42, { sessionIds: 'not-a-list' }, {}]) {
      const r = (await h.call('transcripts:search', bad)) as { hits: unknown[]; groups: unknown[] };
      expect(r.hits).toEqual([]);
      expect(r.groups).toEqual([]);
    }
  });

  it('reports a bad regex rather than rejecting the renderer’s promise', async () => {
    const file = write('a.jsonl', ['anything at all']);
    const h = harness(caps, dir, { liveIds: ['live-1'], transcriptFiles: { 'live-1': file } });

    const r = (await h.call('transcripts:search', {
      sessionIds: ['live-1'],
      query: { term: '[', regex: true },
    })) as { error?: { code: string } };

    expect(r.error?.code).toBe('bad-pattern');
  });
});

// A stream session's transcript is still on disk and still complete — only its
// FEED comes from somewhere else (P2-E18-10). So find searches it, and says
// plainly that it cannot offer a jump.
describe('transcripts:search over a stream session (P2-E17-01)', () => {
  let dir: string;
  tempDirEach('sb-ipc-find-stream-', (d) => (dir = d));

  it('searches the transcript, and reports that it cannot line it up', async () => {
    const file = path.join(dir, 'stream.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a STREAMED answer' }] },
      }) + '\n'
    );
    const streamFeed = new StreamFeed();
    const h = harness({ transcripts: { projectsRoot: () => '/root' } }, dir, {
      transport: 'stream',
      liveIds: ['live-1'],
      streamFeed,
      transcriptFiles: { 'live-1': file },
    });
    streamFeed.offer('live-1', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a STREAMED answer' }] },
      parent_tool_use_id: null,
    });

    const r = (await h.call('transcripts:search', {
      sessionIds: ['live-1'],
      query: { term: 'STREAMED' },
    })) as {
      total: number;
      hits: Array<{ seq?: number; earlierThanLoaded: boolean }>;
      groups: Array<{ searched: boolean; aligned: boolean }>;
    };

    expect(r.total).toBe(1); // complete — the file is the archive either way
    expect(r.groups[0].searched).toBe(true);
    // A stream block's `ts` is when the message reached US, not what the CLI
    // wrote, so the two cannot be lined up and the engine says so.
    expect(r.groups[0].aligned).toBe(false);
    expect(r.hits[0].seq).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-E18-17 — the #404 audit's fourth finding, kept at the end of the file on
// purpose: it is a self-contained block, so a conflict with the other branches
// editing this suite is a trivial one.
// ---------------------------------------------------------------------------

// The env override must AIM a launch, not EDIT anybody's cards.
//
// `SWITCHBOARD_TRANSPORT` is per-app-instance and temporary by nature — you set
// it to try Terminal mode for an afternoon. Writing its answer back onto every
// card that had never chosen would make that afternoon permanent: the cards
// would come out of population 1 ("follows the default") and into population 2
// ("explicitly chose"), so the next launch WITHOUT the variable would still be
// on the old transport, and the next change of default would skip them for
// ever. The same rule as the default itself, for the same reason — absence is a
// meaningful value here.
describe('the env override is not written back onto the card (P2-E18-17)', () => {
  const CARD = 'card-1';
  let dir: string;
  tempDirEach('sb-tr-envback-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir, CARD);

  it('the override decides the spawn but leaves the card unchosen', async () => {
    const h = harness(undefined, dir, { prior: card(), preferredTransport: () => 'pty' });

    await start(h);

    expect(h.created[0].transport).toBe('pty'); // it did decide...
    // `.at(-1)?` on an EMPTY list is undefined too, so the card must be proved
    // written at all — otherwise "stopped persisting the card" passes this as
    // cleanly as "did not write the transport".
    expect(h.upserted).not.toHaveLength(0);
    expect(h.upserted.at(-1)?.transport).toBeUndefined(); // ...and recorded nothing
  });

  it('holds for a brand-new card with no record at all', async () => {
    const h = harness(undefined, dir, { preferredTransport: () => 'pty' });

    await start(h, 'fresh');

    expect(h.created[0].transport).toBe('pty');
    expect(h.upserted).not.toHaveLength(0);
    expect(h.upserted.at(-1)?.transport).toBeUndefined();
  });

  it('and for `stream`, which is the value a lazy write-back would hide in', async () => {
    const h = harness(undefined, dir, { prior: card(), preferredTransport: () => 'stream' });

    await start(h);

    // identical to what the default would have produced, which is the point:
    // the card must still say nothing, or it silently stops following the
    // default the day the default moves.
    expect(h.created[0].transport).toBe('stream');
    expect(h.upserted).not.toHaveLength(0);
    expect(h.upserted.at(-1)?.transport).toBeUndefined();
  });

  it("a card that DID choose keeps its own value written down", async () => {
    const h = harness(undefined, dir, {
      prior: { ...card(), transport: 'pty' },
      preferredTransport: () => 'stream',
    });

    await start(h);

    // the card's choice beat the override at the spawn...
    expect(h.created[0].transport).toBe('pty');
    // ...and the override did not overwrite it on the way through either
    expect(h.upserted.at(-1)?.transport).toBe('pty');
  });
});

// ── P2-E7-06: auto task labels from the CLI's own title ────────────────────
//
// The loop under test: a line lands in the transcript, the watcher puts the
// title on its snapshot, and this module decides what that does to the card.
// Driven by the REAL captured `ai-title` titles, so a repeat here is a repeat
// the CLI actually produced.
describe('auto task labels (P2-E7-06, §5.11)', () => {
  let dir: string;
  tempDirEach('sb-label-', (d) => (dir = d));
  const { card, start } = cardHelpers(() => dir);
  const [FIRST, SETTLED] = titlesOf(REVISED);
  const REPEATED = titlesOf(REPEAT_HEAVY)[0];

  /** an adapter that writes transcripts AND names its conversations */
  const claudeLike: ProviderCapabilities = {
    transcripts: { projectsRoot: () => '/roots/claude' },
    titles: { titleFrom: readAiTitle },
  };

  /** every task-label push the renderer was sent, in order */
  const labels = (h: { pushed: Array<{ channel: string; payload: unknown }> }) =>
    h.pushed
      .filter((p) => p.channel === 'sessions:taskLabel')
      .map((p) => p.payload as { cardId: string; label?: string });

  /** the card as the store now holds it */
  const stored = (h: { cards: PersistedSession[] }) => h.cards.find((c) => c.id === 'card-1')!;

  it('a blank label fills itself from the CLI title, and says so', () => {
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);

    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

    expect(stored(h).taskLabel).toBe(SETTLED);
    expect(stored(h).labelSource).toBe('auto');
    // and the renderer is TOLD: nothing in it asked for this, so a silent
    // persist would be a label that is correct on disk and invisible on screen
    expect(labels(h)).toEqual([{ cardId: 'card-1', label: SETTLED }]);
  });

  it('keeps tracking while on auto — the CLI revises its answer', () => {
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);

    // the real pair, one line apart in a real transcript
    h.fireSnapshot({ sessionId: 'live-1', title: FIRST });
    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

    expect(stored(h).taskLabel).toBe(SETTLED);
    expect(labels(h).map((l) => l.label)).toEqual([FIRST, SETTLED]);
  });

  it('a repeat costs nothing — 13 real title lines, ONE push', () => {
    // The CLI re-emits the settled title EVERY TURN. Undeduped this is a
    // renderer push per turn on every open session at once — so the de-dupe is
    // asserted against the repeat-heavy capture rather than assumed.
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);
    const before = h.upserted.length;

    for (const [, raw] of REPEAT_HEAVY.lines) {
      const title = readAiTitle(JSON.parse(raw) as Record<string, unknown>);
      h.fireSnapshot({ sessionId: 'live-1', title });
    }

    expect(REPEAT_HEAVY.lines.length).toBe(13); // the fixture really does repeat
    expect(labels(h)).toEqual([{ cardId: 'card-1', label: REPEATED }]);
    // the usage upsert still happens per snapshot — that is pre-existing — but
    // the label written by each is the same one, set once and never flipped
    const written = h.upserted.slice(before);
    expect(new Set(written.map((u) => u.taskLabel))).toEqual(new Set([REPEATED]));
    expect(new Set(written.map((u) => u.labelSource))).toEqual(new Set(['auto']));
  });

  it('typing a label pins it, and no later title may overwrite it', () => {
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);
    h.fireSnapshot({ sessionId: 'live-1', title: FIRST });

    h.call('sessions:setTaskLabel', 'card-1', '  mine, thanks  ');
    expect(stored(h).taskLabel).toBe('mine, thanks');
    expect(stored(h).labelSource).toBe('user');

    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });
    expect(stored(h).taskLabel).toBe('mine, thanks');
  });

  it('a label typed BEFORE this feature shipped is the users too', () => {
    // E7-03's label carries no `labelSource`. Treating that absence as "auto"
    // would overwrite it on the first turn after an upgrade.
    const h = harness(claudeLike, dir, { prior: card() });
    h.cards[0].taskLabel = 'from an older build';
    start(h);

    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

    expect(stored(h).taskLabel).toBe('from an older build');
    expect(labels(h)).toEqual([]);
  });

  it('clearing the field hands it back to auto', () => {
    // "Is it empty?" is deliberately NOT the ownership test — a blank label you
    // meant to keep would be impossible — so clearing has to say so explicitly.
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);
    h.call('sessions:setTaskLabel', 'card-1', 'mine');

    h.call('sessions:setTaskLabel', 'card-1', '   ');
    expect(stored(h).taskLabel).toBeUndefined();
    expect(stored(h).labelSource).toBe('auto');

    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });
    expect(stored(h).taskLabel).toBe(SETTLED);
  });

  it('no title means no label — the folder name simply stands', () => {
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);

    h.fireSnapshot({ sessionId: 'live-1' });
    h.fireSnapshot({ sessionId: 'live-1', title: '   ' });

    expect(stored(h).taskLabel).toBeUndefined();
    expect(labels(h)).toEqual([]);
  });

  it('an adapter that does not declare titles starts no title watch at all', () => {
    const h = harness({ transcripts: { projectsRoot: () => '/roots/x' } }, dir, { prior: card() });
    start(h);
    expect(h.watched[0].readTitle).toBeUndefined();

    const withTitles = harness(claudeLike, dir, { prior: card() });
    start(withTitles);
    expect(withTitles.watched[0].readTitle).toBeTypeOf('function');
  });

  describe('the screen-share switch', () => {
    it('fills nothing while it is off', () => {
      const h = harness(claudeLike, dir, { prior: card(), autoLabels: false });
      start(h);

      h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

      expect(stored(h).taskLabel).toBeUndefined();
      expect(labels(h)).toEqual([]);
    });

    it('hides a label already filled, everywhere the renderer reads one', async () => {
      const h = harness(claudeLike, dir, { prior: card() });
      start(h);
      h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

      h.call('settings:setAutoLabels', false);

      // the card list...
      const cards = (await h.call('sessions:cards')) as Array<{ taskLabel?: string }>;
      expect(cards[0].taskLabel).toBeUndefined();
      // ...the toast text (§5.9)...
      expect(h.labelFor('live-1')).toBeUndefined();
      // ...and the push that takes it off a card already on screen
      expect(labels(h).at(-1)).toEqual({ cardId: 'card-1', label: undefined });
      // but nothing was DELETED — flipping back must be lossless
      expect(stored(h).taskLabel).toBe(SETTLED);
    });

    it('puts them straight back when it goes on again', () => {
      // Waiting for the next `ai-title` would work — the CLI re-emits every
      // turn — but "every turn" is minutes on an idle session, and a switch
      // that appears to do nothing is a switch nobody trusts.
      const h = harness(claudeLike, dir, { prior: card() });
      start(h);
      h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });
      h.call('settings:setAutoLabels', false);

      expect(h.call('settings:setAutoLabels', true)).toBe(true);

      expect(labels(h).at(-1)).toEqual({ cardId: 'card-1', label: SETTLED });
      expect(h.labelFor('live-1')).toBe(SETTLED);
    });

    it('reaches a SUSPENDED card too — the ones nobody is looking at', () => {
      // A suspended card has no live session but still has a panel and a rail
      // row, both showing whatever label it was left with. Walking the live
      // bindings would leave exactly those still displaying a prompt-derived
      // phrase, which is the case the switch exists for.
      const h = harness(claudeLike, dir, { prior: card() });
      start(h);
      h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });
      h.call('sessions:dropLive', 'card-1'); // suspended: the binding is gone

      h.call('settings:setAutoLabels', false);

      expect(labels(h).at(-1)).toEqual({ cardId: 'card-1', label: undefined });
    });

    it('never hides a label the user typed', () => {
      const h = harness(claudeLike, dir, { prior: card() });
      start(h);
      h.call('sessions:setTaskLabel', 'card-1', 'mine');

      h.call('settings:setAutoLabels', false);

      expect(h.labelFor('live-1')).toBe('mine');
    });

    it('reports what it actually stored', () => {
      const h = harness(claudeLike, dir, { prior: card() });
      expect(h.call('settings:getAutoLabels')).toBe(true);
      expect(h.call('settings:setAutoLabels', 'yes please')).toBe(false); // not `true`
      expect(h.call('settings:getAutoLabels')).toBe(false);
    });
  });

  describe('the toast route to it (§5.9)', () => {
    it('answers the label for a live session', () => {
      const h = harness(claudeLike, dir, { prior: card() });
      start(h);
      h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

      expect(h.labelFor('live-1')).toBe(SETTLED);
    });

    it('answers nothing for a session with no card, and never throws', () => {
      const h = harness(claudeLike, dir, { prior: card() });
      expect(() => h.labelFor('live-nobody')).not.toThrow();
      expect(h.labelFor('live-nobody')).toBeUndefined();
    });
  });

  it('a snapshot that has ingested nothing changes no label', () => {
    // The zeroed snapshot a /clear or a corrected mis-bind installs. It says
    // nothing about usage and it says nothing about the title either.
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);

    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED, lines: 0 });

    expect(stored(h).taskLabel).toBeUndefined();
  });

  it('carries the label back to the card on a restart', () => {
    // The persisted half: a suspended card handed back to a remounting panel.
    const h = harness(claudeLike, dir, { prior: card() });
    start(h);
    h.fireSnapshot({ sessionId: 'live-1', title: SETTLED });

    const again = harness(claudeLike, dir, { prior: stored(h) });
    const rec = again.call('sessions:create', {
      cardId: 'card-1',
      folder: dir,
      title: 't',
    }) as { taskLabel?: string };

    expect(rec.taskLabel).toBe(SETTLED);
  });
});
