// Claude stream-json -> neutral events (#1286). The frames are the real CLI's
// shapes, as the Feed and lifecycle suites have always used them; those suites
// also run every frame through this translator (`feed/fixtures/claude-fed-feed.ts`),
// so this file pins the mapping itself.
import { describe, it, expect } from 'vitest';
import { claudeEvents, translateClaudeFrame, turnOutcome, wasNeverStreamed } from './claude-events';
import { DISPLAY_CAPS } from '../feed/blocks';
import type { EngineEvent, MessageEvent } from '../sessions/engine-events';
import { localCommandFrame } from '../feed/fixtures/local-command-frame';

const CONV = '00000000-conv-4000-8000-000000000000';
const se = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'stream_event',
  event,
  session_id: CONV,
  parent_tool_use_id: null,
  ...extra,
});
/** the events minus `message`'s function, which `toEqual` cannot compare */
const plain = (evs: EngineEvent[] | null) =>
  evs?.map((e) => (e.type === 'message' ? { ...e, derive: 'fn' } : e)) ?? null;

describe('system frames', () => {
  it('init names the conversation, and is NOT activity (it arrives once per turn)', () => {
    expect(translateClaudeFrame({ type: 'system', subtype: 'init', session_id: CONV })).toEqual([
      { type: 'conversation', id: CONV },
    ]);
  });

  it('an init with no usable id says nothing — learning "" would fake a change', () => {
    expect(translateClaudeFrame({ type: 'system', subtype: 'init', session_id: '' })).toEqual([]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'init', session_id: 7 })).toEqual([]);
  });

  it('compact_boundary is a compaction, with the counts it reported', () => {
    expect(
      translateClaudeFrame({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 32516, post_tokens: 4760 },
      })
    ).toEqual([{ type: 'compaction', trigger: 'manual', preTokens: 32516, postTokens: 4760 }]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'compact_boundary' })).toEqual([
      { type: 'compaction' },
    ]);
  });

  // #1374: the summary that follows a compact_boundary is carried BESIDE its
  // message (which still derives to nothing, #1026), for the Feed to keep.
  it('a synthetic user frame carries its text as a compaction summary; a typed one does not', () => {
    const [summary] = translateClaudeFrame({
      type: 'user',
      message: { role: 'user', content: 'This session is being continued…' },
      parent_tool_use_id: null,
      isReplay: false,
      isSynthetic: true,
    })!;
    expect(summary).toMatchObject({ type: 'message', role: 'user', compactionSummary: 'This session is being continued…' });
    expect((summary as MessageEvent).derive(DISPLAY_CAPS, {})).toEqual([]);
    const [typed] = translateClaudeFrame({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      isReplay: true,
    })!;
    expect(typed).not.toHaveProperty('compactionSummary');
  });

  it('other system subtypes are understood and silent', () => {
    for (const subtype of ['status', 'commands_changed', 'post_turn_summary', 'local_command']) {
      expect(translateClaudeFrame({ type: 'system', subtype })).toEqual([]);
    }
  });
});

describe('conversation_reset', () => {
  it('names the conversation being DISCARDED, not new_conversation_id', () => {
    expect(
      translateClaudeFrame({ type: 'conversation_reset', session_id: 'old', new_conversation_id: 'decoy' })
    ).toEqual([{ type: 'conversation-reset', discarded: 'old' }]);
    expect(translateClaudeFrame({ type: 'conversation_reset' })).toEqual([{ type: 'conversation-reset' }]);
  });
});

describe('stream_event frames', () => {
  const activity = { type: 'activity', label: 'stream_event' };

  it('every frame is activity, then its content', () => {
    expect(translateClaudeFrame(se({ type: 'message_start' }))).toEqual([activity, { type: 'message-start' }]);
    expect(translateClaudeFrame(se({ type: 'message_stop' }))).toEqual([activity, { type: 'message-end' }]);
    expect(translateClaudeFrame(se({ type: 'content_block_stop', index: 2 }))).toEqual([
      activity,
      { type: 'chunk-close', index: 2 },
    ]);
    // nothing for the Feed, still a turn running
    expect(translateClaudeFrame(se({ type: 'message_delta' }))).toEqual([activity]);
    expect(translateClaudeFrame({ type: 'stream_event' })).toEqual([activity]);
  });

  it('content_block_start opens text / thinking / a named tool call', () => {
    expect(
      translateClaudeFrame(se({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }))
    ).toEqual([activity, { type: 'chunk-open', index: 1, kind: 'thinking' }]);
    // a missing type reads as text — the CLI's to send, not ours to require
    expect(translateClaudeFrame(se({ type: 'content_block_start' }))).toEqual([
      activity,
      { type: 'chunk-open', index: 0, kind: 'text' },
    ]);
    expect(
      translateClaudeFrame(
        se({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', name: 'Bash', id: 'tu-1' } })
      )
    ).toEqual([activity, { type: 'tool-call-start', index: 3, name: 'Bash', toolCallId: 'tu-1' }]);
    expect(
      translateClaudeFrame(se({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } }))
    ).toEqual([activity, { type: 'tool-call-start', index: 0, name: 'Read' }]);
  });

  it('opens nothing for a block it cannot render', () => {
    expect(
      translateClaudeFrame(se({ type: 'content_block_start', content_block: { type: 'tool_use' } }))
    ).toEqual([activity]);
    expect(
      translateClaudeFrame(se({ type: 'content_block_start', content_block: { type: 'server_tool_use' } }))
    ).toEqual([activity]);
  });

  it('text and thinking deltas are chunks; input_json and signature are nothing', () => {
    expect(
      translateClaudeFrame(se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }))
    ).toEqual([activity, { type: 'chunk', index: 1, kind: 'text', text: 'hi' }]);
    expect(
      translateClaudeFrame(se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }))
    ).toEqual([activity, { type: 'chunk', index: 0, kind: 'thinking', text: 'hm' }]);
    for (const delta of [
      { type: 'input_json_delta', partial_json: '{"a' },
      { type: 'signature_delta', signature: 'x' },
      { type: 'text_delta', text: '' },
      { type: 'text_delta' },
    ]) {
      expect(translateClaudeFrame(se({ type: 'content_block_delta', delta }))).toEqual([activity]);
    }
  });

  // #977: a subagent's words come from its own transcript, never the stream
  // ...and #1340: that activity is marked as a subagent's, so it opens no turn
  it('a SIDECHAIN frame is activity and nothing else', () => {
    expect(
      translateClaudeFrame(
        se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, { parent_tool_use_id: 'tu-9' })
      )
    ).toEqual([{ ...activity, sidechain: true }]);
  });
});

describe('assistant and user messages', () => {
  const assistant = (extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    session_id: CONV,
    parent_tool_use_id: null,
    ...extra,
  });

  it('an assistant message is activity plus the message, whose content derives as the Feed always did', () => {
    const evs = translateClaudeFrame(assistant())!;
    expect(plain(evs)).toEqual([
      { type: 'activity', label: 'assistant' },
      { type: 'message', role: 'assistant', unstreamed: false, derive: 'fn' },
    ]);
    const intents = (evs[1] as MessageEvent).derive(DISPLAY_CAPS, {});
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ t: 'block', block: { kind: 'assistant', text: 'Hello' } });
    // stamped when the frame was read: the stream carries no time of its own
    expect(typeof (intents[0] as { block: { ts?: string } }).block.ts).toBe('string');
  });

  it('a local command (#978) is UNSTREAMED, by either marker', () => {
    const [, local] = translateClaudeFrame(localCommandFrame())!;
    expect(local).toMatchObject({ type: 'message', unstreamed: true });
    const [, synthetic] = translateClaudeFrame(
      assistant({ message: { role: 'assistant', model: '<synthetic>', content: [] } })
    )!;
    expect(synthetic).toMatchObject({ type: 'message', unstreamed: true });
  });

  it('a user message is content, not activity, and never unstreamed', () => {
    expect(
      plain(translateClaudeFrame({ type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: null }))
    ).toEqual([{ type: 'message', role: 'user', unstreamed: false, derive: 'fn' }]);
  });

  // #680: the `--replay-user-messages` echo names the delivery it hands back
  describe('echoId — the echo of a message we sent', () => {
    const U = '3f2b8c1e-0000-4000-8000-000000000001';
    const echo = (extra: Record<string, unknown> = {}) => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
      parent_tool_use_id: null,
      uuid: U,
      isReplay: true,
      ...extra,
    });
    const id = (frame: Record<string, unknown>) => (translateClaudeFrame(frame)![0] as MessageEvent).echoId;

    it("is an isReplay user frame's uuid", () => {
      expect(id(echo())).toBe(U);
    });

    it('is absent on a frame the CLI did not mark as a replay', () => {
      expect(id(echo({ isReplay: false }))).toBeUndefined();
      expect(id(echo({ isReplay: undefined }))).toBeUndefined();
      // `=== true`: another process's string is not a flag
      expect(id(echo({ isReplay: 'true' }))).toBeUndefined();
    });

    it('is absent when the echo carries no usable uuid — no id, no de-duplication', () => {
      expect(id(echo({ uuid: undefined }))).toBeUndefined();
      expect(id(echo({ uuid: '' }))).toBeUndefined();
      expect(id(echo({ uuid: 42 }))).toBeUndefined();
      expect(translateClaudeFrame(echo({ uuid: undefined }))![0]).not.toHaveProperty('echoId');
    });

    it('is never on an assistant message, whatever it carries', () => {
      const [, msg] = translateClaudeFrame(assistant({ uuid: U, isReplay: true }))!;
      expect(msg).not.toHaveProperty('echoId');
    });
  });

  it('a sidechain message carries no content (#977); an assistant one is still activity', () => {
    expect(translateClaudeFrame(assistant({ parent_tool_use_id: 'tu-1' }))).toEqual([
      { type: 'activity', label: 'assistant', sidechain: true },
    ]);
    expect(translateClaudeFrame({ type: 'user', parent_tool_use_id: 'tu-1' })).toEqual([]);
  });
});

describe('result', () => {
  it('ends the turn, with the label the transition log has always shown', () => {
    expect(translateClaudeFrame({ type: 'result', subtype: 'success' })).toEqual([
      { type: 'turn-end', failed: false, label: 'result:success' },
    ]);
    expect(translateClaudeFrame({ type: 'result' })).toEqual([{ type: 'turn-end', failed: false, label: 'result' }]);
  });

  it('a failed turn is the error signal', () => {
    expect(translateClaudeFrame({ type: 'result', is_error: true })).toEqual([
      { type: 'turn-end', failed: true, label: 'result' },
    ]);
    expect(translateClaudeFrame({ type: 'result', subtype: 'error_max_turns' })).toEqual([
      { type: 'turn-end', failed: true, label: 'result:error_max_turns' },
    ]);
  });

  it('emits NO usage event: Claude’s usage is its transcript ledger (#1288)', () => {
    // One usage path per provider. `result.usage` is per turn and lacks the
    // cache-write split, the thinking share and subagent files, all of which
    // the transcript ledger has; a usage event here would be a second, poorer
    // count of the same tokens that the host then has to know to ignore.
    expect(
      translateClaudeFrame({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 0 },
      })
    ).toEqual([{ type: 'turn-end', failed: false, label: 'result:success' }]);
  });
});

describe('control frames — what the CLI announces (#1287)', () => {
  it('can_use_tool is a permission request, carrying the ask', () => {
    // S-10 probe B's shape, plus every optional field the router reads
    expect(
      translateClaudeFrame({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { file_path: 'C:/p/.claude/x.sh', content: 'y' },
          decision_reason: 'Path is in a sensitive directory',
          decision_reason_type: 'safetyCheck',
          display_name: 'Write file',
          permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
          tool_use_id: 'toolu_1',
        },
      })
    ).toEqual([
      {
        type: 'permission-request',
        requestId: 'req-1',
        tool: 'Write',
        input: { file_path: 'C:/p/.claude/x.sh', content: 'y' },
        reason: 'Path is in a sensitive directory',
        reasonType: 'safetyCheck',
        displayName: 'Write file',
        suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
      },
    ]);
  });

  it('a bare can_use_tool is still a request — unanswerable, with the defaults the router used', () => {
    // An id-less request still moves the status (the CLI IS waiting); the
    // router declines to hold what it cannot answer.
    expect(translateClaudeFrame({ type: 'control_request', request: { subtype: 'can_use_tool' } })).toEqual([
      { type: 'permission-request', requestId: '', tool: 'unknown', input: {} },
    ]);
    // a numeric id is a string by the time anyone compares it
    expect(
      translateClaudeFrame({ type: 'control_request', request_id: 0, request: { subtype: 'can_use_tool' } })
    ).toMatchObject([{ requestId: '0' }]);
  });

  it('control_cancel_request withdraws the request it names', () => {
    expect(translateClaudeFrame({ type: 'control_cancel_request', request_id: 'req-1' })).toEqual([
      { type: 'permission-withdrawn', requestId: 'req-1' },
    ]);
  });

  it('system:init carries the conversation, the command list and the model — each its own event', () => {
    expect(
      translateClaudeFrame({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-1',
        slash_commands: ['clear', 'compact', '', 7],
        model: 'claude-opus-5-5',
      })
    ).toEqual([
      { type: 'conversation', id: 'conv-1' },
      { type: 'commands', commands: [{ name: 'clear' }, { name: 'compact' }], dropped: 2 },
      { type: 'model', id: 'claude-opus-5-5' },
    ]);
    // nothing usable: no commands event (the store keeps its list), no model
    expect(translateClaudeFrame({ type: 'system', subtype: 'init', model: '  ' })).toEqual([]);
  });

  it('commands_changed re-advertises the whole list, with descriptions', () => {
    expect(
      translateClaudeFrame({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }, { name: '' }],
      })
    ).toEqual([{ type: 'commands', commands: [{ name: 'review', description: 'Review a PR' }], dropped: 1 }]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'commands_changed', commands: 'x' })).toEqual([]);
  });

  it('a field it understood but could not use is SAID, for the debug log — the stores used to say it', () => {
    const said: Array<[string, Record<string, string>]> = [];
    const skipped = (what: string, fields: Record<string, string>): void => void said.push([what, fields]);
    translateClaudeFrame({ type: 'system', subtype: 'init', session_id: 'c', slash_commands: 'x' }, skipped);
    translateClaudeFrame({ type: 'system', subtype: 'commands_changed' }, skipped);
    translateClaudeFrame({ type: 'system', subtype: 'status', permissionMode: 'dontAsk' }, skipped);
    expect(said).toEqual([
      ['stream command list ignored: not an array', { subtype: 'init', got: 'string' }],
      ['stream init model ignored', { got: 'absent' }],
      ['stream command list ignored: not an array', { subtype: 'commands_changed', got: 'absent' }],
      ['stream status mode ignored', { got: 'dontAsk' }],
    ]);
  });

  it('system:status names the mode, in the host vocabulary — and only a mode we have a name for', () => {
    expect(translateClaudeFrame({ type: 'system', subtype: 'status', permissionMode: 'default' })).toEqual([
      { type: 'mode', mode: 'ask' },
    ]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'status', permissionMode: 'plan' })).toEqual([
      { type: 'mode', mode: 'plan' },
    ]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'status', permissionMode: 'auto' })).toEqual([]);
    expect(translateClaudeFrame({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([]);
  });

  // hook_callback and mcp_message ride the same channel; treating every control
  // request as a permission would park a working session with nothing to answer
  it('other control traffic says nothing on the event path', () => {
    expect(translateClaudeFrame({ type: 'control_request', request: { subtype: 'hook_callback' } })).toEqual([]);
    expect(translateClaudeFrame({ type: 'control_request' })).toEqual([]);
    expect(translateClaudeFrame({ type: 'control_response', response: {} })).toEqual([]);
  });
});

describe('unknown frames — logged once, skipped, never fatal', () => {
  it('known telemetry is understood and silent', () => {
    for (const type of ['rate_limit_event', 'transcript_mirror', 'active_goal', 'keep_alive']) {
      expect(translateClaudeFrame({ type })).toEqual([]);
    }
  });

  it('command_lifecycle is understood and silent, not reported as unknown (#1328)', () => {
    // the shape the PATH CLI's schema declares; the owner's log showed it as
    // "stream frame type not understood" on the first prompt of a session
    const frame = { type: 'command_lifecycle', command_uuid: 'u-1', state: 'completed' };
    expect(translateClaudeFrame(frame)).toEqual([]);
    const seen: string[] = [];
    claudeEvents.createTranslator({ onUnknown: (x) => seen.push(x) })(frame);
    expect(seen).toEqual([]);
  });

  it('an unknown type is null from the pure function', () => {
    expect(translateClaudeFrame({ type: 'something_new' })).toBeNull();
    expect(translateClaudeFrame({})).toBeNull();
    expect(translateClaudeFrame({ type: 42 })).toBeNull();
  });

  it('the translator reports each unknown type ONCE and returns no events', () => {
    const seen: string[] = [];
    const t = claudeEvents.createTranslator({ onUnknown: (x) => seen.push(x) });
    expect(t({ type: 'a_new_frame' })).toEqual([]);
    expect(t({ type: 'a_new_frame' })).toEqual([]);
    expect(t({})).toEqual([]);
    expect(t({ type: 'another' })).toEqual([]);
    expect(seen).toEqual(['a_new_frame', '(no type)', 'another']);
  });

  it('works with no hooks at all', () => {
    expect(claudeEvents.createTranslator({})({ type: 'nope' })).toEqual([]);
  });
});

// Moved with `turnOutcome` from `health/corroboration.test.ts` (#1286).
describe('what counts as an error', () => {
  it('reads the two fields the protocol documents', () => {
    expect(turnOutcome({ type: 'result', is_error: true })).toBe(true);
    expect(turnOutcome({ type: 'result', subtype: 'error_during_execution' })).toBe(true);
    expect(turnOutcome({ type: 'result', subtype: 'error_max_turns' })).toBe(true);
  });

  it('a clean result is a recovery', () => {
    expect(turnOutcome({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
  });

  it('everything else is not a verdict at all', () => {
    // null, not false: a stream_event must not be able to CLEAR the evidence,
    // which is what returning false here would mean
    expect(turnOutcome({ type: 'stream_event' })).toBeNull();
    expect(turnOutcome({ type: 'assistant' })).toBeNull();
    expect(turnOutcome({ type: 'rate_limit_event' })).toBeNull();
    expect(turnOutcome(null)).toBeNull();
    expect(turnOutcome('result')).toBeNull();
  });
});

describe('wasNeverStreamed', () => {
  it('is false for an ordinary model reply', () => {
    expect(wasNeverStreamed({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } })).toBe(false);
    expect(wasNeverStreamed({ type: 'assistant' })).toBe(false);
  });
});
