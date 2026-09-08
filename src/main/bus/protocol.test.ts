import { describe, it, expect, vi } from 'vitest';
import {
  Dispatch,
  FALLBACK_PROTOCOL_VERSION,
  LineReader,
  MAX_LINE_BYTES,
  ProtocolOptions,
  ToolDescriptor,
  dispatch,
  parseLine,
  textResult,
} from './protocol';

const TOOLS: ToolDescriptor[] = [
  { name: 'list_sessions', description: 'd', inputSchema: { type: 'object' } },
];

function opts(over: Partial<ProtocolOptions> = {}): ProtocolOptions {
  return {
    serverName: 'switchboard',
    serverVersion: '1.0.0',
    tools: TOOLS,
    callTool: vi.fn().mockResolvedValue(textResult('called')),
    ...over,
  };
}

const reply = (d: Dispatch): Record<string, unknown> => {
  if (d.kind !== 'reply') throw new Error(`expected a reply, got ${d.kind}`);
  return d.message as unknown as Record<string, unknown>;
};

describe('dispatch — the handshake never blocks (#760: a silent server costs ~32s)', () => {
  // THE STRUCTURAL ASSERTION, and the reason `dispatch` returns a union at all.
  // Timing this instead would pass on a fast machine with the bug in it: a
  // pipe connect ahead of `initialize` is microseconds when the host is up and
  // ~30 SECONDS when it is not, and a unit test never sees the second case.
  it.each(['initialize', 'tools/list', 'ping'])(
    '%s is answered from the synchronous arm, never `pending`',
    (method) => {
      const d = dispatch({ jsonrpc: '2.0', id: 1, method }, opts());
      expect(d.kind).toBe('reply');
    }
  );

  it('never invokes callTool while answering the handshake', () => {
    const callTool = vi.fn();
    for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized']) {
      dispatch({ jsonrpc: '2.0', id: 1, method }, opts({ callTool }));
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it('tools/call is the ONLY method that may block', () => {
    const methods = ['initialize', 'tools/list', 'ping', 'tools/call', 'nope'];
    const pending = methods.filter(
      (m) =>
        dispatch({ jsonrpc: '2.0', id: 1, method: m, params: { name: 'list_sessions' } }, opts()).kind ===
        'pending'
    );
    expect(pending).toEqual(['tools/call']);
  });

  it('does not run the tool until the pending arm is invoked', async () => {
    const callTool = vi.fn().mockResolvedValue(textResult('x'));
    const d = dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions' } },
      opts({ callTool })
    );
    // `dispatch` returning is NOT the tool running — that separation is what
    // lets `apply` order the write of a handshake reply ahead of any I/O.
    expect(callTool).not.toHaveBeenCalled();
    if (d.kind !== 'pending') throw new Error('expected pending');
    await d.run();
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe('dispatch — initialize', () => {
  it('ECHOES the client protocol version rather than asserting one', () => {
    const d = dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      opts()
    );
    expect((reply(d).result as Record<string, unknown>).protocolVersion).toBe('2025-11-25');
  });

  it('echoes a DIFFERENT version too — otherwise "echo" is untested', () => {
    // Without this, a hard-coded '2025-11-25' passes the test above. That is
    // exactly the class of hole #761's mutation harness found: a fixture built
    // from the value under test proves nothing about it.
    const d = dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      opts()
    );
    expect((reply(d).result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
  });

  it.each([[{}], [{ protocolVersion: '' }], [{ protocolVersion: 7 }]])(
    'falls back when the client proposes nothing usable (%j)',
    (params) => {
      const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params }, opts());
      expect((reply(d).result as Record<string, unknown>).protocolVersion).toBe(FALLBACK_PROTOCOL_VERSION);
    }
  );

  it('identifies the server by the name and version it was GIVEN', () => {
    // Deliberately NOT 'switchboard'/'1.0.0'. Asserting the real values — even
    // by reading them off `opts()` — passes against an implementation that
    // hard-codes them and ignores its configuration entirely; the mutation
    // harness proved exactly that. Distinct values are the whole test.
    const d = dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      opts({ serverName: 'not-the-default', serverVersion: '9.9.9-test' })
    );
    expect((reply(d).result as Record<string, unknown>).serverInfo).toEqual({
      name: 'not-the-default',
      version: '9.9.9-test',
    });
  });

  it('declares the tools capability', () => {
    const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, opts());
    expect((reply(d).result as Record<string, unknown>).capabilities).toEqual({ tools: {} });
  });
});

describe('dispatch — notifications are never answered', () => {
  // A reply to a notification is a protocol violation, and some clients treat
  // it as fatal. Every one of these has an obvious wrong answer that a naive
  // implementation would produce.
  it.each([
    ['notifications/initialized', undefined],
    ['initialized', undefined],
    ['initialize', undefined],
    ['tools/list', undefined],
    ['ping', undefined],
    ['tools/call', undefined],
    ['totally-unknown', undefined],
  ])('%s with no id says nothing', (method) => {
    expect(dispatch({ jsonrpc: '2.0', method }, opts()).kind).toBe('none');
  });

  it('an explicit null id is a notification, not id 0', () => {
    expect(dispatch({ jsonrpc: '2.0', id: null, method: 'ping' }, opts()).kind).toBe('none');
  });

  it('id 0 IS a real id — falsy but valid JSON-RPC', () => {
    const d = dispatch({ jsonrpc: '2.0', id: 0, method: 'ping' }, opts());
    expect(reply(d).id).toBe(0);
  });

  it('an empty-string id is a real id', () => {
    const d = dispatch({ jsonrpc: '2.0', id: '', method: 'ping' }, opts());
    expect(reply(d).id).toBe('');
  });

  it('the namespaced AND bare spellings of initialized are both silent', () => {
    for (const m of ['notifications/initialized', 'initialized']) {
      expect(dispatch({ jsonrpc: '2.0', id: 1, method: m }, opts()).kind).toBe('none');
    }
  });

  it('a response (an id, no method) is not answered — we issue no requests', () => {
    expect(dispatch({ jsonrpc: '2.0', id: 4, result: {} }, opts()).kind).toBe('none');
  });
});

describe('dispatch — tools', () => {
  it('tools/list returns the descriptors it was given', () => {
    const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, opts());
    expect((reply(d).result as { tools: ToolDescriptor[] }).tools).toEqual(TOOLS);
  });

  it('tools/list hands back a COPY — a caller cannot mutate our descriptors', () => {
    const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, opts());
    const returned = (reply(d).result as { tools: ToolDescriptor[] }).tools;
    returned.push({ name: 'injected', description: '', inputSchema: {} });
    expect(TOOLS).toHaveLength(1);
  });

  it('refuses a tool it does not advertise, rather than calling through', () => {
    const callTool = vi.fn();
    const d = dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } },
      opts({ callTool })
    );
    expect(reply(d).error).toMatchObject({ code: -32602 });
    // The half that matters: an unknown name must not reach the handler at all.
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([[undefined], [42], [null], [{}]])('refuses a non-string tool name (%j)', (name) => {
    const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, opts());
    // The MESSAGE, not just the code. Both guards answer -32602, so a code-only
    // assertion cannot tell "you did not send a name" from "no such tool" — and
    // the harness showed the type guard could be deleted outright with every
    // test still green. The two are different diagnoses for the caller.
    const err = reply(d).error as { code: number; message: string };
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('string');
  });

  it.each([[undefined], ['a string'], [[1, 2]], [null]])(
    'normalises non-object arguments to {} rather than throwing (%j)',
    async (args) => {
      const callTool = vi.fn().mockResolvedValue(textResult('ok'));
      const d = dispatch(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: args } },
        opts({ callTool })
      );
      if (d.kind !== 'pending') throw new Error('expected pending');
      await d.run();
      expect(callTool).toHaveBeenCalledWith('list_sessions', {});
    }
  );

  it('passes real arguments through untouched', async () => {
    const callTool = vi.fn().mockResolvedValue(textResult('ok'));
    const d = dispatch(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_sessions', arguments: { lastN: 5 } },
      },
      opts({ callTool })
    );
    if (d.kind !== 'pending') throw new Error('expected pending');
    await d.run();
    expect(callTool).toHaveBeenCalledWith('list_sessions', { lastN: 5 });
  });

  it('carries the request id on the pending arm, so the reply can be addressed', () => {
    const d = dispatch(
      { jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'list_sessions' } },
      opts()
    );
    if (d.kind !== 'pending') throw new Error('expected pending');
    expect(d.id).toBe('abc');
  });
});

describe('dispatch — junk', () => {
  it.each([[null], [undefined], ['a string'], [42], [[]]])('survives %j', (msg) => {
    expect(dispatch(msg, opts()).kind).toBe('none');
  });

  it('an unknown method with an id is refused as method-not-found', () => {
    const d = dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, opts());
    expect(reply(d).error).toMatchObject({ code: -32601 });
  });
});

describe('textResult', () => {
  it('omits isError entirely on success — not `isError: false`', () => {
    // MCP treats the presence of the key as the signal. `{isError: false}` is
    // read as an error by at least one client generation, so this is a shape
    // assertion and not a style one.
    expect(textResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect('isError' in textResult('hi')).toBe(false);
  });

  it('sets isError true when asked', () => {
    expect(textResult('bad', true)).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true });
  });
});

describe('LineReader — framing', () => {
  it('returns whole lines and holds the partial one back', () => {
    const r = new LineReader();
    expect(r.feed('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(r.feed(':2}\n')).toEqual(['{"b":2}']);
  });

  it('reassembles a message split across many chunks', () => {
    const r = new LineReader();
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    for (const ch of msg) expect(r.feed(ch)).toEqual([]);
    expect(r.feed('\n')).toEqual([msg]);
  });

  it('returns several lines from one chunk, in order', () => {
    expect(new LineReader().feed('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('skips blank and whitespace-only lines', () => {
    expect(new LineReader().feed('a\n\n   \nb\n')).toEqual(['a', 'b']);
  });

  it('tolerates \\r\\n by leaving the \\r for the JSON parser to ignore', () => {
    expect(new LineReader().feed('{"a":1}\r\n')).toEqual(['{"a":1}\r']);
    expect(parseLine('{"a":1}\r')).toEqual({ a: 1 });
  });

  it('POISONS itself past the frame limit rather than resyncing', () => {
    // Resyncing on the next newline would resume MID-MESSAGE and feed dispatch
    // a fragment — worse than refusing, because a fragment can parse.
    const r = new LineReader(10);
    expect(r.feed('x'.repeat(50))).toEqual([]);
    expect(r.hasOverflowed()).toBe(true);
    expect(r.feed('short\n')).toEqual([]);
  });

  it('still returns lines that COMPLETED before the overflow', () => {
    const r = new LineReader(10);
    expect(r.feed('ok\n' + 'x'.repeat(50))).toEqual(['ok']);
    expect(r.hasOverflowed()).toBe(true);
  });

  it('DELIVERS a large but legal line at the default limit', () => {
    // The magnitude, which the negatives above leave completely free: every
    // overflow test injects its own tiny limit, so `MAX_LINE_BYTES` could be a
    // few hundred bytes with the whole suite green — and a legitimate large
    // `tools/call` would then poison the reader permanently (it is deliberately
    // unrecoverable), costing the session its bus for the rest of its life,
    // silently.
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { blob: 'y'.repeat(200_000) } });
    expect(big.length).toBeGreaterThan(100_000);
    const r = new LineReader();
    expect(r.feed(big.slice(0, 90_000))).toEqual([]);
    expect(r.feed(big.slice(90_000) + '\n')).toEqual([big]);
    expect(r.hasOverflowed()).toBe(false);
  });

  it('the default limit is bounded on both sides', () => {
    expect(MAX_LINE_BYTES).toBeGreaterThanOrEqual(256_000);
    expect(MAX_LINE_BYTES).toBeLessThanOrEqual(16_000_000);
  });

  it('does not overflow on a long TOTAL that is made of short lines', () => {
    // The bound is per-line, not per-stream: a busy session sends many small
    // messages and must never trip this.
    const r = new LineReader(10);
    for (let i = 0; i < 100; i++) expect(r.feed('abc\n')).toEqual(['abc']);
    expect(r.hasOverflowed()).toBe(false);
  });
});

describe('parseLine', () => {
  it('returns null for junk rather than throwing', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('parses an object', () => {
    expect(parseLine('{"id":1}')).toEqual({ id: 1 });
  });
});
