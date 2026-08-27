// Running `claude mcp <verb>` (#714) — the only file in the app that makes the
// CLI CHANGE something.
//
// WHAT THIS OWNS is the four ways a spawn can go wrong and the one way it can
// go right, plus the launch spec — which is the part that has already shipped
// broken once (#632: `execFile('claude', …)` is ENOENT on Windows, degraded so
// gracefully that nothing looked wrong, and was caught by eye rather than by a
// test). `platform` is INJECTED for the #127 reason: read from the ambient one,
// the Windows branch passes vacuously on the Linux and macOS CI legs.
//
// The CLI's own error TEXT is fixture data captured on 2026-08-26 by making the
// real CLI fail each way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MUTATION_TIMEOUT_MS, runMcp } from './cli';

type ExecFileImpl = (
  file: string,
  argv: readonly string[],
  options: { cwd?: string; timeout?: number; windowsVerbatimArguments?: boolean },
  cb: (err: unknown, stdout: string, stderr: string) => void
) => void;

let execFileImpl: ExecFileImpl | null = null;

// MODULE-MOCKED rather than spied, for the reason `health.test.ts` records:
// `cli.ts` imports `execFile` by name and the real module's properties are
// non-configurable, so `vi.spyOn` throws "Cannot redefine property".
vi.mock('child_process', () => ({
  execFile: (...args: Parameters<ExecFileImpl>) => execFileImpl?.(...args),
}));

const WIN_CLI = 'C:\\Users\\d\\AppData\\Roaming\\npm\\claude.cmd';
const NIX_CLI = '/usr/local/bin/claude';

const spawned: Array<{
  file: string;
  argv: readonly string[];
  cwd?: string;
  timeout?: number;
  verbatim?: boolean;
}> = [];

/** the default: a spawn that succeeds silently, which is what `mcp add` does */
function succeeds(): void {
  execFileImpl = (file, argv, options, cb) => {
    spawned.push({
      file,
      argv,
      cwd: options?.cwd,
      timeout: options?.timeout,
      verbatim: options?.windowsVerbatimArguments,
    });
    cb(null, 'Added stdio MCP server sentry with command: npx to local config', '');
  };
}

beforeEach(() => {
  spawned.length = 0;
  succeeds();
});
afterEach(() => {
  execFileImpl = null;
  vi.restoreAllMocks();
});

describe('the happy path', () => {
  it('resolves ok for a zero exit', async () => {
    expect(await runMcp('/p/acme', ['mcp', 'add', 'x'], { bin: NIX_CLI })).toEqual({ ok: true });
  });

  it('runs in the FOLDER, because scope is resolved from the cwd', async () => {
    // `.mcp.json` and the local-scope project key are both cwd-relative — a
    // mutation run somewhere else writes into somebody else's config.
    await runMcp('/p/acme', ['mcp', 'add', 'x'], { bin: NIX_CLI });
    expect(spawned[0].cwd).toBe('/p/acme');
  });

  it('carries a timeout much shorter than the health check’s', async () => {
    await runMcp('/p/acme', ['mcp', 'add', 'x'], { bin: NIX_CLI });
    expect(spawned[0].timeout).toBe(MUTATION_TIMEOUT_MS);
    // a health check connects to every server and legitimately takes seconds;
    // this edits a JSON file
    expect(MUTATION_TIMEOUT_MS).toBeLessThan(20_000);
  });
});

describe('the launch spec, on both platforms', () => {
  it('runs the binary directly off Windows, with no verbatim flag', async () => {
    await runMcp('/p/acme', ['mcp', 'list'], { bin: NIX_CLI, platform: 'linux' });
    expect(spawned[0].file).toBe(NIX_CLI);
    expect(spawned[0].argv).toEqual(['mcp', 'list']);
    expect(spawned[0].verbatim).toBe(false);
  });

  it('runs a .cmd through cmd.exe /d /s /c with a self-built, verbatim line', async () => {
    await runMcp('C:/p/acme', ['mcp', 'list'], { bin: WIN_CLI, platform: 'win32' });
    expect(spawned[0].file).toMatch(/cmd.exe$/i);
    expect(spawned[0].argv.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
    expect(spawned[0].verbatim).toBe(true);
  });

  it('ESCAPES A HOSTILE ARGUMENT rather than passing it to cmd.exe bare', async () => {
    // The measured hole (`transport/win-cmd.ts`): libuv quotes only what has a
    // space, a tab or a quote in it, so `&` reached cmd.exe live and `calc` ran.
    // Asserted at THIS layer too, not only in `win-cmd.test.ts`, because this
    // is the file that chose which helper to call — and choosing `launchSpec`
    // here would be silently exploitable with every unit below still green.
    await runMcp('C:/p/acme', ['mcp', 'add', 'foo&calc'], { bin: WIN_CLI, platform: 'win32' });
    const line = spawned[0].argv[4];
    expect(line).toContain('^&');
    expect(line).not.toMatch(/[^^]&/);
  });
});

describe('the four ways it goes wrong', () => {
  it('no-cli when the CLI is not on PATH — and nothing is spawned', async () => {
    expect(await runMcp('/p/acme', ['mcp', 'list'], { bin: null })).toEqual({
      ok: false,
      reason: 'no-cli',
    });
    expect(spawned).toHaveLength(0);
  });

  it('timeout when the process was killed, not cli-failed', async () => {
    // different sentences: "the CLI is not responding" is ours to report,
    // "already exists" is the user's to fix
    execFileImpl = (_f, _a, _o, cb) => {
      const err = Object.assign(new Error('timeout'), { killed: true });
      cb(err, '', '');
    };
    expect(await runMcp('/p/acme', ['mcp', 'add', 'x'], { bin: NIX_CLI })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('passes the CLI’s own words through — stdout counts, not just stderr', async () => {
    // captured verbatim 2026-08-26: this one comes out on STDOUT with a
    // non-zero exit, which is exactly the case a stderr-only reader loses
    execFileImpl = (_f, _a, _o, cb) =>
      cb(new Error('exit 1'), 'MCP server p-env already exists in .mcp.json', '');
    expect(await runMcp('/p/acme', ['mcp', 'add', 'x'], { bin: NIX_CLI })).toEqual({
      ok: false,
      reason: 'cli-failed',
      detail: 'MCP server p-env already exists in .mcp.json',
    });
  });

  it('prefers stderr and keeps stdout after it', async () => {
    execFileImpl = (_f, _a, _o, cb) => cb(new Error('exit 1'), 'on stdout', 'on stderr');
    const out = (await runMcp('/p/acme', ['mcp', 'x'], { bin: NIX_CLI })) as { detail: string };
    expect(out.detail).toBe('on stderr\non stdout');
  });

  it('falls back to the EXIT CODE when the CLI said nothing — never err.message', async () => {
    // AN EMPTY DETAIL would render as a dialog with a blank body, so there has
    // to be a fallback. `err.message` is not it: Node builds it as
    // `Command failed: <the entire command line>`, which on Windows is our
    // ESCAPED line, `-e API_KEY=…` and all. Escaped is the sting — redaction is
    // exact-substring, so a secret containing any of `()%!^<>&|` arrives as
    // `p@ss^&word-123` and survives it verbatim. Measured in review.
    execFileImpl = (_f, _a, _o, cb) =>
      cb(Object.assign(new Error('Command failed: cmd.exe … -e API_KEY=p@ss^&word'), { code: 1 }), '', '');
    const out = (await runMcp('/p/acme', ['mcp', 'x'], { bin: NIX_CLI })) as { detail: string };
    expect(out.detail).toBe('the claude command exited with 1');
    expect(out.detail).not.toContain('API_KEY');
    expect(out.detail).not.toContain('Command failed');
  });

  it('bounds the detail so a stack trace cannot become the dialog', async () => {
    execFileImpl = (_f, _a, _o, cb) => cb(new Error('exit 1'), 'x'.repeat(5000), '');
    const out = (await runMcp('/p/acme', ['mcp', 'x'], { bin: NIX_CLI })) as { detail: string };
    expect(out.detail.length).toBeLessThan(700);
    expect(out.detail.endsWith('…')).toBe(true);
  });

  describe('secrets are taken out BEFORE the length bound', () => {
    const secret = 'sk-live-DO-NOT-SHOW';

    it('redacts a submitted value out of the CLI’s words', async () => {
      execFileImpl = (_f, _a, _o, cb) =>
        cb(new Error('exit 1'), `Invalid environment variable format: API_KEY=${secret}`, '');
      const out = (await runMcp('/p/acme', ['mcp', 'x'], {
        bin: NIX_CLI,
        secrets: [secret],
      })) as { detail: string };
      expect(out.detail).not.toContain(secret);
      expect(out.detail).toContain('Invalid environment variable format');
    });

    it('catches one that STRADDLES the 600-character boundary', async () => {
      // The ordering bug this parameter exists for: truncating first leaves the
      // secret's prefix behind, because it is no longer an exact substring.
      const padding = 'y'.repeat(595);
      execFileImpl = (_f, _a, _o, cb) => cb(new Error('exit 1'), padding + secret, '');
      const out = (await runMcp('/p/acme', ['mcp', 'x'], {
        bin: NIX_CLI,
        secrets: [secret],
      })) as { detail: string };
      expect(out.detail).not.toContain('sk-live');
    });

    it('leaves a message with nothing to redact exactly as the CLI wrote it', async () => {
      execFileImpl = (_f, _a, _o, cb) =>
        cb(new Error('exit 1'), 'MCP server sentry already exists in .mcp.json', '');
      const out = (await runMcp('/p/acme', ['mcp', 'x'], {
        bin: NIX_CLI,
        secrets: [secret],
      })) as { detail: string };
      expect(out.detail).toBe('MCP server sentry already exists in .mcp.json');
    });

    it('ignores a value too short to be anything but noise', async () => {
      // blanking every `x` in a sentence destroys it to protect nothing
      execFileImpl = (_f, _a, _o, cb) => cb(new Error('exit 1'), 'exit code x', '');
      const out = (await runMcp('/p/acme', ['mcp', 'x'], { bin: NIX_CLI, secrets: ['x'] })) as {
        detail: string;
      };
      expect(out.detail).toBe('exit code x');
    });
  });

  it('does not reject when the LAUNCH SPEC refuses the arguments', async () => {
    // `execSpec` throws for a double quote or a control character — it cannot
    // deliver either faithfully through cmd.exe (see `transport/win-cmd.ts`).
    // Built outside the try, that throw escapes as a rejection; this pins that
    // it is caught and becomes a verdict the dialog can render.
    const out = await runMcp('C:/p/acme', ['mcp', 'add', 'a"b'], {
      bin: WIN_CLI,
      platform: 'win32',
    });
    expect(out).toEqual({
      ok: false,
      reason: 'cli-failed',
      detail: 'cmd.exe arguments cannot contain a double quote',
    });
    expect(spawned).toHaveLength(0);
  });

  it('does not reject when execFile throws synchronously', async () => {
    // EINVAL on a hostile PATH entry — the trap `update/token.ts` documents.
    // Inside a promise executor an uncaught throw is a rejection, and nothing
    // in this family is allowed to have one: every caller is behind a button in
    // a modal, and an exception there is a button that does nothing.
    execFileImpl = () => {
      throw new Error('EINVAL');
    };
    await expect(runMcp('/p/acme', ['mcp', 'x'], { bin: NIX_CLI })).resolves.toEqual({
      ok: false,
      reason: 'cli-failed',
      detail: 'EINVAL',
    });
  });
});
