// Stream messages -> session status events (P2-E18-05).
//
// In PTY mode the state machine is fed by HOOKS. In stream mode the messages
// themselves are the signal, so this is the translation layer — pure, so the
// mapping is testable without a process.
//
// ---------------------------------------------------------------------------
// MEASURED, from S-11's own run (spike/findings/artifacts/s11/longrun-events.ndjson),
// not reasoned by analogy with the PTY:
//
//   spawn                       ms=14
//   heartbeat (we SENT a prompt) ms=2026
//   init                         ms=2048     <- 22ms AFTER our send
//
// and on every subsequent turn the same order, +6ms and +11ms. **The CLI emits
// NOTHING at spawn.** `system:init` always FOLLOWS a user message.
//
// Two consequences, and both are load-bearing:
//
// 1. A stream session has no startup signal at all, so readiness cannot come
//    from the stream. It comes from the spawn succeeding — which is honest for
//    this transport in a way it would not be for the PTY: there is no TUI to
//    boot, and S-10 confirmed no trust dialog is drawn in this mode. A spawned
//    stream child really is ready.
// 2. `system:init` must NOT transition. It arrives once per TURN (S-11: 4 turns
//    -> 4 inits), ~10-20ms after a send we made ourselves, so it tells us
//    nothing we did not already know — and treating it as "session started",
//    which is the obvious reading of the name, would reset the session on every
//    single turn.
// ---------------------------------------------------------------------------
import { SessionEvent } from './state-machine';

export type StreamMessage = Record<string, unknown>;

/**
 * What a stream message means for status, or `null` for "nothing".
 *
 * Returning null is the common case and is deliberate: most of the stream is
 * content, not lifecycle, and a mapper that invents a transition per message
 * would make the status flicker for the whole of a turn.
 */
export function streamStatusEvent(m: StreamMessage): SessionEvent | null {
  const type = typeof m.type === 'string' ? m.type : '';
  const subtype = typeof m.subtype === 'string' ? m.subtype : undefined;

  switch (type) {
    case 'system':
      // init: see the header. Deliberately no transition.
      // status/commands_changed/post_turn_summary: informational.
      return null;

    case 'assistant':
    case 'stream_event':
      // The turn is producing output. We already marked `working` when we SENT,
      // so this is normally a no-op — it exists for the case where we did not
      // send (a resumed conversation continuing, a queued message the CLI
      // picked up on its own) and the card would otherwise sit idle while text
      // streamed into it.
      return { kind: 'stream', event: type, subtype };

    case 'result':
      // The turn is over. This is stream mode's `Stop` hook.
      return { kind: 'stream', event: 'result', subtype };

    case 'control_request': {
      const req = m.request as { subtype?: unknown } | undefined;
      // can_use_tool is the CLI handing us a decision — the whole point of the
      // epic. Other control requests (hook_callback, mcp_message) are plumbing
      // and must not move the status.
      if (req?.subtype === 'can_use_tool') return { kind: 'permission-held' };
      return null;
    }

    // Everything else — rate_limit_event, transcript_mirror, active_goal,
    // keep_alive, user (our own replay) — is not a lifecycle signal. Listed
    // rather than defaulted so a NEW message type is a decision someone makes,
    // not a silent no-op. (S-11 saw 0 keep_alives in 8 hours, so its cadence is
    // still unmeasured; it must not be load-bearing.)
    default:
      return null;
  }
}
