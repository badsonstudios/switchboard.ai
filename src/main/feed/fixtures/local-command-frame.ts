// A REAL `assistant` frame for a local slash command, captured off the stream.
//
// WHY A REAL ONE, and why this file exists at all. The fake provider has
// emitted a local-command turn since #156, and `e2e/stream.spec.ts` renders it
// end to end — but the fake's frame is a three-key sketch
// (`type` / `message.content` / `session_id`) and the CLI's is not. Passing
// against the sketch proves the renderer works on the sketch. This repo has
// been bitten by exactly that gap four times (#153, #154, #139, and the
// one-message-per-content-block finding in `stream-feed.ts`'s `claim()`), and
// every time the shape the fake was missing was the shape that mattered.
//
// PROVENANCE. `spike/probes/978/probe-local-commands.mjs`, run 2026-09-29
// against the PATH `claude` **2.1.280** on the owner's subscription, with
// switchboard's verbatim argument list. Findings:
// `spike/findings/978-local-slash-commands-on-stream.md`.
//
// VERBATIM IN SHAPE, TRIMMED IN PROSE. Every key, every nesting level and every
// value type is exactly as measured — including the three that did not exist
// when S-11 ran this probe on 2.1.220 and which are the reason the capture was
// worth keeping:
//
//   model: "<synthetic>"   the CLI's own marker that no model was called
//   local_command_source   the RAW `<local-command-stdout>` wrapper
//   local_command_run      `{ command, args }` — the CLI naming the command
//
// The only edit is the length of the output text itself: the real `/usage`
// answer runs 1,043 characters and is a report on the owner's subscription
// usage. The first lines are kept because the assertion is that the text
// survives derivation intact; the rest is telemetry about his account and
// belongs in neither a fixture nor a commit. Re-run the probe for the whole of
// it — the raw JSON is deliberately not committed, which is why this file is.
//
// ⚠️ `usage.input_tokens` / `output_tokens` are ZERO and that is measured, not
// a placeholder. A local command costs nothing because no model runs, and
// `drift.test.ts` already pins the sibling case (the CLI writes a null
// breakdown on `<synthetic>` lines). Anything that averages over turns will see
// these.

/** The unwrapped output, as it arrives in `message.content[0].text`. */
export const LOCAL_COMMAND_TEXT =
  'You are currently using your subscription to power your Claude Code usage\n' +
  '\n' +
  'Current session: 3% used · resets Sep 29, 4:20pm (America/New_York)\n' +
  'Current week (all models): 88% used · resets Sep 29, 9pm (America/New_York)';

/**
 * The frame as the CLI sent it. A function rather than a constant so a test
 * that mutates its copy cannot reach the next test — the same reason
 * `session-transcript.ts` hands out a reader rather than a parsed array.
 */
export function localCommandFrame(): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      diagnostics: null,
      id: '01f17767-9e97-4562-97de-bd7f0e8b55cc',
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: {
        output_tokens_details: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: null,
        iterations: null,
        speed: null,
      },
      content: [{ type: 'text', text: LOCAL_COMMAND_TEXT }],
      context_management: null,
    },
    parent_tool_use_id: null,
    local_command_source: `<local-command-stdout>${LOCAL_COMMAND_TEXT}</local-command-stdout>`,
    session_id: '4f94d86a-07e6-4f6b-8c2f-fe421821e709',
    uuid: 'caa60b03-8b35-4d78-b08a-ffb4886d41b8',
    timestamp: '2026-09-29T16:46:23.467Z',
    usage_report: {
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 3121,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      rate_limits: {
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 3,
            resets_at: '2026-09-29T20:20:00.073570+00:00',
            scope: null,
            severity: 'normal',
            is_active: false,
          },
        ],
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
          currency: null,
        },
      },
    },
    local_command_run: { command: 'usage', args: '' },
  };
}

/**
 * The `system:init` that PRECEDES every local-command turn, reduced to the
 * fields anything reads. Measured: it carries the SAME `session_id` as the
 * turn, which is what makes it inert for `StreamFeed.onSystem` — an init whose
 * id has not changed sets nothing and wipes nothing.
 *
 * Kept beside the assistant frame because "does an extra init per local command
 * wipe the Feed?" is the first question anyone reading this path will ask, and
 * it deserves a test rather than an argument.
 */
export function localCommandInit(sessionId = '4f94d86a-07e6-4f6b-8c2f-fe421821e709'): Record<
  string,
  unknown
> {
  return { type: 'system', subtype: 'init', session_id: sessionId, slash_commands: ['usage'] };
}
