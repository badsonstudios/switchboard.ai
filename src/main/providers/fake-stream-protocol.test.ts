// P2-E18-04 — the stream-json fake's protocol.
//
// Synchronous, no spawn: the CI unit job does not run a build, so anything that
// needed the compiled CLI could only skip there. The compiled program is proven
// end-to-end over real pipes by `npm run check:fake-stream`.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeStreamProtocol,
  FakeStreamHost,
  extractText,
  extractDocuments,
  extractImages,
  FAKE_SESSION_ID,
} from './fake-stream-protocol';

let out: Record<string, unknown>[];
let writes: Array<{ path: string; content: string }>;
let stderrs: string[];
let exits: number[];
let hooks: Record<string, unknown>[];
let proto: FakeStreamProtocol;

const host: FakeStreamHost = {
  cwd: () => '/work',
  writeFile: (p, content) => writes.push({ path: p, content }),
  stderr: (l) => stderrs.push(l),
  exit: (c) => exits.push(c),
  resolve: (cwd, target) => (target.startsWith('/') ? target : `${cwd}/${target}`),
  fireHook: (payload) => hooks.push(payload),
};

beforeEach(() => {
  out = [];
  writes = [];
  stderrs = [];
  exits = [];
  hooks = [];
  proto = new FakeStreamProtocol(host, (m) => out.push(m));
});

function userMsg(text: string): Record<string, unknown> {
  // the SDK envelope S-10 wrote to the real CLI
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

const types = (): string[] =>
  out.map((m) => `${m.type}${m.subtype ? ':' + String(m.subtype) : ''}`);

/**
 * The assistant message carrying TEXT.
 *
 * `out.find(m => m.type === 'assistant')` is no longer that message. The real
 * CLI sends ONE assistant message PER CONTENT BLOCK (measured 2026-08-02,
 * `spike/s11/probe-140-slash-flags.cjs`), and the first of them carries the
 * thinking block. Every test that reached for "the assistant message" was
 * quietly relying on there being only one.
 */
const assistantText = (): string => {
  for (const m of out) {
    if (m.type !== 'assistant') continue;
    const content = (m.message as { content?: Array<{ type?: string; text?: string }> })?.content;
    const text = content?.find((c) => c.type === 'text')?.text;
    if (typeof text === 'string') return text;
  }
  throw new Error('no assistant message carried text');
};

describe('a plain turn (P2-E18-04)', () => {
  // MEASURED, and deliberately NOT the tidy shape this test used to assert.
  // Against the PATH CLI with our exact argument list, three turns running
  // (`spike/s11/probe-140-slash-flags.cjs`, 2026-08-02):
  //
  //   message_start
  //   content_block_start(0, thinking) -> delta -> ASSISTANT -> content_block_stop(0)
  //   content_block_start(1, text)     -> delta -> ASSISTANT -> content_block_stop(1)
  //   message_delta -> message_stop -> result
  //
  // One assistant message PER BLOCK, each arriving BEFORE its own
  // content_block_stop. The old assertion — "every stream_event precedes the
  // assistant message" — was the fake's convenience, not the CLI's behaviour,
  // and a host built against it appends a duplicate of every block after the
  // first.
  it('interleaves one assistant message PER CONTENT BLOCK, mid-stream', () => {
    proto.handle(userMsg('hello'));

    const t = types();
    expect(t[0]).toBe('system:init');
    expect(t[t.length - 1]).toBe('result:success');
    // TWO assistant messages for one turn: the thinking block and the text
    expect(t.filter((x) => x === 'assistant')).toHaveLength(2);
    // and they are NOT all at the end — stream events follow the first one
    expect(t.lastIndexOf('stream_event')).toBeGreaterThan(t.indexOf('assistant'));
    // each carries exactly one content block, so every one of them reports
    // content index 0 while the deltas were addressed 0 and 1
    for (const m of out.filter((x) => x.type === 'assistant')) {
      expect((m.message as { content: unknown[] }).content).toHaveLength(1);
    }
  });

  it('addresses the two content blocks by DIFFERENT stream indices', () => {
    proto.handle(userMsg('hello'));

    const starts = out
      .filter((m) => m.type === 'stream_event' && (m.event as { type: string }).type === 'content_block_start')
      .map((m) => m.event as { index: number; content_block: { type: string } });

    expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([
      [0, 'thinking'],
      [1, 'text'],
    ]);
  });

  it('the deltas concatenate to exactly the assistant text', () => {
    proto.handle(userMsg('hello'));

    // P2-E18-10 widened the fake's stream_event repertoire from deltas alone to
    // the full message envelope (message_start / content_block_start / delta /
    // content_block_stop), because a delta's `index` is how a host matches it
    // to the block it belongs to. Filter on the event type, not on being a
    // stream_event at all.
    const deltas = out
      .filter(
        (m) =>
          m.type === 'stream_event' &&
          (m.event as { type: string }).type === 'content_block_delta' &&
          (m.event as { delta: { type: string } }).delta.type === 'text_delta'
      )
      .map((m) => (m.event as { delta: { text: string } }).delta.text);

    expect(deltas.join('')).toBe(assistantText());
    expect(assistantText()).toBe('FAKE-REPLY: hello');
  });

  // S-11 measured the real CLI emitting init on EVERY turn (4 turns -> 4
  // inits). A fake that emitted it once would hide exactly the bug P2-E18-05
  // and P2-E18-09 exist to prevent.
  it('emits system:init ONCE PER TURN, not once per session', () => {
    proto.handle(userMsg('one'));
    proto.handle(userMsg('two'));
    proto.handle(userMsg('three'));

    expect(types().filter((t) => t === 'system:init')).toHaveLength(3);
  });

  it('init advertises slash_commands, which P2-E18-09 consumes', () => {
    proto.handle(userMsg('hi'));
    const init = out[0] as { slash_commands: string[]; session_id: string };
    expect(init.slash_commands).toContain('clear');
    expect(init.session_id).toBe(FAKE_SESSION_ID);
    // NOT everything the adapter's curated list holds — `curated-only` is
    // absent on purpose, so a test can tell "the CLI's list replaced ours" from
    // "the two were merged". Without it the curated list is a strict subset of
    // this one and both designs render the same popup.
    expect(init.slash_commands).not.toContain('curated-only');
  });
});

describe('commands_changed (P2-E18-09)', () => {
  // Object-shaped, unlike init's bare names. Read out of the shipped VS Code
  // extension — `latestCommands = e.commands`, then `.name` / `.description`
  // off each entry — rather than guessed.
  it('!commands emits an OBJECT-shaped list and finishes the turn', () => {
    proto.handle(userMsg('!commands'));

    const changed = out.find((m) => m.subtype === 'commands_changed') as {
      type: string;
      commands: Array<{ name: string; description?: string }>;
    };
    expect(changed.type).toBe('system');
    expect(changed.commands).toContainEqual({
      name: 'just-installed',
      description: 'Arrived mid-session',
    });
    expect(types()[types().length - 1]).toBe('result:success');
  });
});

describe('the can_use_tool round trip (P2-E18-04)', () => {
  it('!perm raises a control_request and does NOT finish the turn', () => {
    proto.handle(userMsg('!perm .claude/scripts/coverage.sh'));

    const req = out.find((m) => m.type === 'control_request') as {
      request_id: string;
      request: Record<string, unknown>;
    };
    expect(req).toBeTruthy();
    expect(req.request.subtype).toBe('can_use_tool');
    // the turn is suspended: no result until the answer arrives
    expect(types()).not.toContain('result:success');
  });

  // These fields are exactly what P2-E18-07 renders, and they came off the real
  // CLI in S-10 probe B — the `.claude/` case that started the whole epic.
  it('the request carries the S-10 payload: reason, reason type, suggestions', () => {
    proto.handle(userMsg('!perm .claude/scripts/coverage.sh'));
    const r = (out.find((m) => m.type === 'control_request') as { request: Record<string, unknown> })
      .request;

    expect(r.tool_name).toBe('Write');
    expect(r.decision_reason_type).toBe('safetyCheck');
    expect(String(r.decision_reason)).toContain('sensitive file');
    expect(r.permission_suggestions).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(String((r.input as { file_path: string }).file_path)).toBe(
      '/work/.claude/scripts/coverage.sh'
    );
  });

  it('allow writes the file and completes the turn', () => {
    proto.handle(userMsg('!perm .claude/x.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    out.length = 0;

    proto.handle({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { behavior: 'allow' },
      },
    });

    expect(writes).toEqual([{ path: '/work/.claude/x.sh', content: 'echo hi\n' }]);
    expect(types()).toContain('result:success');
  });

  it('deny writes NOTHING and still completes the turn', () => {
    proto.handle(userMsg('!perm .claude/x.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    out.length = 0;

    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'deny' } },
    });

    expect(writes).toEqual([]);
    expect(types()).toContain('result:success');

    expect(assistantText()).toContain('denied');
  });

  // #310 — the silence between an answer and the CLI speaking again.
  //
  // `!perm` replies in the same tick, which is the one way the fake is kinder
  // than the real CLI: a real tool takes seconds to run and the CLI says
  // nothing for all of them. `!permhang` reproduces that, so a host can be
  // asked what it claims about a session whose question has been ANSWERED and
  // whose tool has not finished.
  it('!permhang performs the write and then says nothing at all', () => {
    proto.handle(userMsg('!permhang .claude/slow.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    expect(req).toBeTruthy();
    out.length = 0;

    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'allow' } },
    });

    // the tool RAN — that is the observable a test waits on
    expect(writes).toEqual([{ path: '/work/.claude/slow.sh', content: 'echo hi\n' }]);
    // …and the CLI has gone quiet: no narration, no result, no turn end
    expect(out).toEqual([]);
  });

  it('!permhang denied is just as quiet, and writes nothing', () => {
    proto.handle(userMsg('!permhang .claude/slow.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    out.length = 0;

    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'deny' } },
    });

    expect(writes).toEqual([]);
    expect(out).toEqual([]);
  });

  it('an answer to a request we never asked is ignored, not a crash', () => {
    expect(() =>
      proto.handle({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'never-asked', response: { behavior: 'allow' } },
      })
    ).not.toThrow();
    expect(writes).toEqual([]);
  });

  it('answering the same request twice performs the write once', () => {
    proto.handle(userMsg('!perm .claude/x.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    const answer = {
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'allow' } },
    };

    proto.handle(answer);
    proto.handle(answer);

    expect(writes).toHaveLength(1);
  });

  it('a write that throws is reported, not crashed on', () => {
    const throwing = new FakeStreamProtocol(
      { ...host, writeFile: () => { throw new Error('EACCES'); } },
      (m) => out.push(m)
    );
    throwing.handle(userMsg('!perm /root/x.sh'));
    const req = out.find((m) => m.type === 'control_request') as { request_id: string };
    out.length = 0;

    throwing.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'allow' } },
    });


    expect(assistantText()).toContain('EACCES');
    expect(types()).toContain('result:success');
  });

  it('concurrent requests are answered independently, by id', () => {
    proto.handle(userMsg('!perm a.sh'));
    proto.handle(userMsg('!perm b.sh'));
    const reqs = out.filter((m) => m.type === 'control_request') as Array<{ request_id: string }>;
    expect(reqs).toHaveLength(2);
    expect(reqs[0].request_id).not.toBe(reqs[1].request_id);

    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: reqs[1].request_id, response: { behavior: 'allow' } },
    });

    expect(writes).toEqual([{ path: '/work/b.sh', content: 'echo hi\n' }]);
  });

  // P2-E18-14 — the route to the card's QUEUE on this transport.
  //
  // Two prompts also produce two pending requests (the test above), but that
  // route is not walkable from the UI: the composer's session sits in
  // `needs-permission` behind the first request's bar, so the second prompt
  // cannot be typed. One turn raising both is what a real assistant message
  // carrying two gated `tool_use` blocks does, and it is what an e2e can drive.
  it('!perm with several targets raises one request PER TARGET, in order', () => {
    proto.handle(userMsg('!perm one.sh two.sh'));

    const reqs = out.filter((m) => m.type === 'control_request') as Array<{
      request_id: string;
      request: { input: { file_path: string } };
    }>;
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.request.input.file_path)).toEqual(['/work/one.sh', '/work/two.sh']);
    expect(reqs[0].request_id).not.toBe(reqs[1].request_id);
    // both are outstanding: the turn does not end until every one is answered
    expect(types()).not.toContain('result:success');
  });

  it('each of the several is answered independently, by its own id', () => {
    proto.handle(userMsg('!perm one.sh two.sh'));
    const reqs = out.filter((m) => m.type === 'control_request') as Array<{ request_id: string }>;

    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: reqs[0].request_id, response: { behavior: 'allow' } },
    });
    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: reqs[1].request_id, response: { behavior: 'deny' } },
    });

    // the allowed one ran, the denied one did not — which is the whole claim a
    // queue test reads off the disk
    expect(writes).toEqual([{ path: '/work/one.sh', content: 'echo hi\n' }]);
  });

  it('extra whitespace between targets is not a third, empty request', () => {
    proto.handle(userMsg('!perm  a.sh   b.sh '));
    expect(out.filter((m) => m.type === 'control_request')).toHaveLength(2);
  });

  it('one target is exactly what it always was', () => {
    proto.handle(userMsg('!perm .claude/scripts/coverage.sh'));
    const reqs = out.filter((m) => m.type === 'control_request') as Array<{
      request: { input: { file_path: string } };
    }>;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].request.input.file_path).toBe('/work/.claude/scripts/coverage.sh');
  });
});

// P2-E18-14 — a turn made of TOOL CALLS.
//
// Nothing on this transport ever emitted a `tool_use`, so every rich Feed block
// was reachable from a JSONL transcript and from no stream anywhere. The shape
// asserted here is the same one `emitAssistantText` was corrected to in E18-10,
// because it is a property of the CLI and not of text: one `assistant` message
// per content block, single-element `content`, arriving mid-stream.
describe('!tools — a turn of tool calls (P2-E18-14)', () => {
  /** every `assistant` message's single content item, in order */
  const items = (): Array<{ type?: string; name?: string; text?: string }> =>
    out
      .filter((m) => m.type === 'assistant')
      .map(
        (m) =>
          (m.message as { content: Array<{ type?: string; name?: string; text?: string }> })
            .content[0]
      );

  it('emits one assistant message per tool call, then the prose', () => {
    proto.handle(userMsg('!tools'));
    expect(items().map((c) => c.name ?? c.type)).toEqual([
      'Bash',
      'Edit',
      'Read',
      'TodoWrite',
      'text',
    ]);
  });

  it('every assistant message carries a SINGLE content item, as the real CLI does', () => {
    proto.handle(userMsg('!tools'));
    for (const m of out.filter((x) => x.type === 'assistant')) {
      expect((m.message as { content: unknown[] }).content).toHaveLength(1);
    }
  });

  it('opens each block with the tool NAME and streams the input as JSON fragments', () => {
    proto.handle(userMsg('!tools'));
    const starts = out.filter(
      (m) => (m.event as { type?: string } | undefined)?.type === 'content_block_start'
    );
    // four tool blocks addressed 0..3, plus the text block at 4
    expect(
      starts.map((m) => {
        const ev = m.event as { index: number; content_block: { type: string; name?: string } };
        return [ev.index, ev.content_block.type, ev.content_block.name ?? null];
      })
    ).toEqual([
      [0, 'tool_use', 'Bash'],
      [1, 'tool_use', 'Edit'],
      [2, 'tool_use', 'Read'],
      [3, 'tool_use', 'TodoWrite'],
      [4, 'text', null],
    ]);
    // and the input arrives only as half-written JSON — nothing renderable
    const deltas = out
      .map((m) => m.event as { type?: string; delta?: { type?: string } } | undefined)
      .filter((ev) => ev?.type === 'content_block_delta');
    expect(deltas.filter((d) => d?.delta?.type === 'input_json_delta')).toHaveLength(4);
  });

  it('an assistant message arrives BEFORE its own content_block_stop', () => {
    proto.handle(userMsg('!tools'));
    const firstAssistant = out.findIndex((m) => m.type === 'assistant');
    const firstStop = out.findIndex(
      (m) => (m.event as { type?: string } | undefined)?.type === 'content_block_stop'
    );
    expect(firstAssistant).toBeGreaterThan(0);
    expect(firstAssistant).toBeLessThan(firstStop);
  });

  it('replays a tool_result for the Bash call and finishes the turn', () => {
    proto.handle(userMsg('!tools'));
    // the LAST user message is the replay; the first is our own prompt echo
    const results = out.filter((m) => {
      const content = (m.message as { content?: Array<{ type?: string }> } | undefined)?.content;
      return m.type === 'user' && content?.[0]?.type === 'tool_result';
    }) as Array<{ message: { content: Array<{ tool_use_id: string; content: string }> } }>;
    expect(results).toHaveLength(1);
    expect(results[0].message.content[0].tool_use_id).toBe('toolu_fake_bash');
    expect(results[0].message.content[0].content).toContain('STREAM_OUT_LINE2');
    expect(types()).toContain('result:success');
  });

  it('mirrors the whole turn into the transcript, as the real CLI does', () => {
    const lines: Record<string, unknown>[] = [];
    const p = new FakeStreamProtocol(
      { ...host, appendTranscript: (l) => lines.push(l) },
      (m) => out.push(m)
    );
    p.handle(userMsg('!tools'));
    // the prompt, four tool calls, the prose, the tool result
    expect(lines).toHaveLength(7);
  });

  // #458. Session find lines a Direct session's transcript up with its Feed on
  // the ids the API puts in the message, and a `message.id` is the one that
  // carries PROSE blocks. The real API sends one on every assistant message; a
  // fake that did not would leave that half of the join with no e2e proof at
  // all — the same argument this file already makes for `tool_use` ids.
  it('stamps every assistant message with an id, the same one on both sides', () => {
    const lines: Record<string, unknown>[] = [];
    const p = new FakeStreamProtocol(
      { ...host, appendTranscript: (l) => lines.push(l) },
      (m) => out.push(m)
    );
    p.handle(userMsg('!tools'));

    const idOf = (m: { message?: unknown }): unknown => (m.message as { id?: unknown } | undefined)?.id;
    const streamed = out.filter((m) => m.type === 'assistant');
    const written = lines.filter((l) => l.type === 'assistant');
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.every((m) => typeof idOf(m) === 'string')).toBe(true);
    // The file's copy of the turn and the stream's carry the SAME ids, in the
    // same order. If these ever diverge, find goes quietly list-only on Direct.
    expect(written.map(idOf)).toEqual(streamed.map(idOf));
    // ...and it is ONE message split across several lines, not several
    // messages — which is the shape the real transcript has (measured: 583 of
    // 884 ids in the captured transcript span more than one line).
    expect(new Set(written.map(idOf)).size).toBe(1);
  });
});

// P2-E18-14 — enough conversation to scroll.
describe('!bulk — many blocks in one turn (P2-E18-14)', () => {
  const texts = (): string[] =>
    out
      .filter((m) => m.type === 'assistant')
      .map(
        (m) => (m.message as { content: Array<{ text?: string }> }).content[0]?.text ?? ''
      );

  it('emits the requested number of assistant blocks, numbered from 1', () => {
    proto.handle(userMsg('!bulk 5 SB_'));
    expect(texts()).toEqual(['SB_1', 'SB_2', 'SB_3', 'SB_4', 'SB_5']);
    expect(types()).toContain('result:success');
  });

  it('has a default prefix, and no thinking block to pad the count', () => {
    proto.handle(userMsg('!bulk 2'));
    expect(texts()).toEqual(['BULK_BLOCK_1', 'BULK_BLOCK_2']);
  });

  it('is bounded, so a typo cannot hang the harness', () => {
    proto.handle(userMsg('!bulk 99999 X'));
    expect(texts()).toHaveLength(200);
  });

  it('a non-numeric count is zero blocks and a finished turn, not a crash', () => {
    proto.handle(userMsg('!bulk lots'));
    expect(texts()).toEqual([]);
    expect(types()).toContain('result:success');
  });
});

describe('the other scripted behaviours (P2-E18-04)', () => {
  it('!exit exits with the given code', () => {
    proto.handle(userMsg('!exit 3'));
    expect(exits).toEqual([3]);
  });

  it('!stderr writes to stderr and still completes the turn', () => {
    proto.handle(userMsg('!stderr a warning'));
    expect(stderrs).toEqual(['a warning']);
    expect(types()).toContain('result:success');
  });

  it('ignores message types it does not know, like the real CLI does', () => {
    expect(() => proto.handle({ type: 'something_new', payload: 1 })).not.toThrow();
    expect(out).toEqual([]);
  });
});

// #404 — `--resume` made observable. The real CLI silently continues the
// conversation; nothing on the wire says "resumed", so the fake says it
// out loud in its first reply — that marker is the only way an e2e can read
// "the relaunch really passed --resume" off the screen.
describe('a resumed session announces it, once (#404)', () => {
  const resumed = (): FakeStreamProtocol =>
    new FakeStreamProtocol(host, (m) => out.push(m), { resumedFrom: 'native-7' });

  it('the first reply leads with RESUMED-FROM:<id>', () => {
    const p = resumed();
    p.handle(userMsg('hello'));

    expect(assistantText()).toBe('RESUMED-FROM:native-7');
    // and the ordinary reply still follows in the same turn
    expect(types()).toContain('result:success');
  });

  it('the second turn is an ordinary turn — the marker is once per PROCESS', () => {
    const p = resumed();
    p.handle(userMsg('first'));
    out.length = 0;

    p.handle(userMsg('second'));

    expect(out.some((m) => JSON.stringify(m).includes('RESUMED-FROM'))).toBe(false);
  });

  it('a session spawned without --resume never says it', () => {
    proto.handle(userMsg('hello'));

    expect(out.some((m) => JSON.stringify(m).includes('RESUMED-FROM'))).toBe(false);
  });
});

// #313 — the hook channel a Direct session has and this fake did not.
//
// Hooks are independent of the transport: a stream session is spawned with our
// `--settings` file exactly like a PTY one, so the real CLI can POST a
// `Notification` while its permissions ride `can_use_tool`. That collision is
// the whole of #313, and until now the fake could not produce one — which is
// why #261 part B had to be settled by reading code and why its e2e POSTed the
// hook from the test process rather than from the session.
describe('!notify fires a hook Notification (#313)', () => {
  it('sends the payload the real CLI would, on the hook channel', () => {
    proto.handle(userMsg('!notify permission_prompt Claude needs your permission to use Write'));

    expect(hooks).toEqual([
      {
        hook_event_name: 'Notification',
        session_id: FAKE_SESSION_ID,
        cwd: '/work',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Write',
      },
    ]);
  });

  it('the classification is the CALLER own — any type, any message', () => {
    proto.handle(userMsg('!notify idle Claude is waiting for your input'));

    expect(hooks[0]).toMatchObject({
      notification_type: 'idle',
      message: 'Claude is waiting for your input',
    });
  });

  it('a type with no message is a notification too', () => {
    proto.handle(userMsg('!notify permission_prompt'));

    expect(hooks[0]).toMatchObject({ notification_type: 'permission_prompt', message: '' });
  });

  // The turn is left OPEN on purpose, in the shape of `!hang`: whatever the
  // notification did to the status has to stay observable, and an `assistant`
  // message straight after would walk the card back to `working` and hide it.
  it('emits nothing on the stream and does not end the turn', () => {
    proto.handle(userMsg('!notify permission_prompt asking'));

    expect(types()).toEqual(['system:init', 'user']); // the per-turn preamble, and nothing else
  });

  // Every other host of this protocol — `fake-stream-check`, and every test in
  // this file written before #313 — has no hook channel at all.
  it('a host without fireHook is unharmed', () => {
    const bare = new FakeStreamProtocol({ ...host, fireHook: undefined }, (m) => out.push(m));

    expect(() => bare.handle(userMsg('!notify permission_prompt asking'))).not.toThrow();
    expect(hooks).toEqual([]);
  });

  it('a bare !notify with no type is an ordinary prompt', () => {
    proto.handle(userMsg('!notify'));

    expect(hooks).toEqual([]);
    expect(assistantText()).toBe('FAKE-REPLY: !notify');
  });
});

describe('extractText — the inbound envelope (P2-E18-04)', () => {
  it('reads the SDK content-block array S-10 wrote to the real CLI', () => {
    expect(extractText({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe('hi');
  });

  it('joins several text blocks', () => {
    expect(
      extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
    ).toBe('ab');
  });

  it('skips non-text blocks rather than rendering [object Object]', () => {
    expect(
      extractText({ content: [{ type: 'image', source: {} }, { type: 'text', text: 'b' }] })
    ).toBe('b');
  });

  it('accepts a bare string, which the message format also permits', () => {
    expect(extractText({ content: 'plain' })).toBe('plain');
  });

  it('is empty rather than throwing on a malformed envelope', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText({})).toBe('');
    expect(extractText({ content: 42 })).toBe('');
  });
});

// P2-E10-09 — the fake has to be able to TELL that an image arrived, or every
// test of the image path can only prove the composer cleared itself.
describe('images on the inbound envelope (P2-E10-09)', () => {
  const png = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
  };
  const withImage = (): Record<string, unknown> => ({
    type: 'user',
    message: { role: 'user', content: [png, { type: 'text', text: 'what is this?' }] },
    parent_tool_use_id: null,
    session_id: '',
  });

  it('reads exactly the block shape the extension writes', () => {
    expect(extractImages({ content: [png] })).toEqual([
      { mediaType: 'image/png', data: 'AQIDBA==' },
    ]);
  });

  // A strict reader, on purpose: a block WE got wrong should look like an image
  // that vanished, not like one the fake was kind enough to accept.
  it('ignores anything that is not that shape', () => {
    expect(extractImages({ content: [{ type: 'image' }] })).toEqual([]);
    expect(extractImages({ content: [{ type: 'image', source: { type: 'url', url: 'x' } }] })).toEqual([]);
    expect(extractImages({ content: [{ type: 'text', text: 'a' }] })).toEqual([]);
    expect(extractImages(undefined)).toEqual([]);
    expect(extractImages({ content: 'plain' })).toEqual([]);
  });

  it('answers an image turn with what it decoded off the wire', () => {
    proto.handle(withImage());
    const said = out
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => ((m.message as { content?: Array<{ text?: string }> })?.content ?? []))
      .map((c) => c.text ?? '')
      .join(' ');
    expect(said).toContain('IMAGE-SEEN:image/png:8');
  });

  // `--replay-user-messages` echoes our own turn back. Dropping the image from
  // that echo would be a fake that cannot distinguish a working image path from
  // a broken one.
  it('echoes the image block back, unchanged', () => {
    proto.handle(withImage());
    const echo = out.find((m) => m.type === 'user') as
      | { message: { content: Array<Record<string, unknown>> } }
      | undefined;
    expect(echo?.message.content[0]).toEqual(png);
    expect(echo?.message.content[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('leaves a text-only turn exactly as it was', () => {
    proto.handle(userMsg('hello'));
    const echo = out.find((m) => m.type === 'user') as
      | { message: { content: Array<Record<string, unknown>> } }
      | undefined;
    expect(echo?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(types().filter((t) => t === 'assistant').length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain('IMAGE-SEEN');
  });
});

describe('documents on the inbound envelope (P2-E10-10)', () => {
  const doc = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '# hello\n' },
    title: 'notes.md',
  };
  const pdf = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'AQIDBA==' },
    title: 'spec.pdf',
  };
  const withDoc = (block: Record<string, unknown> = doc): Record<string, unknown> => ({
    type: 'user',
    message: { role: 'user', content: [block, { type: 'text', text: 'read this' }] },
    parent_tool_use_id: null,
    session_id: '',
  });

  it('reads both document shapes the extension writes', () => {
    expect(extractDocuments({ content: [doc] })).toEqual([
      { kind: 'text', title: 'notes.md', data: '# hello\n' },
    ]);
    expect(extractDocuments({ content: [pdf] })).toEqual([
      { kind: 'pdf', title: 'spec.pdf', data: 'AQIDBA==' },
    ]);
  });

  // THE REGRESSION THIS EXISTS FOR: a text document whose source says `base64`
  // is still valid JSON and still round-trips — it just reaches the model as
  // gibberish. A strict reader turns that into a document that vanished.
  it('refuses a text document that claims the wrong source type', () => {
    expect(
      extractDocuments({
        content: [{ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'eA==' }, title: 'a.md' }],
      })
    ).toEqual([]);
    expect(extractDocuments({ content: [{ type: 'document', title: 'a.md' }] })).toEqual([]);
    expect(extractDocuments({ content: [{ ...doc, title: 7 }] })).toEqual([]);
    expect(extractDocuments(undefined)).toEqual([]);
  });

  // The CONTENTS are echoed for text, not a length: a base64'd text file has a
  // perfectly plausible length and completely wrong bytes.
  it('answers a document turn with what it decoded off the wire', () => {
    proto.handle(withDoc());
    const said = out
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => ((m.message as { content?: Array<{ text?: string }> })?.content ?? []))
      .map((c) => c.text ?? '')
      .join(' ');
    expect(said).toContain('DOC-SEEN:text:notes.md:# hello');
  });

  it('echoes the document block back, unchanged', () => {
    proto.handle(withDoc());
    const echo = out.find((m) => m.type === 'user') as
      | { message: { content: Array<Record<string, unknown>> } }
      | undefined;
    expect(echo?.message.content[0]).toEqual(doc);
    expect(echo?.message.content[1]).toEqual({ type: 'text', text: 'read this' });
  });

  it('leaves a text-only turn exactly as it was', () => {
    proto.handle(userMsg('hello'));
    expect(JSON.stringify(out)).not.toContain('DOC-SEEN');
  });
});

// ── #563 — the CLI's own chooser, in the shape the real one sends it ─────────
describe("the AskUserQuestion round trip (#563)", () => {
  /**
   * Every assistant TEXT this turn produced.
   *
   * The empty ones are the thinking block's own assistant message, which every
   * ordinary reply carries (see `emitAssistantText`) and which is not prose.
   */
  const said = (): string[] =>
    out
      .filter((m) => m.type === 'assistant')
      .map((m) => (m.message as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
      .filter(Boolean);

  const request = () =>
    out.find((m) => m.type === 'control_request') as {
      request_id: string;
      request: Record<string, unknown>;
    };

  const answer = (response: Record<string, unknown>): void => {
    const req = request();
    out.length = 0;
    proto.handle({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response },
    });
  };

  it('!ask raises a can_use_tool for AskUserQuestion and suspends the turn', () => {
    proto.handle(userMsg('!ask'));

    const r = request();
    expect(r.request.subtype).toBe('can_use_tool');
    expect(r.request.tool_name).toBe('AskUserQuestion');
    expect(types()).not.toContain('result:success');
  });

  // The real capture carries NONE of the permission furniture, because it is
  // not asking for permission — there is nothing to justify and nothing to
  // suggest. A fake that attached "which is a sensitive file" to a question
  // would have the panel rendering a safety warning nobody sent.
  it('the request carries no reason, reason type or suggestions', () => {
    proto.handle(userMsg('!ask'));
    const r = request().request;

    expect(r.decision_reason).toBeUndefined();
    expect(r.decision_reason_type).toBeUndefined();
    expect(r.permission_suggestions).toBeUndefined();
    expect(r.tool_use_id).toBeTruthy(); // this one IS on the real payload
  });

  it('offers one of each arity, so both halves of the panel are reachable', () => {
    proto.handle(userMsg('!ask'));
    const questions = (request().request.input as { questions: Array<Record<string, unknown>> })
      .questions;

    expect(questions).toHaveLength(2);
    expect(questions[0].multiSelect).toBe(false);
    expect(questions[1].multiSelect).toBe(true);
    expect(questions[0].header).toBe('Colour');
  });

  it('!ask1 raises the pick-one alone', () => {
    proto.handle(userMsg('!ask1'));
    const questions = (request().request.input as { questions: unknown[] }).questions;
    expect(questions).toHaveLength(1);
  });

  // The point of the verb: what comes back is what the HOST actually put on the
  // wire, so an e2e can assert the answer rather than the panel's own belief
  // about it.
  it('echoes the answers it was given, verbatim', () => {
    proto.handle(userMsg('!ask'));
    answer({
      behavior: 'allow',
      updatedInput: {
        questions: [],
        answers: {
          'Which colour do you prefer?': 'Red',
          'Which of these languages do you use?': 'TypeScript, Rust',
        },
      },
    });

    expect(said()).toEqual([
      'ANSWERS: Which colour do you prefer?=Red | Which of these languages do you use?=TypeScript, Rust',
    ]);
    expect(types()).toContain('result:success');
  });

  it('an allow with no answers reports none — the CLI own "did not answer" case', () => {
    proto.handle(userMsg('!ask1'));
    answer({ behavior: 'allow', updatedInput: { questions: [] } });

    expect(said()).toEqual(['ANSWERS: none']);
  });

  it('a deny says so and still finishes the turn', () => {
    proto.handle(userMsg('!ask1'));
    answer({ behavior: 'deny', message: 'Not now' });

    expect(said()).toEqual(['QUESTION DENIED']);
    expect(types()).toContain('result:success');
  });

  it('writes no files — a question is not a tool that does anything', () => {
    proto.handle(userMsg('!ask1'));
    answer({ behavior: 'allow', updatedInput: { answers: { x: 'y' } } });

    expect(writes).toEqual([]);
  });
});
