// P2-E18-02 — the transport seam.
//
// The item's own acceptance criterion is that EXISTING tests pass unedited;
// these are the ones that would fail if the seam were wired wrongly. They are
// deliberately about routing and nothing else — there is still exactly one
// transport implementation, and proving that is most of the point.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager, type SessionRecord } from './session-manager';
// TYPE-ONLY, and it must stay that way: `preload/index.ts` calls
// `contextBridge.exposeInMainWorld` at import time and there is no
// contextBridge in a vitest process. `import type` is erased entirely.
import type { SessionRecordDto } from '../../preload/index';
import type { SessionRecordWire, SessionStatus } from '../../shared/sessions';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions, SpawnRecipe } from '../extensibility/contributions';
import {
  DEFAULT_SESSION_TRANSPORT,
  DEFAULT_TRANSPORT,
  SessionTransport,
  TransportKind,
  TransportSpawnOptions,
  UnknownTransportError,
} from '../transport/transport';
import { buildEnv as buildEnvFromPty } from '../pty/pty-service';
import { buildEnv as buildEnvShared } from '../transport/env';
import { LogSink, createLogger } from '../log/logger';

class RecordingTransport implements SessionTransport {
  spawned: TransportSpawnOptions[] = [];
  removed: string[] = [];
  spawn(opts: TransportSpawnOptions) {
    this.spawned.push(opts);
    return { pid: 4242, onExit: () => () => {}, kill: () => {} };
  }
  remove(id: string): void {
    this.removed.push(id);
  }
}

function registryWith(recipe: Partial<SpawnRecipe>): ContributionRegistry<MainContributions> {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: () => ({ command: 'cli', args: [], env: {}, ...recipe }),
  });
  return r;
}

let dir: string;
let pty: RecordingTransport;
let stream: RecordingTransport;
beforeEach(() => {
  dir = tempDir('sb-seam-');
  pty = new RecordingTransport();
  stream = new RecordingTransport();
});
afterEach(() => cleanupTempDirs()); // one per test, gone at the end of it (#213)

function manager(recipe: Partial<SpawnRecipe>, withStream = false): SessionManager {
  const sink = new LogSink({ dir });
  return new SessionManager(
    registryWith(recipe),
    pty,
    createLogger(sink, 'sessions'),
    dir,
    withStream ? { stream } : undefined
  );
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };

describe('transport seam (P2-E18-02)', () => {
  it('a recipe that says nothing still spawns on the PTY — the pre-E18 default', () => {
    const mgr = manager({});
    const rec = mgr.create(identity);

    expect(pty.spawned).toHaveLength(1);
    expect(stream.spawned).toHaveLength(0);
    expect(rec.transport).toBe('pty');
  });

  it('an explicit pty recipe is the same path (the field is not load-bearing yet)', () => {
    const mgr = manager({ transport: 'pty' });
    expect(mgr.create(identity).transport).toBe('pty');
    expect(pty.spawned).toHaveLength(1);
  });

  // THE item. A silent fallback here would hand a stream-json adapter a
  // terminal and surface hours later as garbled output or a session that never
  // answers a permission request.
  it('a recipe asking for an unimplemented transport THROWS rather than getting a PTY', () => {
    const mgr = manager({ transport: 'stream' });

    expect(() => mgr.create(identity)).toThrow(UnknownTransportError);
    expect(pty.spawned).toHaveLength(0);
  });

  it('the throw names the transport, the provider, and what IS available', () => {
    const mgr = manager({ transport: 'stream' });
    let err: unknown;
    try {
      mgr.create(identity);
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error).message);
    expect(msg).toContain('stream');
    expect(msg).toContain('fake');
    expect(msg).toContain('pty');
  });

  it('a failed transport resolution leaves NO session record', () => {
    const mgr = manager({ transport: 'stream' });
    expect(() => mgr.create(identity)).toThrow();

    // same contract as the "no provider adapter" throw it sits beside: the
    // record is never added, so nothing has to be cleaned up
    expect(mgr.list()).toHaveLength(0);
  });

  it('a registered transport receives the spawn, and the PTY does not', () => {
    const mgr = manager({ transport: 'stream' }, true);
    const rec = mgr.create(identity);

    expect(stream.spawned).toHaveLength(1);
    expect(pty.spawned).toHaveLength(0);
    expect(rec.transport).toBe('stream');
    expect(stream.spawned[0].cwd).toBe(identity.folder);
  });

  // Revert-proof: routing kill() through the default instead of the record's
  // own transport passes every other test in this file and leaves stream
  // sessions un-killable.
  it('kill() reaches the transport that SPAWNED the session, not the default', () => {
    const mgr = manager({ transport: 'stream' }, true);
    const rec = mgr.create(identity);

    mgr.kill(rec.id);

    expect(stream.removed).toEqual([rec.id]);
    expect(pty.removed).toHaveLength(0);
  });

  // The teardown moved INTO remove() in this item. Before, `sessions/ipc.ts`
  // called `ptys.remove(id)` itself — which tears down nothing at all for a
  // session hosted anywhere but the PTY, i.e. a leaked child process nobody
  // would notice until the count grew.
  it('remove() tears the process down through the right transport', () => {
    const mgr = manager({ transport: 'stream' }, true);
    const rec = mgr.create(identity);

    mgr.remove(rec.id);

    expect(stream.removed).toEqual([rec.id]);
    expect(pty.removed).toHaveLength(0);
    expect(mgr.get(rec.id)).toBeUndefined();
  });

  // The ordering inside remove() is load-bearing and looks arbitrary: the
  // record is deleted BEFORE the teardown because a transport's remove() fires
  // onExit synchronously and apply() drops events for sessions it no longer
  // knows. Swap the two lines and closing a card pushes a starting -> exited
  // transition into history and notifies every status listener about a session
  // the user just closed.
  //
  // Note what this does NOT claim: the exit LISTENERS still fire either way —
  // they live in the onExit closure and never consult the map. That was true
  // before this item too. (Asserted the wrong one of these first; the test
  // caught it, which is the entire argument for writing it.)
  it('remove() emits no status transition — the card is closed, not exited', () => {
    const statuses: string[] = [];
    const sink = new LogSink({ dir });
    // a transport whose remove() synchronously fires onExit, like a real one
    const eager: SessionTransport = {
      spawn: (opts: TransportSpawnOptions) => {
        const ls: Array<(c: number) => void> = [];
        eagerExit.set(opts.id, ls);
        return {
          pid: 1,
          onExit: (l: (c: number) => void) => {
            ls.push(l);
            return () => {};
          },
          kill: () => {},
        };
      },
      remove: (id: string) => eagerExit.get(id)?.forEach((l) => l(0)),
    };
    const eagerExit = new Map<string, Array<(c: number) => void>>();
    const mgr = new SessionManager(registryWith({}), eager, createLogger(sink, 'sessions'), dir);
    const rec = mgr.create(identity);
    mgr.onStatusChange((c) => statuses.push(`${c.from}->${c.to}`));

    mgr.remove(rec.id);

    expect(statuses).toEqual([]);
    expect(mgr.transitions(rec.id)).toEqual([]);
  });
});

// P2-E18-17 — the ADAPTER ANSWERS, the caller only ASKS (P2-E18-08a).
//
// The #404 audit's first finding: `recipe.transport ?? DEFAULT_TRANSPORT` had
// zero coverage across 42 `create()` call sites, and it is the one line keeping
// the promise `SpawnOptions.transport` documents — "a request, not an order".
// Every caller in the app now passes a request (`sessions:create` sends the
// card's choice, the env override, or Direct), so if the request could win, a
// terminal-only CLI would be handed stream-json the moment anybody's card said
// `stream`.
describe('a transport REQUEST loses to the adapter’s answer (P2-E18-17)', () => {
  /** an adapter that records what it was ASKED for and answers `recipe` */
  function recordingRegistry(
    recipe: Partial<SpawnRecipe>,
    asked: Array<TransportKind | undefined>
  ): ContributionRegistry<MainContributions> {
    const r = new ContributionRegistry<MainContributions>();
    r.register('provider-adapter', {
      manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
      buildSpawn: (o) => {
        asked.push(o.transport);
        return { command: 'cli', args: [], env: {}, ...recipe };
      },
    });
    return r;
  }

  function managerFor(
    recipe: Partial<SpawnRecipe>,
    asked: Array<TransportKind | undefined>
  ): SessionManager {
    const sink = new LogSink({ dir });
    // BOTH transports registered on purpose: a request that won would then
    // spawn on the wrong one instead of throwing, which is the failure this
    // pins. A throw would have been caught by the P2-E18-02 tests above.
    return new SessionManager(recordingRegistry(recipe, asked), pty, createLogger(sink, 'sessions'), dir, {
      stream,
    });
  }

  it('the request DOES reach the adapter — it is how the adapter can answer at all', () => {
    const asked: Array<TransportKind | undefined> = [];
    managerFor({ transport: 'stream' }, asked).create(identity, { transport: 'stream' });

    expect(asked).toEqual(['stream']);
  });

  // The pre-E18 adapter: it has never heard of the field, so its recipe says
  // nothing, and silence from an ADAPTER means the PTY. Ask it for stream and
  // it still gets a terminal.
  it('a PTY-only adapter asked for stream spawns on the PTY anyway', () => {
    const asked: Array<TransportKind | undefined> = [];
    const rec = managerFor({}, asked).create(identity, { transport: 'stream' });

    expect(rec.transport).toBe('pty');
    expect(pty.spawned).toHaveLength(1);
    expect(stream.spawned).toHaveLength(0);
  });

  it('an adapter that answers `pty` outright is honoured the same way', () => {
    const asked: Array<TransportKind | undefined> = [];
    const rec = managerFor({ transport: 'pty' }, asked).create(identity, { transport: 'stream' });

    expect(rec.transport).toBe('pty');
    expect(stream.spawned).toHaveLength(0);
  });

  // The other direction, so this is a pin on "the answer decides" and not on
  // "the PTY always wins": an adapter that answers `stream` gets stream even
  // though the caller asked for a terminal. Sounds surprising until you read it
  // as the contract it is — the adapter knows what its CLI can be driven with,
  // and a provider whose only mode is stream-json has no PTY recipe to give.
  it('an adapter answering `stream` beats a request for `pty`', () => {
    const asked: Array<TransportKind | undefined> = [];
    const rec = managerFor({ transport: 'stream' }, asked).create(identity, { transport: 'pty' });

    expect(asked).toEqual(['pty']);
    expect(rec.transport).toBe('stream');
    expect(stream.spawned).toHaveLength(1);
    expect(pty.spawned).toHaveLength(0);
  });

  it('no request at all is still the adapter’s answer, not the caller’s default', () => {
    const asked: Array<TransportKind | undefined> = [];
    const rec = managerFor({ transport: 'stream' }, asked).create(identity);

    expect(asked).toEqual([undefined]);
    expect(rec.transport).toBe('stream');
  });
});

// P2-E18-17 — the two defaults are two DIFFERENT claims, and collapsing them
// is a one-word change that no other test in the repo notices.
//
// `DEFAULT_TRANSPORT` is what an ADAPTER's silence means; `DEFAULT_SESSION_
// TRANSPORT` is what a USER's silence means. Reading an adapter's silence as
// "stream" hands a terminal-only CLI a protocol it cannot answer — the exact
// failure the tests above spend their time on — so this is pinned as a VALUE
// and as an inequality: the day the user-facing default moves again, only the
// second assertion stops someone "tidying up" the two into one constant.
describe('DEFAULT_TRANSPORT vs DEFAULT_SESSION_TRANSPORT (P2-E18-17)', () => {
  it("an adapter's silence means the PTY, and must keep meaning it", () => {
    expect(DEFAULT_TRANSPORT).toBe('pty');
  });

  it("...which is NOT what a user's silence means", () => {
    expect(DEFAULT_SESSION_TRANSPORT).toBe('stream'); // named, so the diff explains itself if it moves
    expect(DEFAULT_TRANSPORT).not.toBe(DEFAULT_SESSION_TRANSPORT);
  });
});

// #445 / #590 — one contract, one declaration.
//
// The preload DTO USED to be a hand-written mirror of `SessionRecord`: nothing
// compiled the two against each other, because they live on opposite sides of
// an IPC boundary that carries JSON. So the mirror drifted silently, and the
// drift had a cost the day a field went optional on one side only —
// `transport?` in the DTO made every renderer that read it answer "and if it
// is missing?", and SessionGrid's answer was `'pty'`: a second default for the
// same contract, contradicting `DEFAULT_SESSION_TRANSPORT` above, and one that
// would have rendered Terminal-mode UI for a session spawned on Direct.
//
// #445 pinned that one field. #590 deleted the mirror: `SessionRecordWire` in
// `shared/sessions.ts` is the single declaration of what crosses IPC, main's
// `SessionRecord` EXTENDS it, and the preload's `SessionRecordDto` IS it. The
// assertions below are what is left to check once there is only one copy —
// that nobody puts the copy back, and that a new field on the record is a
// decision instead of an accident.
//
// These are TYPECHECK gates, not runtime ones — the assignments fail `tsc`,
// and the `expect`s exist only so `noUnusedLocals` keeps the locals alive.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The keys `SessionRecord` adds to the wire shape — main's own bookkeeping,
 * deliberately NOT sent to the renderer.
 *
 * Named here so the key-set assertion below reads as a claim rather than a
 * literal soup: everything on the record is either published or on this list.
 */
type MainOnlyRecordKeys = 'autonomy' | 'killRequested';

describe('the live record and its DTO cannot drift (#445, #590)', () => {
  it('is required on the record — a spawned session is always ON something', () => {
    const required: Exact<SessionRecord['transport'], TransportKind> = true;
    expect(required).toBe(true);
  });

  it('...and the DTO says exactly the same thing, so no reader can default it', () => {
    // If this stops compiling, do NOT re-add `?? DEFAULT_SESSION_TRANSPORT` in
    // the renderer — fix whichever side went optional. A live record with no
    // transport is a main-process bug, not a UI default.
    const mirrored: Exact<SessionRecordDto['transport'], SessionRecord['transport']> = true;
    expect(mirrored).toBe(true);
  });

  it('the DTO IS the shared wire shape — not a copy of it', () => {
    // Fails the moment someone re-inlines the fields into `preload/index.ts`,
    // which is exactly how #445 happened. The fix is an alias, not a copy that
    // happens to agree today.
    const derived: Exact<SessionRecordDto, SessionRecordWire> = true;
    expect(derived).toBe(true);
  });

  it("status carries main's union, not `string`", () => {
    // It said `string` in the preload until #590 — looser than the record and
    // silently so, which let the renderer compare against statuses that no
    // state machine can produce.
    const union: Exact<SessionRecordDto['status'], SessionStatus> = true;
    expect(union).toBe(true);
  });

  it('every field of the record is either published or deliberately main-only', () => {
    // The drift-pin proper. Add a field to `SessionRecord` and this stops
    // compiling until you say which side it belongs on: on the wire (move it
    // to `SessionRecordWire` and the renderer can see it) or main's alone (add
    // it to `MainOnlyRecordKeys` above). Optional fields count — an optional
    // one that slipped through is how a shape drifts without ever failing a
    // runtime test.
    const accountedFor: Exact<keyof SessionRecord, keyof SessionRecordWire | MainOnlyRecordKeys> =
      true;
    expect(accountedFor).toBe(true);
  });
});

describe('the S-01 env scrub is shared, not copied (P2-E18-02)', () => {
  // A second copy of SCRUB_ALWAYS is how "both transports behave the same"
  // stops being true without anything failing. Identity, not equality.
  it('pty-service re-exports the shared buildEnv rather than defining its own', () => {
    expect(buildEnvFromPty).toBe(buildEnvShared);
  });

  it('still scrubs the S-01 landmines through the old import path', () => {
    const env = buildEnvFromPty({
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      KEEP: 'x',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.KEEP).toBe('x');
  });
});
