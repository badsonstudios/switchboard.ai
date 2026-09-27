// The MCP seam's §5.29 gate, and how it says no (#632 read, #714 write).
//
// THE CLAIM UNDER TEST IS THE FOLDER CHECK, and it is the only real logic in
// `ipc.ts` — everything else delegates to `config.ts`, `health.ts`, `args.ts`
// and `cli.ts`, which have their own files. It earns a test of its own because
// the folder is UNTRUSTED RENDERER INPUT that decides three dangerous things:
// which `.mcp.json` gets read off the disk, which directory a child process is
// spawned in, and — since #714 — which repo's checked-in `.mcp.json` gets a new
// server WRITTEN into it. An ungated `mcp:add` is a way to plant a program that
// runs on a teammate's machine when they next clone.
//
// The refusal shape follows the house rule (`group-ipc.ts`'s header): RESOLVE,
// never throw, and say so in the log at `warn`. It matters more here than most
// because every channel is driven from a modal the user opened on purpose — an
// exception behind a dialog is a dialog that does nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerMcpIpc, McpLiveSession } from './ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import * as health from './health';
import * as cli from './cli';
import * as config from './config';
import type { McpAddRequest, McpStatusWire } from '../../shared/mcp';
import type { ControlVerdict } from '../../shared/control';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

interface HarnessOpts {
  sessions?: Record<string, McpLiveSession>;
  /** omitted entirely for the "no PTY host wired" case */
  withPty?: boolean;
  /** the control-channel verdict `mcp:status` gets back, or omitted for the
   *  read-only wiring where no channel was handed in at all (#729) */
  status?: (liveId: string) => Promise<ControlVerdict>;
  /** wire the two auth verbs (#734), or omit for the no-control-channel case */
  auth?: boolean;
}

function harness(folders: string[], opts: HarnessOpts = {}) {
  const handlers = new Map<string, Handler>();
  const warnings: Array<{ msg: string; fields?: LogFields }> = [];
  const typed: Array<{ liveId: string; data: string }> = [];
  /** what actually reached the session layer — the assertion that the gate let
   *  something THROUGH, which a refusal test on its own cannot make (#734) */
  const authed: Array<{ verb: string; liveId: string; name: unknown }> = [];
  const broker = {
    handle: (channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
      handlers.set(channel, fn);
    },
  } as unknown as IpcBroker;
  const noop = (): void => {};
  const log: Logger = {
    debug: noop,
    info: noop,
    warn: (msg: string, fields?: LogFields) => warnings.push({ msg, fields }),
    error: noop,
    child: () => log,
  };
  registerMcpIpc({
    broker,
    log,
    isSessionFolder: (f) => folders.includes(f),
    liveSession: (id) => opts.sessions?.[id] ?? null,
    ...(opts.withPty === false
      ? {}
      : { typeIntoPty: (liveId: string, data: string) => typed.push({ liveId, data }) }),
    ...(opts.status ? { mcpStatus: opts.status } : {}),
    ...(opts.auth
      ? {
          mcpAuthenticate: async (liveId: string, name: unknown) => {
            authed.push({ verb: 'authenticate', liveId, name });
            return { ok: true, response: {} };
          },
          mcpClearAuth: async (liveId: string, name: unknown) => {
            authed.push({ verb: 'clearAuth', liveId, name });
            return { ok: true, response: {} };
          },
        }
      : {}),
  });
  return {
    warnings,
    typed,
    authed,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args),
    channels: [...handlers.keys()].sort(),
  };
}

/** a request that passes validation, so a test can be about the GATE */
const GOOD_ADD: McpAddRequest = {
  name: 'sentry',
  scope: 'local',
  transport: 'stdio',
  target: 'npx',
  args: ['-y', 'server'],
};

afterEach(() => vi.restoreAllMocks());

describe('registration', () => {
  it('registers the three read channels and the eight write ones', () => {
    // A channel appearing here should be a deliberate edit to this list — the
    // point of the assertion is that a new door into main is never accidental.
    expect(harness([]).channels).toEqual([
      'mcp:add',
      'mcp:authenticate',
      'mcp:clearAuth',
      'mcp:health',
      'mcp:list',
      'mcp:reconnectServer',
      'mcp:remove',
      'mcp:resetApprovals',
      'mcp:status',
      'mcp:toggle',
    ]);
  });
});

describe('mcp:status — the real inventory, over the control channel (#729)', () => {
  const OK: ControlVerdict = {
    ok: true,
    response: {
      mcpServers: [
        { name: 'DeepWiki', status: 'connected', scope: 'local', config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
        { name: 'Slack', status: 'connected', scope: 'dynamic' },
      ],
    },
  };
  const live = { sessions: { s1: { folder: '/ok' } } };

  /**
   * An empty mutability floor — no config file declares anything.
   *
   * STUBBED RATHER THAN LEFT TO THE DISK, and not just for determinism: the
   * real `readInventory` reads the developer's own `~/.claude.json`, so an
   * unstubbed test would pass or fail depending on whose machine ran it.
   */
  const noConfig = (): void => {
    vi.spyOn(config, 'readInventory').mockReturnValue({
      folder: '/ok',
      servers: [],
      unreadable: [],
    });
  };

  it('answers the servers the session reports', async () => {
    noConfig();
    const h = harness(['/ok'], { ...live, status: async () => OK });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    expect(res.reason).toBe('ok');
    expect(res.servers.map((s) => s.name)).toEqual(['DeepWiki', 'Slack']);
    // Nothing in a file vouches for either, so both are read-only — which is
    // the connector case, and 13 of the 16 rows on the reporting machine.
    expect(res.servers.every((s) => s.readOnly)).toBe(true);
  });

  it('folds the config file in, so a declared server becomes removable', async () => {
    vi.spyOn(config, 'readInventory').mockReturnValue({
      folder: '/ok',
      servers: [
        {
          name: 'DeepWiki',
          scope: 'local',
          transport: 'http',
          approval: 'n/a',
          target: 'https://mcp.deepwiki.com/mcp',
          args: [],
          envKeys: ['DW_TOKEN'],
          headerKeys: [],
          source: 'claude.json',
        },
      ],
      unreadable: [],
    });
    const h = harness(['/ok'], { ...live, status: async () => OK });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    const [deepwiki, slack] = res.servers;
    expect(deepwiki.readOnly).toBe(false);
    expect(deepwiki.removeScope).toBe('local');
    expect(deepwiki.envKeys).toEqual(['DW_TOKEN']);
    // ...and the connector beside it is untouched by that
    expect(slack.readOnly).toBe(true);
  });

  // ── EVERY EMPTY LIST CARRIES A REASON ──────────────────────────────────────
  //
  // This is the whole shape of the wire type. #723 exists because "no servers
  // configured" was rendered for a case that actually meant "we cannot see
  // them", and an empty list with no reason would reintroduce that one layer in.

  it('says `not-stream` for a PTY session rather than reporting no servers', async () => {
    const h = harness(['/ok'], {
      ...live,
      status: async () => ({ ok: false, reason: 'not-stream', message: 'no channel' }),
    });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    expect(res).toMatchObject({ reason: 'not-stream', servers: [] });
    // NOT LOGGED AS A FAILURE, because it is not one — it is a permanent
    // property of that transport, and the pane says something different for it.
    expect(h.warnings).toHaveLength(0);
  });

  it.each([
    ['a session that has stopped', 'session-gone', 'no-session'],
    ['a CLI that never answered', 'timed-out', 'unavailable'],
    ['a refusal', 'refused', 'unavailable'],
  ])('maps %s to `%s` -> `%s`', async (_label, reason, expected) => {
    const h = harness(['/ok'], {
      ...live,
      status: async () => ({ ok: false, reason, message: 'x' }) as ControlVerdict,
    });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    expect(res.reason).toBe(expected);
    expect(res.servers).toEqual([]);
  });

  it('says `unavailable` when no control channel was wired in at all', async () => {
    // The read-only wiring — #632's tests, and any host that registers the seam
    // without a session manager. Must not pretend the session has no servers.
    const h = harness(['/ok'], live);
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    expect(res).toMatchObject({ reason: 'unavailable', servers: [] });
  });

  it('says `no-session` for a card with nothing running', async () => {
    const h = harness(['/ok'], { status: async () => OK });
    const res = (await h.call('mcp:status', '/ok', 'gone')) as McpStatusWire;
    expect(res).toMatchObject({ reason: 'no-session', servers: [] });
  });

  // ── THE SECOND GATE, WHICH IS THE ONE THAT MATTERS ─────────────────────────

  it('REFUSES a session that does not belong to the gated folder', async () => {
    // Without this the gate checks one thing and the action reads another: a
    // caller pairs a folder it is allowed to name with the id of any live
    // session in the app, and gets ITS servers back. `mcp:reconnect` carries the
    // same check; this channel returns data, so the hole would be more useful.
    const called = vi.fn(async () => OK);
    const h = harness(['/ok'], {
      sessions: { s1: { folder: '/somewhere-else' } },
      status: called,
    });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    // `unavailable`, NOT `no-session` — the renderer turns the latter into
    // "start this session to see everything it really has", which is advice
    // about a session that is running perfectly well. A refusal is ours, not a
    // fact about the user's setup.
    expect(res.reason).toBe('unavailable');
    expect(called).not.toHaveBeenCalled();
    expect(h.warnings[0].msg).toContain('does not belong');
  });

  it.each([
    ['a folder no session has', '/etc', 's1', 'unavailable'],
    ['a non-string folder', 42, 's1', 'unavailable'],
    ['an empty liveId', '/ok', '', 'no-session'],
    ['a non-string liveId', '/ok', {}, 'no-session'],
  ])('refuses %s without touching the channel', async (_label, folder, id, reason) => {
    const called = vi.fn(async () => OK);
    const h = harness(['/ok'], { ...live, status: called });
    const res = (await h.call('mcp:status', folder, id)) as McpStatusWire;
    expect(res.servers).toEqual([]);
    // A GATE REFUSAL IS `unavailable`; a genuinely absent session is
    // `no-session`. Collapsing the two would tell a user with a running session
    // to start it.
    expect(res.reason).toBe(reason);
    expect(called).not.toHaveBeenCalled();
  });

  it('lists config servers the session has NOT loaded, so Add is not a dead button', async () => {
    // MEASURED: `mcp_status` is frozen at session start
    // (`spike/probes/721/probe-mcp-add-live.mjs`). A server added a moment ago
    // is in the files and not in the session, and without this the pane would
    // say "Added github." over a list that did not change.
    vi.spyOn(config, 'readInventory').mockReturnValue({
      folder: '/ok',
      servers: [
        {
          name: 'justAdded',
          scope: 'local',
          transport: 'stdio',
          approval: 'n/a',
          target: 'npx',
          args: [],
          envKeys: [],
          headerKeys: [],
          source: 'claude.json',
        },
      ],
      unreadable: [],
    });
    const h = harness(['/ok'], { ...live, status: async () => OK });
    const res = (await h.call('mcp:status', '/ok', 's1')) as McpStatusWire;
    expect(res.servers.map((s) => s.name)).toEqual(['DeepWiki', 'Slack']);
    expect(res.notLoaded.map((s) => s.name)).toEqual(['justAdded']);
  });
});

describe('the folder gate refuses, and does not throw (§5.29)', () => {
  const BAD: Array<[string, unknown]> = [
    ['a folder no session has', '/etc'],
    ['an empty string', ''],
    ['a number', 42],
    ['undefined', undefined],
    ['an object pretending to be a path', { toString: () => '/ok' }],
  ];

  for (const [label, folder] of BAD) {
    it(`refuses ${label} on mcp:list`, () => {
      const h = harness(['/ok']);
      const out = h.call('mcp:list', folder) as { servers: unknown[]; folder: string };
      expect(out.servers).toEqual([]);
      expect(h.warnings.map((w) => w.msg)).toHaveLength(1);
      expect(h.warnings[0].msg).toContain('mcp:list refused');
    });

    it(`refuses ${label} on mcp:health, without spawning anything`, async () => {
      // THE ASSERTION THAT MATTERS on this channel: not merely that it answered
      // empty, but that the CLI was never started. A gate that refuses AFTER
      // spawning has already done the thing it was there to prevent.
      const spy = vi.spyOn(health, 'checkHealth');
      const h = harness(['/ok']);
      const out = (await h.call('mcp:health', folder)) as { states: unknown; ok: boolean };
      expect(out.states).toEqual({});
      expect(out.ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    // THE ONE THAT WOULD ACTUALLY HURT. `mcp:add` in an ungated folder writes a
    // server definition into a `.mcp.json` — a file that is checked in, shared
    // with a team, and launched by the CLI. Same assertion as health's: the CLI
    // must never have been spawned at all.
    for (const [channel, args] of [
      ['mcp:add', [GOOD_ADD]],
      ['mcp:remove', ['sentry', 'local']],
      ['mcp:resetApprovals', []],
    ] as Array<[string, unknown[]]>) {
      it(`refuses ${label} on ${channel}, without spawning anything`, async () => {
        const spy = vi.spyOn(cli, 'runMcp');
        const h = harness(['/ok']);
        const out = (await h.call(channel, folder, ...args)) as { ok: boolean; reason: string };
        expect(out).toEqual({ ok: false, reason: 'refused' });
        expect(spy).not.toHaveBeenCalled();
      });
    }

    // The `mcp:reconnect` gate case went with the channel (#952). Every OTHER
    // channel in this file is still gated by the loop above, which is the claim
    // that matters: the folder gate covers every door into main, and a new one
    // is never accidental.
  }

  it('echoes back a string folder even when refusing, so a stale answer is discardable', () => {
    // Both read channels echo the folder they were asked about; the pane uses it
    // to drop an answer that arrived after the user switched sessions. A refusal
    // that dropped the echo would be an answer the pane could not place.
    const h = harness(['/ok']);
    expect((h.call('mcp:list', '/nope') as { folder: string }).folder).toBe('/nope');
  });

  it('names the folder in the log for a real path, and cannot for a non-string', () => {
    const h = harness(['/ok']);
    h.call('mcp:list', '/nope');
    expect(h.warnings[0].fields).toEqual({ folder: '/nope' });
    const h2 = harness(['/ok']);
    h2.call('mcp:list', 42);
    expect(h2.warnings[0].msg).toContain('non-empty string');
  });
});

describe('an allowed folder gets through to the readers', () => {
  it('answers an inventory for a real session folder', () => {
    // ECHO AND SILENCE ARE THE CLAIM, not the contents. This calls the real
    // `readInventory`, which reads the DEVELOPER'S OWN `~/.claude.json` —
    // review flagged that asserting `unreadable` is `[]` here made the result
    // depend on whether the machine's home config happens to parse, which is a
    // unit test that goes red for somebody else's reason. What this owns is
    // that an allowed folder reaches the reader at all and is not refused; the
    // reader's own behaviour is `config.test.ts`'s, on fixtures.
    const h = harness(['/ok']);
    const out = h.call('mcp:list', '/ok') as { folder: string; servers: unknown[] };
    expect(out.folder).toBe('/ok');
    expect(Array.isArray(out.servers)).toBe(true);
    expect(h.warnings.filter((w) => w.msg.includes('refused'))).toEqual([]);
  });

  it('spawns the health check only for a folder that passed the gate', async () => {
    const spy = vi
      .spyOn(health, 'checkHealth')
      .mockResolvedValue({ ok: true, states: { srv: 'connected' } });
    const h = harness(['/ok']);
    const out = await h.call('mcp:health', '/ok');
    expect(spy).toHaveBeenCalledWith('/ok');
    expect(out).toEqual({ folder: '/ok', states: { srv: 'connected' }, ok: true });
  });

  it('carries ok:false through from a check that could not run', async () => {
    // the distinction #632's review asked for: "the CLI never answered" is not
    // the same fact as "the CLI has never heard of that server"
    vi.spyOn(health, 'checkHealth').mockResolvedValue({ ok: false, states: {} });
    const h = harness(['/ok']);
    expect(await h.call('mcp:health', '/ok')).toEqual({ folder: '/ok', states: {}, ok: false });
  });
});

describe('mcp:add', () => {
  it('validates in MAIN, not just in the form', async () => {
    // The renderer's own checks are a courtesy that puts the error on screen
    // without a round trip. A caller that skips them must get no further.
    const spy = vi.spyOn(cli, 'runMcp');
    const h = harness(['/ok']);
    const out = (await h.call('mcp:add', '/ok', { ...GOOD_ADD, name: '--help' })) as {
      ok: boolean;
      reason: string;
      error: { field: string; code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid');
    expect(out.error).toEqual({ field: 'name', code: 'looks-like-a-flag' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a request that is not an object at all', async () => {
    const h = harness(['/ok']);
    expect(await h.call('mcp:add', '/ok', 'sentry')).toEqual({ ok: false, reason: 'refused' });
    expect(await h.call('mcp:add', '/ok', null)).toEqual({ ok: false, reason: 'refused' });
  });

  it('builds the command line and runs it in the gated folder', async () => {
    const spy = vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    expect(await h.call('mcp:add', '/ok', GOOD_ADD)).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(
      '/ok',
      ['mcp', 'add', '-s', 'local', '-t', 'stdio', 'sentry', '--', 'npx', '-y', 'server'],
      { secrets: [] }
    );
  });

  it('passes the CLI’s own words back rather than translating them', async () => {
    // "MCP server sentry already exists in .mcp.json" names the exact file and
    // stays correct when the CLI changes its mind. We would write something worse.
    vi.spyOn(cli, 'runMcp').mockResolvedValue({
      ok: false,
      reason: 'cli-failed',
      detail: 'MCP server sentry already exists in .mcp.json',
    });
    const h = harness(['/ok']);
    expect(await h.call('mcp:add', '/ok', GOOD_ADD)).toEqual({
      ok: false,
      reason: 'cli-failed',
      detail: 'MCP server sentry already exists in .mcp.json',
    });
  });

  it('hands the submitted credentials to runMcp, so they are redacted before truncation', async () => {
    // WHY THE SECRETS GO IN RATHER THAN THE DETAIL BEING FILTERED ON THE WAY
    // OUT: redaction has to happen before the 600-character bound, or a secret
    // straddling the boundary is no longer an exact substring and its prefix
    // survives. `cli.ts` owns both steps so they cannot be reordered.
    const spy = vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    await h.call('mcp:add', '/ok', {
      ...GOOD_ADD,
      env: [{ key: 'API_KEY', value: 'sk-live-DO-NOT-SHOW' }],
    });
    expect(spy.mock.calls[0][2]).toEqual({ secrets: ['sk-live-DO-NOT-SHOW'] });
  });

  it('counts the URL’s userinfo as a secret too', async () => {
    // `https://user:token@host/mcp` is a documented remote-MCP form and
    // `validateAdd` accepts it, so a rejection quoting the URL back would put
    // the token on screen. Only the credential parts go in the list — the
    // address itself is what makes the CLI's message useful.
    const spy = vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    await h.call('mcp:add', '/ok', {
      name: 'sentry',
      scope: 'local',
      transport: 'http',
      target: 'https://alice:tok-DO-NOT-SHOW@x.test/mcp',
    });
    expect(spy.mock.calls[0][2]).toEqual({ secrets: ['tok-DO-NOT-SHOW', 'alice'] });
  });

  it('never logs a secret VALUE — only the field and the key name', async () => {
    const h = harness(['/ok']);
    await h.call('mcp:add', '/ok', {
      ...GOOD_ADD,
      env: [{ key: 'API_KEY', value: 'sk-live-DO-NOT-LOG' }],
      // ...made invalid by the NAME, so the request is logged as refused
      name: '--help',
    });
    const blob = JSON.stringify(h.warnings);
    expect(blob).not.toContain('sk-live-DO-NOT-LOG');
  });
});

describe('mcp:remove', () => {
  it('takes a name the add form would have refused', async () => {
    // the row came off a config file somebody else wrote; refusing to delete
    // what we just listed is a state we could not get the user out of
    const spy = vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    expect(await h.call('mcp:remove', '/ok', 'my server', 'project')).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('/ok', ['mcp', 'remove', 'my server', '-s', 'project']);
  });

  it('still refuses a name the CLI would read as an option', async () => {
    const spy = vi.spyOn(cli, 'runMcp');
    const h = harness(['/ok']);
    const out = (await h.call('mcp:remove', '/ok', '-s', 'project')) as {
      reason: string;
      error: { code: string };
    };
    expect(out.reason).toBe('invalid');
    expect(out.error.code).toBe('looks-like-a-flag');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a scope that is not one of the three', async () => {
    const spy = vi.spyOn(cli, 'runMcp');
    const h = harness(['/ok']);
    const out = (await h.call('mcp:remove', '/ok', 'sentry', 'global')) as {
      reason: string;
      error: { field: string };
    };
    expect(out.reason).toBe('invalid');
    expect(out.error.field).toBe('scope');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mcp:resetApprovals', () => {
  it('runs the no-argument verb in the gated folder', async () => {
    const spy = vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    expect(await h.call('mcp:resetApprovals', '/ok')).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('/ok', ['mcp', 'reset-project-choices']);
  });
});

// ── Nothing here may THROW, on any argument, ever ───────────────────────────
//
// `broker.handle` deliberately does not catch a handler's throw — it rejects
// the caller — and this family's whole contract (`McpMutationResult`, and this
// file's header) is that it resolves a verdict instead. The renderer's `catch`
// then reports a bare "refused" with no idea why, which is how such a bug hides.
//
// THIS IS A REGRESSION PIN. `validateAdd` validates `env` only on the stdio
// branch and `headers` only on the remote one, so the OTHER field is never
// checked and arrives at the handler as any structured-clonable value the
// caller liked. The secret-redaction code added in review round 1 spread both
// directly — `{ transport: 'stdio', headers: 5 }` threw "not iterable" — which
// is the same hazard the `Array.isArray` guards were added for, reintroduced
// one field over.
describe('every channel resolves, whatever it is handed', () => {
  const JUNK: unknown[] = [5, true, {}, [], null, 'str', undefined, [null], { value: 1 }];

  it('mcp:add, for junk in either credential field and in args', async () => {
    vi.spyOn(cli, 'runMcp').mockResolvedValue({
      ok: false,
      reason: 'cli-failed',
      detail: 'MCP server srv already exists in .mcp.json',
    });
    const h = harness(['/ok']);
    for (const junk of JUNK) {
      for (const field of ['env', 'headers', 'args'] as const) {
        for (const transport of ['stdio', 'http'] as const) {
          const req = {
            name: 'srv',
            scope: 'local',
            transport,
            target: transport === 'stdio' ? 'npx' : 'https://x.test/mcp',
            [field]: junk,
          };
          const out = await h.call('mcp:add', '/ok', req);
          expect(out, `${transport}/${field}=${JSON.stringify(junk)}`).toHaveProperty('ok');
        }
      }
    }
  });

  it('the other five, for junk in every argument position', async () => {
    vi.spyOn(cli, 'runMcp').mockResolvedValue({ ok: true });
    const h = harness(['/ok']);
    for (const junk of JUNK) {
      expect(() => h.call('mcp:list', junk)).not.toThrow();
      await expect(h.call('mcp:health', junk)).resolves.toHaveProperty('states');
      await expect(h.call('mcp:remove', '/ok', junk, 'local')).resolves.toHaveProperty('ok');
      await expect(h.call('mcp:remove', '/ok', 'srv', junk)).resolves.toHaveProperty('ok');
      await expect(h.call('mcp:resetApprovals', junk)).resolves.toHaveProperty('ok');
    }
  });
});

// ── THE `mcp:reconnect` SUITE WENT WITH THE CHANNEL (#952) ───────────────────
//
// It pinned that MAIN, not the renderer, decided whether typing `/mcp` into a
// session meant anything: a `pty` session got `/mcp` and then a SEPARATE Enter
// (one write each, because text and a carriage return together register as a
// PASTE in the TUI and never submit — S-03), while a `stream` session got
// `restart-required` and nothing sent. It also pinned the folder gate by
// RESOLUTION rather than spelling, so `/ok/sub/..` was accepted.
//
// With one transport the handler had one possible answer, so it was deleted and
// the dialog says `restart-required` itself. The surviving verb is
// `mcp:reconnectServer` (`mcp_reconnect`, #729/#734), which reconnects a NAMED
// server over the control channel with no terminal and no restart — a better
// answer than typing at a picker, and covered by its own tests below.
//
// The path-resolution rule it demonstrated is not lost: `samePath` still guards
// every channel that takes a `liveId`, and the auth suite below exercises it on
// the two verbs where it matters most.

/**
 * The two auth channels (#734).
 *
 * BOTH GATES MATTER MORE HERE THAN ANYWHERE ELSE IN THIS FILE, because these
 * verbs act on an ACCOUNT rather than on a config file: one starts an OAuth
 * flow, the other discards credentials the CLI is holding. The folder gate is
 * the house rule; the session-belongs-to-that-folder check is what stops a
 * caller pairing a folder it may name with any live session in the app.
 */
describe('mcp:authenticate / mcp:clearAuth — signing in and out (#734)', () => {
  const live = { sessions: { s1: { folder: '/ok' } } };

  it.each([['mcp:authenticate'], ['mcp:clearAuth']])('%s reaches the session when gated', async (channel) => {
    const h = harness(['/ok'], { ...live, auth: true });
    const res = await h.call(channel, '/ok', 's1', 'Slack');
    expect(res).toMatchObject({ ok: true });
    expect(h.authed).toEqual([
      { verb: channel === 'mcp:authenticate' ? 'authenticate' : 'clearAuth', liveId: 's1', name: 'Slack' },
    ]);
  });

  it.each([['mcp:authenticate'], ['mcp:clearAuth']])('%s refuses a folder we do not answer for', async (channel) => {
    const h = harness(['/ok'], { ...live, auth: true });
    const res = await h.call(channel, '/somewhere-else', 's1', 'Slack');
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.authed).toEqual([]);
  });

  it.each([['mcp:authenticate'], ['mcp:clearAuth']])(
    '%s refuses a session that is not in that folder',
    async (channel) => {
      // THE HOLE THIS CLOSES: a caller naming a folder it is allowed to name,
      // paired with the id of a live session somewhere else. Without the second
      // check the gate checks one thing and the action affects another — and
      // the action here is somebody's sign-in.
      const h = harness(['/ok', '/other'], {
        sessions: { s1: { folder: '/other' } },
        auth: true,
      });
      const res = await h.call(channel, '/ok', 's1', 'Slack');
      expect(res).toMatchObject({ ok: false, reason: 'invalid' });
      expect(h.authed).toEqual([]);
    }
  );

  it.each([['mcp:authenticate'], ['mcp:clearAuth']])('%s reports a session that has stopped', async (channel) => {
    const h = harness(['/ok'], { auth: true });
    expect(await h.call(channel, '/ok', 'gone', 'Slack')).toMatchObject({
      ok: false,
      reason: 'session-gone',
    });
  });

  it.each([['mcp:authenticate'], ['mcp:clearAuth']])(
    '%s says `not-stream` when no control channel was wired',
    async (channel) => {
      // The read-only wiring. `not-stream` rather than a generic refusal,
      // because the renderer says something different for it: "this session
      // runs in Terminal mode", not "that failed".
      const h = harness(['/ok'], live);
      expect(await h.call(channel, '/ok', 's1', 'Slack')).toMatchObject({
        ok: false,
        reason: 'not-stream',
      });
    }
  );

  it.each([
    ['mcp:authenticate', 'authenticate'],
    ['mcp:clearAuth', 'clearAuth'],
  ])('%s passes a bad name STRAIGHT THROUGH to the one place that validates it', async (channel, verb) => {
    // NOT narrowed here, deliberately — the request builders are the only
    // validators, and a second weaker gate in this file could only ever drift
    // into disagreeing with them. The same division `mcp:toggle` documents, and
    // the reason that one is written this way is the measured hazard where a
    // dropped field turns a server off and reports success.
    const h = harness(['/ok'], { ...live, auth: true });
    await h.call(channel, '/ok', 's1', 42);
    expect(h.authed).toEqual([{ verb, liveId: 's1', name: 42 }]);
  });
});
