// P2-E11-03: `BusHost.attachSession` — the synchronous seam that lets a bus be
// attached from inside a spawn path that must not await.
//
// The two things worth proving here are both about the SHAPE of the call rather
// than its return value: that it starts a real endpoint without being waited
// on, and that the addresses it hands the CLI are the addresses the host is
// really listening on. The second is the one that would fail invisibly — a
// config naming one path while the listener binds another produces a bus tool
// that times out, with both halves individually looking correct.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { BusHost } from './host-channel';
import { stubDelivery, stubQueries } from './fixtures/queries';
import { busEndpointFor, busPipePath, busTokenPath, BUS_TOKEN_FILE } from './bus-paths';
import type { Logger } from '../log/logger';
import type { SessionSummary } from '../sessions/queries';

const SESSIONS: SessionSummary[] = [
  { id: 'sb-a', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working', exited: false },
];

function fakeLog(): Logger {
  const l: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): Logger => l,
  };
  return l;
}

let stateDir: string;
let log: Logger;
let host: BusHost;
/**
 * A session id no other test in this file uses.
 *
 * The endpoint name is a digest of the SESSION ID ALONE — deliberately, since
 * `<stateDir>/<uuid>/bus.sock` overruns `sun_path` on macOS (`bus-paths.ts`) —
 * so it is process-global, not scoped to this test's temp dir. Reusing one id
 * across tests made the second `listen` fail with EADDRINUSE against the first
 * test's socket, which `server.close()` had not finished releasing.
 *
 * That is not a quirk of the test: it is the same fact `unregisterSession`'s
 * socket-file cleanup exists for on posix, seen from the other side.
 */
let nextId = 0;
const sid = (): string => `sb-attach-${process.pid}-${++nextId}`;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-attach-'));
  log = fakeLog();
  host = new BusHost({
    stateDir,
    log,
    queries: stubQueries({ listSessions: () => ({ ok: true, value: SESSIONS }) }),
    delivery: stubDelivery(),
    // Under vitest only the TypeScript exists, so the real resolver correctly
    // finds no compiled `bus-server.js` and throws. Without this seam every
    // test below would silently exercise the "no server" branch while reading
    // as if it covered the attach path — an unrun assertion wearing a passing
    // test's clothes (#762's `runIf` lesson).
    busServerPath: path.join(stateDir, 'bus-server.js'),
  });
});

afterEach(() => {
  host.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Wait for the registration `attachSession` kicked off.
 *
 * `registerSession` hands back the IN-FLIGHT promise for a session that is
 * already opening (that memo is #762's fix for overlapping registrations), so
 * calling it here joins the attach rather than starting a second one — which
 * makes this both the wait and a small proof of the idempotency.
 *
 * Deliberately NOT `setImmediate`: `listen` resolves on a libuv callback, not a
 * microtask or a check-phase tick, and a test that waited one tick would assert
 * against an endpoint that is merely usually up by then. That is the shape of
 * flake #768 is, and it is avoidable here.
 */
const attached = (id: string): Promise<unknown> => host.registerSession(id);

/**
 * One turn of the loop — for the FAILURE tests only.
 *
 * Where `registerSession` is mocked to reject there is no endpoint to wait for
 * and `attached()` would reject in the test's face; what is being waited on is
 * `attachSession`'s own `.catch` handler, which is a microtask. Two of these in
 * a row is not superstition: the rejection settles on one, the handler runs on
 * the next.
 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('busEndpointFor — one derivation, two callers (P2-E11-03)', () => {
  it('is pure: same inputs, same answer, no filesystem', () => {
    // Purity is what lets the config be written before anything is listening,
    // which is what lets the spawn path stay synchronous.
    const a = busEndpointFor('/state', 'sess-1');
    const b = busEndpointFor('/state', 'sess-1');
    expect(a).toEqual(b);
    expect(a.pipePath).toBe(busPipePath('sess-1'));
    expect(a.tokenPath).toBe(busTokenPath('/state', 'sess-1'));
  });

  it('forwards the PathEnvironment it was given', () => {
    // The parameter is accepted and passed on to `busPipePath`; nothing
    // exercised it, so dropping the forwarding survived (review of #763). The
    // signature would then lie, and the next caller injecting a platform gets
    // the host's own instead — which on a Linux CI runner means Windows pipe
    // names, i.e. the exact cross-platform bug the parameter exists to test.
    const linux = busEndpointFor('/state', 'sess-1', { platform: 'linux', tmpDir: '/tmp' });
    expect(linux.pipePath).toBe(busPipePath('sess-1', { platform: 'linux', tmpDir: '/tmp' }));
    expect(linux.pipePath.startsWith('/tmp/')).toBe(true);
    const win = busEndpointFor('/state', 'sess-1', { platform: 'win32' });
    expect(win.pipePath.startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(win.pipePath).not.toBe(linux.pipePath);
  });

  it('gives different sessions different endpoints', () => {
    // One endpoint per session is what stops a child addressing a sibling's
    // (§5.4). If this ever collapsed, the token check would be the only thing
    // left between two sessions' transcripts.
    const a = busEndpointFor('/state', 'sess-1');
    const b = busEndpointFor('/state', 'sess-2');
    expect(a.pipePath).not.toBe(b.pipePath);
    expect(a.tokenPath).not.toBe(b.tokenPath);
  });
});

describe('BusHost.attachSession (P2-E11-03)', () => {
  it('answers synchronously — the caller never awaits', () => {
    // `SessionManager.create` is synchronous end to end and has to stay that
    // way. This is the assertion that stops someone "tidying" attachSession
    // into an async function and quietly making create() async with it.
    const launch = host.attachSession(sid());
    expect(launch).not.toBeNull();
    expect(launch).not.toBeInstanceOf(Promise);
    // `process.execPath`, pinned rather than merely "a string" — a mutant
    // returning a doctored command survived the looser assertion. In main this
    // IS the Electron binary, which is the only thing that can run the server
    // out of `app.asar` (#762).
    expect(launch!.command).toBe(process.execPath);
    expect(launch!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('names the SAME paths the host then listens on', () => {
    // THE INVARIANT THIS ITEM IS MOST LIKELY TO BREAK LATER. The launch is
    // built before the listener exists, so nothing about the two agreeing is
    // enforced by the runtime — only by both going through `busEndpointFor`.
    const id = sid();
    const launch = host.attachSession(id)!;
    const pipeArg = launch.args[launch.args.indexOf('--pipe') + 1];
    const tokenArg = launch.args[launch.args.indexOf('--token-file') + 1];
    const derived = busEndpointFor(stateDir, id);
    expect(pipeArg).toBe(derived.pipePath);
    expect(tokenArg).toBe(derived.tokenPath);
  });

  it('puts the token PATH on argv and never the token', () => {
    // S-03's rule: argv is world-readable on every platform we ship.
    const id = sid();
    const launch = host.attachSession(id)!;
    expect(launch.args).toContain('--token-file');
    expect(launch.args.join(' ')).toContain(BUS_TOKEN_FILE);
    return attached(id).then(() => {
      const token = fs.readFileSync(busTokenPath(stateDir, id), 'utf8').trim();
      expect(token.length).toBeGreaterThan(0);
      // The secret itself appears nowhere in the argv we handed the CLI.
      expect(launch.args.join(' ')).not.toContain(token);
    });
  });

  it('really opens the endpoint, WITHOUT anyone awaiting it', async () => {
    // ⚠️ DELIBERATELY DOES NOT CALL `attached()`. That helper is
    // `host.registerSession`, which opens the endpoint ITSELF — so a version of
    // this test that used it passed even with `void this.registerSession(...)`
    // deleted from `attachSession`, i.e. it proved nothing about the thing it
    // is named after (review of #763). Polling `endpointFor` observes the side
    // effect instead of causing it.
    const id = sid();
    host.attachSession(id);
    const deadline = Date.now() + 5_000;
    while (!host.endpointFor(id) && Date.now() < deadline) await tick();
    expect(host.endpointFor(id), 'attachSession never opened the endpoint').not.toBeNull();
    // A real connection, not `endpointFor` reporting on itself — the claim is
    // that a child could dial this, and only a dial proves it.
    const { pipePath } = busEndpointFor(stateDir, id);
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ path: pipePath });
      sock.on('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', reject);
    });
    expect(host.endpointFor(id)).not.toBeNull();
  });

  it('is idempotent across an in-flight attach', async () => {
    // Two `attachSession` calls in one tick is the restart path (#762's
    // overlapping-registration bug). Both must end up on ONE endpoint with ONE
    // token, or the second overwrites the first's token file and that session
    // answers "not authorized" for the rest of its life.
    const id = sid();
    const a = host.attachSession(id)!;
    const b = host.attachSession(id)!;
    expect(a.args).toEqual(b.args);
    await attached(id);
    expect(host.endpointFor(id)).not.toBeNull();
    expect(fs.existsSync(busTokenPath(stateDir, id))).toBe(true);
  });

  it('STILL RETURNS A LAUNCH when the endpoint fails to open (P6, fail-open)', async () => {
    // #762 made `registerSession` REJECT rather than answer null, and left the
    // fail-open decision to this item on the grounds that only the caller knows
    // whether a session should still start. It should: a session that cannot
    // reach its siblings is enormously better than a session that does not run.
    //
    // Withholding the config would be the tempting alternative and is worse —
    // the bus tools would simply VANISH, and an agent cannot report the absence
    // of something it was never offered. A dead host gives it a readable error
    // instead, which is the path #762 built and timed.
    const id = sid();
    const boom = new Error('listen EADDRINUSE');
    const spy = vi.spyOn(host, 'registerSession').mockRejectedValue(boom);
    const launch = host.attachSession(id);
    expect(launch).not.toBeNull();
    await tick();
    expect(spy).toHaveBeenCalledWith(id);
    // ...and it is not silent, and it names the SESSION. A bus that never
    // opened with nothing in the log is the failure #762's own registration bug
    // hid behind for a whole item — so the log CONTENT is the deliverable here,
    // not the fact that `error` was reached (review of #763).
    // Read the call args directly rather than nesting matchers: the point is
    // that BOTH the session and the cause reach the log, and reading them makes
    // that literal.
    const [message, fields] = vi.mocked(log.error).mock.calls[0] as [string, Record<string, string>];
    expect(message).toContain('bus');
    expect(fields.sessionId).toBe(id);
    expect(fields.error).toContain('EADDRINUSE');
  });

  it('does not take the process down when the endpoint fails to open', async () => {
    // The rejection is handled by a `.catch` on a floating promise. Without it
    // this is an unhandled rejection, which in Electron main is a crash — from
    // a condition (a stale socket file) that is supposed to be survivable.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(host, 'registerSession').mockRejectedValue(new Error('nope'));
    host.attachSession(sid());
    await tick();
    await tick();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('attaches NOTHING, and does not throw, when the compiled server is missing', () => {
    // A broken build rather than a runtime condition — and exactly the case
    // where attaching nothing is right, because there is no server to reach.
    // Writing a config for it would put a permanently-failing MCP server in
    // front of the agent instead of leaving it plainly bus-less.
    //
    // The failure mode this pins is the OTHER one: `busServerPath` throws by
    // design ("a wrong path must fail as a wrong path"), and that throw
    // originates inside `SessionManager.create`, which would turn a missing
    // build artifact into a session that will not start at all — the exact
    // inversion of P6.
    const noServer = new BusHost({
      stateDir,
      log,
      queries: stubQueries({ listSessions: () => ({ ok: true, value: [] }) }),
      delivery: stubDelivery(),
      // Resolve for real: under vitest nothing compiled exists, so this is the
      // genuine missing-server condition rather than a simulated one.
      busServerPath: undefined,
    });
    const registered = vi.spyOn(noServer, 'registerSession');
    expect(noServer.attachSession(sid())).toBeNull();
    // ...and it did NOT open an endpoint for a server that cannot be launched.
    expect(registered).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('a teardown that RACES the open is info, not error', async () => {
    // An ordinary restart calls `unregisterSession` while `openEndpoint` is
    // still awaiting `listen`, and `openEndpoint` then rejects by design. That
    // reached the same `error` branch as a genuine failure, so a normal restart
    // logged "this session has no siblings" at error level (review of #763).
    const id = sid();
    host.attachSession(id);
    host.unregisterSession(id); // lands mid-flight, before `listen` resolves
    const infoCalls = (): unknown[][] => vi.mocked(log.info).mock.calls;
    const deadline = Date.now() + 5_000;
    while (!infoCalls().some((c) => String(c[0]).includes('abandoned')) && Date.now() < deadline) {
      await tick();
    }
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('abandoned'),
      expect.objectContaining({ sessionId: id })
    );
    // ...and NOT as a fault.
    expect(log.error).not.toHaveBeenCalled();
  });
});
