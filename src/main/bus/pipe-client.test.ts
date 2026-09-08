import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { DEFAULT_HOST_TIMEOUT_MS, HostError, askHost } from './pipe-client';
import { CHANNEL_VERSION } from './channel';

/**
 * A socket double.
 *
 * Hand-rolled rather than mocked from `net`: every behaviour under test here is
 * an EVENT ORDERING (connect-then-reply, error-before-connect, close without
 * data), and the thing that has to be exercised is which listener the client
 * attached — which a stubbed module cannot show.
 */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

let dir: string;
let tokenPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-client-'));
  tokenPath = path.join(dir, 'bus-token');
  fs.writeFileSync(tokenPath, 'tok-123\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Wire the fake up and give the caller the socket to drive. */
function ask(over: Partial<Parameters<typeof askHost>[0]> = {}): {
  sock: FakeSocket;
  promise: Promise<Record<string, unknown>>;
} {
  const sock = new FakeSocket();
  const promise = askHost({
    pipePath: '\\\\.\\pipe\\whatever',
    tokenPath,
    request: { op: 'list_sessions' },
    timeoutMs: 50,
    connect: () => sock as unknown as net.Socket,
    ...over,
  });
  return { sock, promise };
}

describe('askHost — the request it sends', () => {
  it('presents the token READ FROM THE FILE, and never a path', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    const sent = JSON.parse(sock.written[0]) as Record<string, unknown>;
    expect(sent.token).toBe('tok-123');
    // S-03: the token travels in the payload, having come from a 0600 file. The
    // PATH is what rode argv. Neither must be confused for the other.
    expect(JSON.stringify(sent)).not.toContain(tokenPath);
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('trims the token — a trailing newline is not part of it', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    expect((JSON.parse(sock.written[0]) as Record<string, unknown>).token).toBe('tok-123');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('stamps the channel version so #764 can extend the payload', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    expect((JSON.parse(sock.written[0]) as Record<string, unknown>).v).toBe(CHANNEL_VERSION);
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('carries the op AND the tool arguments through', async () => {
    const { sock, promise } = ask({ request: { op: 'list_sessions', args: { lastN: 7 } } });
    sock.emit('connect');
    // `args` NESTED, not spread: a spread would let a tool argument named
    // `token` or `op` overwrite the fields the host authenticates and
    // dispatches on — arguments a language model wrote, shadowing the two
    // things this channel decides everything by.
    expect(JSON.parse(sock.written[0])).toMatchObject({ op: 'list_sessions', args: { lastN: 7 } });
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('a tool argument cannot shadow the token or the op', async () => {
    const { sock, promise } = ask({
      request: { op: 'list_sessions', args: { token: 'forged', op: 'something_else' } },
    });
    sock.emit('connect');
    const sent = JSON.parse(sock.written[0]) as Record<string, unknown>;
    expect(sent.token).toBe('tok-123');
    expect(sent.op).toBe('list_sessions');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('writes ONE newline-terminated line', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    expect(sock.written).toHaveLength(1);
    expect(sock.written[0].endsWith('\n')).toBe(true);
    expect(sock.written[0].slice(0, -1)).not.toContain('\n');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
  });

  it('does not write before the socket connects', async () => {
    const { sock, promise } = ask({ timeoutMs: 20 });
    expect(sock.written).toEqual([]);
    // Settled deliberately: an abandoned request rejects on its deadline, and
    // an unhandled rejection in this file would be indistinguishable from the
    // real leak these tests exist to catch.
    await expect(promise).rejects.toThrow();
  });
});

describe('askHost — the reply', () => {
  it('resolves with the parsed object', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":true,"sessions":[1]}\n'));
    await expect(promise).resolves.toEqual({ ok: true, sessions: [1] });
  });

  it('reassembles a reply split across chunks', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":'));
    sock.emit('data', Buffer.from('true}\n'));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('ignores anything after the first line', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":true}\n{"ok":false}\n'));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('destroys the socket once it has its answer', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    await promise;
    expect(sock.destroyed).toBe(true);
  });

  it('rejects unparseable JSON rather than resolving with junk', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('not json\n'));
    await expect(promise).rejects.toThrow(/could not be read/);
  });

  it.each(['[1,2]', '"a string"', '42', 'null'])(
    'rejects a non-object reply (%s) rather than handing it on',
    async (body) => {
      // `JSON.parse('[1,2]')` succeeds, and an array flows straight through a
      // naive `typeof === 'object'` guard into `reply.ok` being undefined —
      // which the caller reports as "the host refused", blaming the host for
      // our own parse.
      const { sock, promise } = ask();
      sock.emit('connect');
      sock.emit('data', Buffer.from(body + '\n'));
      await expect(promise).rejects.toThrow(/could not be read/);
    }
  );
});

describe('askHost — never hangs (the done-when)', () => {
  it('rejects on the deadline when the host accepts and says nothing', async () => {
    const { sock, promise } = ask({ timeoutMs: 30 });
    sock.emit('connect');
    await expect(promise).rejects.toThrow(/did not answer within 30ms/);
  });

  it('destroys the socket on the deadline — no leaked handle', async () => {
    const { sock, promise } = ask({ timeoutMs: 30 });
    sock.emit('connect');
    await expect(promise).rejects.toThrow();
    expect(sock.destroyed).toBe(true);
  });

  it('rejects immediately when the host is not there', async () => {
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    sock.emit('error', err);
    // The point is that it did NOT wait out the 10s deadline.
    await expect(promise).rejects.toThrow(/could not reach the switchboard host/);
  });

  it('rejects when the host closes without answering, without waiting for the deadline', async () => {
    // Its own arm. A host that drops us leaves no error behind, so without a
    // 'close' listener the only thing left is the deadline — a five-second
    // stall where a millisecond answer was available.
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    sock.emit('connect');
    sock.emit('close');
    await expect(promise).rejects.toThrow(/closed the connection without answering/);
  });

  it('a close AFTER a good reply does not overwrite the answer', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    sock.emit('close');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('an error AFTER a good reply does not overwrite the answer', async () => {
    const { sock, promise } = ask();
    sock.emit('connect');
    sock.emit('data', Buffer.from('{"ok":true}\n'));
    sock.emit('error', new Error('late'));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('survives a synchronous throw from connect', async () => {
    // An unhandled throw here escapes the promise and kills the child, which
    // the agent experiences as the server dying mid-call.
    await expect(
      askHost({
        pipePath: 'bad',
        tokenPath,
        request: { op: 'list_sessions' },
        connect: () => {
          throw Object.assign(new Error('bad path'), { code: 'ERR_INVALID_ARG_TYPE' });
        },
      })
    ).rejects.toThrow('could not reach the switchboard host');
  });

  it('rejects when the write itself throws', async () => {
    const sock = new FakeSocket();
    sock.write = () => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    };
    const promise = askHost({
      pipePath: 'p',
      tokenPath,
      request: { op: 'list_sessions' },
      timeoutMs: 10_000,
      connect: () => sock as unknown as net.Socket,
    });
    sock.emit('connect');
    await expect(promise).rejects.toThrow('could not send to the switchboard host');
  });
});

describe('the default deadline (pinned by nothing until review said so)', () => {
  // Every other test passes `timeoutMs` explicitly, so the CONSTANT was free to
  // be anything. Mutated to 5 the whole suite stayed green while every real
  // call over a busy pipe failed; mutated to 500_000 it stayed green while an
  // unreachable host wedged the agent's turn for eight minutes — which is this
  // file's done-when exactly inverted.
  it('is bounded on BOTH sides', () => {
    expect(DEFAULT_HOST_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_HOST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('is what a call with no timeoutMs actually uses', () => {
    // The bound above says nothing about whether the constant is READ. This
    // asserts the wiring: the message names the value that fired.
    const sock = new FakeSocket();
    const promise = askHost({
      pipePath: 'p',
      tokenPath,
      request: { op: 'list_sessions' },
      connect: () => sock as unknown as net.Socket,
    });
    sock.emit('connect');
    // Not awaited to completion — that would take the whole default — but the
    // rejection is claimed so it is never an unhandled one.
    const claimed = promise.catch((e: Error) => e.message);
    sock.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    return expect(claimed).resolves.toContain('could not reach');
  });

  it('names the deadline it actually waited for', async () => {
    const { sock, promise } = ask({ timeoutMs: 25 });
    sock.emit('connect');
    await expect(promise).rejects.toThrow('the switchboard host did not answer within 25ms');
  });
});

describe('askHost — the reply is bounded', () => {
  it('rejects an oversized reply rather than buffering it', async () => {
    // The child's receive buffer was a hand-rolled `buf +=` with no limit, so a
    // host — or anything squatting on the endpoint name — that streamed without
    // a newline grew this process's memory until the deadline.
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    sock.emit('connect');
    sock.emit('data', Buffer.from('x'.repeat(1_100_000)));
    await expect(promise).rejects.toThrow(/oversized reply/);
  });

  it('still accepts a large but LEGAL reply', async () => {
    // The negative above passes for a limit of 10 bytes as easily as 1 MB. This
    // is the half that pins the magnitude — a session list is not tiny.
    const big = { ok: true, sessions: Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, name: `n${i}` })) };
    const payload = JSON.stringify(big);
    expect(payload.length).toBeGreaterThan(50_000);
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    sock.emit('connect');
    // Split, so chunk reassembly is exercised at size too.
    sock.emit('data', Buffer.from(payload.slice(0, 30_000)));
    sock.emit('data', Buffer.from(payload.slice(30_000) + '\n'));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });
});

describe('askHost — the token file', () => {
  it('fails with a SETUP message, not a reachability one, when the file is missing', async () => {
    // Reporting this as "the host is unreachable" sends whoever debugs it to
    // the wrong end of the channel.
    await expect(
      askHost({ pipePath: 'p', tokenPath: path.join(dir, 'nope'), request: { op: 'list_sessions' } })
    ).rejects.toThrow('could not read the session token');
  });

  it('fails on an empty token file', async () => {
    fs.writeFileSync(tokenPath, '   \n');
    await expect(
      askHost({ pipePath: 'p', tokenPath, request: { op: 'list_sessions' } })
    ).rejects.toThrow(/token file is empty/);
  });

  it('does not connect at all when the token cannot be read', async () => {
    let connected = false;
    await expect(
      askHost({
        pipePath: 'p',
        tokenPath: path.join(dir, 'nope'),
        request: { op: 'list_sessions' },
        connect: () => {
          connected = true;
          return new FakeSocket() as unknown as net.Socket;
        },
      })
    ).rejects.toThrow();
    expect(connected).toBe(false);
  });
});

describe('askHost — the error text (the #760 correction)', () => {
  // The findings note carries an explicit correction: ENOENT is a WINDOWS
  // NAMED PIPE fact, not a bus fact. A unix socket with no listener gives
  // ECONNREFUSED. Nothing may branch on a code, and both must produce the same
  // condition with the same message.
  it.each(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ECONNRESET'])(
    'reports %s as one unreachable-host condition, with the SAME message',
    async (code) => {
      const { sock, promise } = ask({ timeoutMs: 10_000 });
      sock.emit('error', Object.assign(new Error('x'), { code }));
      const err = (await promise.catch((e: HostError) => e)) as HostError;
      // Byte-identical across platforms. A message that varied by errno would
      // be a code this branched on, wearing a disguise.
      expect(err.message).toBe('could not reach the switchboard host');
      // …and the code is still recoverable, for the log.
      expect(err.detail).toBe(code);
    }
  );

  it('keeps the platform code OUT of the message a model reads', async () => {
    // Handing a model `ENOENT` invites it to go hunting for a missing file that
    // never existed — the same class of mistake as a denial that reads like an
    // infrastructure fault. The detail belongs on stderr.
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    sock.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    const err = (await promise.catch((e: HostError) => e)) as HostError;
    expect(err.message).not.toMatch(/ENOENT/);
  });

  it('falls back to the stringified error when the platform gave no code', async () => {
    const { sock, promise } = ask({ timeoutMs: 10_000 });
    sock.emit('error', new Error('something odd'));
    const err = (await promise.catch((e: HostError) => e)) as HostError;
    expect(err.detail).toBe('Error: something odd');
  });
});
