// P2-E11-02 done-when check: the COMPILED bus server really speaks MCP over
// real pipes, launched by the real Electron binary, against a real host
// endpoint. Exits 0 on PASS, 1 on FAIL.
//
// The protocol, the framing, the rendering and the host's auth are unit-tested
// in `*.test.ts` without spawning, because the CI unit job does not run a
// build. This file covers the four things those cannot:
//
//   1. ELECTRON-AS-NODE ACTUALLY WORKS. #760 left this explicitly UNPROVEN —
//      its probe spawned plain Node, so what was measured was the mechanism
//      (an env block reaches the child), not the thing. This spawns
//      `process.execPath` under `ELECTRON_RUN_AS_NODE`, which is the real
//      launcher (`launch.ts`), and if that is wrong nothing here works at all.
//   2. THE REAL ENDPOINT round-trips — a named pipe on Windows and, when this
//      runs on the Linux CI runner, a UNIX DOMAIN SOCKET. That path is written
//      in #760's probe and was never once executed; the findings note lists it
//      under "what is NOT proven". This is where it stops being unproven.
//   3. A DEAD HOST fails the call cleanly and FAST. Asserted with a clock, not
//      by inspection, because "never hangs" is a claim about time.
//   4. `initialize` IS ANSWERED WITH NOTHING LISTENING. This is the ~32-second
//      finding as a test: a server that starts and never speaks MCP moves a
//      session's first token from 3.0 s to 35.2 s.
//
// UNLIKE `check:adapter` / `check:hooks` / `check:transcripts`, this needs no
// model, no `claude` binary and no login — it drives our own server over our
// own stdio — so it runs in CI on both operating systems rather than being
// LOCAL_ONLY (#182). That is what makes point 2 above happen automatically.
//
// Run with: npm run check:bus   (after npm run build)
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BusHost } from './host-channel';
import { busLaunch, busServerPath } from './launch';
import { LineReader } from './protocol';
import { BUS_SERVER_NAME } from './bus-paths';
import type { SessionSummary } from '../sessions/queries';

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(label);
  console.log(`[bus-check] ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** A logger that prints, so a failing check in CI says why on the same stream. */
const log = {
  debug: () => {},
  info: (m: string, f?: unknown) => console.log(`[bus-check]      ${m}`, f ?? ''),
  warn: (m: string, f?: unknown) => console.log(`[bus-check] warn ${m}`, f ?? ''),
  error: (m: string, f?: unknown) => console.log(`[bus-check] ERR  ${m}`, f ?? ''),
  child: () => log,
} as unknown as import('../log/logger').Logger;

const SESSIONS: SessionSummary[] = [
  { id: 'sb-caller', name: 'Switchboard', folder: '/projects/switchboard', providerId: 'claude-code', status: 'working' },
  { id: 'sb-other', name: 'PropaneMon', folder: '/projects/propanemon', providerId: 'claude-code', status: 'idle' },
];

/** Drives one child over its stdio, one JSON-RPC request at a time. */
class Peer {
  private readonly reader = new LineReader();
  private readonly waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  private nextId = 1;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.reader.feed(chunk)) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = typeof msg.id === 'number' ? msg.id : -1;
        const resolve = this.waiting.get(id);
        if (resolve) {
          this.waiting.delete(id);
          resolve(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no reply to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
}

/** Every child we spawn, so no failure path leaves an Electron process on the
 *  runner. A timed-out `peer.request` used to orphan one. */
const spawned: ChildProcess[] = [];

function killSpawned(): void {
  for (const c of spawned) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

function spawnChild(sessionId: string, pipePath: string, tokenPath: string): ChildProcess {
  const recipe = busLaunch(sessionId, { pipePath, tokenPath });
  console.log(`[bus-check]      spawning ${recipe.command} (ELECTRON_RUN_AS_NODE=1)`);
  const child = spawn(recipe.command, recipe.args, {
    env: { ...process.env, ...recipe.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => process.stderr.write(d));
  spawned.push(child);
  return child;
}

/** Text of a tools/call result, whatever shape it came back in. */
function resultText(msg: Record<string, unknown>): string {
  const result = msg.result as { content?: { text?: unknown }[] } | undefined;
  return result?.content?.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n') ?? '';
}

function isError(msg: Record<string, unknown>): boolean {
  return (msg.result as { isError?: boolean } | undefined)?.isError === true;
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-check-'));
  const host = new BusHost({ stateDir, log, queries: { listSessions: () => ({ ok: true, value: SESSIONS }) } });
  const sessionId = 'sb-caller';
  const endpoint = await host.registerSession(sessionId);
  console.log(`[bus-check]      endpoint ${endpoint.pipePath}`);
  check('the token is a file, not an argument (S-03)', fs.existsSync(endpoint.tokenPath));

  // ── the boundary, asserted against the BUILT ARTIFACT ────────────────────
  //
  // `bus-tools.test.ts` walks the import graph, which is the right check at
  // source level. This is the one that cannot be fooled by a re-export, a
  // dynamic `import()`, or a new file nobody added to a list: the bundle is
  // what actually runs in a process the agent's CLI spawns, and if the query
  // core or Electron got in, they are in here as text.
  const bundle = fs.readFileSync(busServerPath(), 'utf8');
  check('the built child bundle does not require electron', !/require\(["']electron["']\)/.test(bundle));
  check('…and does not carry the session query core', !bundle.includes('SessionQueries'));
  check('…and does not carry node-pty', !bundle.includes('node-pty'));

  const child = spawnChild(sessionId, endpoint.pipePath, endpoint.tokenPath);
  const peer = new Peer(child);

  // ── the handshake ────────────────────────────────────────────────────────
  const init = await peer.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'bus-check', version: '0.0.0' },
  });
  const initResult = init.result as Record<string, unknown> | undefined;
  const serverInfo = initResult?.serverInfo as { name?: string } | undefined;
  check('initialize is answered under ELECTRON_RUN_AS_NODE', !!initResult);
  check(`serverInfo names us "${BUS_SERVER_NAME}"`, serverInfo?.name === BUS_SERVER_NAME, String(serverInfo?.name));
  check('the proposed protocolVersion is echoed', initResult?.protocolVersion === '2025-11-25');
  peer.notify('notifications/initialized');

  const list = await peer.request('tools/list');
  const tools = (list.result as { tools?: { name?: string }[] } | undefined)?.tools ?? [];
  check('tools/list offers exactly list_sessions', tools.length === 1 && tools[0]?.name === 'list_sessions',
    tools.map((t) => String(t.name)).join(','));

  // ── the round trip, over a real endpoint ─────────────────────────────────
  const called = await peer.request('tools/call', { name: 'list_sessions', arguments: {} });
  const text = resultText(called);
  check('tools/call round-trips through the host', !isError(called), text);
  check('the sibling session is in the answer', text.includes('PropaneMon'), text);
  check('the caller is marked as itself', text.includes('(this session)'), text);

  // ── a dead host: clean, readable, and FAST ───────────────────────────────
  //
  // THE TOKEN IS PUT BACK ON PURPOSE. `unregisterSession` takes the endpoint
  // AND the token file down together, so tearing it down and calling straight
  // away exercises the token-missing branch — which fails inside the child
  // before it ever attempts a connection. The first version of this check did
  // exactly that and reported a passing dead-host test that had never touched
  // the dead-host path. Restoring the file reproduces the case that actually
  // matters: the app crashed, the endpoint is gone, the file it wrote lingers.
  const savedToken = fs.readFileSync(endpoint.tokenPath, 'utf8');
  host.unregisterSession(sessionId);
  // ASSERTED HERE, before the file is put back. The first version checked this
  // at the END of the section — after a deliberate `rmSync` — so it was
  // asserting its own cleanup rather than `unregisterSession`, and could not
  // fail. Exactly the trap the comment above congratulates itself for catching.
  check('the token file is gone once the session is unregistered', !fs.existsSync(endpoint.tokenPath));
  fs.mkdirSync(path.dirname(endpoint.tokenPath), { recursive: true });
  fs.writeFileSync(endpoint.tokenPath, savedToken);

  const t0 = Date.now();
  const afterDeath = await peer.request('tools/call', { name: 'list_sessions', arguments: {} });
  const elapsed = Date.now() - t0;
  const deadText = resultText(afterDeath);
  check('a dead host answers rather than hanging', !!afterDeath.result, deadText);
  check('…and says so as readable isError content', isError(afterDeath), deadText);
  check('…having really tried the endpoint, not failed on the token first',
    /could not reach the switchboard host/.test(deadText), deadText);
  check('…with advice the agent can act on', /Continue without it/.test(deadText), deadText);
  // The #760 correction, at the surface a model actually reads: ENOENT is a
  // Windows named-pipe fact and ECONNREFUSED a unix-socket one. Neither belongs
  // in front of the agent, which would go hunting for a file that never existed.
  check('…and no platform errno reaches the model',
    !/ENOENT|ECONNREFUSED|EACCES/.test(deadText), deadText);
  check(`…and returns promptly (${elapsed}ms)`, elapsed < 10_000, `${elapsed}ms`);

  // …and the OTHER cause, reported as itself rather than as unreachability.
  fs.rmSync(endpoint.tokenPath, { force: true });
  const noToken = resultText(await peer.request('tools/call', { name: 'list_sessions', arguments: {} }));
  check('a missing token is reported as a token fault, not a reachability one',
    /could not read the session token/.test(noToken) && !/not reachable/.test(noToken), noToken);
  check('…and no platform errno reaches the model', !/ENOENT|ECONNREFUSED|EACCES/.test(noToken), noToken);

  child.stdin?.end();

  // ── the ~32-second finding, inverted into an assertion ───────────────────
  // A server whose host never existed must STILL complete the handshake
  // immediately. If anything blocking ever creeps ahead of `initialize`, this
  // is the check that reddens.
  const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-orphan-'));
  const orphanToken = path.join(orphanDir, 'bus-token');
  fs.writeFileSync(orphanToken, 'not-a-real-token');
  const orphan = spawnChild('sb-orphan', deadEndpoint(), orphanToken);
  const orphanPeer = new Peer(orphan);
  const t1 = Date.now();
  const orphanInit = await orphanPeer.request('initialize', { protocolVersion: '2025-11-25' }, 15_000);
  const handshakeMs = Date.now() - t1;
  check('initialize is answered with NOTHING listening on the pipe', !!orphanInit.result);
  check(`…and it does not wait on the pipe to do it (${handshakeMs}ms)`, handshakeMs < 5_000, `${handshakeMs}ms`);
  orphan.stdin?.end();

  host.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(orphanDir, { recursive: true, force: true });
}

/** An endpoint name of the right shape that nothing is listening on. */
function deadEndpoint(): string {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\switchboard-bus-deadbeef0000'
    : path.join(os.tmpdir(), 'sb-bus-deadbeef0000.sock');
}

main().then(
  () => {
    killSpawned();
    console.log(failures.length === 0 ? '[bus-check] PASS' : `[bus-check] FAIL: ${failures.join('; ')}`);
    process.exit(failures.length === 0 ? 0 : 1);
  },
  (err) => {
    killSpawned();
    console.error('[bus-check] threw:', err);
    process.exit(1);
  }
);
