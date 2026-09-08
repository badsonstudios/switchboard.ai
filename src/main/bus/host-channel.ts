// The HOST end of the bus channel (P2-E11-02, §5.4) — Electron main's side.
//
// A stdio MCP server's stdin/stdout belong to the CLI that spawned it, so the
// bus child cannot answer `list_sessions` on its own. AR-P1-6 decided the
// AGENT↔BUS transport (stdio) and is silent on CHILD↔HOST; the owner decided
// that one on 2026-09-07: a named pipe / unix domain socket. No port, no HTTP,
// no network stack — which preserves the "there is no door to guard" property
// that made stdio worth choosing, rather than re-admitting §5.29's localhost
// attack class on a channel that never needed it. Reusing `HookListener`'s
// loopback HTTP was the cheaper build and was considered and rejected.
//
// ── THE TOKEN DECIDES IDENTITY, NOT THE CHILD ──────────────────────────────
//
// The child is passed `--session` on argv (#760 measured it arrives verbatim),
// but argv is world-readable and a child process is not a trusted narrator of
// who it is. So the map here is TOKEN → SESSION ID, exactly as
// `HookListener.tokens` is, and every answer is computed for the session the
// token belongs to. A child cannot ask about a session it is not. That is what
// makes §5.4's identity-at-spawn a property rather than an honour system.
//
// ── ONE ENDPOINT PER SESSION ───────────────────────────────────────────────
//
// Not one shared endpoint with the token as the only discriminator. This keeps
// the symmetry §5.4 chose stdio for — one server process per session at the
// agent end, one endpoint per session at the host end — and means a child
// cannot address a sibling's endpoint even if it wanted to. The cost is one
// listener per live session, which is tens of handles at the scale this app
// runs at.
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { busPipePath, busTokenPath } from './bus-paths';
import { CHANNEL_VERSION, isBusOp } from './channel';
import { LineReader, MAX_LINE_BYTES } from './protocol';
import type { Logger } from '../log/logger';
import type { SessionQueries } from '../sessions/queries';

/** Just enough of `SessionQueries` to be callable with a test double. */
export type BusQueries = Pick<SessionQueries, 'listSessions'>;

export interface BusHostOptions {
  /** Same directory `HookListener` writes `hook-token` into. */
  stateDir: string;
  queries: BusQueries;
  log: Logger;
  /**
   * How long a replied-to connection may linger. Absent = `REPLY_LINGER_MS`.
   *
   * A test seam, and the only reason it is an option at all — the same
   * justification `HookListener.sweepBudgetMs` carries. The alternative was
   * fake timers over real sockets, which is what the first version of the
   * reclaim test did: `vi.advanceTimersByTimeAsync` does not drive libuv, so
   * the test passed against a mutant that had removed the reclaim entirely.
   */
  replyLingerMs?: number;
  /** How long a connection may sit without completing a request. Absent =
   *  `IDLE_TIMEOUT_MS`. A test seam, for the same reason as `replyLingerMs`. */
  idleTimeoutMs?: number;
}

export interface BusEndpoint {
  pipePath: string;
  tokenPath: string;
}

/**
 * How long a replied-to connection may linger before we take it back.
 *
 * Generous on purpose: the reply is already flushed by `end()`, so this is not
 * a delivery deadline — it is only the window in which a well-behaved child
 * closes its own side. Anything shorter would be racing a child that is merely
 * busy, for no gain.
 */
export const REPLY_LINGER_MS = 5_000;

/**
 * How long a connection may sit without completing a request.
 *
 * A child connects and writes immediately — `askHost` does both in the same
 * tick — so this is generous by orders of magnitude for the legitimate case and
 * still bounds the one that is not.
 */
export const IDLE_TIMEOUT_MS = 10_000;

/** What a child gets back. `ok:false` carries a reason the AGENT will read. */
type HostReply = { ok: true; callerId: string; sessions: unknown } | { ok: false; reason: string };

interface Registration {
  token: string;
  server: net.Server;
  endpoint: BusEndpoint;
  /** Live connections on THIS session's endpoint, so teardown drops its own
   *  children and nobody else's. A single host-wide set would have made one
   *  session closing cut every other session's in-flight tool call. */
  sockets: Set<net.Socket>;
}

export class BusHost {
  private readonly bySession = new Map<string, Registration>();
  /** token → sessionId. The only thing that decides who is calling. */
  private readonly byToken = new Map<string, string>();
  /** Registrations that have started and not yet landed in `bySession`. */
  private readonly pending = new Map<string, Promise<BusEndpoint>>();
  /** Sessions torn down while their registration was still in flight. */
  private readonly cancelled = new Set<string>();

  constructor(private readonly opts: BusHostOptions) {}

  /**
   * Mint this session's token and open its endpoint.
   *
   * Idempotent per session, and idempotent ACROSS AN IN-FLIGHT CALL — the
   * second half is the part review had to find, because every test awaited the
   * first call before making the second and so could not see it.
   * `SessionManager`'s restart paths call teardown and setup in orders that are
   * not always obvious, and two overlapping registrations used to: both miss
   * the map (which is written after the await), both mint a token, the second
   * OVERWRITE the token file, then fail `listen` with `EADDRINUSE` — leaving
   * the file holding a token that is in no map. Every `list_sessions` for that
   * session then answered "not authorized" for the rest of its life, with
   * nothing in any log to explain it.
   *
   * So the in-flight promise is the memo, not the map.
   */
  registerSession(sessionId: string): Promise<BusEndpoint> {
    const existing = this.bySession.get(sessionId);
    if (existing) return Promise.resolve(existing.endpoint);
    const inFlight = this.pending.get(sessionId);
    if (inFlight) return inFlight;
    const opening = this.openEndpoint(sessionId).finally(() => {
      this.pending.delete(sessionId);
      this.cancelled.delete(sessionId);
    });
    this.pending.set(sessionId, opening);
    return opening;
  }

  private async openEndpoint(sessionId: string): Promise<BusEndpoint> {
    const pipePath = busPipePath(sessionId);
    const tokenPath = busTokenPath(this.opts.stateDir, sessionId);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => this.serve(sessionId, sock, sockets));
    // A listener that throws after `listen` resolves would otherwise reach the
    // process's uncaught handler and take the app down over a broken pipe.
    server.on('error', (err) =>
      this.opts.log.warn('bus endpoint error', { sessionId, error: String(err) })
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(pipePath, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (err) {
      // NOTHING PARTIAL SURVIVES A FAILED OPEN. The token file is deliberately
      // not written until after this point, so there is nothing on disk to
      // strip; the listener is the only thing to reclaim.
      try {
        server.close();
      } catch {
        /* never listened */
      }
      // Rethrown rather than swallowed into a null endpoint: "this session has
      // no bus" and "this session's bus failed to open" are different facts,
      // and only the caller knows whether a session should still start. #763
      // owns that decision (P6 says it must start anyway) and MUST catch this.
      throw new Error(`could not open the session bus endpoint: ${String(err)}`);
    }

    // `/tmp` is world-writable on Linux, so the socket file is narrowed the
    // moment it exists. Best-effort: the token is what actually decides, and a
    // filesystem that cannot chmod is not a reason to deny the session its bus.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(pipePath, 0o600);
      } catch (err) {
        this.opts.log.warn('could not restrict the bus socket file', { sessionId, error: String(err) });
      }
    }

    // THE TOKEN FILE IS WRITTEN LAST, once there is an endpoint it can open.
    // Written first, a failed `listen` left a live credential on disk for a
    // listener that never existed.
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    const token = crypto.randomBytes(32).toString('hex');
    // mode 0600 is a no-op on Windows; the real protection there is stateDir
    // living under the user profile (same-user ACL). Same reasoning, same
    // shape, and the same sentence as `HookListener.registerSession` — this is
    // deliberately the second instance of one pattern, not a new one.
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });

    const endpoint = { pipePath, tokenPath };

    // TEARDOWN LANDED WHILE WE WERE OPENING. `unregisterSession` found nothing
    // in `bySession` — it is not written until the line below — so it returned
    // early and did nothing. Without this check the registration would then
    // complete and install a live endpoint and a live token for a session that
    // no longer exists, contradicting this class's own "the token leaves memory
    // first" invariant and leaving both until app quit.
    if (this.cancelled.has(sessionId)) {
      this.opts.log.info('bus endpoint discarded — the session was torn down while it was opening', {
        sessionId,
      });
      try {
        server.close();
      } catch {
        /* nothing to close */
      }
      this.removeTokenFile(sessionId);
      this.removeSocketFile(pipePath);
      throw new Error('the session was torn down while its bus endpoint was opening');
    }

    this.bySession.set(sessionId, { token, server, endpoint, sockets });
    this.byToken.set(token, sessionId);
    this.opts.log.info('bus endpoint up', { sessionId });
    return endpoint;
  }

  /**
   * Close this session's endpoint and kill its token.
   *
   * Order matters, and it is `HookListener.unregisterSession`'s: the token
   * leaves memory FIRST, so nothing can authenticate for the moments the
   * listener takes to close. Everything after that is hygiene.
   */
  unregisterSession(sessionId: string): void {
    // Mark FIRST, and unconditionally. A teardown that arrives while
    // `openEndpoint` is awaiting `listen` finds nothing in `bySession` and
    // would otherwise be a silent no-op that the in-flight registration then
    // undoes by installing a live endpoint for a dead session.
    if (this.pending.has(sessionId)) this.cancelled.add(sessionId);
    const reg = this.bySession.get(sessionId);
    if (!reg) return;
    this.byToken.delete(reg.token);
    this.bySession.delete(sessionId);
    try {
      reg.server.close();
    } catch (err) {
      this.opts.log.warn('could not close the bus endpoint', { sessionId, error: String(err) });
    }
    // `close()` stops new connections but leaves established ones running, and
    // a child mid-call would otherwise hold the handle open indefinitely. It
    // gets the dead-host path, which is a path it is built for. THIS session's
    // connections only — a sibling mid-call is none of this teardown's business.
    for (const sock of reg.sockets) sock.destroy();
    this.removeTokenFile(sessionId);
    this.removeSocketFile(reg.endpoint.pipePath);
  }

  /** Every endpoint down. Called on app quit. */
  stop(): void {
    for (const sessionId of [...this.bySession.keys()]) this.unregisterSession(sessionId);
  }

  /** The endpoint for a session, if it has one. #763 needs this to write the config. */
  endpointFor(sessionId: string): BusEndpoint | null {
    return this.bySession.get(sessionId)?.endpoint ?? null;
  }

  private removeTokenFile(sessionId: string): void {
    try {
      fs.unlinkSync(busTokenPath(this.opts.stateDir, sessionId));
    } catch (err) {
      // ENOENT is ordinary — a session torn down before it ever registered, or
      // one whose whole state directory `SessionManager` already removed (#290).
      // A crash leaves the file behind, and it is INERT: tokens live in memory,
      // so nothing on disk can authenticate against a process that is gone, and
      // #290's directory sweep takes it in the end. That is why there is no
      // start-up sweep here to match `HookListener`'s (#282).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.opts.log.warn('could not remove the bus token file', { sessionId, error: String(err) });
      }
    }
  }

  private removeSocketFile(pipePath: string): void {
    // Windows named pipes are kernel objects — the last handle closing drops
    // them and there is no file to unlink. A unix socket leaves a real file
    // that would block the next `bind` on the same derived name, which is
    // exactly what a session restart does.
    if (process.platform === 'win32') return;
    try {
      fs.unlinkSync(pipePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.opts.log.warn('could not remove the bus socket file', { error: String(err) });
      }
    }
  }

  /**
   * Serve one child connection: authenticate, answer ONCE, close.
   *
   * ONE REQUEST PER CONNECTION, enforced rather than assumed. This used to keep
   * reading after `reply()`, and all three consequences were real: a child that
   * pipelined N lines in one chunk ran N synchronous `listSessions()` calls on
   * Electron's MAIN THREAD; the second `reply()` was a write-after-end, which
   * emits `'error'`, which the handler below turns into `destroy()` — and
   * `destroy` discards buffered writes, so the reply we had already sent could
   * be truncated into exactly the bare close that `reply()` exists to avoid;
   * and each `reply()` added another `'close'` listener, so past ten the app
   * logged a MaxListeners warning out of main. The oversized-line path walked
   * straight through all of it, passing only because a 45-byte reply usually
   * flushes before the next chunk arrives.
   */
  private serve(sessionId: string, sock: net.Socket, sockets: Set<net.Socket>): void {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // A child that dies mid-write is not the host's problem, but an unhandled
    // 'error' on a socket is a process-level crash.
    sock.on('error', () => sock.destroy());

    // AN IDLE DEADLINE, because a raw `net.Server` has none. The precedent this
    // mirrors got it for free: `HookListener` is an `http.Server`, which brings
    // `headersTimeout`/`requestTimeout` defaults with it. A connection that
    // opens and never sends a byte would otherwise sit in `sockets` until the
    // session ends — and the endpoint is reachable by any process running as
    // this user, which is precisely the case worth bounding.
    sock.setTimeout(this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    sock.on('timeout', () => {
      this.opts.log.debug('bus connection idle — dropping it', { sessionId });
      sock.destroy();
    });

    const reader = new LineReader(MAX_LINE_BYTES);
    sock.setEncoding('utf8');
    let replied = false;
    sock.on('data', (chunk: string) => {
      if (replied) return;
      for (const line of reader.feed(chunk)) {
        replied = true;
        // `pause` before the answer: nothing after the first complete request
        // on this connection is ours to act on, and a paused socket cannot
        // deliver another 'data' event while we are answering this one.
        sock.pause();
        this.reply(sock, this.answer(sessionId, line));
        return;
      }
      if (reader.hasOverflowed()) {
        this.opts.log.warn('bus client exceeded the frame limit — dropping it', { sessionId });
        replied = true;
        sock.pause();
        this.reply(sock, { ok: false, reason: 'the request was too large' });
      }
    });
  }

  /**
   * Answer, or REFUSE WITH A REASON and hang up.
   *
   * Refusing in silence would be marginally tidier from a security point of
   * view and is the wrong trade: the child would then wait out its full
   * deadline for a verdict we already reached, which is the stall this channel
   * is built to avoid. Say no, immediately, and drop the connection.
   *
   * SYNCHRONOUS, because every answer it can give today is. #764 adds
   * `get_session_diff`, which is not — that item turns this async and takes the
   * ordering question with it, rather than this one carrying an `await` it does
   * not use in case somebody needs it later.
   */
  private answer(sessionId: string, line: string): HostReply {
    let req: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      req = parsed as Record<string, unknown>;
    } catch {
      this.opts.log.warn('bus request unparseable', { sessionId });
      return { ok: false, reason: 'the request could not be read' };
    }

    const caller = this.callerFor(req.token);
    if (!caller) {
      this.opts.log.warn('bus request rejected: invalid token', { sessionId });
      return { ok: false, reason: 'not authorized' };
    }
    // The token is valid but belongs to a DIFFERENT session than the endpoint
    // it arrived on. Not reachable today — each endpoint's name is a digest of
    // its own session id — but "reachable today" is not the property worth
    // relying on when the answer would be another session's data. Both facts
    // have to agree.
    if (caller !== sessionId) {
      this.opts.log.error('bus token presented on another session endpoint', {
        sessionId,
        callerId: caller,
      });
      return { ok: false, reason: 'not authorized' };
    }

    // The version stamp, actually READ. It was decorative until review pointed
    // out nothing inspected it — a stamp no receiver checks is a compatibility
    // story rather than a compatibility mechanism, and #764 was going to widen
    // the payload and discover the gate had never existed. Checked AFTER auth,
    // so an unauthenticated client learns nothing about our versioning.
    if (req.v !== CHANNEL_VERSION) {
      this.opts.log.warn('bus request with an unknown channel version', { sessionId, version: req.v });
      return { ok: false, reason: `unsupported bus protocol version: ${String(req.v)}` };
    }

    if (!isBusOp(req.op)) {
      return { ok: false, reason: `unknown request: ${String(req.op)}` };
    }
    // #761's module owns the answer and the caps; this is transport, not
    // policy. `listSessions` never throws by contract — the try is because that
    // contract belongs to a module this one does not own, and a throw here
    // would take down Electron main from a child's request.
    try {
      const result = this.opts.queries.listSessions();
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, callerId: caller, sessions: result.value };
    } catch (err) {
      this.opts.log.error('session query threw on the bus path', { sessionId, error: String(err) });
      return { ok: false, reason: 'the session list is unavailable' };
    }
  }

  /**
   * Resolve a presented token to a session id, in constant time.
   *
   * `timingSafeEqual` over every live token rather than a map lookup: a `Map`
   * hit/miss is not constant-time, and the tokens are 32 bytes of randomness
   * guarding another session's transcript contents. The loop is over live
   * sessions — tens — on a path a child hits once per tool call.
   *
   * DELIBERATELY UNLIKE `hook-listener.ts`'s `this.tokens.get(token)`, which is
   * a plain map lookup. That is not an oversight there or an inconsistency
   * here: a hook token gates *status events about your own session*, this one
   * gates *reading another session's work*. Noting the divergence so it does
   * not later read as an accident and get "tidied" into a lookup.
   */
  private callerFor(presented: unknown): string | null {
    if (typeof presented !== 'string' || presented === '') return null;
    const given = Buffer.from(presented);
    let found: string | null = null;
    for (const [token, sessionId] of this.byToken) {
      const known = Buffer.from(token);
      // Length is not a secret and `timingSafeEqual` throws on a mismatch.
      if (known.length !== given.length) continue;
      if (crypto.timingSafeEqual(known, given)) found = sessionId;
    }
    return found;
  }

  /**
   * One request, one reply, one connection.
   *
   * `end(payload)` rather than `write` then `destroy`: `destroy` tears the
   * socket down without waiting for the write to flush, so a refusal could be
   * delivered as a bare close — and a bare close is indistinguishable, at the
   * child, from a host that died. The child would then report "the host closed
   * the connection without answering" for a request we in fact answered
   * precisely. `end` flushes, then FINs.
   */
  private reply(sock: net.Socket, reply: HostReply): void {
    try {
      sock.end(JSON.stringify(reply) + '\n');
    } catch (err) {
      this.opts.log.debug('bus reply could not be written', { error: String(err) });
      sock.destroy();
      return;
    }
    // `end` is a HALF-close: we have sent our FIN, and a peer that never sends
    // its own leaves this socket held open indefinitely. A well-behaved child
    // destroys the moment it has read its answer, so this only ever fires for
    // one that does not — which is exactly the case worth bounding, since the
    // endpoint is reachable by any process running as this user.
    //
    // POSIX ONLY IN PRACTICE, measured 2026-09-08: on a Windows named pipe the
    // server socket fully closes ~67ms after `end()` even against a peer that
    // is `allowHalfOpen` and never closes, so 'close' clears this timer before
    // it can fire. Kept unconditional anyway — a platform check here would be a
    // second place for the two behaviours to drift, and an unfired timer costs
    // nothing.
    const reclaim = setTimeout(() => sock.destroy(), this.opts.replyLingerMs ?? REPLY_LINGER_MS);
    reclaim.unref?.();
    sock.on('close', () => clearTimeout(reclaim));
  }
}
