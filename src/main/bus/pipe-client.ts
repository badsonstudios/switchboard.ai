// The CHILD end of the host channel (P2-E11-02): one request, one reply, or a
// clean failure — never a hang.
//
// This file runs INSIDE the bus server child, which is a bare Node process
// under `ELECTRON_RUN_AS_NODE`. It may import nothing but Node builtins and our
// own transport-free modules: no Electron, no `SessionQueries`, no IPC.
// `bus-tools.test.ts` walks the child's import graph and asserts that, rather
// than trusting this comment.
//
// ── WHY A HANG IS THE FAILURE THAT MATTERS ─────────────────────────────────
//
// #762's done-when singles this out, and it is the right thing to single out. A
// missing tool costs the agent one retry. A WEDGED tool call costs it the turn:
// the model sits in a call that never returns, the user watches a session that
// looks busy and is not, and nothing on screen says why. So every path out of
// this function is bounded — connect, write, and reply all share one deadline,
// and the socket is destroyed on the way out whichever path fires.
//
// ── AND WHY THE ERROR SHAPE IS NOT `ENOENT` ────────────────────────────────
//
// #760 measured a dead host on Windows and got `ENOENT`, and the findings note
// carries an explicit correction: that is a NAMED PIPE fact, not a bus fact. A
// unix socket with no listener gives `ECONNREFUSED`, and a stale socket file
// whose owner died gives `ECONNREFUSED` too. Nothing here branches on a code —
// any failure to reach the host is one condition with one message. The code
// travels on `HostError.detail`, which goes to stderr for a human and NOT into
// the tool content a model reads (see `hostError` at the foot of this file).
import fs from 'node:fs';
import net from 'node:net';
import { CHANNEL_VERSION } from './channel';
import { LineReader } from './protocol';

/**
 * How long the whole exchange gets: connect, write, and reply together.
 *
 * Both directions matter and `pipe-client.test.ts` bounds both. Too small and
 * every real call over a busy pipe fails; too large and an unreachable host
 * wedges the agent's turn for minutes, which is this file's done-when inverted.
 * Five seconds is far above a local pipe round trip (measured at 2 ms in
 * `check:bus`) and far below anything a person would sit through.
 */
export const DEFAULT_HOST_TIMEOUT_MS = 5_000;

export interface AskHostOptions {
  pipePath: string;
  /** Path to the 0600 token file. The token itself is never on argv (S-03). */
  tokenPath: string;
  request: { op: string; args?: Record<string, unknown> };
  timeoutMs?: number;
  /** Seam for tests; defaults to a real connection. */
  connect?: (pipePath: string) => net.Socket;
}

/**
 * Ask the host one question.
 *
 * Rejects — never resolves to a sentinel — because the caller
 * (`bus-server.ts`) has to turn a failure into `isError` tool content with a
 * message the AGENT reads, and a sentinel would let that translation be
 * forgotten silently.
 */
export function askHost(opts: AskHostOptions): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = fs.readFileSync(opts.tokenPath, 'utf8').trim();
    } catch (err) {
      // Its own message. A missing token file is a SETUP fault — the host never
      // registered this session, or tore it down — and reporting it as "the
      // host is unreachable" would send whoever debugs it to the wrong end of
      // the channel.
      return reject(hostError('could not read the session token', err));
    }
    if (!token) return reject(new Error('the session token file is empty'));

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `destroy`, not `end`: `end` is a half-close that waits on the peer, and
      // waiting on the peer is the thing this function exists not to do.
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`the switchboard host did not answer within ${timeoutMs}ms`))),
      timeoutMs
    );
    // Never keep the child process alive on this timer alone.
    timer.unref?.();

    let sock: net.Socket;
    try {
      sock = (opts.connect ?? ((p: string) => net.connect({ path: p })))(opts.pipePath);
    } catch (err) {
      // A synchronous throw from `connect` — a malformed path does this — would
      // otherwise escape past the promise and become an unhandled exception in
      // the child, which the agent sees as the server dying mid-call.
      clearTimeout(timer);
      return reject(hostError('could not reach the switchboard host', err));
    }

    // BOUNDED, via the same reader the host uses. A hand-rolled `buf +=` here
    // had no limit at all, so a host — or anything squatting on the endpoint
    // name — that streamed without ever sending a newline grew this child's
    // memory until the deadline. The correct implementation was three files
    // away and was not being used.
    const reader = new LineReader();
    sock.on('data', (d: Buffer) => {
      const lines = reader.feed(d.toString());
      if (reader.hasOverflowed()) {
        return finish(() => reject(new Error('the switchboard host sent an oversized reply')));
      }
      const line = lines[0];
      if (line === undefined) return;
      finish(() => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return reject(new Error('the switchboard host sent a reply that could not be read'));
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('the switchboard host sent a reply that could not be read'));
        }
        resolve(parsed as Record<string, unknown>);
      });
    });
    sock.on('error', (err) =>
      finish(() => reject(hostError('could not reach the switchboard host', err)))
    );
    // The host closing without answering. Distinct from `error` and reachable
    // on its own — an unregistered session's endpoint accepts nothing, and a
    // host that drops us mid-exchange leaves no error behind. Without this arm
    // the only thing left is the deadline, which is a five-second stall where a
    // millisecond answer was available.
    sock.on('close', () =>
      finish(() => reject(new Error('the switchboard host closed the connection without answering')))
    );
    sock.on('connect', () => {
      try {
        sock.write(JSON.stringify({ v: CHANNEL_VERSION, token, ...opts.request }) + '\n');
      } catch (err) {
        finish(() => reject(hostError('could not send to the switchboard host', err)));
      }
    });
  });
}

/**
 * An error whose MESSAGE is prose and whose `detail` carries the platform code.
 *
 * The split exists because the two audiences want different things. The message
 * is rendered into MCP tool content, which a language model reads — and review
 * pointed out that handing a model `ENOENT` invites it to go hunting for a
 * missing file that does not exist, which is the same class of mistake as the
 * "Denied from switchboard" wording that taught an agent to route around a
 * user's refusal (`hook-listener.ts`'s `verdict`). `detail` goes to stderr,
 * where a person debugging wants exactly that string.
 *
 * It is also why nothing here BRANCHES on a code: #760 measured `ENOENT` for a
 * dead Windows named pipe, and a unix socket gives `ECONNREFUSED` for the same
 * condition. One condition, one message, whatever the platform called it.
 */
export interface HostError extends Error {
  detail?: string;
}

function hostError(message: string, err: unknown): HostError {
  const e = new Error(message) as HostError;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  e.detail = code ?? String(err);
  return e;
}
