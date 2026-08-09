// P2-E18-03 — StreamService against a REAL spawned child.
//
// Deliberately not a mocked child_process. The failure modes this item exists
// to prevent (a partial line dropped at a chunk boundary, an exit that never
// resolves, a write to a dead pipe crashing the process) all live in the seam
// between a real pipe and our decoder, which is precisely what a mock removes.
// The stand-in CLI is `process.execPath` running a generated script, so the
// suite needs no `claude` login and no network — the same property the PTY
// fake gives the e2e suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import {
  StreamService,
  StreamSession,
  StreamSpawnOptions,
  StreamDiagnostic,
} from './stream-service';

let dir: string;
let svc: StreamService;
/**
 * EVERY child this file starts, tracked individually rather than via the
 * services that own them. Two holes that closes: `beforeEach` throws the
 * previous service away, so earlier tests' children would go unreaped; and
 * `remove()` DELETES a session from its service's map while the child is still
 * dying, so anything asking the service would not see it at all. See `reapAll`.
 */
const sessions: StreamSession[] = [];
const diagnostics: StreamDiagnostic[] = [];

/** `svc.spawn`, plus the bookkeeping teardown needs. Every spawn goes through it. */
function spawnTracked(opts: StreamSpawnOptions): StreamSession {
  const s = svc.spawn(opts); // throws on a duplicate id — nothing to track then
  sessions.push(s);
  return s;
}

/** Write a throwaway node script and return its path. */
function script(body: string): string {
  const p = path.join(dir, `s${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, body);
  return p;
}

function run(body: string, id = 'sess'): StreamSession {
  return spawnTracked({
    id,
    command: process.execPath,
    args: [script(body)],
    cwd: dir,
    onDiagnostic: (d) => diagnostics.push(d),
  });
}

/**
 * Resolve when `check` holds, or reject on timeout — no arbitrary sleeps.
 *
 * The `ms` passed here must stay STRICTLY BELOW the enclosing test's timeout,
 * or vitest kills the test first and reports its own generic message instead of
 * ours. The default is 4 s against vitest's default 5 s; tests that spawn real
 * children raise BOTH, together. (First version had 10–30 s waits under a 5 s
 * test timeout — the waits could never fire, so every slow-machine failure
 * would have surfaced as an unexplained timeout rather than a named condition.)
 */
function until(check: () => boolean, ms = 4_000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (check()) return res();
      if (Date.now() - t0 > ms) return rej(new Error('timed out waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Kill every child this file started and WAIT for the OS to finish reaping it.
 *
 * `kill()` only *asks*. On Windows a process holds a lock on its `cwd` — which
 * for every session here is the temp `dir` — and that lock outlives the kill
 * request by however long the kernel takes to tear the process down. An
 * `rmSync` issued straight after therefore races it and throws EBUSY on the
 * directory itself. Vitest attributes a hook throw to the FILE, so the suite
 * reported "1 file failed" with ZERO failing tests: a phantom failure that
 * reads as a broken test run and isn't one (#167). Reproduced 20/20 locally
 * with a bare spawn-kill-rmSync loop; in this file it needed the children of
 * the *last* test still dying, which is why it only showed up ~2 runs in 20.
 *
 * Waiting on `exitCode` is the real fix: it settles from the child's 'exit'
 * event, which libuv raises off the process handle — i.e. once the process
 * object is genuinely signalled and its handles, cwd lock included, are gone.
 */
async function reapAll(): Promise<void> {
  for (const s of sessions) s.kill();
  try {
    // 5 s, and the headroom matters: vitest's default hook timeout is 10 s, so
    // a 10 s wait here could only ever be cut short by vitest — reporting `Hook
    // timed out` against the FILE, i.e. the very phantom this exists to remove,
    // and the fail-open below would never run. Same trap `until` documents
    // against test timeouts above. The hooks also ask for 20 s explicitly.
    await until(() => sessions.every((s) => s.exitCode !== null), 5_000);
  } catch {
    // A straggler must not fail the file — the retrying rm is the net.
  }
  // Drop what is proven dead; anything still alive stays for the next reap.
  // Also unpins the finished tests' rings, which hold up to ~1.2 MB of payload.
  const alive = sessions.filter((s) => s.exitCode === null);
  sessions.length = 0;
  sessions.push(...alive);
}

beforeAll(() => {
  // One directory for the whole FILE — every child spawned here has it as its
  // cwd — so there is deliberately no `afterEach` sweep (it would delete the
  // scripts under the remaining tests). Registered with #213's registry, so
  // even a `beforeAll` that throws half-way leaves nothing behind (#360).
  dir = tempDir('sb-stream-');
});
afterEach(async () => {
  // Reap per test rather than only at the end, so a child never outlives the
  // test that spawned it and the wait is over one test's worth of processes.
  await reapAll();
}, 20_000);
afterAll(async () => {
  await reapAll();
  // Second layer. `cleanupTempDirs()` carries the retries this used to spell
  // out itself (a virus scanner or the search indexer can hold a transient
  // handle on a file it just saw appear, and `maxRetries` covers exactly those
  // codes) AND — unlike the bare `rmSync` that was here — it cannot throw out
  // of this hook, which vitest would report as a failed FILE with zero failing
  // tests (#167). Called explicitly rather than left to `test-setup.ts`'s net
  // so the delete still happens straight after the reap, with the ordering the
  // comment above `reapAll` depends on; the net then retries anything Windows
  // was still holding.
  cleanupTempDirs();
}, 20_000);
beforeEach(() => {
  svc = new StreamService();
  diagnostics.length = 0;
});

describe('StreamService — a real child over real pipes (P2-E18-03)', () => {
  it('reads NDJSON messages off stdout', async () => {
    const got: unknown[] = [];
    const s = run(`
      process.stdout.write('{"type":"system","subtype":"init"}\\n');
      process.stdout.write('{"type":"result","subtype":"success"}\\n');
    `);
    s.onMessage((m) => got.push(m));

    await until(() => got.length === 2);
    expect(got).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success' },
    ]);
  });

  it('reassembles a message the child wrote in pieces', async () => {
    const got: Record<string, unknown>[] = [];
    const s = run(`
      process.stdout.write('{"type":"assi');
      setTimeout(() => process.stdout.write('stant","n":7}\\n'), 30);
    `);
    s.onMessage((m) => got.push(m));

    await until(() => got.length === 1);
    expect(got[0]).toEqual({ type: 'assistant', n: 7 });
  });

  // The pipe hands us ~64 KB at a time, so this genuinely crosses many chunk
  // boundaries rather than simulating it.
  it('carries a ~500 KB message across real chunk boundaries', async () => {
    const got: { text: string }[] = [];
    const s = run(`
      const big = 'x'.repeat(500 * 1024);
      process.stdout.write(JSON.stringify({ type: 'assistant', text: big }) + '\\n');
    `);
    s.onMessage((m) => got.push(m as { text: string }));

    await until(() => got.length === 1, 20_000);
    expect(got[0].text).toHaveLength(500 * 1024);
    expect(s.health.parseFailures).toBe(0);
  }, 30_000);

  // The S-10 probes do `chunk.toString('utf8')` per chunk, which is subtly
  // wrong: a multi-byte character straddling a pipe read decodes to two
  // replacement characters and corrupts the JSON line. At 500 KB of 4-byte
  // characters, a boundary lands mid-character many times over — so this fails
  // loudly if the StringDecoder is ever dropped.
  it('does not corrupt multi-byte characters split across pipe reads', async () => {
    const got: { text: string }[] = [];
    const s = run(`
      const s = '\\u{1F600}\\u{1F680}\\u00e9\\u4e2d'.repeat(30000);
      process.stdout.write(JSON.stringify({ type: 'assistant', text: s }) + '\\n');
    `);
    s.onMessage((m) => got.push(m as { text: string }));

    await until(() => got.length === 1, 20_000);
    expect(s.health.parseFailures).toBe(0);
    expect(got[0].text).toBe('\u{1F600}\u{1F680}é中'.repeat(30000));
    expect(got[0].text).not.toContain('�'); // no replacement characters
  }, 30_000);

  it('a garbage line costs one message and the session keeps reading', async () => {
    const got: Record<string, unknown>[] = [];
    const s = run(`
      process.stdout.write('{"n":1}\\n');
      process.stdout.write('this is not json\\n');
      process.stdout.write('{"n":2}\\n');
    `);
    s.onMessage((m) => got.push(m));

    await until(() => got.length === 2);
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
    expect(s.health.parseFailures).toBe(1);
    expect(diagnostics.some((d) => d.kind === 'parse-failure')).toBe(true);
  });

  it('round-trips a message written to the child on stdin', async () => {
    const got: Record<string, unknown>[] = [];
    const s = run(`
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          process.stdout.write(JSON.stringify({ type: 'echo', got: JSON.parse(line) }) + '\\n');
        }
      });
    `);
    s.onMessage((m) => got.push(m));

    s.send({ type: 'user', message: { role: 'user', content: 'hello' } });

    await until(() => got.length === 1);
    expect(got[0]).toEqual({
      type: 'echo',
      got: { type: 'user', message: { role: 'user', content: 'hello' } },
    });
  });

  it('captures stderr separately — it is never mistaken for a message', async () => {
    const got: unknown[] = [];
    const s = run(`
      process.stderr.write('a warning about settings\\n');
      process.stdout.write('{"n":1}\\n');
    `);
    s.onMessage((m) => got.push(m));

    await until(() => got.length === 1 && s.stderrSnapshot.length > 0);
    expect(got).toEqual([{ n: 1 }]);
    expect(s.stderrSnapshot).toContain('a warning about settings');
    expect(s.health.parseFailures).toBe(0);
  });

  it('resolves onExit with the child’s code', async () => {
    let code: number | null = null;
    const s = run(`process.exit(3);`);
    s.onExit((c) => (code = c));

    await until(() => code !== null);
    expect(code).toBe(3);
    expect(s.exitCode).toBe(3);
  });

  it('kill() resolves onExit', async () => {
    let exited = false;
    const s = run(`setInterval(() => {}, 1000);`); // never ends on its own
    s.onExit(() => (exited = true));

    await until(() => s.pid > 0);
    s.kill();

    await until(() => exited);
    expect(s.exitCode).not.toBeNull();
  });

  it('onExit fires ONCE even though exit and close both do', async () => {
    let calls = 0;
    const s = run(`process.exit(0);`);
    s.onExit(() => calls++);

    await until(() => calls > 0);
    await new Promise((r) => setTimeout(r, 150)); // give 'close' time to follow 'exit'
    expect(calls).toBe(1);
  });

  // The S-01 lesson PtyService records for PTY writes: writing to a dead pipe
  // raises ASYNC errors, and an unhandled 'error' on a stream takes the whole
  // process down.
  it('sending to a dead child is a no-op, not a throw or a crash', async () => {
    const s = run(`process.exit(0);`);
    await until(() => s.exitCode !== null);

    expect(() => s.send({ type: 'user' })).not.toThrow();
  });

  it('a spawn failure settles instead of hanging for ever', async () => {
    const s = spawnTracked({
      id: 'nope',
      command: path.join(dir, 'definitely-not-an-executable'),
      args: [],
      cwd: dir,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    let exited = false;
    s.onExit(() => (exited = true));

    await until(() => exited);
    expect(s.exitCode).toBe(1);
  });

  it('the ring keeps the most recent messages and reports what it dropped', async () => {
    const s = spawnTracked({
      id: 'ring',
      command: process.execPath,
      args: [script(`for (let i = 0; i < 50; i++) process.stdout.write(JSON.stringify({ i }) + '\\n');`)],
      cwd: dir,
      ringCapacity: 10,
    });

    await until(() => s.messages.droppedCount >= 40);
    const snap = s.messages.snapshot();
    expect(snap).toHaveLength(10);
    expect(snap[snap.length - 1]).toEqual({ i: 49 }); // newest retained
    expect(s.messages.droppedCount).toBe(40);
  });
});

// P1's `pty/lifecycle-check.ts` is a separate Electron entry point because
// node-pty is a NATIVE module and cannot load under vitest — it needs
// `electron --run-as-node`. StreamService has no native dependency
// (`child_process` is core), so the same coverage runs here instead, on all
// three CI legs rather than only where someone remembers to invoke a script.
describe('concurrency — the shape the product actually runs (P2-E18-03)', () => {
  it('12 concurrent sessions each frame their own stream, then all exit', async () => {
    const N = 12;
    const got = new Map<number, string[]>();
    for (let i = 0; i < N; i++) {
      got.set(i, []);
      const s = spawnTracked({
        id: `c${i}`,
        command: process.execPath,
        // a big payload per session, so the chunk boundaries are real and the
        // sessions genuinely interleave rather than completing one at a time
        args: [
          script(`
            const pad = 'p'.repeat(64 * 1024);
            process.stdout.write(JSON.stringify({ who: ${i}, pad }) + '\\n');
            process.stdout.write(JSON.stringify({ who: ${i}, done: true }) + '\\n');
          `),
        ],
        cwd: dir,
      });
      s.onMessage((m) => {
        const rec = m as { who: number; done?: boolean };
        if (rec.done) got.get(i)!.push('done');
      });
    }

    await until(() => [...got.values()].every((v) => v.includes('done')), 30_000);

    // no session picked up another's bytes
    for (let i = 0; i < N; i++) {
      const snap = svc.get(`c${i}`)!.messages.snapshot() as Array<{ who: number }>;
      expect(snap.every((m) => m.who === i)).toBe(true);
      expect(svc.get(`c${i}`)!.health.parseFailures).toBe(0);
    }

    svc.killAll();
    await until(() => svc.list().every((s) => s.exitCode !== null), 15_000);
  }, 60_000);
});

describe('StreamService bookkeeping (P2-E18-03)', () => {
  it('refuses to reuse a live session id', () => {
    run(`setInterval(() => {}, 1000);`, 'dup');
    expect(() => run(`setInterval(() => {}, 1000);`, 'dup')).toThrow(/already exists/);
  });

  it('remove() kills a live session and forgets it', async () => {
    const s = run(`setInterval(() => {}, 1000);`, 'gone');
    await until(() => s.pid > 0);

    svc.remove('gone');

    await until(() => s.exitCode !== null);
    expect(svc.get('gone')).toBeUndefined();
  });
});
