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
// ── AND WHAT #764 ADDED: THE REAL QUERY CORE, NOT A STUB ────────────────────
//
// This used to hand the host `{ listSessions: () => SESSIONS }` — a constant.
// That was enough while `list_sessions` was the only tool, because the thing
// under test was the pipe. It is not enough for the read tools: `#761 → host →
// child → text` is four layers, and a constant at the top proves the bottom
// three while asserting nothing about the join. So the host below is built with
// a **real `SessionQueries`**, over a real temp git repo with a real
// uncommitted change and a real JSONL transcript on disk. What that buys, and
// nothing else in the suite has: the caps are observed against text that really
// came out of the derivation, and `git diff` really runs.
//
// Run with: npm run check:bus   (after npm run build)
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BusHost } from './host-channel';
import { busLaunch, busServerPath } from './launch';
import { LineReader } from './protocol';
import { BUS_SERVER_NAME } from './bus-paths';
import { GitService } from '../git/git-service';
import { DIFF_CHAR_CAP, OUTPUT_CHAR_CAP, SessionQueries } from '../sessions/queries';
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

/**
 * The workspace the real query core is pointed at (#764).
 *
 * `PropaneMon` is the SIBLING the caller reads: a real git repo with a real
 * uncommitted change and a real JSONL transcript. `Switchboard` is the caller
 * and deliberately has neither, so the two "normal, not an error" branches —
 * no transcript, not a repository — are covered by the same run rather than
 * asserted only in unit tests where the file system is a fake.
 */
interface Workspace {
  root: string;
  repo: string;
  transcript: string;
  /** An ordinary directory under no version control at all. */
  notARepo: string;
  /** A real repo whose working tree is CLEAN — the third diff outcome. */
  cleanRepo: string;
}

const SESSIONS: SessionSummary[] = [
  { id: 'sb-caller', name: 'Switchboard', folder: '', providerId: 'claude-code', status: 'working' },
  { id: 'sb-other', name: 'PropaneMon', folder: '', providerId: 'claude-code', status: 'idle' },
  { id: 'sb-tidy', name: 'Tidy', folder: '', providerId: 'claude-code', status: 'idle' },
];

/** One JSONL line the CLI would have written; `deriveIntents` reads these. */
function turn(role: 'user' | 'assistant', text: string, i: number): string {
  return JSON.stringify({
    parentUuid: i === 0 ? null : `u${i - 1}`,
    isSidechain: false,
    type: role,
    message:
      role === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    uuid: `u${i}`,
    timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString(),
  });
}

/**
 * A real repo and a real transcript, both deliberately OVER the caps.
 *
 * Over on purpose: #764's done-when names the caps at the tool edge, and a
 * fixture that fits inside them measures nothing. `DISPLAY_CAPS` bounds one
 * prose block at 20k characters inside the derivation, so a single enormous
 * message would be cut before `OUTPUT_CHAR_CAP` ever saw it — hence several
 * large ones, which is also what a real long session looks like.
 */
function makeWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-ws-'));
  const repo = path.join(root, 'propanemon');
  const notARepo = path.join(root, 'switchboard');
  const cleanRepo = path.join(root, 'tidy');
  for (const d of [repo, notARepo, cleanRepo]) fs.mkdirSync(d);

  // HERMETIC, or the assertions measure this machine's git config as much as
  // our code: `init.templateDir`, global hooks and `diff.external` all reach in
  // otherwise, and `diff.external` is the one `--no-ext-diff` exists to stop.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe', env });
  };
  const init = (dir: string): void => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'bus-check@example.invalid');
    git(dir, 'config', 'user.name', 'bus check');
    git(dir, 'config', 'commit.gpgsign', 'false');
  };

  init(repo);
  fs.writeFileSync(path.join(repo, 'burner.ts'), 'export const psi = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  // The change the sibling is asked about. Long enough to pass DIFF_CHAR_CAP:
  // every line is a distinct addition, so the diff is roughly the file.
  const long = Array.from({ length: 1200 }, (_, i) => `export const reading${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(repo, 'burner.ts'), `export const psi = 2;\n${long}\n`);

  // THE THIRD DIFF OUTCOME, which was only ever asserted against a hand-built
  // payload before (#764 review): a real repository with a clean tree. It is
  // also the outcome the untracked-files wording is about, so it carries an
  // untracked file — committed to nothing, invisible to `git diff`, and exactly
  // the state that used to be reported as "matches the last commit".
  init(cleanRepo);
  fs.writeFileSync(path.join(cleanRepo, 'kept.ts'), 'export const kept = true;\n');
  git(cleanRepo, 'add', '-A');
  git(cleanRepo, 'commit', '-qm', 'initial');
  fs.writeFileSync(path.join(cleanRepo, 'brand-new.ts'), 'export const unseen = true;\n');

  const transcript = path.join(root, 'propanemon.jsonl');
  const bulk = 'x'.repeat(9_000);
  fs.writeFileSync(
    transcript,
    [
      turn('user', 'check the tank pressure', 0),
      turn('assistant', `THE-OLDEST-LINE ${bulk}`, 1),
      turn('assistant', `filler ${bulk}`, 2),
      turn('assistant', `filler ${bulk}`, 3),
      turn('assistant', 'THE-NEWEST-LINE: the regulator is the fault', 4),
    ].join('\n') + '\n'
  );
  return { root, repo, transcript, notARepo, cleanRepo };
}

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
  const ws = makeWorkspace();
  SESSIONS[0].folder = ws.notARepo;
  SESSIONS[1].folder = ws.repo;
  SESSIONS[2].folder = ws.cleanRepo;
  // THE REAL QUERY CORE (#764), not a constant — see the header. This is the
  // same construction `main/index.ts` performs, with the same three dependencies
  // wired the same way round, which is the closest an automated check gets to
  // the production object graph without booting Electron.
  const queries = new SessionQueries({
    list: () => SESSIONS,
    transcriptFor: (id) => (id === 'sb-other' ? ws.transcript : null),
    git: new GitService(),
  });
  const host = new BusHost({ stateDir, log, queries });
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
  const toolNames = tools.map((t) => String(t.name)).sort().join(',');
  check('tools/list offers the three read tools', toolNames === 'get_session_diff,get_session_output,list_sessions',
    toolNames);

  // ── the round trip, over a real endpoint ─────────────────────────────────
  const called = await peer.request('tools/call', { name: 'list_sessions', arguments: {} });
  const text = resultText(called);
  check('tools/call round-trips through the host', !isError(called), text);
  check('the sibling session is in the answer', text.includes('PropaneMon'), text);
  check('the caller is marked as itself', text.includes('(this session)'), text);

  // ── #764: the read tools, through the REAL query core ────────────────────
  //
  // Everything below runs against a real repo and a real transcript on disk, so
  // a passing line here means `#761 → host → child → text` joined up — not that
  // four layers each work against a fake of the next.
  const out = await peer.request('tools/call', {
    name: 'get_session_output',
    arguments: { session: 'PropaneMon' },
  });
  const outText = resultText(out);
  check('get_session_output round-trips', !isError(out), outText.slice(0, 200));
  check('…and returns the sibling’s NEWEST work', outText.includes('THE-NEWEST-LINE'), outText.slice(-200));
  // THE CAP, AT THE TOOL EDGE — the done-when, asserted against text that
  // really came out of the derivation rather than a hand-built string. The
  // header adds a couple of hundred characters on top of the query core's cap.
  // TWO-SIDED ON PURPOSE (#764 review). An upper bound alone proves "not too
  // big", which a renderer returning its last 500 characters also satisfies —
  // and every other assertion in this block would have stayed green under it.
  // The lower bound is what proves the cap is being FILLED. The slack above is
  // the header we add on top of the query core's cap.
  check(`…observing OUTPUT_CHAR_CAP (${outText.length} chars)`,
    outText.length < OUTPUT_CHAR_CAP + 800 && outText.length > OUTPUT_CHAR_CAP - 2_000,
    `${outText.length} vs cap ${OUTPUT_CHAR_CAP}`);
  check('…and saying so, rather than silently handing over a fragment',
    /Earlier activity was left out/.test(outText), outText.slice(0, 200));
  check('…keeping the NEWEST end, not the oldest', !outText.includes('THE-OLDEST-LINE'));

  // `lastN` really reaches the query core. Threaded through four hops —
  // model → child → pipe → `sessionOutput` — and #762's comment flagged this as
  // the first argument any of them could silently drop.
  const outputFor = async (lastN: number): Promise<string> =>
    resultText(
      await peer.request('tools/call', {
        name: 'get_session_output',
        arguments: { session: 'PropaneMon', lastN },
      })
    );
  const one = await outputFor(1);
  const two = await outputFor(2);
  check('lastN reaches the query core', one.length < outText.length && one.includes('THE-NEWEST-LINE'),
    `${one.length} vs ${outText.length}`);
  // TWO VALUES, because one survives a mutation that hard-codes `lastN = 1`.
  check('…and DIFFERENT values give different answers', two.length > one.length, `${two.length} > ${one.length}`);

  // A session with no transcript is a NORMAL STATE and says so in words.
  const quiet = resultText(
    await peer.request('tools/call', { name: 'get_session_output', arguments: { session: 'Switchboard' } })
  );
  check('a session with no transcript answers plainly, not with an error',
    /has not produced any readable output yet/.test(quiet), quiet);

  // AN UNKNOWN SESSION IS A CLEAN TOOL ERROR — the done-when that matters most,
  // because the failure it forbids is an empty success an agent believes.
  const missing = await peer.request('tools/call', {
    name: 'get_session_output',
    arguments: { session: 'NoSuchSession' },
  });
  const missingText = resultText(missing);
  check('an unknown session is an isError, not an empty success', isError(missing), missingText);
  check('…naming the sessions that DO exist, so the agent can retry',
    missingText.includes('PropaneMon') && /no session named/.test(missingText), missingText);

  const diff = await peer.request('tools/call', {
    name: 'get_session_diff',
    arguments: { session: 'PropaneMon' },
  });
  const diffText = resultText(diff);
  check('get_session_diff round-trips through a REAL git diff', !isError(diff), diffText.slice(0, 200));
  check('…and carries the sibling’s actual change', /burner\.ts/.test(diffText) && /^\+export const psi = 2;$/m.test(diffText),
    diffText.slice(0, 300));
  check(`…observing DIFF_CHAR_CAP (${diffText.length} chars)`,
    diffText.length < DIFF_CHAR_CAP + 800 && diffText.length > DIFF_CHAR_CAP - 2_000,
    `${diffText.length} vs cap ${DIFF_CHAR_CAP}`);
  check('…and saying that it was cut', /cut short/.test(diffText), diffText.slice(0, 200));

  // "Not a repository" and "a repo with nothing uncommitted" are different
  // facts, and the second is the confident wrong answer if they are conflated.
  const notRepo = resultText(
    await peer.request('tools/call', { name: 'get_session_diff', arguments: { session: 'Switchboard' } })
  );
  check('a folder that is not a repo says so, rather than "no changes"',
    /not working inside a git repository/.test(notRepo), notRepo);

  // THE THIRD OUTCOME, against a REAL clean repo (#764 review). It had only
  // ever been asserted against a hand-built payload, and it is the one the
  // untracked-files bug lived in: this repo's only change is a brand-new file
  // `git diff` cannot see, and the old wording called that "matches the last
  // commit" — flatly telling an agent its scaffolding sibling had done nothing.
  const clean = resultText(
    await peer.request('tools/call', { name: 'get_session_diff', arguments: { session: 'Tidy' } })
  );
  check('a clean repo says it has no TRACKED changes', /no tracked changes/.test(clean), clean);
  check('…and warns that untracked files are invisible, on THIS branch too',
    /Untracked/.test(clean), clean);
  check('…and does not claim the tree matches the last commit', !/matches the last commit/.test(clean), clean);

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
  discard(stateDir);
  discard(orphanDir);
  discard(ws.root);
}

/**
 * Remove a scratch directory, and never fail the run over it.
 *
 * ⚠️ **`force: true` DOES NOT COVER `EPERM`.** It suppresses ENOENT and nothing
 * else, and on Windows git writes its loose objects READ-ONLY — so removing a
 * repo this script created threw after every assertion had already passed, and
 * the check reported `threw` for a run that was green. A cleanup failure must
 * never be able to report itself as a product failure.
 *
 * What is left behind is swept: the names have `mkdtemp`'s shape under the OS
 * temp dir, which is exactly what `scripts/sweep-temp-orphans.js` matches.
 */
function discard(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.log(`[bus-check]      could not remove ${dir} (${String(err)}) — the temp sweeper will`);
  }
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
