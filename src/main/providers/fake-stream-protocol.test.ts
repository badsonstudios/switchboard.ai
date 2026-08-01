// P2-E18-04 — the stream-json fake's protocol.
//
// Synchronous, no spawn: the CI unit job does not run a build, so anything that
// needed the compiled CLI could only skip there. The compiled program is proven
// end-to-end over real pipes by `npm run check:fake-stream`.
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeStreamProtocol, FakeStreamHost, extractText, FAKE_SESSION_ID } from './fake-stream-protocol';

let out: Record<string, unknown>[];
let writes: Array<{ path: string; content: string }>;
let stderrs: string[];
let exits: number[];
let proto: FakeStreamProtocol;

const host: FakeStreamHost = {
  cwd: () => '/work',
  writeFile: (p, content) => writes.push({ path: p, content }),
  stderr: (l) => stderrs.push(l),
  exit: (c) => exits.push(c),
  resolve: (cwd, target) => (target.startsWith('/') ? target : `${cwd}/${target}`),
};

beforeEach(() => {
  out = [];
  writes = [];
  stderrs = [];
  exits = [];
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

describe('a plain turn (P2-E18-04)', () => {
  it('emits init -> deltas -> assistant -> result, in the order S-10 observed', () => {
    proto.handle(userMsg('hello'));

    const t = types();
    expect(t[0]).toBe('system:init');
    expect(t[t.length - 1]).toBe('result:success');
    expect(t.filter((x) => x === 'stream_event').length).toBeGreaterThan(0);
    // deltas come BEFORE the assembled message
    expect(t.lastIndexOf('stream_event')).toBeLessThan(t.indexOf('assistant'));
  });

  it('the deltas concatenate to exactly the assistant text', () => {
    proto.handle(userMsg('hello'));

    const deltas = out
      .filter((m) => m.type === 'stream_event')
      .map((m) => ((m.event as { delta: { text: string } }).delta.text));
    const assistant = out.find((m) => m.type === 'assistant') as {
      message: { content: Array<{ text: string }> };
    };
    expect(deltas.join('')).toBe(assistant.message.content[0].text);
    expect(assistant.message.content[0].text).toBe('FAKE-REPLY: hello');
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
    const assistant = out.find((m) => m.type === 'assistant') as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant.message.content[0].text).toContain('denied');
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

    const assistant = out.find((m) => m.type === 'assistant') as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant.message.content[0].text).toContain('EACCES');
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
