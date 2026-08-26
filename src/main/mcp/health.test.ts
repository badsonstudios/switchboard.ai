// The `claude mcp list` health parser (#632).
//
// THE FIXTURE IS REAL OUTPUT. Every line below was captured from the CLI on
// PATH on 2026-08-25 by registering a server, connecting it, breaking it and
// removing it again — not written from the ticket, which claimed a `--json`
// flag that does not exist. If the CLI's wording moves, re-probe and update the
// fixture; do not adjust the parser to a guess.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkHealth, parseHealth, parseHealthLine } from './health';

/**
 * `child_process` is MODULE-MOCKED rather than spied: `health.ts` imports
 * `execFile` by name, and the real module's properties are non-configurable, so
 * `vi.spyOn(cp, 'execFile')` throws "Cannot redefine property".
 */
type ExecFileImpl = (
  file: string,
  argv: readonly string[],
  options: { cwd?: string },
  cb: (err: unknown, stdout: string) => void
) => void;

let execFileImpl: ExecFileImpl | null = null;

vi.mock('child_process', () => ({
  execFile: (...args: Parameters<ExecFileImpl>) => execFileImpl?.(...args),
}));

/** a real Windows install path — `claude.cmd`, which is the whole point */
const WIN_CLI = 'C:\\\\Users\\\\d\\\\claude.cmd';

/** verbatim, including the ellipsis character and the blank line */
const REAL = [
  'Checking MCP server health…',
  '',
  'selftest: claude mcp serve - ✔ Connected',
  'broken: no-such-binary-xyz --flag - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
  'probe-a: node fake-server.js - ⏸ Pending approval (run `claude` to approve)',
].join('\n');

describe('parseHealth on real CLI output', () => {
  it('reads all three states out of one listing', () => {
    expect(parseHealth(REAL)).toEqual({
      selftest: 'connected',
      broken: 'failed',
      // pending approval is an APPROVAL answer, not a health one — the config
      // files own that, and they cannot time out
      'probe-a': 'unknown',
    });
  });

  it('ignores the header, the blank line and the empty notice', () => {
    expect(parseHealth('Checking MCP server health…\n\n')).toEqual({});
    expect(parseHealth('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual(
      {}
    );
  });

  it('answers nothing for nothing, rather than throwing', () => {
    expect(parseHealth('')).toEqual({});
  });
});

describe('the failure-before-success ordering', () => {
  it('does not read "Failed to connect" as connected', () => {
    // THE BUG THIS ORDERING EXISTS TO PREVENT: "Failed to connect" contains
    // "connect", so a word test run in the other order reports every broken
    // server as healthy — the single worst answer this pane could give.
    expect(parseHealthLine('broken: x - ✘ Failed to connect — CONNECTION_CLOSED')).toEqual({
      name: 'broken',
      health: 'failed',
    });
  });

  it('still reads a plain success as connected', () => {
    expect(parseHealthLine('ok: x - ✔ Connected')).toEqual({ name: 'ok', health: 'connected' });
  });
});

describe('colons in the remainder do not break the split', () => {
  it('an http endpoint', () => {
    expect(parseHealthLine('sentry: https://mcp.sentry.dev/mcp - ✔ Connected')).toEqual({
      name: 'sentry',
      health: 'connected',
    });
  });

  it('a Windows path', () => {
    expect(parseHealthLine('local: C:\\tools\\srv.exe --port 9 - ✔ Connected')).toEqual({
      name: 'local',
      health: 'connected',
    });
  });

  it('and the error tail, which carries its own colon', () => {
    const l = 'b: x - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed';
    expect(parseHealthLine(l)?.name).toBe('b');
  });
});

describe('degrading rather than claiming (§4)', () => {
  it('reads a server whose status it does not recognise as unknown', () => {
    // a state a newer CLI grew: still a server, still listed, no verdict
    expect(parseHealthLine('s: x - ◐ Reconnecting')).toEqual({ name: 's', health: 'unknown' });
  });

  it('falls back to the WORD when the glyph is mangled', () => {
    // This output crosses a Windows console-encoding boundary. A mangled glyph
    // must not turn every server on screen into `unknown` while the English
    // word beside it is still perfectly readable.
    expect(parseHealthLine('s: x - ? Connected')).toEqual({ name: 's', health: 'connected' });
    expect(parseHealthLine('s: x - ? Failed to connect')).toEqual({ name: 's', health: 'failed' });
  });

  it('refuses prose that happens to contain a colon', () => {
    // the guard that keeps a future CLI notice from being listed as a server
    expect(parseHealthLine('Checking MCP server health…')).toBeNull();
    expect(parseHealthLine('Note: something happened')).toBeNull();
    expect(parseHealthLine('')).toBeNull();
    expect(parseHealthLine(': orphaned')).toBeNull();
    expect(parseHealthLine('name-with-no-status:')).toBeNull();
  });

  it('last line wins for a repeated name, rather than throwing', () => {
    expect(parseHealth('s: x - ✔ Connected\ns: x - ✘ Failed')).toEqual({ s: 'failed' });
  });
});

// ── how it launches the CLI (#632 review blocker) ───────────────────────────
//
// THE BUG THIS PINS SHIPPED GREEN AND WAS FOUND BY EYE, not by a test. The
// first version ran `execFile('claude', ['mcp','list'])`, which CANNOT WORK ON
// WINDOWS: `child_process` without a shell does not apply PATHEXT, so a bare
// `claude` is ENOENT (measured), and the thing PATH actually holds there is
// `claude.cmd`, which Node >=18.20 refuses to spawn directly. Every row would
// have read "status unknown" for ever on the maintainer's own machine — and
// because this file's whole design is to degrade quietly, nothing would have
// looked broken.
//
// `platform` is INJECTED for the reason `launchSpec` documents (#127): read
// from the ambient one, the Windows branch passes vacuously on the Linux and
// macOS CI legs, which is exactly how a launch bug hides.
describe('the launch spec, on both platforms (#632)', () => {
  const spawned: Array<{ file: string; argv: readonly string[]; cwd?: string }> = [];

  beforeEach(() => {
    spawned.length = 0;
    execFileImpl = (file, argv, options, cb) => {
      spawned.push({ file, argv, cwd: options?.cwd });
      cb(null, 'srv: x - ✔ Connected');
    };
  });
  afterEach(() => {
    execFileImpl = null;
  });

  it('runs a .cmd through cmd.exe on Windows', async () => {
    const out = await checkHealth('C:/p/acme', { bin: WIN_CLI, platform: 'win32' });
    expect(spawned[0].file).toMatch(/cmd.exe$/i);
    // `/d /s /c` and ONE self-built, escaped argument since #714 — the old
    // `['/c', cli, 'mcp', 'list']` let libuv build the line, which is safe for
    // these two constants and is a live injection hole for the argv the write
    // channels carry. One launch helper for all four, so the safe one is not
    // the odd one out somebody later copies. See `transport/win-cmd.ts`.
    expect(spawned[0].argv.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
    expect(spawned[0].argv[4]).toContain('mcp');
    expect(spawned[0].argv[4]).toContain('list');
    expect(out).toEqual({ ok: true, states: { srv: 'connected' } });
  });

  it('runs the binary directly everywhere else', async () => {
    await checkHealth('/p/acme', { bin: '/usr/local/bin/claude', platform: 'linux' });
    expect(spawned[0].file).toBe('/usr/local/bin/claude');
    expect(spawned[0].argv).toEqual(['mcp', 'list']);
  });

  it('runs in the FOLDER, because scope is resolved from the cwd', async () => {
    // `.mcp.json` and the local-scope project key are both cwd-relative — a
    // health check run somewhere else answers about somebody else's servers.
    await checkHealth('/p/acme', { bin: '/usr/local/bin/claude', platform: 'linux' });
    expect(spawned[0].cwd).toBe('/p/acme');
  });

  it('answers nothing, and spawns nothing, when the CLI cannot be found', async () => {
    expect(await checkHealth('/p/acme', { bin: null })).toEqual({ ok: false, states: {} });
    expect(spawned).toHaveLength(0);
  });

  it('does not reject when execFile throws synchronously', async () => {
    // EINVAL on a hostile PATH entry — the trap `update/token.ts` documents.
    // Inside a promise executor an uncaught throw is a rejection, and this
    // function's contract is that it never has one.
    execFileImpl = () => {
      throw new Error('EINVAL');
    };
    await expect(checkHealth('/p/acme', { bin: '/usr/bin/claude' })).resolves.toEqual({
      ok: false,
      states: {},
    });
  });
});

// ── `ok`: did the check RUN? (#714, deferred from #632's review) ─────────────
//
// The map alone cannot say which of two things happened, because both are an
// absent key: "the CLI ran and has never heard of that server" and "the CLI
// could not be found / timed out / said nothing we understood". The pane drew
// `status unknown` on every row for both, which is honest about each server and
// silent about the far more useful fact that nothing was checked at all.
//
// `ok` FOLLOWS THE OUTPUT, NOT THE EXIT CODE — see `checkHealth`.
describe('ok — whether the check ran at all (#714)', () => {
  beforeEach(() => {
    execFileImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
  });

  const run = (stdout: string, err: unknown = null): Promise<{ ok: boolean }> => {
    execFileImpl = (_f, _a, _o, cb) => cb(err, stdout);
    return checkHealth('/p/acme', { bin: '/usr/bin/claude', platform: 'linux' });
  };

  it('is true for a listing with servers in it', async () => {
    expect((await run(REAL)).ok).toBe(true);
  });

  it('is TRUE for an empty inventory — "no servers" is a complete answer', async () => {
    // The opposite reading is the tempting one and it is wrong: reporting a
    // correct "you have none" as a failed check is a lie in the other direction.
    const out = await run('No MCP servers configured. Use `claude mcp add` to add a server.');
    expect(out).toEqual({ ok: true, states: {} });
  });

  it('is true when the CLI exited non-zero but still printed the rows it reached', async () => {
    // a partial answer is strictly better than none for a column allowed to
    // say `unknown` — so the rows survive, and so does `ok`
    const out = (await run(REAL, new Error('exit 1'))) as { ok: boolean; states: object };
    expect(out.ok).toBe(true);
    expect(out.states).toEqual({ selftest: 'connected', broken: 'failed', 'probe-a': 'unknown' });
  });

  it('is false when the spawn produced nothing — the case that was invisible', async () => {
    expect(await run('')).toEqual({ ok: false, states: {} });
    expect(await run('   \n  ')).toEqual({ ok: false, states: {} });
  });
});
