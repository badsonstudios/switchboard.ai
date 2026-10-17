// The one-question `codex app-server` exchange (#1290), against a scripted
// child that answers with the frames #1285 / #1290 captured (no `jsonrpc`).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { askAppServer, type AppServerChild } from './codex-app-server';

type Obj = Record<string, unknown>;

/** A child that answers `initialize` and then the question, as scripted. */
function scripted(
  answer: (frame: Obj) => Obj | undefined,
  opts: { initialize?: Obj; exitOnSpawn?: number; noise?: boolean; serverRequest?: boolean } = {}
) {
  const msgs = new Set<(m: Obj) => void>();
  const exits = new Set<(c: number) => void>();
  const sent: Obj[] = [];
  let killed = 0;
  const child: AppServerChild = {
    send: (m) => {
      const f = m as Obj;
      sent.push(f);
      setImmediate(() => {
        if (f.method === 'initialize') {
          if (opts.noise) for (const l of [...msgs]) l({ method: 'remoteControl/status/changed', params: {} });
          // a request FROM the server, reusing our ids: never our reply
          if (opts.serverRequest) for (const l of [...msgs]) l({ id: 1, method: 'server/ask', params: {} });
          const init = opts.initialize ?? { id: 1, result: { userAgent: 'x/0.163.0', codexHome: 'C:/h' } };
          for (const l of [...msgs]) l(init);
          return;
        }
        if (f.id !== undefined) {
          const reply = answer(f);
          if (reply) for (const l of [...msgs]) l(reply);
        }
      });
    },
    onMessage: (l) => {
      msgs.add(l);
      return () => msgs.delete(l);
    },
    onExit: (l) => {
      exits.add(l);
      if (opts.exitOnSpawn !== undefined) setImmediate(() => l(opts.exitOnSpawn!));
      return () => exits.delete(l);
    },
    kill: () => {
      killed += 1;
    },
  };
  return { child, sent, killed: () => killed };
}

afterEach(() => vi.useRealTimers());

describe('askAppServer', () => {
  it('initialize, initialized, then the question; the answer matched by id with no jsonrpc', async () => {
    const s = scripted((f) => ({ id: f.id, result: { account: null, requiresOpenaiAuth: true } }), { noise: true });
    const got = await askAppServer('codex.cmd', 'account/read', { refreshToken: false }, { spawn: () => s.child });
    expect(got).toEqual({ ok: true, result: { account: null, requiresOpenaiAuth: true } });
    expect(s.sent.map((f) => f.method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(s.sent[0]).toMatchObject({ id: 1, params: { capabilities: { experimentalApi: true } } });
    expect(s.sent[2]).toMatchObject({ id: 2, params: { refreshToken: false } });
    expect(s.killed()).toBe(1); // always closed
  });

  it('a request FROM the server with our id is not taken as our reply, and is refused (review of #1290)', async () => {
    const s = scripted((f) => (f.method === 'account/read' ? { id: f.id, result: { account: null } } : undefined), {
      serverRequest: true,
    });
    const got = await askAppServer('codex.cmd', 'account/read', undefined, { spawn: () => s.child });
    expect(got).toEqual({ ok: true, result: { account: null } });
    expect(s.sent.find((f) => f.error !== undefined)).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it('a request with no params sends none (account/rateLimits/read, as measured)', async () => {
    const s = scripted((f) => ({ id: f.id, result: {} }));
    await askAppServer('codex.cmd', 'account/rateLimits/read', undefined, { spawn: () => s.child });
    expect('params' in s.sent[2]).toBe(false);
  });

  it('an error reply is not ok, with the reason (logged out, measured)', async () => {
    const s = scripted((f) => ({
      id: f.id,
      error: { code: -32600, message: 'codex account authentication required to read rate limits' },
    }));
    const got = await askAppServer('codex.cmd', 'account/rateLimits/read', undefined, { spawn: () => s.child });
    expect(got).toEqual({
      ok: false,
      reason: 'codex account authentication required to read rate limits (-32600)',
    });
    expect(s.killed()).toBe(1);
  });

  it('a refused initialize is not ok and asks nothing', async () => {
    const s = scripted(() => undefined, { initialize: { id: 1, error: { message: 'nope' } } });
    const got = await askAppServer('codex.cmd', 'account/read', undefined, { spawn: () => s.child });
    expect(got).toMatchObject({ ok: false, reason: 'initialize refused: nope' });
    expect(s.sent.map((f) => f.method)).toEqual(['initialize']);
  });

  it('a child that dies first is not ok', async () => {
    const s = scripted(() => undefined, { exitOnSpawn: 1, initialize: { method: 'noise' } });
    const got = await askAppServer('codex.cmd', 'account/read', undefined, { spawn: () => s.child });
    expect(got).toEqual({ ok: false, reason: 'exited (1) before answering' });
  });

  it('a spawn that throws is not ok, and nothing rejects', async () => {
    const got = await askAppServer('codex.cmd', 'account/read', undefined, {
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    expect(got).toMatchObject({ ok: false, reason: expect.stringMatching(/^could not start: .*ENOENT/) as unknown });
  });

  it('a child that never answers is cut off at the deadline, and killed', async () => {
    vi.useFakeTimers();
    const s = scripted(() => undefined);
    const p = askAppServer('codex.cmd', 'account/read', undefined, { spawn: () => s.child, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timed out' });
    expect(s.killed()).toBe(1);
  });
});

describe('askAppServer and an AbortSignal (the detection runner)', () => {
  it('an abort settles as cancelled and kills the child; an already-aborted signal spawns nothing', async () => {
    const s = scripted(() => undefined);
    const ac = new AbortController();
    const p = askAppServer('codex.cmd', 'account/read', undefined, { spawn: () => s.child, signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(s.killed()).toBe(1);
    let spawned = false;
    const pre = new AbortController();
    pre.abort();
    await expect(
      askAppServer('codex.cmd', 'account/read', undefined, {
        spawn: () => {
          spawned = true;
          return s.child;
        },
        signal: pre.signal,
      })
    ).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(spawned).toBe(false);
  });
});
