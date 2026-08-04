// P2-E18-02 — the transport seam.
//
// The item's own acceptance criterion is that EXISTING tests pass unedited;
// these are the ones that would fail if the seam were wired wrongly. They are
// deliberately about routing and nothing else — there is still exactly one
// transport implementation, and proving that is most of the point.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions, SpawnRecipe } from '../extensibility/contributions';
import {
  SessionTransport,
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
