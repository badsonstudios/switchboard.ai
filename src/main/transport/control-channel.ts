// The outbound control_request channel (#721) — the missing half of stream-json.
//
// WHAT WAS MISSING, precisely. We have always been able to WRITE a control
// request (`StreamSession.send`, and `SessionManager.interrupt` has sent one
// since #154) and always been able to READ messages (`onStreamMessage`). What
// did not exist was the thing between them: allocate an id, remember who is
// waiting, match the reply back to them, and give up rather than hang. That is
// this file, and it is the whole of it — ~200 lines that unblock the GUI model
// picker (#633), the MCP toggle/reconnect (#714's follow-up) and the per-session
// context percentage (#715), none of which need a transport of their own.
//
// ── WHY IT DOES NOT LIVE ON StreamSession ────────────────────────────────────
//
// It could. It does not, because `StreamService`/`StreamSession` are
// deliberately electron-free, logger-free and protocol-free: they move NDJSON
// and count framing failures, and they do not know what a `control_request` is.
// Teaching them would put Claude Code's protocol vocabulary inside the generic
// transport, which is exactly the seam `SessionTransport` exists to keep clean.
// So this sits above, talks to a narrow port, and is driven in tests without a
// child process anywhere near it.
//
// ── THE RULES IT INHERITS ────────────────────────────────────────────────────
//
//  * **It resolves a verdict; it never rejects.** Same contract as
//    `mcp/health.ts` and `mcp/cli.ts`. A caller that has to wrap every call in
//    try/catch grows a swallowed catch eventually, and this channel's whole
//    point is telling the surface WHY it cannot do something.
//  * **Fail-open (P6).** An unsupported subtype on a future CLI must degrade
//    the surface and leave the session alive. Measured: an unknown verb answers
//    `Unsupported control request subtype: …` as an ordinary error and the
//    session carries on.
//  * **The PTY has no control channel at all.** Decided once, here, rather than
//    per feature (#721's own constraint): `not-stream` is a first-class verdict
//    and every consumer gets the same honest answer.
import { readControlResponse, type StreamControlRequest } from '../../shared/stream-protocol';
import type { ControlVerdict } from '../../shared/control';

// The verdict types live in `shared/control.ts` — they cross IPC, so main, the
// preload and the renderer all declare from one place. Re-exported here so a
// main-side consumer needs one import, not two.
export type { ControlFailure, ControlVerdict } from '../../shared/control';

/**
 * The narrow slice of `SessionManager` this needs.
 *
 * A port rather than the manager itself, so the correlation logic is unit-tested
 * against two functions instead of a process tree. `send` returning `false` is
 * the transport gate: `SessionManager.sendToTransport` answers false when the
 * handle has no `send`, which is precisely the PTY.
 */
export interface ControlPort {
  send(sessionId: string, msg: unknown): boolean;
  onMessage(l: (sessionId: string, msg: Record<string, unknown>) => void): () => void;
}

/**
 * How long a control request gets.
 *
 * Generous by three orders of magnitude, on purpose. Measured round trips were
 * **0–2 ms, including while a turn was mid-reply** — the channel is not blocked
 * by an in-flight turn, so there is no such thing as a legitimately slow
 * control response. Anything approaching this bound is a session that has
 * stopped answering, and the number is large enough that nobody is tempted to
 * "fix" a flaky consumer by raising it.
 */
export const CONTROL_TIMEOUT_MS = 10_000;

interface Pending {
  sessionId: string;
  settle: (v: ControlVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlChannel {
  private readonly port: ControlPort;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: () => void;
  /**
   * One counter for the whole channel, so an id is unique ACROSS sessions and
   * `pending` can be a single flat map. `sb-` prefixed rather than a UUID
   * because these ids end up in logs and in a protocol trace, and `sb-7` tells
   * you at a glance that we sent it — a UUID tells you nothing and costs 36
   * characters per line. (`interrupt` still mints a UUID; it correlates
   * nothing, so it never needed to be readable.)
   */
  private seq = 0;

  constructor(port: ControlPort, opts: { timeoutMs?: number } = {}) {
    this.port = port;
    this.timeoutMs = opts.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.unsubscribe = port.onMessage((sessionId, msg) => this.ingest(sessionId, msg));
  }

  /**
   * Send one control request and wait for its answer.
   *
   * `build` is a FUNCTION of the id rather than a prepared object, so the
   * builders in `shared/stream-protocol.ts` own both the shape and the
   * validation. A builder that returns `null` has refused the arguments, and
   * nothing is written — that is the `invalid` verdict, and it is how the
   * measured `set_model`-with-no-field silent no-op is made impossible.
   */
  request(
    sessionId: string,
    build: (requestId: string) => StreamControlRequest | null
  ): Promise<ControlVerdict> {
    const requestId = `sb-${++this.seq}`;
    // GUARDED, because this function's contract is that it resolves a verdict
    // and NEVER rejects — and a builder is caller-supplied code. Today's
    // builders cannot throw, but the one that eventually validates something
    // richer than a string will, and a rejection here surfaces in the renderer
    // as an unhandled `ipcRenderer.invoke` rejection rather than as a verdict
    // the surface can draw. See `shared/ipc/refusal.ts` for why that matters.
    let msg: StreamControlRequest | null;
    try {
      msg = build(requestId);
    } catch {
      msg = null;
    }
    if (!msg) {
      return Promise.resolve({
        ok: false,
        reason: 'invalid',
        message: 'the request was missing something the CLI needs',
      });
    }

    return new Promise<ControlVerdict>((resolve) => {
      // REGISTERED BEFORE THE WRITE, and that ordering is the reason this class
      // does not carry the SDK's `unmatchedControlResponses` map.
      //
      // #721 suggested copying it "rather than rediscovering". It guards a real
      // race in the SDK, whose `request()` awaits initialisation before
      // registering — so a reply can genuinely beat its caller. Ours cannot:
      // the entry is in the map before `send` is called, and even a reply
      // parsed synchronously inside `send` would find it. Carrying a bounded
      // map for an unreachable case would be code nobody can test and everybody
      // has to reason about.
      const settle = (v: ControlVerdict): void => {
        const p = this.pending.get(requestId);
        // Identity, not just presence. Presence alone is correct only because
        // `seq` never reuses an id — a global invariant enforced nowhere near
        // here. Comparing the closure makes "this promise has already been
        // settled" a local fact.
        if (!p || p.settle !== settle) return; // already settled, or not ours
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        resolve(v);
      };
      const timer = setTimeout(
        () =>
          settle({
            ok: false,
            reason: 'timed-out',
            message: 'the session did not answer',
          }),
        this.timeoutMs
      );
      // `unref` so a pending control request can never be the reason the main
      // process refuses to exit. Node-only and absent under some test timers,
      // hence the guard.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(requestId, { sessionId, settle, timer });

      // The write is inside the try for the same reason `build` is: a transport
      // whose `send` throws must produce a verdict, not a rejection — and, worse
      // than the rejection, an armed pending entry that nobody is waiting on
      // any more. `StreamSession.send` swallows its own stdin errors today, so
      // this is one new transport away rather than reachable now.
      let delivered: boolean;
      try {
        delivered = this.port.send(sessionId, msg);
      } catch {
        delivered = false;
      }
      if (!delivered) {
        // No `send` on the handle. `SessionManager` has already ruled out the
        // session-is-gone case before delegating here (see its `listModels` /
        // `setModel`), so what is left is a transport that cannot carry a typed
        // message at all — the PTY.
        settle({
          ok: false,
          reason: 'not-stream',
          message: 'this session has no control channel',
        });
      }
    });
  }

  /**
   * Give up on everything a session had in flight (#700's `forgetSession`
   * pattern — `streamCommands` and `streamFeed` already have one, and
   * `tearDownLive` calls them before `manager.remove`).
   *
   * Without this a consumer awaiting a reply from a session the user just
   * closed waits the full timeout before finding out, and paints a "did not
   * answer" ten seconds after the card vanished. The timeout is the backstop
   * for a session that goes quiet; this is the fast path for one we KNOW is
   * gone.
   */
  forgetSession(sessionId: string): void {
    // `settle` owns the delete and the clearTimeout — deleting here first makes
    // it a no-op (it looks the entry up to prove it has not already settled) and
    // the caller waits for ever. Caught by its own test, which is the only
    // reason this comment exists.
    for (const [, p] of [...this.pending]) {
      if (p.sessionId !== sessionId) continue;
      p.settle({ ok: false, reason: 'session-gone', message: 'the session has stopped' });
    }
  }

  /** Pending count — for tests, and for asserting nothing leaks. */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * Unsubscribe and settle everything outstanding.
   *
   * NO PRODUCTION CALLER TODAY, and that is deliberate rather than an
   * oversight: `SessionManager` owns exactly one of these and lives as long as
   * the app, so there is nothing to dispose of before exit — and the pending
   * timers are `unref`'d, so an outstanding request cannot hold the process
   * open. It exists so that the class is not the reason a future
   * short-lived manager (a test host, a second window's worth of state) leaks a
   * listener into the fan-out.
   */
  dispose(): void {
    this.unsubscribe();
    // Same rule as `forgetSession`: let `settle` do the removal.
    for (const [, p] of [...this.pending]) {
      p.settle({ ok: false, reason: 'session-gone', message: 'the session has stopped' });
    }
  }

  private ingest(sessionId: string, msg: Record<string, unknown>): void {
    const parsed = readControlResponse(msg);
    if (!parsed) return; // not a control response, or one with no id we can use
    const p = this.pending.get(parsed.requestId);
    if (!p) return; // a reply to something we already gave up on, or never sent
    // THE SESSION HAS TO MATCH. Ids are unique across the channel, so a
    // mismatch cannot happen by accident — but the map is flat and the fan-out
    // is app-wide, so checking costs one comparison and removes the whole class
    // of "session A's answer resolved session B's request" from consideration.
    if (p.sessionId !== sessionId) return;
    p.settle(
      parsed.ok
        ? { ok: true, response: parsed.response }
        : {
            ok: false,
            reason: 'refused',
            // The CLI's own sentence, verbatim — see `readControlResponse`.
            // The fallback matters: an `error` subtype with no readable text
            // must still fail, not succeed with an empty message.
            message: parsed.error || 'the session refused the request',
          }
    );
  }
}
