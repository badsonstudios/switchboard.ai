// What a control request answers (#721).
//
// In `shared/` rather than beside the channel in `main/transport/` for the
// ordinary reason: it crosses IPC. The renderer renders these four failures
// differently, the preload declares them, and main produces them — three
// consumers, so one declaration. (`shared/mcp.ts` is here for the same reason,
// and `SessionRecordWire`'s docblock records what happened the last time a wire
// type was hand-copied on both sides of this boundary: it drifted twice.)
//
// The CHANNEL itself — correlation, timeouts, the pending map — is Claude's
// and lives behind its provider (`main/providers/claude-control-channel.ts`,
// since E40 item 04, #1287). These verdicts are the NEUTRAL answer every
// provider's controls give (`main/sessions/engine-controls.ts`).

/**
 * Why a control request produced no answer.
 *
 * Four distinguishable outcomes rather than a boolean, because each one asks
 * something different of the surface:
 *
 *  - `not-stream`  — this session is on a PTY and has NO control channel at
 *                    all. Not an error and not retryable: the honest response
 *                    is to hand the user to the CLI's own picker in their
 *                    terminal, which is the #714 reconnect precedent.
 *  - `refused`     — the CLI understood and said no, in a sentence written for
 *                    a human. Show its words, not ours.
 *  - `timed-out`   — nobody answered. Retryable.
 *  - `session-gone`— the session was torn down while we waited.
 *  - `invalid`     — WE refused it, before the wire. Exists because
 *                    `set_model` with no `model` field answers `success` and
 *                    silently changes nothing (measured), so an argument we
 *                    dropped must not be able to look like a feature working.
 *  - `unsupported` — this session's AI has no such control at all (E40 item
 *                    04, #1287: its provider does not declare it). The
 *                    composer greys such a control out before it can be
 *                    asked, so reaching this is a caller that did not look;
 *                    it is an answer, never a throw (P6).
 */
export type ControlFailure =
  | 'not-stream'
  | 'refused'
  | 'timed-out'
  | 'session-gone'
  | 'invalid'
  | 'unsupported';

export type ControlVerdict =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; reason: ControlFailure; message: string };
