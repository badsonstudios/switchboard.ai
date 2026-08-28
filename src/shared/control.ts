// What a control request answers (#721).
//
// In `shared/` rather than beside the channel in `main/transport/` for the
// ordinary reason: it crosses IPC. The renderer renders these four failures
// differently, the preload declares them, and main produces them — three
// consumers, so one declaration. (`shared/mcp.ts` is here for the same reason,
// and `SessionRecordWire`'s docblock records what happened the last time a wire
// type was hand-copied on both sides of this boundary: it drifted twice.)
//
// The CHANNEL itself — correlation, timeouts, the pending map — stays in
// `main/transport/control-channel.ts`, which is main-only and imports these.

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
 */
export type ControlFailure = 'not-stream' | 'refused' | 'timed-out' | 'session-gone' | 'invalid';

export type ControlVerdict =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; reason: ControlFailure; message: string };
