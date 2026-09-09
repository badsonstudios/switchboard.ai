// The host end, driven over a REAL endpoint — a named pipe on Windows, a unix
// socket everywhere else. No Electron, no spawning, so it runs in the CI unit
// job on both operating systems, which is also what gives the unix-socket path
// its first coverage anywhere (#760 left it written-but-never-executed).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { BusHost, BusQueries, IDLE_TIMEOUT_MS, REPLY_LINGER_MS } from './host-channel';
import { busPipePath, busTokenPath } from './bus-paths';
import { CHANNEL_VERSION } from './channel';
import { stubQueries } from './fixtures/queries';
import { askHost } from './pipe-client';
import type { Logger } from '../log/logger';
import type { QueryResult, SessionDiff, SessionOutput, SessionSummary } from '../sessions/queries';

const SESSIONS: SessionSummary[] = [
  { id: 'sb-a', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working' },
  { id: 'sb-b', name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'idle' },
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
let listSessions: () => QueryResult<SessionSummary[]>;
let sessionOutput: (ref: string, lastN?: number) => QueryResult<SessionOutput>;
let sessionDiff: (ref: string) => Promise<QueryResult<SessionDiff>>;

/**
 * The queries every host in this file is built with.
 *
 * INDIRECTED THROUGH THE `let`s ON PURPOSE, so a test can swap one answer after
 * the host exists without rebuilding it — the endpoint is a real socket and
 * re-registering per case would cost the suite far more than it is worth.
 */
const queries = (): BusQueries => ({
  listSessions: () => listSessions(),
  sessionOutput: (ref, lastN) => sessionOutput(ref, lastN),
  sessionDiff: (ref) => sessionDiff(ref),
});

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-host-'));
  log = fakeLog();
  listSessions = () => ({ ok: true, value: SESSIONS });
  const defaults = stubQueries();
  sessionOutput = defaults.sessionOutput.bind(defaults);
  sessionDiff = defaults.sessionDiff.bind(defaults);
  host = new BusHost({ stateDir, log, queries: queries() });
});

afterEach(() => {
  host.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A session id short enough to keep the derived socket path well inside sun_path. */
let n = 0;
const newId = (): string => `s${process.pid}-${n++}`;

/** Speak to the endpoint directly, so a test can send what a good client would not. */
function rawAsk(pipePath: string, payload: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: pipePath });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('no reply'));
    }, timeoutMs);
    let buf = '';
    let closed = false;
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        clearTimeout(timer);
        closed = true;
        sock.destroy();
        resolve(buf.slice(0, buf.indexOf('\n')));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on('close', () => {
      if (!closed) {
        clearTimeout(timer);
        reject(new Error('closed without answering'));
      }
    });
    sock.on('connect', () => sock.write(payload));
  });
}

describe('registerSession', () => {
  it('writes the token to a file and returns its PATH (S-03)', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    expect(fs.existsSync(ep.tokenPath)).toBe(true);
    // The endpoint carries a path; the secret never leaves the file except in
    // a payload. Nothing here would put it on argv.
    expect(ep.pipePath).not.toContain(fs.readFileSync(ep.tokenPath, 'utf8'));
  });

  it('mints a token with real entropy', async () => {
    const a = await host.registerSession(newId());
    const b = await host.registerSession(newId());
    const ta = fs.readFileSync(a.tokenPath, 'utf8');
    expect(ta).toMatch(/^[0-9a-f]{64}$/);
    expect(ta).not.toBe(fs.readFileSync(b.tokenPath, 'utf8'));
  });

  it('gives different sessions different endpoints', async () => {
    const a = await host.registerSession(newId());
    const b = await host.registerSession(newId());
    expect(a.pipePath).not.toBe(b.pipePath);
  });

  it('is idempotent — a second register returns the same endpoint, not a second listener', async () => {
    // A second `listen` on a live Windows pipe name fails with EADDRINUSE, and
    // a session that cannot take the bus over an accounting slip is a real
    // outcome of the restart paths.
    const id = newId();
    const first = await host.registerSession(id);
    const second = await host.registerSession(id);
    expect(second).toEqual(first);
  });

  it('is idempotent ACROSS AN IN-FLIGHT CALL, not just after one', async () => {
    // THE RACE. Every other test here awaits the first register before making
    // the second, so none of them can see this: both calls used to miss the map
    // (it is written after the await), both minted a token, the second
    // OVERWROTE the token file, then failed `listen` with EADDRINUSE — leaving
    // the file holding a token that was in no map. The session then answered
    // "not authorized" for the rest of its life with nothing in any log.
    const id = newId();
    const [a, b] = await Promise.all([host.registerSession(id), host.registerSession(id)]);
    expect(b).toEqual(a);
    // The file on disk must still be the token the host will honour.
    await expect(askHost({ ...a, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: true });
  });

  it('opens exactly one listener under a concurrent register', async () => {
    const id = newId();
    const all = await Promise.all([0, 1, 2, 3].map(() => host.registerSession(id)));
    expect(new Set(all.map((e) => e.pipePath)).size).toBe(1);
    // A second listener would have leaked; tearing down once must be enough to
    // make the endpoint dead.
    host.unregisterSession(id);
    await expect(
      askHost({ ...all[0], request: { op: 'list_sessions' }, timeoutMs: 1500 })
    ).rejects.toThrow();
  });

  it('an unregister DURING an in-flight register does not leave a live endpoint', async () => {
    // The mirror of the race above. `unregisterSession` found nothing in
    // `bySession` — not written until the register lands — so it returned early
    // and did nothing; the registration then completed and installed a live
    // endpoint AND a live 0600 token for a session that no longer existed,
    // reclaimed only at app quit.
    const id = newId();
    const opening = host.registerSession(id);
    host.unregisterSession(id);
    await expect(opening).rejects.toThrow(/torn down/);
    expect(host.endpointFor(id)).toBeNull();
    expect(fs.existsSync(busTokenPath(stateDir, id))).toBe(false);
  });

  it('…and the discarded endpoint is really closed, not merely forgotten', async () => {
    const id = newId();
    const opening = host.registerSession(id);
    host.unregisterSession(id);
    await expect(opening).rejects.toThrow();
    // Nothing must be listening on the name the child would have been told.
    await expect(
      askHost({
        pipePath: busPipePath(id),
        tokenPath: busTokenPath(stateDir, id),
        request: { op: 'list_sessions' },
        timeoutMs: 1500,
      })
    ).rejects.toThrow();
  });

  it('a cancelled register does not poison the NEXT one', async () => {
    const id = newId();
    const opening = host.registerSession(id);
    host.unregisterSession(id);
    await expect(opening).rejects.toThrow();
    const ep = await host.registerSession(id);
    await expect(askHost({ ...ep, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: true });
  });

  it('exposes the endpoint for #763 to write into the MCP config', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    expect(host.endpointFor(id)).toEqual(ep);
    expect(host.endpointFor('never-registered')).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('narrows the socket file to 0600', async () => {
    // Linux CI is where this runs, and `/tmp` is world-writable there — so the
    // mode is the difference between "any local process may connect" and "only
    // this user's".
    const ep = await host.registerSession(newId());
    expect(fs.statSync(ep.pipePath).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('writes the token file 0600', async () => {
    // Windows ignores the mode argument entirely (the protection there is
    // stateDir living under the user profile), so this can only be asserted on
    // posix — and until it was, `mode: 0o600` was pinned by nothing at all.
    const ep = await host.registerSession(newId());
    expect(fs.statSync(ep.tokenPath).mode & 0o777).toBe(0o600);
  });
});

describe('the round trip', () => {
  it('answers list_sessions with the query core’s value', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    const reply = await askHost({ ...ep, request: { op: 'list_sessions' } });
    expect(reply).toMatchObject({ ok: true, sessions: SESSIONS });
  });

  it('names the CALLER, so the child can mark "this session"', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    const reply = await askHost({ ...ep, request: { op: 'list_sessions' } });
    expect(reply.callerId).toBe(id);
  });

  it('derives the caller from the TOKEN, not from anything the child claims', async () => {
    // The child is passed `--session` on argv, and argv is world-readable. If
    // the host ever trusted a self-declared id, a session could read a
    // sibling's answers by lying in one field.
    //
    // SENT RAW, not through `askHost`. Going through our own client typed the
    // hostile field into `args`, where it is nested and harmless — so the test
    // stopped exercising the attack and a mutant taking `callerId` straight off
    // the request survived it. A hostile child writes its own JSON; so does this.
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    const raw = await rawAsk(
      ep.pipePath,
      JSON.stringify({
        v: CHANNEL_VERSION,
        token,
        op: 'list_sessions',
        // every shape a liar might reach for, at the top level
        session: 'sb-somebody-else',
        sessionId: 'sb-somebody-else',
        callerId: 'sb-somebody-else',
      }) + '\n'
    );
    expect((JSON.parse(raw) as { callerId: string }).callerId).toBe(id);
  });

  it('serves repeated calls on the same endpoint', async () => {
    const ep = await host.registerSession(newId());
    for (let i = 0; i < 3; i++) {
      await expect(askHost({ ...ep, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: true });
    }
  });

  it('serves concurrent calls', async () => {
    const ep = await host.registerSession(newId());
    const all = await Promise.all(
      [0, 1, 2, 3].map(() => askHost({ ...ep, request: { op: 'list_sessions' } }))
    );
    expect(all.every((r) => r.ok === true)).toBe(true);
  });

  describe('the read tools (#764)', () => {
    it('answers get_session_output with the query core’s value, under its own field', async () => {
      const ep = await host.registerSession(newId());
      const reply = await askHost({
        ...ep,
        request: { op: 'get_session_output', args: { session: '@Beta' } },
      });
      expect(reply).toMatchObject({ ok: true, output: { text: 'output for @Beta' } });
      // Not smuggled into `sessions` — the child reads a different field per op,
      // and a host that answered under the wrong one would render as an empty
      // session list.
      expect(reply.sessions).toBeUndefined();
    });

    it('answers get_session_diff with the query core’s value, under its own field', async () => {
      const ep = await host.registerSession(newId());
      const reply = await askHost({
        ...ep,
        request: { op: 'get_session_diff', args: { session: '@Beta' } },
      });
      expect(reply).toMatchObject({ ok: true, diff: { isRepo: true, diff: 'diff for @Beta' } });
      expect(reply.output).toBeUndefined();
    });

    it('PASSES THE SESSION REFERENCE THROUGH, rather than answering about the caller', async () => {
      // The mutation that reads as correct: hand `sessionOutput` the caller's
      // own id and every "it round-trips" assertion above still passes, while
      // the tool answers the wrong question with total confidence.
      const asked: unknown[] = [];
      sessionOutput = (ref) => {
        asked.push(ref);
        return { ok: true, value: { session: SESSIONS[1], text: '', blocks: 0, truncated: false } };
      };
      const ep = await host.registerSession(newId());
      await askHost({ ...ep, request: { op: 'get_session_output', args: { session: 'PropaneMon' } } });
      expect(asked).toEqual(['PropaneMon']);
    });

    it('PASSES lastN THROUGH UNTOUCHED, including nonsense', async () => {
      // `MAX_LAST_N` and `DEFAULT_LAST_N` live in the query core and nowhere
      // else. A clamp added here would be a second answer to one question, and
      // the composer path (#08) would not get it.
      const asked: unknown[] = [];
      sessionOutput = (_ref, lastN) => {
        asked.push(lastN);
        return { ok: true, value: { session: SESSIONS[1], text: '', blocks: 0, truncated: false } };
      };
      const ep = await host.registerSession(newId());
      for (const lastN of [5, 999_999, -1]) {
        await askHost({ ...ep, request: { op: 'get_session_output', args: { session: 'x', lastN } } });
      }
      await askHost({ ...ep, request: { op: 'get_session_output', args: { session: 'x' } } });
      expect(asked).toEqual([5, 999_999, -1, undefined]);
    });

    it('an unknown session is a refusal WITH THE CORE’S REASON, not an empty success', async () => {
      // The done-when, at the host seam. Rewriting the reason here would be the
      // damage: `resolve` names the sessions that DO exist, which is what makes
      // the refusal actionable.
      sessionOutput = () => ({ ok: false, reason: 'no session named "Gamma" — running sessions: Alpha' });
      const ep = await host.registerSession(newId());
      const reply = await askHost({
        ...ep,
        request: { op: 'get_session_output', args: { session: 'Gamma' } },
      });
      expect(reply).toEqual({ ok: false, reason: 'no session named "Gamma" — running sessions: Alpha' });
    });

    it('a MISSING session argument reaches the core, which is what refuses it', async () => {
      // Deliberately not guarded at this layer: `resolve` type-guards `ref`
      // because both its consumers cross a boundary where types are not
      // enforced. A guard here would refuse with a worse reason.
      const asked: unknown[] = [];
      sessionOutput = (ref) => {
        asked.push(ref);
        return { ok: false, reason: 'session reference must be a string' };
      };
      const ep = await host.registerSession(newId());
      const reply = await askHost({ ...ep, request: { op: 'get_session_output', args: {} } });
      expect(asked).toEqual([undefined]);
      expect(reply).toMatchObject({ ok: false, reason: 'session reference must be a string' });
    });

    it('a REJECTED query is caught rather than crashing Electron main', async () => {
      // `sessionDiff` never rejects by contract, but that contract belongs to a
      // module this one does not own, and an unhandled rejection out of main
      // takes the app down over a child's request.
      sessionDiff = () => Promise.reject(new Error('git exploded'));
      const ep = await host.registerSession(newId());
      const reply = await askHost({ ...ep, request: { op: 'get_session_diff', args: { session: 'x' } } });
      expect(reply).toMatchObject({ ok: false });
      expect(String(reply.reason)).toContain('get_session_diff');
    });

    it('a SYNCHRONOUS throw from a query is caught too', async () => {
      sessionOutput = () => {
        throw new Error('boom');
      };
      const ep = await host.registerSession(newId());
      await expect(
        askHost({ ...ep, request: { op: 'get_session_output', args: { session: 'x' } } })
      ).resolves.toMatchObject({ ok: false });
    });

    it('an unknown op is still refused by name', async () => {
      const ep = await host.registerSession(newId());
      await expect(askHost({ ...ep, request: { op: 'get_session_brain' } })).resolves.toEqual({
        ok: false,
        reason: 'unknown request: get_session_brain',
      });
    });

    it('a SLOW answer still arrives — the idle deadline does not eat it', async () => {
      // THE BUG THE ASYNC TURN INTRODUCES IF NOBODY LOOKS. `IDLE_TIMEOUT_MS`
      // bounds a connection that opens and never sends a byte; once `answer`
      // can await, a socket with no traffic on it is ALSO what a slow `git
      // diff` looks like. Left armed, a big repo reaches the model as
      // "switchboard could not be reached".
      //
      // Driven with a real clock on a deliberately tiny deadline: fake timers do
      // not drive libuv, which is the same trap the reply-linger test records.
      const slow = new BusHost({
        stateDir,
        log,
        idleTimeoutMs: 40,
        queries: {
          ...queries(),
          sessionDiff: (ref) =>
            new Promise((r) =>
              setTimeout(
                () => r({ ok: true, value: { session: SESSIONS[1], isRepo: true, diff: `late ${ref}`, truncated: false } }),
                250
              )
            ),
        },
      });
      try {
        const ep = await slow.registerSession(newId());
        const reply = await askHost({
          ...ep,
          request: { op: 'get_session_diff', args: { session: 'x' } },
          timeoutMs: 3000,
        });
        expect(reply).toMatchObject({ ok: true, diff: { diff: 'late x' } });
      } finally {
        slow.stop();
      }
    });

    it('a connection that never sends a byte is STILL dropped', async () => {
      // The other half of the pair above, restated here so the fix cannot be
      // "remove the idle deadline". `sock.setTimeout(0)` fires only once a
      // complete request has been read; a silent client never gets there.
      const short = new BusHost({ stateDir, log, idleTimeoutMs: 60, queries: queries() });
      try {
        const ep = await short.registerSession(newId());
        const sock = net.connect({ path: ep.pipePath });
        sock.on('error', () => {});
        const closed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('never dropped')), 3000);
          sock.on('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await new Promise<void>((r) => sock.on('connect', () => r()));
        await expect(closed).resolves.toBeUndefined();
      } finally {
        short.stop();
      }
    });

    it('AN ANSWER THAT NEVER SETTLES is bounded, and says which op ran long', async () => {
      // ⚠️ THE HOLE REVIEW FOUND IN MY OWN FIX. Clearing the idle deadline once
      // a request is in hand is right — a slow `git diff` must not read as
      // "switchboard could not be reached" — but the first cut cleared it and
      // put NOTHING back, so between reading a request and writing a reply the
      // host had no bound at all. A wedged git held a socket and a promise for
      // the life of the app, and anything that could read the token could do it
      // deliberately, N times over.
      //
      // Resolving to a refusal rather than letting the socket backstop destroy
      // the connection is the point: a bare close reaches the model as "the
      // host closed the connection without answering", which is true and
      // useless. This names the operation, from the only layer that knows.
      const stuck = new BusHost({
        stateDir,
        log,
        answerDeadlineMs: 80,
        queries: { ...queries(), sessionDiff: () => new Promise(() => {}) },
      });
      try {
        const ep = await stuck.registerSession(newId());
        const reply = await askHost({
          ...ep,
          request: { op: 'get_session_diff', args: { session: 'x' } },
          timeoutMs: 3000,
        });
        expect(reply.ok).toBe(false);
        expect(String(reply.reason)).toMatch(/took longer/);
      } finally {
        stuck.stop();
      }
    });

    it('…and the connection is given back afterwards, not held', async () => {
      // The other half: a bounded ANSWER is worth little if the socket it was
      // holding stays in the set. Measured through `connectionCount`, which is
      // the observable the reclaim work added for exactly this reason.
      const stuck = new BusHost({
        stateDir,
        log,
        answerDeadlineMs: 60,
        replyLingerMs: 60,
        queries: { ...queries(), sessionDiff: () => new Promise(() => {}) },
      });
      const id = newId();
      try {
        const ep = await stuck.registerSession(id);
        await askHost({
          ...ep,
          request: { op: 'get_session_diff', args: { session: 'x' } },
          timeoutMs: 3000,
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(stuck.connectionCount(id)).toBe(0);
      } finally {
        stuck.stop();
      }
    });

    it('a client that hangs up mid-answer is NOTICED, not written to', async () => {
      // The await window `answerAndReply` owns. Writing to a destroyed socket is
      // an asynchronous 'error' event, not a throw the reply path would catch,
      // and it also arms a reclaim timer whose 'close' has already fired.
      //
      // ⚠️ ASSERTED ON THE BRANCH, because the first version of this test was
      // decoration and the mutant proved it: it checked only that nothing was
      // logged at `error` or `warn`, and removing the guard entirely kept it
      // green — the stray write is swallowed by the socket's own 'error'
      // handler, so "no fault logged" is true with the bug in as well as out.
      // The debug line fires only when the guard runs.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const slow = new BusHost({
        stateDir,
        log,
        queries: {
          ...queries(),
          sessionDiff: () =>
            held.then(() => ({
              ok: true as const,
              value: { session: SESSIONS[1], isRepo: true, diff: 'x', truncated: false },
            })),
        },
      });
      try {
        const ep = await slow.registerSession(newId());
        const token = fs.readFileSync(ep.tokenPath, 'utf8');
        const sock = net.connect({ path: ep.pipePath });
        sock.on('error', () => {});
        await new Promise<void>((r) => sock.on('connect', () => r()));
        sock.write(
          JSON.stringify({ v: CHANNEL_VERSION, token, op: 'get_session_diff', args: { session: 'x' } }) + '\n'
        );
        // Give the host the request, then vanish before the answer is ready.
        await new Promise((r) => setTimeout(r, 50));
        sock.destroy();
        // AND LET THE HOST NOTICE. Releasing in the same tick resolves the
        // pending query on a MICROTASK, which runs before libuv delivers the
        // socket's 'close' — so `sock.destroyed` was still false and the guard
        // was not the thing under test. The first version of this did exactly
        // that and failed identically with the guard in and out, which is how
        // it was caught.
        await new Promise((r) => setTimeout(r, 50));
        release();
        await new Promise((r) => setTimeout(r, 100));
        expect(log.debug).toHaveBeenCalledWith(
          'bus client went away before its answer was ready',
          expect.anything()
        );
        // …and it is not a FAULT. A child hanging up is how a cancelled tool
        // call looks from here, and a session torn down mid-call is a restart.
        expect(log.error).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        slow.stop();
      }
    });
  });

  it('passes a query REFUSAL through with its reason', async () => {
    listSessions = () => ({ ok: false, reason: 'the session list is unavailable' });
    const ep = await host.registerSession(newId());
    await expect(askHost({ ...ep, request: { op: 'list_sessions' } })).resolves.toEqual({
      ok: false,
      reason: 'the session list is unavailable',
    });
  });

  it('survives a query that THROWS — a child request must not take main down', async () => {
    listSessions = () => {
      throw new Error('boom');
    };
    const ep = await host.registerSession(newId());
    await expect(askHost({ ...ep, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: false });
  });

  it('does not leak the internal error text to the agent', async () => {
    listSessions = () => {
      throw new Error('ENOENT /Users/danheinz/secret/path');
    };
    const ep = await host.registerSession(newId());
    const reply = await askHost({ ...ep, request: { op: 'list_sessions' } });
    expect(JSON.stringify(reply)).not.toContain('secret/path');
  });
});

describe('authentication (the done-when: the pipe refuses an unauthenticated client)', () => {
  it('refuses a wrong token', async () => {
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v: 1, token: 'x'.repeat(64), op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it('refuses a missing token', async () => {
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v: 1, op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it.each([[''], ['   '], ['null'], ['[]']])('refuses a malformed token (%s)', async (token) => {
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, `{"v":1,"token":${JSON.stringify(token)},"op":"list_sessions"}\n`);
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it('refuses a token of the RIGHT LENGTH but the wrong value', async () => {
    // `timingSafeEqual` throws on a length mismatch, so a length guard that
    // returned early on equal-length input would look identical to a working
    // comparison in every other test here.
    const id = newId();
    const ep = await host.registerSession(id);
    const real = fs.readFileSync(ep.tokenPath, 'utf8');
    const forged = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');
    expect(forged).toHaveLength(real.length);
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v: 1, token: forged, op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it('refuses a SIBLING session’s valid token on this endpoint', async () => {
    // Both facts must agree: a token that is real, on an endpoint that is not
    // its own, is still a refusal. Not reachable today — endpoint names are
    // digests of their own session id — but the answer would be another
    // session's data, which is not a thing to leave resting on reachability.
    const a = await host.registerSession(newId());
    const b = await host.registerSession(newId());
    const bToken = fs.readFileSync(b.tokenPath, 'utf8');
    const raw = await rawAsk(a.pipePath, JSON.stringify({ v: 1, token: bToken, op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it('does not run the query at all for an unauthenticated client', async () => {
    const spy = vi.fn((): QueryResult<SessionSummary[]> => ({ ok: true, value: SESSIONS }));
    listSessions = spy;
    const ep = await host.registerSession(newId());
    await rawAsk(ep.pipePath, JSON.stringify({ v: 1, token: 'nope', op: 'list_sessions' }) + '\n');
    expect(spy).not.toHaveBeenCalled();
  });

  it('CLOSES the connection on a refusal rather than leaving it open', async () => {
    const ep = await host.registerSession(newId());
    const sock = net.connect({ path: ep.pipePath });
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    sock.on('error', () => {});
    // Reading matters: a Node socket with no 'data' listener stays PAUSED, so
    // it never processes the host's FIN and never closes. Without this the
    // test times out against a host that behaved perfectly.
    sock.on('data', () => {});
    await new Promise<void>((r) => sock.on('connect', () => r()));
    sock.write(JSON.stringify({ v: 1, token: 'nope', op: 'list_sessions' }) + '\n');
    await expect(closed).resolves.toBeUndefined();
  });

  // RUNS EVERYWHERE, but only POSIX distinguishes anything. Measured
  // 2026-09-08: on a Windows named pipe the server socket fully closes ~67ms
  // after `end()` even against a peer that is `allowHalfOpen` and never closes
  // its side, so there the count reaches zero whether the reclaim exists or
  // not. Unix sockets do have a real half-open state, which is where the timer
  // earns its keep — the mutation harness marks this mutant posix-only for
  // exactly that reason. Kept unskipped on Windows anyway: it costs nothing and
  // it means the mechanics of the test itself are exercised on both platforms,
  // which is precisely what `runIf(posix)` stopped happening the first time.
  it('reclaims a socket from a client that reads its answer and then holds on', async () => {
    // The half-open case `end()` alone does not cover: our FIN is sent, the
    // peer never sends its own. A well-behaved child destroys immediately, so
    // this only fires for one that does not — and the endpoint is reachable by
    // any process running as this user.
    //
    // REAL TIMERS, on a short injected linger. The first version used
    // `vi.advanceTimersByTimeAsync`, which does not drive libuv's socket
    // teardown, and it passed against a mutant with the reclaim removed
    // entirely.
    const short = new BusHost({ stateDir, log, replyLingerMs: 60, queries: queries() });
    const id = newId();
    try {
      const ep = await short.registerSession(id);
      // `allowHalfOpen` is half the test: a default socket auto-ends when it
      // reads the host's FIN, so it closes on its own and the assertion would
      // pass whether the reclaim exists or not. Half-open keeps our side up,
      // which is what a client "holding on" actually is.
      const sock = net.connect({ path: ep.pipePath, allowHalfOpen: true });
      sock.on('error', () => {});
      // Drain but never close our end.
      const read = new Promise<void>((r) => sock.on('data', () => r()));
      await new Promise<void>((r) => sock.on('connect', () => r()));
      sock.write(JSON.stringify({ v: CHANNEL_VERSION, token: 'nope', op: 'list_sessions' }) + '\n');
      await read;

      // ASSERTED ON THE HOST, not on the client. A half-open client cannot
      // observe this at all — it stays up by its own choice no matter what the
      // peer does — so watching it for a 'close' was an assertion that could
      // never pass on posix. It failed on its first ever run, because this test
      // is runIf(posix) and Windows had always skipped it.
      await vi.waitFor(() => expect(short.connectionCount(id)).toBe(0), { timeout: 3000 });
      sock.destroy();
    } finally {
      short.stop();
    }
  });

  it('the default linger is a real duration, not zero', () => {
    // The seam above only proves the timer fires at whatever it is told. If
    // the default were 0 the reclaim would race every well-behaved child.
    expect(REPLY_LINGER_MS).toBeGreaterThanOrEqual(1000);
  });

  it('says no rather than going silent — a silent refusal costs the child its deadline', async () => {
    // This is the whole reason a refusal carries a reason at all. Going quiet
    // would be marginally tidier and would make the child wait out five seconds
    // for a verdict already reached.
    const ep = await host.registerSession(newId());
    const t0 = Date.now();
    await rawAsk(ep.pipePath, JSON.stringify({ v: 1, token: 'nope', op: 'x' }) + '\n');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('bad requests', () => {
  it('refuses an unparseable line', async () => {
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, 'not json\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'the request could not be read' });
  });

  it.each(['[1,2]', '"a string"', '42'])('refuses a non-object request (%s)', async (body) => {
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, body + '\n');
    // The REASON, not merely `ok:false`. Dropping the shape guard sends these
    // down the auth path instead, where they are refused as "not authorized" —
    // still a refusal, so an assertion on `ok` alone passes either way and the
    // guard goes unpinned. #761's cap-direction lesson on a new surface.
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'the request could not be read' });
  });

  it('refuses an unknown op, naming it', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v: 1, token, op: 'delete_everything' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'unknown request: delete_everything' });
  });

  it('refuses an oversized line instead of buffering it', async () => {
    const ep = await host.registerSession(newId());
    // No newline, ever: a peer that never framces a message would otherwise
    // grow the host's buffer without bound.
    const raw = await rawAsk(ep.pipePath, 'x'.repeat(1_100_000));
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'the request was too large' });
  });
});

describe('one request per connection', () => {
  it('runs the query ONCE for a client that pipelines several lines in one chunk', async () => {
    // The host used to keep reading after replying, so N lines in one chunk ran
    // N synchronous `listSessions()` calls on Electron's MAIN THREAD — and the
    // second `reply()` was a write-after-end, whose 'error' handler destroys the
    // socket, which discards buffered writes and can truncate the reply already
    // sent into exactly the bare close `reply()` exists to avoid.
    const calls = vi.fn((): QueryResult<SessionSummary[]> => ({ ok: true, value: SESSIONS }));
    listSessions = calls;
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    const line = JSON.stringify({ v: CHANNEL_VERSION, token, op: 'list_sessions' }) + '\n';
    const raw = await rawAsk(ep.pipePath, line.repeat(5));
    expect(JSON.parse(raw)).toMatchObject({ ok: true });
    // A beat for any extra work to show up before asserting it did not.
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('delivers a WHOLE reply under a pipelined chunk, not a truncated one', async () => {
    // The consequence that would actually reach a user: a reply cut short is
    // indistinguishable, at the child, from a host that died.
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    const line = JSON.stringify({ v: CHANNEL_VERSION, token, op: 'list_sessions' }) + '\n';
    const raw = await rawAsk(ep.pipePath, line.repeat(20));
    expect(JSON.parse(raw)).toMatchObject({ ok: true, sessions: SESSIONS });
  });
});

describe('the idle deadline', () => {
  it('drops a connection that opens and never sends anything', async () => {
    // A raw `net.Server` has no request timeout — the `http.Server` this
    // mirrors (`HookListener`) got `requestTimeout` for free, and moving to a
    // raw socket dropped it silently. Without this a connection sits in the
    // session's socket set until the session ends, and the endpoint is
    // reachable by any process running as this user.
    const short = new BusHost({
      stateDir,
      log,
      idleTimeoutMs: 60,
      queries: queries(),
    });
    try {
      const ep = await short.registerSession(newId());
      const sock = net.connect({ path: ep.pipePath });
      sock.on('error', () => {});
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the idle connection was never dropped')), 3000);
        sock.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise<void>((r) => sock.on('connect', () => r()));
      await expect(closed).resolves.toBeUndefined();
    } finally {
      short.stop();
    }
  });

  it('the default deadline is generous enough for a real client', () => {
    // A child connects and writes in the same tick, so this only has to be
    // above "immediately". Bounded on both sides: too small breaks real calls,
    // too large stops bounding anything.
    expect(IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(IDLE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('the channel version', () => {
  const send = async (v: unknown): Promise<Record<string, unknown>> => {
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v, token, op: 'list_sessions' }) + '\n');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  it('accepts the current version', async () => {
    expect(await send(CHANNEL_VERSION)).toMatchObject({ ok: true });
  });

  it.each([[0], [2], ['1'], [null], [undefined]])('refuses version %j', async (v) => {
    // The stamp was decorative until review noticed nothing read it. #764 will
    // widen this payload, and a version nobody checks is a compatibility story
    // rather than a compatibility mechanism.
    expect(await send(v)).toMatchObject({ ok: false });
  });

  it('does not tell an UNAUTHENTICATED client about our versioning', async () => {
    // The version is checked after auth on purpose: a refusal should not be a
    // probe for what protocol the host speaks.
    const ep = await host.registerSession(newId());
    const raw = await rawAsk(ep.pipePath, JSON.stringify({ v: 99, token: 'nope', op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });
});

describe('teardown', () => {
  it('kills the token FILE', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    host.unregisterSession(id);
    expect(fs.existsSync(ep.tokenPath)).toBe(false);
  });

  it('kills the token in MEMORY — a client holding it can no longer authenticate', async () => {
    // The file is hygiene; this is the security property. A test that only
    // checked the file would pass with the token still live in the map.
    const id = newId();
    const ep = await host.registerSession(id);
    const token = fs.readFileSync(ep.tokenPath, 'utf8');
    host.unregisterSession(id);
    const again = await host.registerSession(id);
    const raw = await rawAsk(again.pipePath, JSON.stringify({ v: 1, token, op: 'list_sessions' }) + '\n');
    expect(JSON.parse(raw)).toEqual({ ok: false, reason: 'not authorized' });
  });

  it('makes the endpoint unusable — the child gets the dead-host path', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    host.unregisterSession(id);
    await expect(askHost({ ...ep, request: { op: 'list_sessions' }, timeoutMs: 1500 })).rejects.toThrow();
  });

  it('a torn-down session can be registered again (restart)', async () => {
    const id = newId();
    await host.registerSession(id);
    host.unregisterSession(id);
    // On posix this is the unlink working: a leftover socket file would make
    // the second `listen` fail with EADDRINUSE.
    const again = await host.registerSession(id);
    await expect(askHost({ ...again, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: true });
  });

  it('does not cut a SIBLING’S IN-FLIGHT call', async () => {
    // The bug this pins: the first version of this class kept ONE host-wide
    // socket set, so tearing down any session destroyed every other session's
    // live connections. The obvious test — "B still answers after A is
    // unregistered" — does NOT catch it, because by then no socket is open;
    // it passed against the broken version. The connection has to be held
    // across the teardown for the mutation to red.
    const a = newId();
    const b = newId();
    await host.registerSession(a);
    const epB = await host.registerSession(b);
    const token = fs.readFileSync(epB.tokenPath, 'utf8');

    const held = net.connect({ path: epB.pipePath });
    held.on('error', () => {});

    // THE LISTENERS GO ON FIRST. Attaching them after the teardown lets the
    // very close this test exists to detect fire before anything is listening —
    // and a paused socket (no 'data' handler yet) does not even process it. The
    // first version did exactly that and passed against the broken code.
    const answered = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 2000);
      held.on('data', (d) => {
        clearTimeout(timer);
        resolve(d.toString());
      });
      held.on('close', () => {
        clearTimeout(timer);
        reject(new Error('the sibling connection was cut'));
      });
    });
    await new Promise<void>((r) => held.on('connect', () => r()));

    // A PARTIAL request — no newline, so nothing is answered yet. The client's
    // `connect` fires before the host's `connection` handler runs, so at that
    // moment B's socket set can still be EMPTY and a teardown that wrongly
    // destroys every session's sockets would find nothing to destroy. Sending
    // bytes forces the accept, so the socket really is in the set that the
    // mutation reaches.
    const request = JSON.stringify({ v: 1, token, op: 'list_sessions' });
    held.write(request.slice(0, 10));
    await vi.waitFor(() => expect(held.bytesWritten).toBeGreaterThan(0));
    await new Promise<void>((r) => setTimeout(r, 50));

    host.unregisterSession(a);

    held.write(request.slice(10) + '\n');
    expect(JSON.parse(await answered)).toMatchObject({ ok: true });
    held.destroy();
  });

  it('leaves a SIBLING session working', async () => {
    // The first version of this class kept one host-wide socket set, so one
    // session closing cut every other session's in-flight call.
    const a = newId();
    const b = newId();
    await host.registerSession(a);
    const epB = await host.registerSession(b);
    host.unregisterSession(a);
    await expect(askHost({ ...epB, request: { op: 'list_sessions' } })).resolves.toMatchObject({ ok: true });
    expect(host.endpointFor(b)).toEqual(epB);
  });

  it('unregistering an unknown session is a no-op, not a throw', () => {
    expect(() => host.unregisterSession('never-existed')).not.toThrow();
  });

  it('stop() takes every endpoint down', async () => {
    const a = await host.registerSession(newId());
    const b = await host.registerSession(newId());
    host.stop();
    expect(fs.existsSync(a.tokenPath)).toBe(false);
    expect(fs.existsSync(b.tokenPath)).toBe(false);
    await expect(askHost({ ...a, request: { op: 'list_sessions' }, timeoutMs: 1500 })).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')('removes the socket FILE on posix', async () => {
    const id = newId();
    const ep = await host.registerSession(id);
    host.unregisterSession(id);
    expect(fs.existsSync(ep.pipePath)).toBe(false);
  });
});
