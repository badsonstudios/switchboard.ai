// The MCP config reader (#632, §5.17).
//
// EVERY RULE HERE CAME OFF A REAL PROBE, not off the ticket — the ticket said
// to read `claude mcp list --json`, which does not exist. The file shapes below
// are what `claude mcp add` actually wrote on this machine on 2026-08-25, and
// the drive-letter case in `projects` is what a real `~/.claude.json` actually
// held. Re-probe before changing any of them; do not reason from the issue.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildInventory, samePath } from './config';

/** exactly what `claude mcp add -s project probe-a -- node fake-server.js`
 *  wrote into `.mcp.json` (probed) */
const PROJECT_JSON = {
  mcpServers: {
    'probe-a': { type: 'stdio', command: 'node', args: ['fake-server.js'], env: {} },
  },
};

const FOLDER = 'C:/Projects/acme';

const inv = (opts: { claudeJson?: unknown; mcpJson?: unknown; folder?: string } = {}) =>
  buildInventory({
    folder: opts.folder ?? FOLDER,
    claudeJson: opts.claudeJson ?? {},
    mcpJson: opts.mcpJson ?? {},
  });

const names = (i: ReturnType<typeof inv>) => i.servers.map((s) => s.name);
const byName = (i: ReturnType<typeof inv>, n: string) => i.servers.find((s) => s.name === n)!;

describe('the three scopes, where they actually live', () => {
  it('reads a project server out of .mcp.json', () => {
    const i = inv({ mcpJson: PROJECT_JSON });
    expect(names(i)).toEqual(['probe-a']);
    const s = byName(i, 'probe-a');
    expect(s.scope).toBe('project');
    expect(s.transport).toBe('stdio');
    expect(s.target).toBe('node');
    expect(s.args).toEqual(['fake-server.js']);
  });

  it('reads a LOCAL server out of ~/.claude.json projects[folder]', () => {
    const i = inv({
      claudeJson: {
        projects: { [FOLDER]: { mcpServers: { mine: { type: 'stdio', command: 'x' } } } },
      },
    });
    expect(names(i)).toEqual(['mine']);
    expect(byName(i, 'mine').scope).toBe('local');
  });

  it('reads a USER server off the TOP LEVEL of ~/.claude.json', () => {
    const i = inv({ claudeJson: { mcpServers: { everywhere: { type: 'http', url: 'https://x/mcp' } } } });
    expect(byName(i, 'everywhere').scope).toBe('user');
    expect(byName(i, 'everywhere').target).toBe('https://x/mcp');
  });

  it('does not take another project’s local servers', () => {
    const i = inv({
      claudeJson: { projects: { 'C:/Projects/other': { mcpServers: { theirs: { command: 'x' } } } } },
    });
    expect(names(i)).toEqual([]);
  });

  it('orders project, then local, then user — most specific first', () => {
    const i = inv({
      mcpJson: { mcpServers: { p: { command: 'x' } } },
      claudeJson: {
        mcpServers: { u: { command: 'x' } },
        projects: { [FOLDER]: { mcpServers: { l: { command: 'x' } } } },
      },
    });
    expect(names(i)).toEqual(['p', 'l', 'u']);
  });

  it('keeps a name defined in two scopes as TWO rows', () => {
    // Deliberately not deduplicated: two scopes defining `github` is a real and
    // confusing situation, and showing it is what the manager is for. Quietly
    // picking a winner would hide the thing the user opened the pane to find.
    const i = inv({
      mcpJson: { mcpServers: { github: { command: 'a' } } },
      claudeJson: { mcpServers: { github: { command: 'b' } } },
    });
    expect(i.servers.map((s) => `${s.name}@${s.scope}`)).toEqual(['github@project', 'github@user']);
  });
});

describe('the Windows drive-letter collision (#632 probe)', () => {
  // A REAL `~/.claude.json` on this machine held both spellings for one repo,
  // each with its own `mcpServers`. A `===` lookup finds whichever the CLI
  // wrote last and reports the other as empty — on screen, "you have no local
  // servers" rather than the ambiguity it really is.
  const both = {
    projects: {
      'c:/Projects/acme': { mcpServers: { lower: { command: 'x' } } },
      'C:/Projects/acme': { mcpServers: { upper: { command: 'y' } } },
    },
  };

  it('merges every entry that names the same folder', () => {
    const i = inv({ claudeJson: both, folder: 'C:/Projects/acme' });
    expect(names(i).sort()).toEqual(['lower', 'upper']);
  });

  it('matches a backslash path against a forward-slash key', () => {
    const i = inv({ claudeJson: both, folder: 'C:\\Projects\\acme' });
    expect(names(i).sort()).toEqual(['lower', 'upper']);
  });

  it('and a trailing separator is not a different folder', () => {
    const i = inv({ claudeJson: both, folder: 'C:/Projects/acme/' });
    expect(names(i).sort()).toEqual(['lower', 'upper']);
  });
});

describe('samePath — case folding is per-platform, and that is the point', () => {
  const platform = (p: string): void => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(p as NodeJS.Platform);
  };
  afterEach(() => vi.restoreAllMocks());

  it('folds case on Windows, where two spellings are one directory', () => {
    platform('win32');
    expect(samePath('c:/Projects/acme', 'C:/Projects/ACME')).toBe(true);
  });

  it('does NOT fold case elsewhere, where they are two directories', () => {
    // Folding on Linux would merge two real projects' servers into one list —
    // a worse bug than the one the folding fixes, and silent.
    platform('linux');
    expect(samePath('/home/dan/acme', '/home/dan/ACME')).toBe(false);
    expect(samePath('/home/dan/acme', '/home/dan/acme/')).toBe(true);
  });
});

describe('approval — derived from two lists, not stored anywhere', () => {
  const withLists = (enabled: string[], disabled: string[]) =>
    inv({
      mcpJson: { mcpServers: { s: { command: 'x' } } },
      claudeJson: {
        projects: {
          [FOLDER]: { enabledMcpjsonServers: enabled, disabledMcpjsonServers: disabled },
        },
      },
    });

  it('is pending when neither list mentions it — the CLI’s ⏸ state', () => {
    expect(byName(withLists([], []), 's').approval).toBe('pending');
  });

  it('is approved when enabled', () => {
    expect(byName(withLists(['s'], []), 's').approval).toBe('approved');
  });

  it('is disabled when disabled', () => {
    expect(byName(withLists([], ['s']), 's').approval).toBe('disabled');
  });

  it('reads a name in BOTH lists as disabled', () => {
    // A corrupt state we did not create — refusing to connect is the safe
    // reading of it, so `disabled` is checked before `approved`.
    expect(byName(withLists(['s'], ['s']), 's').approval).toBe('disabled');
  });

  it('never puts an approval on a local or user server', () => {
    // there is nothing to approve: you added it yourself, on purpose
    const i = inv({
      claudeJson: {
        mcpServers: { u: { command: 'x' } },
        projects: { [FOLDER]: { mcpServers: { l: { command: 'x' } } } },
      },
    });
    expect(byName(i, 'u').approval).toBe('n/a');
    expect(byName(i, 'l').approval).toBe('n/a');
  });
});

describe('secrets never reach the wire shape (#632 plan call, §5.29)', () => {
  const secretive = {
    mcpServers: {
      sentry: {
        type: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer sk-live-DO-NOT-LEAK', 'X-Tenant': 'acme' },
        env: { API_KEY: 'sk-also-secret', REGION: 'eu' },
      },
    },
  };

  it('carries the KEYS and not the values', () => {
    const s = byName(inv({ mcpJson: secretive }), 'sentry');
    expect(s.headerKeys).toEqual(['Authorization', 'X-Tenant']);
    expect(s.envKeys).toEqual(['API_KEY', 'REGION']);
  });

  it('and no field anywhere on the row contains the value', () => {
    // THE REAL ASSERTION, and the reason it is written this way rather than as
    // three `not.toBe`s: this passes only while the shape has no field that can
    // carry a secret. Add one — a `reveal` payload, an `env` map "just for the
    // detail view" — and this goes red, which is the decision being made on
    // purpose instead of leaking by default.
    const blob = JSON.stringify(inv({ mcpJson: secretive }));
    expect(blob).not.toContain('sk-live-DO-NOT-LEAK');
    expect(blob).not.toContain('sk-also-secret');
    // ...while the endpoint, which is not a secret, is still there to read
    expect(blob).toContain('https://mcp.sentry.dev/mcp');
  });
});

describe('tolerant of what users and newer CLIs put in these files', () => {
  it('treats a missing type as stdio, which is what the CLI defaults to', () => {
    expect(byName(inv({ mcpJson: { mcpServers: { s: { command: 'x' } } } }), 's').transport).toBe(
      'stdio'
    );
  });

  it('carries an UNKNOWN transport through rather than dropping the server', () => {
    // A transport a newer CLI grew is still a server this session has. Hiding
    // it would make the pane lie about the inventory — the same fail-open
    // direction as the rail's `presentStatus`.
    const s = byName(inv({ mcpJson: { mcpServers: { s: { type: 'quic-9000' } } } }), 's');
    expect(s.transport).toBe('unknown');
    expect(s.name).toBe('s');
  });

  it('survives garbage in every position without throwing', () => {
    const junk = inv({
      claudeJson: { mcpServers: 'not a map', projects: 42 },
      mcpJson: { mcpServers: { ok: { command: 'x', args: ['a', 7, null], env: 'nope' } } },
    });
    expect(names(junk)).toEqual(['ok']);
    expect(byName(junk, 'ok').args).toEqual(['a']); // non-strings dropped, not kept as holes
    expect(byName(junk, 'ok').envKeys).toEqual([]);
  });

  it('handles the empty-is-null case the real file has', () => {
    // top-level `mcpServers` is `null`, not `{}`, when you have no user servers
    expect(names(inv({ claudeJson: { mcpServers: null, projects: null } }))).toEqual([]);
  });

  it('answers an empty inventory rather than throwing on nothing at all', () => {
    const i = inv();
    expect(i.servers).toEqual([]);
    expect(i.unreadable).toEqual([]);
    expect(i.folder).toBe(FOLDER);
  });
});
