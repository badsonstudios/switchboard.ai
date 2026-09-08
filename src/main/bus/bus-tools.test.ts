import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TOOLS, TOOL_DEADLINE_MS, apply, makeCallTool, renderSessions } from './bus-tools';
import { DEFAULT_HOST_TIMEOUT_MS } from './pipe-client';
import { Dispatch, ToolResult, textResult } from './protocol';

const SESSIONS = [
  { id: 'sb-a', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working' },
  { id: 'sb-b', name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'idle' },
];

const text = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

describe('the tool surface', () => {
  it('is exactly list_sessions — #762 exposes ONE tool on purpose', () => {
    // The pipe is proven end to end before any tool surface is designed on top
    // of it. #764 and #765 add the rest; a tool arriving early here would ship
    // without the read-cap and delivery-policy arguments those items carry.
    expect(TOOLS.map((t) => t.name)).toEqual(['list_sessions']);
  });

  it('takes no arguments and forbids extras', () => {
    expect(TOOLS[0].inputSchema).toMatchObject({ additionalProperties: false });
  });

  it('has a description that could find it unaided (#760 §6)', () => {
    // MCP SCHEMAS are deferred behind ToolSearch while NAMES are visible, so
    // this string is what does the discovery work. Asserted for substance, not
    // exact wording: it must name the product and say what it is for.
    const d = TOOLS[0].description;
    expect(d.toLowerCase()).toContain('switchboard');
    expect(d.length).toBeGreaterThan(80);
  });
});

describe('renderSessions', () => {
  it('lists every session with name, id, status and folder', () => {
    const out = renderSessions(SESSIONS, 'sb-a');
    expect(out).toContain('Alpha');
    expect(out).toContain('Beta');
    expect(out).toContain('/p/beta');
    expect(out).toContain('idle');
  });

  it('INCLUDES THE ID, so an agent can act on an ambiguity refusal', () => {
    // `SessionQueries.resolve` refuses an ambiguous NAME and tells the caller
    // to use the id. An agent that had only ever seen names could not comply.
    expect(renderSessions(SESSIONS, null)).toContain('[id sb-b]');
  });

  it('marks the caller, and only the caller', () => {
    const out = renderSessions(SESSIONS, 'sb-a');
    const marked = out.split('\n').filter((l) => l.includes('(this session)'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Alpha');
  });

  it('marks nobody when the caller is not in the list', () => {
    expect(renderSessions(SESSIONS, 'sb-somebody-else')).not.toContain('(this session)');
  });

  it('does not mark on an undefined id matching an undefined caller', () => {
    // `s.id === callerId` is true for two undefineds, which would label every
    // malformed row as the caller.
    expect(renderSessions([{ name: 'X' }], undefined)).not.toContain('(this session)');
  });

  it('counts what it lists', () => {
    expect(renderSessions(SESSIONS, null)).toContain('2 sessions');
    expect(renderSessions([SESSIONS[0]], null)).toContain('1 session open');
  });

  it('says the count in singular for one, plural for two', () => {
    expect(renderSessions([SESSIONS[0]], null)).not.toContain('1 sessions');
  });

  it.each([[[]], [null], [undefined], ['nope'], [{}]])('answers readably for %j', (input) => {
    expect(renderSessions(input, null)).toBe('No sessions are open in switchboard.');
  });

  it('renders a row with missing fields rather than throwing', () => {
    // This data crossed a pipe. A host that answered something odd must
    // degrade to a readable line, not throw inside a tool call.
    expect(() => renderSessions([{}, null, { name: 5 }], null)).not.toThrow();
    expect(renderSessions([{}], null)).toContain('(unnamed)');
  });

  it('one line per session', () => {
    expect(renderSessions(SESSIONS, null).split('\n')).toHaveLength(3); // header + 2
  });

  it('renders a row EXACTLY — every field, in order', () => {
    // `toContain` assertions leave holes a mutant walks through: nothing else
    // here asserts `providerId` reaches the output at all (drop it from `bits`
    // and every other test passes, because 'claude-code' appears in no
    // expectation), and reordering the fields survives too.
    expect(renderSessions([SESSIONS[1]], 'sb-a')).toBe(
      '1 session open in switchboard:\n- Beta [id sb-b] — idle — /p/beta — claude-code'
    );
  });

  it('renders the caller’s row exactly, marker and all', () => {
    expect(renderSessions([SESSIONS[0]], 'sb-a')).toBe(
      '1 session open in switchboard:\n- Alpha [id sb-a] (this session) — working — /p/alpha — claude-code'
    );
  });
});

describe('makeCallTool', () => {
  const ok = vi.fn().mockResolvedValue({ ok: true, sessions: SESSIONS, callerId: 'sb-a' });

  it('renders the host’s answer', async () => {
    const call = makeCallTool({ pipePath: 'p', tokenPath: 't', ask: ok });
    const r = await call('list_sessions', {});
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Alpha');
  });

  it('asks the host for the tool that was named', async () => {
    const ask = vi.fn().mockResolvedValue({ ok: true, sessions: [] });
    await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ request: { op: 'list_sessions', args: {} } }));
  });

  it('THREADS THE TOOL ARGUMENTS THROUGH to the host', async () => {
    // `dispatch` normalises the model's arguments carefully and this used to
    // drop them one line later. `list_sessions` takes none, so nothing today
    // notices — #764's `get_session_output(ref, lastN)` is the first tool that
    // would, by silently ignoring `lastN`. Pinned now, while it is free.
    const ask = vi.fn().mockResolvedValue({ ok: true, sessions: [] });
    await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', { lastN: 5, ref: '@A' });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ request: { op: 'list_sessions', args: { lastN: 5, ref: '@A' } } })
    );
  });

  it('sends the platform detail to the log, never into the tool content', async () => {
    const lines: string[] = [];
    const err = Object.assign(new Error('could not reach the switchboard host'), { detail: 'ECONNREFUSED' });
    const ask = vi.fn().mockRejectedValue(err);
    const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask, log: (m) => lines.push(m) })(
      'list_sessions',
      {}
    );
    expect(text(r)).not.toMatch(/ECONNREFUSED/);
    expect(lines.join('\n')).toContain('ECONNREFUSED');
  });

  it('passes the endpoint it was configured with', async () => {
    const ask = vi.fn().mockResolvedValue({ ok: true, sessions: [] });
    await makeCallTool({ pipePath: 'PIPE', tokenPath: 'TOKEN', ask })('list_sessions', {});
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ pipePath: 'PIPE', tokenPath: 'TOKEN' }));
  });

  describe('failure is ALWAYS readable isError content, never a throw', () => {
    // The done-when: a dead host fails the call cleanly with an error the agent
    // can read, and never hangs. A throw here would become a JSON-RPC protocol
    // error the model cannot act on.
    it('a rejected host request', async () => {
      const ask = vi.fn().mockRejectedValue(new Error('could not reach the switchboard host (ENOENT)'));
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('could not answer');
      expect(text(r)).toContain('Continue without it');
      // The real cause survives to the log, rather than being replaced by a
      // generic sentence.
      expect(text(r)).toContain('could not reach the switchboard host');
    });

    it('does NOT claim unreachability for a cause that is not unreachability', async () => {
      // `askHost` separates "cannot reach the host" from "cannot read the
      // token", and an outer sentence asserting the first would flatten the
      // second back into it and state it as fact. The check script caught this
      // by taking the token-missing branch while claiming to test a dead host.
      const ask = vi.fn().mockRejectedValue(new Error('could not read the session token (ENOENT)'));
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      expect(text(r)).not.toContain('not reachable');
      expect(text(r)).toContain('could not read the session token');
    });

    it('a refusal from the host, with its reason', async () => {
      const ask = vi.fn().mockResolvedValue({ ok: false, reason: 'not authorized' });
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('not authorized');
    });

    it('a reply with no ok field at all', async () => {
      const ask = vi.fn().mockResolvedValue({ sessions: SESSIONS });
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      // NOT rendered as success. `ok !== true` has to be the gate, because a
      // truthiness check would let `{sessions: …}` through unauthenticated.
      expect(r.isError).toBe(true);
    });

    it('a truthy-but-not-true ok', async () => {
      const ask = vi.fn().mockResolvedValue({ ok: 'yes', sessions: SESSIONS });
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      expect(r.isError).toBe(true);
    });

    it('a rejection with no message', async () => {
      const ask = vi.fn().mockRejectedValue('just a string');
      const r = await makeCallTool({ pipePath: 'p', tokenPath: 't', ask })('list_sessions', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('just a string');
    });
  });

  describe('an unconfigured bus reports itself rather than exiting', () => {
    // #760 measured that a server which fails to speak MCP costs the session
    // ~32s. A misconfigured one that stays up and says so costs nothing.
    it.each([
      [{ pipePath: null, tokenPath: 't' }],
      [{ pipePath: 'p', tokenPath: null }],
      [{ pipePath: null, tokenPath: null }],
    ])('%j', async (config) => {
      const ask = vi.fn();
      const r = await makeCallTool({ ...config, ask })('list_sessions', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('not configured');
      // And it does not try the pipe anyway.
      expect(ask).not.toHaveBeenCalled();
    });
  });
});

describe('apply', () => {
  it('writes a synchronous reply immediately', () => {
    const write = vi.fn();
    apply({ kind: 'reply', message: { jsonrpc: '2.0', id: 1, result: {} } }, write);
    expect(write).toHaveBeenCalledOnce();
  });

  it('writes NOTHING for a notification', () => {
    const write = vi.fn();
    apply({ kind: 'none' }, write);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not write the handshake reply AFTER starting the tool', async () => {
    // The ordering that #760's 32-second finding is really about: a reply that
    // is produced synchronously must be on the wire before anything awaits.
    const order: string[] = [];
    const write = (): void => void order.push('write');
    const pending: Dispatch = {
      kind: 'pending',
      id: 1,
      run: async () => {
        order.push('tool');
        return textResult('x');
      },
    };
    apply({ kind: 'reply', message: { jsonrpc: '2.0', id: 0, result: {} } }, write);
    apply(pending, write);
    await vi.waitFor(() => expect(order).toContain('tool'));
    expect(order[0]).toBe('write');
  });

  it('answers a pending call with the tool’s result, addressed to its id', async () => {
    const write = vi.fn();
    apply({ kind: 'pending', id: 'xyz', run: async () => textResult('done') }, write);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(write).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 'xyz',
      result: { content: [{ type: 'text', text: 'done' }] },
    });
  });

  it('ANSWERS A HANDLER THAT NEVER RETURNS, on its own deadline', async () => {
    // "Never hangs" held only because the one tool happened to go through a
    // client that owns a timer — a property of today's implementation, not of
    // this layer. #764's tools should inherit the guarantee rather than have to
    // remember it.
    const write = vi.fn();
    const onBug = vi.fn();
    apply({ kind: 'pending', id: 3, run: () => new Promise(() => {}) }, write, onBug, 40);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    const sent = write.mock.calls[0][0] as { id: number; result: ToolResult };
    expect(sent.id).toBe(3);
    expect(sent.result.isError).toBe(true);
    expect(onBug).toHaveBeenCalled();
  });

  it('does not answer TWICE when a slow handler finishes after the deadline', async () => {
    // Two responses for one id is a protocol violation, and the obvious
    // implementation of the deadline above produces exactly that.
    const write = vi.fn();
    let settle: (r: ToolResult) => void = () => {};
    apply(
      { kind: 'pending', id: 4, run: () => new Promise<ToolResult>((r) => (settle = r)) },
      write,
      () => {},
      30
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    settle(textResult('late'));
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('the default deadline is above the pipe client’s, so the better message wins', () => {
    // If this were below `DEFAULT_HOST_TIMEOUT_MS`, every unreachable-host call
    // would report the generic "took too long" instead of the specific reason.
    expect(TOOL_DEADLINE_MS).toBeGreaterThan(DEFAULT_HOST_TIMEOUT_MS);
  });

  it('STILL ANSWERS when the tool handler rejects — an unanswered id is the hang', async () => {
    const write = vi.fn();
    const onBug = vi.fn();
    apply({ kind: 'pending', id: 9, run: () => Promise.reject(new Error('bug')) }, write, onBug);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    const sent = write.mock.calls[0][0] as { id: number; result: ToolResult };
    expect(sent.id).toBe(9);
    expect(sent.result.isError).toBe(true);
    expect(onBug).toHaveBeenCalled();
  });
});

describe('the child bundle is transport-free (asserted, not documented)', () => {
  // The child runs under ELECTRON_RUN_AS_NODE in a process the CLI owns. An
  // `import 'electron'` there resolves to a PATH STRING, not the module, and
  // pulling in `SessionQueries` would put the host's own code — and its fs
  // access — inside a process spawned by the agent's CLI.
  //
  // THE GRAPH IS WALKED, NOT LISTED. The first version hand-listed five files
  // and matched specifiers per LINE, which review showed could be defeated
  // three ways with every test green: a multi-line `import {\n  X\n} from '…'`
  // (the specifier lives on the `} from` line, which the `^import` filter never
  // sees), a dynamic `await import('electron')`, and — worst — simply adding a
  // NEW file to the child's graph, since the list was manual. Walking from the
  // entry closes all three: a file that is not reachable from `bus-server.ts`
  // is not in the child, and one that is gets checked whether anyone remembered
  // it or not. `bus-check.ts` then asserts the same thing against the BUILT
  // bundle, which is the copy that actually runs.
  // Matched against SPECIFIERS (the inner text of the quotes), one per line —
  // so `electron` anchors to a whole line rather than looking for quotes that
  // the extraction has already stripped.
  const FORBIDDEN: [RegExp, string][] = [
    [/^electron$/m, 'electron'],
    [/sessions\/queries/, 'the query core'],
    [/shared\/ipc/, 'IPC'],
    [/\bipc\b/, 'IPC'],
    [/node-pty/, 'node-pty'],
    [/host-channel/, 'the host end'],
  ];

  /** Every local module reachable from an entry, following relative imports. */
  function childGraph(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      for (const m of src.matchAll(/from\s+['"](\.\/[^'"]+)['"]|import\(\s*['"](\.\/[^'"]+)['"]/g)) {
        queue.push(`${m[1] ?? m[2]}.ts`.replace('./', ''));
      }
    }
    return [...seen];
  }

  const graph = childGraph('bus-server.ts');

  it('reaches the modules it should (guards against walking nothing)', () => {
    // A graph walk that silently returns just the entry would pass every
    // assertion below — the exact failure mode a source-text guard is prone to.
    expect(graph).toEqual(
      expect.arrayContaining(['bus-server.ts', 'bus-tools.ts', 'pipe-client.ts', 'protocol.ts', 'channel.ts'])
    );
    expect(graph.length).toBeGreaterThanOrEqual(5);
  });

  it.each(FORBIDDEN)('nothing in the child graph imports %s (%s)', (pattern, label) => {
    for (const file of graph) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // Specifiers only, so the prose above — which names all of these — is not
      // itself a violation. Matched across the whole file rather than per line,
      // which is what a multi-line import defeats.
      const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1] ?? m[2])
        .join('\n');
      expect(specifiers, `${file} must not import ${label}`).not.toMatch(pattern);
    }
  });

  it('would FAIL on a multi-line import of the query core (the guard guards)', () => {
    // The concrete shape that defeated the previous per-line version.
    const src = "import {\n  SessionQueries,\n} from '../sessions/queries';\n";
    const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).join('\n');
    expect(FORBIDDEN.some(([p]) => p.test(specifiers))).toBe(true);
  });

  it('would FAIL on a dynamic import of electron', () => {
    const src = "const e = await import('electron');";
    const specifiers = [...src.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).join('\n');
    expect(FORBIDDEN.some(([p]) => p.test(specifiers))).toBe(true);
  });
});
