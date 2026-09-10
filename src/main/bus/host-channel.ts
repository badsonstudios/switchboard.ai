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
import { busEndpointFor, busTokenPath } from './bus-paths';
import { busLaunch, type BusLaunch } from './launch';
import { CHANNEL_VERSION, MESSAGE_ARG, SESSION_ARG, isBusOp } from './channel';
import { LineReader, MAX_LINE_BYTES } from './protocol';
import type { Logger } from '../log/logger';
import type { SessionQueries } from '../sessions/queries';
import type { BusDelivery } from '../sessions/delivery';

/**
 * Just enough of `SessionQueries` to be callable with a test double.
 *
 * WIDENED BY #764 RATHER THAN RE-DECLARED, which is the point of the `Pick`:
 * `main/index.ts` passes a whole `SessionQueries` and needed no edit, and a
 * method dropped from the query core is a typecheck failure here rather than a
 * tool that answers "unknown request" at runtime.
 */
export type BusQueries = Pick<SessionQueries, 'listSessions' | 'sessionOutput' | 'sessionDiff'>;

export interface BusHostOptions {
  /** Same directory `HookListener` writes `hook-token` into. */
  stateDir: string;
  queries: BusQueries;
  /**
   * Where `send_to_session` goes (#765) — the delivery POLICY lives there, not
   * here, for the reason every answer lives in `SessionQueries`: this file is
   * transport.
   *
   * REQUIRED, not optional, and that was a choice. Its only production caller
   * is `main/index.ts`, which has no tests; an optional field there could be
   * left out and the app would ship a `send_to_session` that refuses every
   * call, with the whole suite green. Required makes that a compile error.
   */
  delivery: BusDelivery;
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
  /** How long the host gives its own answer. Absent = `ANSWER_DEADLINE_MS`.
   *  A test seam: the real value is twelve seconds, which no unit test may
   *  wait out, and fake timers do not drive libuv over a real socket. */
  answerDeadlineMs?: number;
  /** The socket backstop behind that race. Absent = `ANSWER_BACKSTOP_MS`. */
  answerBackstopMs?: number;
  /**
   * Where the COMPILED bus server is. Absent = resolve it (`busServerPath`).
   *
   * A seam, and unlike the two above it is not only for tests: `busServerPath`
   * answers from `__dirname` against the BUILD OUTPUT, so under vitest — which
   * runs the TypeScript in `src/` — it correctly finds nothing and throws. That
   * would make `attachSession` answer `null` in every unit test, i.e. the whole
   * attach path would be untestable while looking fine, which is precisely the
   * "a platform-skipped test is an unrun test" failure #762 ended on.
   *
   * Production passes nothing and resolves for real.
   */
  busServerPath?: string;
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

/**
 * How long the host gives its OWN answer before saying so (#764 review).
 *
 * A different deadline with a different motive from `IDLE_TIMEOUT_MS`, which is
 * why it is a second constant rather than a reuse: that one bounds a client
 * that never speaks, this one bounds US. It exists because `answer()` can now
 * await `git`, `execFile` carries no timeout of its own, and a wedged git on an
 * unresponsive filesystem would otherwise hold a socket and a promise for the
 * life of the app — reachable deliberately, and repeatedly, by anything that
 * can read the token.
 *
 * Sized against a measurement rather than a feeling: `git diff` on this
 * repository (a ~97 KB diff, Windows, warm) runs ~370 ms, and `sessionDiff`
 * makes three git calls, so a realistic worst case is one to two seconds and a
 * genuinely enormous repository is several. 12 s sits well above that and BELOW
 * the 15 s the child allows a diff, so the host's own message — which knows
 * what it was doing — is the one that normally reaches the model.
 */
export const ANSWER_DEADLINE_MS = 12_000;

/**
 * The socket's backstop while we work — deliberately slack.
 *
 * The race in `answerAndReply` is what should fire; this catches only the case
 * where that machinery itself did not, and it must never be the thing that
 * pre-empts a working answer.
 */
export const ANSWER_BACKSTOP_MS = ANSWER_DEADLINE_MS * 2;

/**
 * What a child gets back. `ok:false` carries a reason the AGENT will read.
 *
 * ONE FIELD PER OP RATHER THAN A UNIFORM `data`, decided in #764. Folding
 * `list_sessions`'s `sessions` into a shared envelope would have been tidier
 * and would have changed a wire shape that works, for nothing a reader gains —
 * the discriminant a consumer actually switches on is the OP IT SENT, which it
 * already knows. Additive means the only way to get this wrong is to read a
 * field that is absent, which is `undefined` and renders as the empty answer.
 */
type HostReply =
  | { ok: true; callerId: string; sessions: unknown }
  | { ok: true; callerId: string; output: unknown }
  | { ok: true; callerId: string; diff: unknown }
  | { ok: true; callerId: string; delivery: unknown }
  /**
   * `uncertain` (#765 review): this refusal is "I gave up waiting", not "the
   * answer is no". For a read the two cost the same; for a WRITE they differ —
   * a send the host stopped waiting on may already be in a composer — so the
   * child must not render it as "NOT delivered".
   */
  | { ok: false; reason: string; uncertain?: true };

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
    // THE SAME DERIVATION #763's `--mcp-config` writer uses, deliberately (see
    // `busEndpointFor`). The config file naming one path while this binds
    // another would surface as a child dialling an address nothing listens on —
    // a tool that times out with both sides individually looking correct.
    const { pipePath, tokenPath } = busEndpointFor(this.opts.stateDir, sessionId);
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

  /**
   * Give back what `attachSession` took, for a session that never started.
   *
   * Deliberately the same body as `unregisterSession` and deliberately a
   * different NAME — exactly the shape `HookListener.releaseHookSettings` has
   * over its own `unregisterSession`, and for the same reason: a session dies
   * the same death whether it ran or never got off the ground, but the CALLER
   * is answering a different question, and a call site reading
   * `unregisterSession` inside `abandonStart` invites "was this session ever
   * registered?" every time it is read.
   *
   * Idempotent and safe for an id that never attached, which is what makes it
   * callable from a cleanup path that cannot know how far the start got.
   */
  releaseSession(sessionId: string): void {
    this.unregisterSession(sessionId);
  }

  /** Every endpoint down. Called on app quit. */
  stop(): void {
    for (const sessionId of [...this.bySession.keys()]) this.unregisterSession(sessionId);
  }

  /** The endpoint for a session, if it has one — i.e. one that is really listening. */
  endpointFor(sessionId: string): BusEndpoint | null {
    return this.bySession.get(sessionId)?.endpoint ?? null;
  }

  /**
   * Attach this session to the bus and hand back how to launch its server
   * (P2-E11-03) — SYNCHRONOUSLY, which is the whole point.
   *
   * ── WHY THIS DOES NOT AWAIT `registerSession` ──────────────────────────────
   *
   * Its only caller runs inside `SessionManager.create`, which is synchronous
   * end to end and must stay that way. `sessions/ipc.ts` documents one reason
   * (no `await` between `bindLive` and `persist.upsert`, or the renderer pulls a
   * live binding whose card is not written yet); planning #763 found a worse
   * one — an `await` anywhere before `create` lets two lazy-spawn calls both
   * pass the reap, which breaks ONE LIVE SESSION PER CARD (P2-E15-08), and the
   * grid's spawn effect firing twice on remount is an ordinary path, not a
   * contrived one.
   *
   * So the registration is STARTED here and not waited on. That is sound rather
   * than hopeful, for two reasons that are both properties of merged code:
   *
   *   1. The endpoint's paths are DERIVED, not discovered (`busEndpointFor`), so
   *      the config can name them before anything listens.
   *   2. The child does not connect at spawn. `pipe-client.ts` reads the token
   *      file and dials inside `askHost` — at the first TOOL CALL, seconds
   *      later at the very least — while the promise below settles on the next
   *      tick of the loop.
   *
   * ── AND WHY A FAILURE STILL RETURNS A LAUNCH ───────────────────────────────
   *
   * `registerSession` rejects rather than resolving null (#762's deliberate
   * choice: only the caller knows whether a session should still start). It is
   * caught here and the session gets its config anyway, because the alternative
   * failure modes are worse than the one this leaves. A bus that never opened
   * makes `list_sessions` answer with a readable error — the dead-host path
   * #762 built and timed — whereas withholding the config would make the tool
   * VANISH, and an agent cannot report the absence of something it was never
   * offered. P6: our breakage degrades the session, it does not shape it.
   */
  attachSession(sessionId: string): BusLaunch | null {
    let launch: BusLaunch;
    try {
      // Throws only if the compiled server is missing (`busServerPath`), which
      // is a broken build, not a runtime condition — and is exactly the case
      // where attaching nothing is right: there is no server to reach.
      // A plain pass-through: `busLaunch`'s default parameter fires exactly when
      // this is `undefined`, so production resolves for real. (An earlier
      // version spread a conditional array here to "avoid passing undefined on",
      // which review correctly called a no-op with an incorrect comment
      // attached — the worst kind, since it invites the next reader to preserve
      // a subtlety that was never there.)
      launch = busLaunch(
        sessionId,
        busEndpointFor(this.opts.stateDir, sessionId),
        this.opts.busServerPath
      );
    } catch (err) {
      this.opts.log.error('the session bus could not be attached', {
        sessionId,
        error: String(err),
      });
      return null;
    }
    void this.registerSession(sessionId).catch((err: unknown) => {
      // The session is already starting by the time this lands. Nothing to
      // unwind and nobody to tell but the log — the agent finds out the honest
      // way, by calling a tool that answers with a reason.
      //
      // A TEARDOWN THAT RACED THE OPEN IS NOT A FAULT. `openEndpoint` rejects
      // with this exact message when `unregisterSession` arrived mid-flight,
      // which is an ordinary restart, so logging it at `error` would put
      // "this session has no siblings" in front of the user on a path where
      // nothing went wrong (review of #763).
      const cancelled = String(err).includes('torn down while its bus endpoint was opening');
      const level = cancelled ? 'info' : 'error';
      this.opts.log[level](
        cancelled
          ? 'bus attach abandoned — the session was torn down while it was opening'
          : 'the session bus endpoint failed to open — this session has no siblings',
        { sessionId, error: String(err) }
      );
    });
    return launch;
  }

  /**
   * How many connections this session's endpoint is currently holding.
   *
   * Exists because the reclaim below is otherwise UNOBSERVABLE from outside.
   * The first version of its test watched the client for a 'close' — which a
   * client cannot see: an `allowHalfOpen` socket stays up by its own choice no
   * matter what the peer does, so the assertion could never pass on posix and
   * the test failed on its first-ever run (Linux CI; it is `runIf(posix)` and
   * had been skipped on Windows). The thing that actually matters is that the
   * HOST let go of the handle, and that is what this reports.
   */
  connectionCount(sessionId: string): number {
    return this.bySession.get(sessionId)?.sockets.size ?? 0;
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
        // THE IDLE DEADLINE IS DONE ITS JOB — SWAP IT, DO NOT DROP IT (#764).
        // It exists to bound a connection that opens and never sends a byte,
        // and this one has now sent a whole request. Left as it was it becomes
        // something else entirely once `answer` can await: `get_session_diff`
        // shells out to `git diff` against a folder ANOTHER AGENT is writing,
        // and a socket with no traffic on it is exactly what a slow diff looks
        // like — so `destroy()` mid-answer would reach the model as
        // "switchboard could not be reached", a confident wrong answer about
        // our own availability for a request that was about to succeed.
        //
        // ⚠️ The first cut of this cleared the deadline outright
        // (`setTimeout(0)`), which review correctly called a hole rather than a
        // fix: between reading a request and writing a reply the host then had
        // NO bound at all, so a query that never settles — a wedged `git`, an
        // unresponsive filesystem — held a socket and a promise until the app
        // quit, and anything that could read the token could do it on purpose.
        // The right answer is a longer, differently-motivated deadline, not
        // none. `answerAndReply` owns what happens when it fires.
        sock.setTimeout(this.opts.answerBackstopMs ?? ANSWER_BACKSTOP_MS);
        void this.answerAndReply(sessionId, sock, line);
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
   * Await the answer, then reply — if there is still anybody to reply to.
   *
   * ── THE ORDERING QUESTION #762 LEFT TO #764 ─────────────────────────────────
   *
   * `answer` became async here, and an await opens a window that did not exist
   * before: between the request arriving and the reply being written, the
   * session can be torn down (`unregisterSession` destroys every socket on its
   * endpoint) or the child can give up on its own 5-second deadline and destroy
   * its end. Both are ORDINARY, not exotic — a restart during a long diff is
   * the daily case.
   *
   * Writing to a destroyed socket is not a throw `reply`'s try/catch would
   * catch; it is an asynchronous `'error'` event, which the handler in `serve`
   * turns into another `destroy()`, and the log line it leaves behind describes
   * a fault that did not happen. So the socket is checked after the await
   * rather than after the fact.
   *
   * `answer` never rejects by contract — every arm catches — but this catches
   * anyway, because that contract belongs to a method a future op will edit and
   * an unhandled rejection out of Electron main is a worse way to find out.
   */
  private async answerAndReply(sessionId: string, sock: net.Socket, line: string): Promise<void> {
    let reply: HostReply;
    try {
      reply = await this.withDeadline(sessionId, this.answer(sessionId, line));
    } catch (err) {
      this.opts.log.error('bus answer threw', { sessionId, error: String(err) });
      // `uncertain`: a throw says nothing about how far a WRITE got.
      reply = { ok: false, reason: 'switchboard could not answer this request', uncertain: true };
    }
    if (sock.destroyed) {
      // Not a warning. The child hanging up is how a cancelled tool call looks
      // from here, and a session torn down mid-call is a restart.
      this.opts.log.debug('bus client went away before its answer was ready', { sessionId });
      return;
    }
    this.reply(sock, reply);
  }

  /**
   * Bound our own answer, and SAY SO rather than going quiet.
   *
   * Resolving to a refusal instead of rejecting is the point: the alternative
   * is letting the socket backstop destroy the connection, which reaches the
   * child as a bare close and reaches the model as "the host closed the
   * connection without answering" — true, and useless. This says which
   * operation ran long, from the only layer that knows.
   *
   * ⚠️ It does NOT cancel the work. `execFile` is already running and will
   * finish or hang on its own; what this bounds is how long the socket, the
   * connection slot and the agent's turn are held hostage to it. Killing the
   * child git is a bigger question than this item, and pretending otherwise in
   * a comment is how the next reader stops looking.
   */
  private withDeadline(sessionId: string, work: Promise<HostReply>): Promise<HostReply> {
    const ms = this.opts.answerDeadlineMs ?? ANSWER_DEADLINE_MS;
    return new Promise<HostReply>((resolve) => {
      const timer = setTimeout(() => {
        this.opts.log.warn('a bus answer exceeded its deadline', { sessionId, ms });
        resolve({
          ok: false,
          reason: `switchboard took longer than ${Math.round(ms / 1000)}s to gather this and gave up`,
          // Unreachable for a send today — `DELIVERY_ACK_TIMEOUT_MS` (8 s)
          // settles first — and marked anyway, because "today" is an ordering
          // of two constants in two files, not a property of this code.
          uncertain: true,
        });
      }, ms);
      timer.unref?.();
      work.then(
        (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.opts.log.error('bus answer rejected', { sessionId, error: String(err) });
          resolve({ ok: false, reason: 'switchboard could not answer this request', uncertain: true });
        }
      );
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
   * ASYNC SINCE #764, which is what `get_session_diff` costs: it shells out to
   * git. Everything before the dispatch at the foot of this method is still
   * synchronous and still runs before any await — parse, authenticate, version,
   * vocabulary — so a request that is going to be refused is refused in the
   * same tick it arrived in, and only a request we are actually going to answer
   * can hold the connection open. `answerAndReply` owns what the await window
   * costs.
   */
  private async answer(sessionId: string, line: string): Promise<HostReply> {
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
    const op = req.op;
    // TORN DOWN WHILE THIS WAS IN THE PIPE. Cheap, and it matters more now that
    // an answer can read a 4 MB transcript or shell out to git: without it a
    // session ending mid-request still pays for the whole answer, for a socket
    // that is already gone.
    if (!this.bySession.has(sessionId)) {
      return { ok: false, reason: 'this session is shutting down' };
    }
    // The MCP tool's own arguments, exactly as the model wrote them. NOT
    // validated here beyond being an object: `SessionQueries.resolve` type-
    // guards `ref` itself and refuses with a reason an agent can act on, and a
    // second validator at this layer would be a second answer to one question —
    // the drift `queries.ts` exists to prevent.
    const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args)
      ? (req.args as Record<string, unknown>)
      : {};
    // A CAST OVER A GUARD WE DELIBERATELY DO NOT WRITE. `ref` really can be a
    // number, an object or absent — it is JSON a language model composed — and
    // `SessionQueries.resolve` type-guards it there, refusing with a reason
    // that names the sessions which DO exist. A second check here would refuse
    // with a worse reason and put one question's answer in two places.
    const ref = args[SESSION_ARG] as string;

    // #761's module owns every answer and every cap; this is transport, not
    // policy. The queries never throw by contract — the try is because that
    // contract belongs to a module this one does not own, and a throw here
    // would take down Electron main from a child's request.
    try {
      switch (op) {
        case 'list_sessions': {
          const result = this.opts.queries.listSessions();
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, callerId: caller, sessions: result.value };
        }
        case 'get_session_output': {
          // `lastN` goes through UNTOUCHED, including when it is absent or
          // nonsense. `sessionOutput` clamps it to `MAX_LAST_N` and falls back
          // to `DEFAULT_LAST_N`, and doing any of that here would put the cap
          // in two places — which is the one thing #761's done-when forbids and
          // the reason "thin" is this item's requirement rather than its taste.
          const result = this.opts.queries.sessionOutput(ref, args.lastN as number | undefined);
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, callerId: caller, output: result.value };
        }
        case 'get_session_diff': {
          // THE ONLY AWAIT ON THIS PATH, and the reason the method is async.
          const result = await this.opts.queries.sessionDiff(ref);
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, callerId: caller, diff: result.value };
        }
        case 'send_to_session': {
          // `caller`, from the TOKEN — never anything the child said about
          // itself. It is who the message will be attributed to in the target's
          // composer, so it is the one argument here that must not be a claim.
          // The message itself goes through untouched; `SiblingDelivery` owns
          // every check on it, for the reason `ref` is not validated here.
          const result = await this.opts.delivery.send(caller, ref, args[MESSAGE_ARG]);
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, callerId: caller, delivery: result.value };
        }
        default: {
          // Exhaustive over `BusOp` — `isBusOp` gated it above, so TypeScript
          // narrows `op` to `never` here. A word added to `BUS_OPS` with no case
          // for it is therefore a COMPILE error rather than a tool that reaches
          // the host and is told it does not exist.
          const unhandled: never = op;
          return { ok: false, reason: `unknown request: ${String(unhandled)}` };
        }
      }
    } catch (err) {
      this.opts.log.error('session query threw on the bus path', { sessionId, op, error: String(err) });
      // `uncertain` for the reason the deadline's refusal carries it: a throw
      // after a successful submit is a write that WENT, reported as a failure.
      return { ok: false, reason: `switchboard could not answer ${op}`, uncertain: true };
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
