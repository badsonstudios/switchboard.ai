// The stream-json wire envelopes we WRITE (P2-E18-06).
//
// Shapes taken from the SDK envelope the VS Code extension sends and that S-10
// wrote to the real CLI (`spike/s10/probe-*.cjs`), not invented. Kept in
// `shared/` because the renderer composes a prompt and main sends it, and one
// definition is how those stay the same thing.
//
// This is the whole of what `renderer/lib/composer.ts` does for the PTY —
// bracketed-paste wrapper, a 75ms delayed CR, the S-03 "text+CR in one chunk
// registers as a paste and never submits" workaround — replaced by a struct.
// That entire class of timing bug does not exist on this transport.

/** One user turn, as the CLI expects it on stdin. */
export interface StreamUserMessage {
  type: 'user';
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Build a user turn.
 *
 * `session_id` is deliberately EMPTY, matching what S-10 sent and what the CLI
 * accepted: the id belongs to the conversation the CLI is already running, and
 * echoing back a stale one is how a message gets attributed to a conversation
 * that has since been replaced (a `/clear` mints a new one — see #107).
 *
 * The text is passed through UNTOUCHED. Newlines, backticks and a leading `/`
 * are all just characters here: `JSON.stringify` escapes the newline so it can
 * never be mistaken for a frame boundary, which is exactly the property the PTY
 * path had to fake with bracketed paste.
 */
export function userMessage(text: string): StreamUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Ask the CLI to interrupt the running turn (#154).
 *
 * Shape read out of the SDK inside the VS Code extension bundle, not guessed:
 * `interrupt()` there is `this.request({subtype:'interrupt'})`, and `request()`
 * wraps it as `{type:'control_request', request_id, request}`. The reply
 * carries `still_queued` — messages the CLI had queued and did NOT discard.
 *
 * NOTE the honest limit: what the CLI actually DOES on interrupt is still
 * unmeasured (S-11 probes 2-6 never ran; E18-12 owns that). This ships because
 * the alternative was a dead button — the stop control wrote Esc to a PTY that
 * a stream session does not have, so it did nothing at all.
 */
export interface StreamInterruptRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: 'interrupt' };
}

export function interruptRequest(requestId: string): StreamInterruptRequest {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

/** A reply to a `can_use_tool` control request (P2-E18-07 sends these). */
export interface StreamControlResponse {
  type: 'control_response';
  response: {
    subtype: 'success';
    request_id: string;
    response: Record<string, unknown>;
  };
}

export function controlResponse(
  requestId: string,
  response: Record<string, unknown>
): StreamControlResponse {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
}
