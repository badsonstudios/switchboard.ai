// Neutral session events -> session status events (P2-E18-05; neutral since
// E40 item 03, #1286).
//
// In PTY mode the state machine was fed by HOOKS. In stream mode the session's
// own traffic is the signal, and this is the translation layer — pure, so the
// mapping is testable without a process.
//
// IT READS NO PROVIDER'S FRAMES. What a Claude frame means for status — that
// `system:init` must never transition, that `can_use_tool` is the decision —
// is decided by Claude's translator (`providers/claude-events.ts`, with the
// S-11 measurements that justify it). This module only says what each NEUTRAL
// event means for status, so a second engine gets the same status rules for
// free. `engine-seam.test.ts` pins that it stays that way.
import { SessionEvent } from './state-machine';
import type { EngineEvent } from './engine-events';

/**
 * What a neutral event means for status, or `null` for "nothing".
 *
 * Returning null is the common case and is deliberate: most of a turn is
 * content, not lifecycle, and a mapper that invented a transition per event
 * would make the status flicker for the whole of a turn. The ONE event per
 * frame that does matter while a turn streams is `activity`, which the
 * translator emits once per output frame — so the status machine is consulted
 * exactly as often as it was when it read the frames itself.
 */
export function streamStatusEvent(e: EngineEvent): SessionEvent | null {
  switch (e.type) {
    case 'activity':
      // The turn is producing output. We already marked `working` when we
      // SENT, so this is normally a no-op — it exists for the case where we
      // did not send (a resumed conversation continuing, a queued message the
      // engine picked up on its own) and the card would otherwise sit idle
      // while text streamed into it.
      return e.sidechain
        ? { kind: 'stream', signal: 'output', label: e.label, sidechain: true }
        : { kind: 'stream', signal: 'output', label: e.label };
    case 'turn-end':
      // The turn is over, failed or not. Stream mode's `Stop` hook.
      return { kind: 'stream', signal: 'turn-end', label: e.label };
    case 'permission-request':
      // The engine handed us a decision — the whole point of E18.
      return { kind: 'permission-held' };
    // Content (chunks, messages, tool calls), the conversation's identity,
    // the control-path notices (a withdrawn request, the command list, the
    // model, the mode — #1287), compaction and usage are not lifecycle
    // signals. Listed rather than defaulted so a NEW event type is a decision
    // someone makes.
    //
    // A WITHDRAWN request does not move the status here, and never did: the
    // CLI's cancel frame was silent for status before the seam too. The
    // router lets the request go and applies `permission-withdrawn` itself
    // (#1258, #1340) — only it knows whether another is still held.
    case 'permission-withdrawn':
    case 'commands':
    case 'model':
    case 'mode':
    case 'settings':
    case 'conversation':
    case 'conversation-reset':
    case 'message-start':
    case 'message-end':
    case 'chunk-open':
    case 'tool-call-start':
    case 'chunk':
    case 'chunk-close':
    case 'message':
    case 'compaction':
    case 'usage':
      return null;
  }
}
