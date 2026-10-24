// The outbound control_request channel (#721) — the missing half of stream-json.
//
// CLAUDE'S, AND BEHIND ITS ADAPTER since E40 item 04 (#1287): this was
// `main/transport/control-channel.ts`, one per `SessionManager`, listening to
// every session's frames. It is now one per SESSION, built by
// `claude-controls.ts` and fed that session's frames through
// `SessionControls.receive`. The class itself is unchanged — its port is still
// "send" and "subscribe" — so the correlation rules below, and their tests,
// stand as they were.
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
import { readControlResponse, type StreamControlRequest } from './claude-protocol';
import type { ControlVerdict } from '../../shared/control';

// The verdict types live in `shared/control.ts` — they cross IPC, so main, the
// preload and the renderer all declare from one place. Re-exported here so a
// main-side consumer needs one import, not two.
export type { ControlFailure, ControlVerdict } from '../../shared/control';

/**
 * The narrow slice of a session this needs (`claude-controls.ts` builds it
 * from the provider's `ControlSession`).
 *
 * A port rather than the manager itself, so the correlation logic is unit-tested
 * against two functions instead of a process tree. `send` returning `false` is
 * the transport gate: `SessionManager.sendToTransport` answers false when the
 * handle has no `send`.
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
 *
 * ONE VERB IS THE EXCEPTION, and it is an exception about the NETWORK, not the
 * session: see `MCP_AUTHENTICATE_TIMEOUT_MS`. Everything else keeps this.
 */
export const CONTROL_TIMEOUT_MS = 10_000;

/**
 * How long `mcp_authenticate` alone gets (#1425).
 *
 * THE ONE CONTROL VERB WHOSE ANSWER WAITS ON SOMEBODY ELSE'S SERVER. The CLI
 * answers once the server's authorisation side has produced a sign-in address
 * (discovery plus client registration — round trips to the internet), and
 * since #1420 the HOST opens the browser FROM that answer. So a slow
 * authorisation server is not a session that stopped answering: it is a
 * sign-in that would have worked, and under the global ten seconds its answer
 * arrived after we had given up and was dropped (`ingest`), with no browser
 * ever opening.
 *
 * Thirty seconds, not "as long as it takes": past this the user has been
 * looking at "Working…" for half a minute and a retry is the better offer.
 * Passed per request by `claude-controls.ts`; nothing else uses it.
 */
export const MCP_AUTHENTICATE_TIMEOUT_MS = 30_000;

/** Per-request options for `ControlChannel.request`. */
export interface ControlRequestOptions {
  /**
   * This request's timeout, overriding the channel's for this one request
   * only. For a verb whose answer legitimately waits on the network — today
   * only `mcp_authenticate` (`MCP_AUTHENTICATE_TIMEOUT_MS`).
   */
  timeoutMs?: number;
}

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
   * One counter for EVERY channel, so an id is unique ACROSS sessions and
   * `pending` can be a single flat map. `sb-` prefixed rather than a UUID
   * because these ids end up in logs and in a protocol trace, and `sb-7` tells
   * you at a glance that we sent it — a UUID tells you nothing and costs 36
   * characters per line. (`interrupt` still mints a UUID; it correlates
   * nothing, so it never needed to be readable.)
   *
   * STATIC since #1287, when the one channel per manager became one per
   * session: a per-instance counter would have every session's first request
   * be `sb-1`, and a log line naming `sb-1` would stop saying which one. Kept
   * app-wide, the ids read exactly as they did before.
   */
  private static seq = 0;

  constructor(port: ControlPort, opts: { timeoutMs?: number } = {}) {
    this.port = port;
    this.timeoutMs = opts.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.unsubscribe = port.onMessage((sessionId, msg) => this.ingest(sessionId, msg));
  }

  /**
   * Send one control request and wait for its answer.
   *
   * `build` is a FUNCTION of the id rather than a prepared object, so the
   * builders in `claude-protocol.ts` own both the shape and the
   * validation. A builder that returns `null` has refused the arguments, and
   * nothing is written — that is the `invalid` verdict, and it is how the
   * measured `set_model`-with-no-field silent no-op is made impossible.
   *
   * `opts.timeoutMs` overrides the channel's timeout for THIS request only
   * (#1425); a reply after it is dropped exactly like one after the default.
   */
  request(
    sessionId: string,
    build: (requestId: string) => StreamControlRequest | null,
    opts: ControlRequestOptions = {}
  ): Promise<ControlVerdict> {
    const requestId = `sb-${++ControlChannel.seq}`;
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
        opts.timeoutMs ?? this.timeoutMs
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
        // `setModel`), so what is left is a handle that cannot carry a typed
        // message at all.
        //
        // ⚠️ THE VERDICT'S NAME OUTLIVED ITS CAUSE (#952). `not-stream` meant "this
        // is a PTY", and there is no PTY. It is still REACHABLE — `send` is
        // optional on `TransportSession` because §5.3's adapter contract admits a
        // byte-only CLI — but today it means the handle came up without one, which
        // a restart usually fixes. The three user-facing strings behind it say
        // that rather than naming Terminal mode; the verdict keeps its name
        // because renaming a wire value is a change the renderer would have to
        // follow, for no gain.
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
   * oversight: since #1287 each session's controls own one of these, its
   * subscription is to that session's own listener set (which goes with the
   * session), and `forgetSession` already settles what was in flight — and the
   * pending timers are `unref`'d, so an outstanding request cannot hold the
   * process open. It exists so that the class is not the reason a longer-lived
   * owner leaks a listener into a shared fan-out.
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
    // THE SESSION HAS TO MATCH. Ids are unique across every channel, and since
    // #1287 each channel only hears its own session's frames, so a mismatch
    // cannot happen by accident. Kept as defence in depth: it costs one
    // comparison and removes the whole class of "session A's answer resolved
    // session B's request" from consideration, whoever wires the port.
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
