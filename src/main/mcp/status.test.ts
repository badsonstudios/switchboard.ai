import { describe, expect, it } from 'vitest';
import { readMcpStatus } from './status';

/**
 * THE FIXTURE IS A REAL CAPTURE, not a hand-written shape. Both halves came off
 * the PATH CLI 2.1.245 on 2026-08-29 via
 * `spike/probes/721/probe-mcp-settle.mjs` — the COLD answer at 0.9s and the WARM
 * one at 5.0s, from the same session. The #721 review scar is why: the model
 * picker's fixture carried 3 of the 5 real entries and therefore could not
 * express the collision that shipped a double tick to Dan's default setup.
 */
const COLD = {
  mcpServers: [
    {
      name: 'DeepWiki',
      status: 'pending',
      config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      scope: 'local',
    },
  ],
};

const WARM = {
  mcpServers: [
    {
      name: 'DeepWiki',
      status: 'connected',
      serverInfo: { name: 'DeepWiki', version: '2.14.3' },
      config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      scope: 'local',
      tools: [
        { name: 'ask_question', annotations: {} },
        { name: 'read_wiki_contents', annotations: {} },
        { name: 'read_wiki_structure', annotations: {} },
      ],
    },
  ],
};

describe('the measured cold/warm difference', () => {
  it('reads the COLD answer without inventing the fields it lacks', () => {
    const [s] = readMcpStatus(COLD);
    expect(s.name).toBe('DeepWiki');
    expect(s.status).toBe('pending');
    // THE POINT OF THE WHOLE TEST. `serverInfo` and `tools` are absent for the
    // entire pending window, and a reader that treated that as malformed would
    // drop every server on screen for the first five seconds of every fresh
    // session.
    expect(s.version).toBeUndefined();
    expect(s.tools).toEqual([]);
    expect(s.scope).toBe('local');
  });

  it('reads the WARM answer with the version and the tool names', () => {
    const [s] = readMcpStatus(WARM);
    expect(s.status).toBe('connected');
    expect(s.version).toBe('2.14.3');
    // NAMES, not the entries — the `annotations` object is deliberately dropped.
    expect(s.tools).toEqual(['ask_question', 'read_wiki_contents', 'read_wiki_structure']);
  });

  it('carries `pending` through as itself rather than folding it into unknown', () => {
    // It is a real five-second state, not an absence of information, and the
    // pane draws a different word for it.
    expect(readMcpStatus(COLD)[0].status).toBe('pending');
    expect(readMcpStatus({ mcpServers: [{ name: 'x', status: 'weird' }] })[0].status).toBe(
      'unknown'
    );
  });
});

describe('the scope vocabulary the config files cannot reach', () => {
  it('keeps every runtime scope the CLI resolves', () => {
    const scopes = ['local', 'user', 'project', 'enterprise', 'managed', 'builtin', 'dynamic', 'skills'];
    const out = readMcpStatus({
      mcpServers: scopes.map((scope, i) => ({ name: `s${i}`, status: 'connected', scope })),
    });
    expect(out.map((s) => s.scope)).toEqual(scopes);
  });

  it('carries an UNRECOGNISED scope through as `unknown` rather than dropping the server', () => {
    // The `McpTransport` tolerance, applied to scopes: a server we cannot label
    // is still a server the session has, and hiding it is how #723 happened.
    const out = readMcpStatus({
      mcpServers: [{ name: 'from-the-future', status: 'connected', scope: 'quantum' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe('unknown');
  });
});

describe('secrets do not reach the row', () => {
  it('redacts userinfo and query values out of a runtime URL', () => {
    // The runtime path reads the SAME `config.url` the config path does, so it
    // is a secret-carrying field by exactly the same argument — `redactUrl` is
    // imported rather than reimplemented so the two cannot drift.
    const [s] = readMcpStatus({
      mcpServers: [
        {
          name: 'remote',
          status: 'connected',
          config: { type: 'http', url: 'https://user:tok3n@host/mcp?api_key=sk-live-abc' },
        },
      ],
    });
    expect(s.target).not.toContain('tok3n');
    expect(s.target).not.toContain('sk-live-abc');
    expect(s.target).toContain('host');
  });
});

describe('leniency — one bad entry never costs the other fifteen', () => {
  it.each([
    ['not an array', { mcpServers: 'nope' }],
    ['absent', {}],
  ])('answers an empty list when `mcpServers` is %s', (_label, payload) => {
    expect(readMcpStatus(payload as Record<string, unknown>)).toEqual([]);
  });

  it('drops only the malformed entries', () => {
    const out = readMcpStatus({
      mcpServers: [
        null,
        'a string',
        { status: 'connected' }, // no name — worthless, nothing can be said about it
        { name: '', status: 'connected' },
        { name: 'good', status: 'connected' },
      ],
    });
    expect(out.map((s) => s.name)).toEqual(['good']);
  });

  it('answers an empty target for a row with no `config` at all', () => {
    // The connector case: `mcp_status` reports no `config` for a server that
    // came from the account rather than a file, so there is no command and no
    // address to show. The row still renders — it just has nothing to say here.
    const [s] = readMcpStatus({ mcpServers: [{ name: 'Slack', status: 'connected' }] });
    expect(s.target).toBe('');
  });
});

describe('readOnly starts TRUE', () => {
  it('marks every row unmutatable until a config file vouches for it', () => {
    // The safe direction: a merge bug costs a missing Remove button rather than
    // a button that deletes something the CLI does not own. `enrichRuntime` is
    // the only thing that lowers it.
    expect(readMcpStatus(WARM).every((s) => s.readOnly)).toBe(true);
    expect(readMcpStatus(WARM)[0].envKeys).toEqual([]);
  });
});

/**
 * The transport, and the one case the whole field exists for (#734).
 *
 * `transport` was on this shape in #729 PR 1, was deleted in PR 2 as
 * computed-but-unrendered, and review's second objection was correct: it
 * asserted `stdio` whenever `mcp_status` reported no `config`, which is exactly
 * the claude.ai connector case. It is back because a row cannot decide whether
 * to offer sign-in without it — `mcp_authenticate` is refused BY TYPE for stdio
 * — and the first test below is the bug that got it removed.
 */
describe('transport', () => {
  const one = (entry: Record<string, unknown>): string =>
    readMcpStatus({ mcpServers: [{ name: 'x', status: 'connected', ...entry }] })[0].transport;

  it('answers `unknown` for a row with no `config` — NOT `stdio`', () => {
    // THE REGRESSION TEST FOR #729 PR 2's DELETED FIELD. A connector is in no
    // file, so `mcp_status` sends no `config` for it. Calling that `stdio`
    // labels every connector on the machine as the one transport that cannot
    // authenticate, which would hide sign-in on precisely the rows that need it.
    expect(one({})).toBe('unknown');
  });

  it.each([
    ['http', 'http'],
    ['sse', 'sse'],
    ['stdio', 'stdio'],
  ])('carries a `type` of %s through', (type, expected) => {
    expect(one({ config: { type, url: 'https://example.test/mcp' } })).toBe(expected);
  });

  it('answers `unknown` for a transport a newer CLI grew', () => {
    // Same tolerance as `scopeOf`: a word we do not know is still a server the
    // session has, and `unknown` may legitimately be offered sign-in.
    expect(one({ config: { type: 'websocket', url: 'wss://example.test' } })).toBe('unknown');
  });

  it('reads a `command` with no `type` as stdio', () => {
    // There is nothing else a command can be.
    expect(one({ config: { command: 'npx', args: ['-y', 'server'] } })).toBe('stdio');
  });

  it('answers `unknown` for a bare `url` with no `type`', () => {
    // http and sse are both spelled with a URL and we cannot tell which. A guess
    // would buy nothing — `unknown` already means "may authenticate" — and could
    // be wrong.
    expect(one({ config: { url: 'https://example.test/mcp' } })).toBe('unknown');
  });

  it('answers `unknown` for an empty `config` object', () => {
    expect(one({ config: {} })).toBe('unknown');
  });

  it('reads the real capture as http', () => {
    expect(readMcpStatus(WARM)[0].transport).toBe('http');
    expect(readMcpStatus(COLD)[0].transport).toBe('http');
  });
});
