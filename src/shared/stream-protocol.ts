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

/** A block of prose in a user turn. */
export interface StreamTextBlock {
  type: 'text';
  text: string;
}

/**
 * An image the model is shown, inline (P2-E10-09).
 *
 * NOT INVENTED — read out of the VS Code extension's webview bundle (2.1.226),
 * which is the known-correct consumer of this contract:
 *
 *   case"image": a.push({type:"image",source:{type:"base64",media_type:p,data:u}});break;
 *
 * where `p` is the lower-cased MIME and `u` is `dataUrl.split(",")[1]` — the
 * base64 payload with the `data:image/png;base64,` prefix STRIPPED. It is the
 * Anthropic Messages API's own block shape; `input_image` and `image_url`
 * (the OpenAI spellings) count ZERO in both bundles, which is how we know this
 * is the only shape on offer.
 *
 * There is no temp file and no `@path` mention anywhere in that path, and no
 * CLI flag: the bytes ride the stdin NDJSON line we already write. `tmpdir` in
 * the extension host is used for session-resume transcripts and nothing else.
 *
 * VERIFIED AGAINST THE CLI ON PATH, 2026-08-13 (claude 2.1.226) — one budgeted
 * turn, because the extension ships its own binary and their behaviour is not
 * our guarantee. A 64x64 solid-blue PNG in exactly this block, sent as one
 * NDJSON line, came back on the `--replay-user-messages` echo intact
 * (`source.type=base64 media_type=image/png data.len=224`) and the model
 * answered "Blue". Both halves asserted, in that order, because a silent
 * result is indistinguishable from a broken harness (S-09).
 */
export interface StreamImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type StreamContentBlock = StreamTextBlock | StreamImageBlock;

/** One user turn, as the CLI expects it on stdin. */
export interface StreamUserMessage {
  type: 'user';
  message: { role: 'user'; content: StreamContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

/** An image on its way into a turn — base64 WITHOUT a `data:` prefix. */
export interface PromptImage {
  mediaType: string;
  data: string;
}

/**
 * Build a user turn.
 *
 * `session_id` is deliberately EMPTY, matching what S-10 sent, what the CLI
 * accepted, and what the extension itself sends (`session_id:""` in its own
 * envelope): the id belongs to the conversation the CLI is already running, and
 * echoing back a stale one is how a message gets attributed to a conversation
 * that has since been replaced (a `/clear` mints a new one — see #107).
 *
 * The text is passed through UNTOUCHED. Newlines, backticks and a leading `/`
 * are all just characters here: `JSON.stringify` escapes the newline so it can
 * never be mistaken for a frame boundary, which is exactly the property the PTY
 * path had to fake with bracketed paste.
 *
 * IMAGES COME FIRST, THE TEXT LAST — the extension's assembly order, not a
 * preference of ours. Its builder pushes IDE context, then attachments, then
 * `@terminal` and `@browser` blocks, and only then `a.push({type:"text",text:e})`
 * with the user's typed prompt. The prompt refers to the images above it, so
 * the order is part of the contract rather than a detail.
 *
 * An EMPTY prompt contributes no text block at all, rather than an empty one:
 * an image pasted and sent with nothing typed is a legitimate turn, and a
 * zero-length text block is not a thing the message format accepts.
 */
export function userMessage(text: string, images: readonly PromptImage[] = []): StreamUserMessage {
  const content: StreamContentBlock[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  // no images -> exactly the one-text-block array this function has always
  // returned, so every existing caller and every pinned shape is unchanged
  if (text.length > 0 || content.length === 0) content.push({ type: 'text', text });
  return {
    type: 'user',
    message: { role: 'user', content },
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
