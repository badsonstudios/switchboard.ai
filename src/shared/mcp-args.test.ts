// The `claude mcp` argv builders (#714).
//
// EVERY COMMAND LINE ASSERTED HERE WAS RUN AGAINST THE REAL CLI on 2026-08-26
// and did what it says. The `--` split in particular is not a guess: without
// it, `npx -y some-server` — the single most common install form there is —
// fails with `error: unknown option '-y'` from our own invocation.
//
// (If you re-probe these by hand, use bash. PowerShell 5.1 eats a bare `--`
// before the CLI sees it and makes the working form look broken.)
import { describe, it, expect } from 'vitest';
import {
  RESET_APPROVALS_ARGS,
  buildAddArgs,
  buildRemoveArgs,
  validateAdd,
  validateAddName,
  validateRemoveName,
  validateScope,
} from './mcp-args';
import type { McpAddRequest } from './mcp';

const NUL = String.fromCharCode(0);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const DEL = String.fromCharCode(127);

const stdio = (over: Partial<McpAddRequest> = {}): McpAddRequest => ({
  name: 'my-server',
  scope: 'local',
  transport: 'stdio',
  target: 'npx',
  args: ['-y', 'some-server'],
  ...over,
});

const remote = (over: Partial<McpAddRequest> = {}): McpAddRequest => ({
  name: 'sentry',
  scope: 'user',
  transport: 'http',
  target: 'https://mcp.sentry.dev/mcp',
  ...over,
});

describe('validateAddName', () => {
  it('takes the ordinary shape every published server uses', () => {
    for (const n of ['sentry', 'my-server', 'my_server', 'a.b.c', 'srv2', 'A1']) {
      expect(validateAddName(n), n).toBeNull();
    }
  });

  it('refuses an empty or non-string name', () => {
    expect(validateAddName('')).toEqual({ field: 'name', code: 'required' });
    expect(validateAddName(undefined)).toEqual({ field: 'name', code: 'required' });
    expect(validateAddName(42)).toEqual({ field: 'name', code: 'required' });
  });

  it('refuses a control character before it refuses the pattern', () => {
    // the more useful of two true messages
    expect(validateAddName('a' + LF + 'b')).toEqual({ field: 'name', code: 'control-character' });
    expect(validateAddName('a' + NUL)).toEqual({ field: 'name', code: 'control-character' });
    expect(validateAddName('a' + DEL)).toEqual({ field: 'name', code: 'control-character' });
  });

  it('refuses a name the CLI would read as one of its own options', () => {
    // commander sees `-s` / `--help` as options no matter how well the shell
    // layer escaped them — this is the SECOND parser, and only refusal helps
    for (const n of ['-s', '--help', '--', '-x']) {
      expect(validateAddName(n), n).toEqual({ field: 'name', code: 'looks-like-a-flag' });
    }
  });

  it('refuses __proto__, because the leading character class excludes _', () => {
    expect(validateAddName('__proto__')).toEqual({ field: 'name', code: 'format' });
  });

  it('refuses a space, a slash and the shell metacharacters', () => {
    for (const n of ['my server', 'a/b', 'a&b', 'a%b']) {
      expect(validateAddName(n), n).toEqual({ field: 'name', code: 'format' });
    }
  });

  it('gives a quote its OWN message rather than the generic one', () => {
    // the charset would have caught it as `format` — "that is not a valid
    // value" — but the manual promises the specific explanation for a quote,
    // and every other field delivers it
    expect(validateAddName('a"b')).toEqual({ field: 'name', code: 'double-quote' });
  });

  it('caps the length', () => {
    expect(validateAddName('a'.repeat(64))).toBeNull();
    expect(validateAddName('a'.repeat(65))).toEqual({ field: 'name', code: 'too-long' });
  });
});

describe('validateRemoveName', () => {
  it('is LAX where add is strict — a row we read is a row we can delete', () => {
    // none of these could be CREATED through the form; all of them can exist in
    // a config file somebody else wrote, and a manager that cannot remove them
    // is one that can get you into a state it cannot get you out of
    for (const n of ['my server', '__proto__', 'a/b', 'a&b', 'ünïcode', 'x'.repeat(200)]) {
      expect(validateRemoveName(n), n).toBeNull();
    }
  });

  it('still refuses the two the CLI genuinely cannot take', () => {
    expect(validateRemoveName('-x')).toEqual({ field: 'name', code: 'looks-like-a-flag' });
    expect(validateRemoveName('a' + CR)).toEqual({ field: 'name', code: 'control-character' });
    expect(validateRemoveName('')).toEqual({ field: 'name', code: 'required' });
  });
});

describe('validateScope', () => {
  it('takes the three the CLI spells', () => {
    expect(validateScope('project')).toBeNull();
    expect(validateScope('local')).toBeNull();
    expect(validateScope('user')).toBeNull();
  });

  it('refuses anything else, including a plausible near-miss', () => {
    for (const s of ['global', 'Local', '', undefined, null, 4]) {
      expect(validateScope(s)).toEqual({ field: 'scope', code: 'format' });
    }
  });
});

describe('validateAdd — stdio', () => {
  it('accepts the documented npx form', () => {
    expect(validateAdd(stdio())).toBeNull();
  });

  it('accepts a child argument that starts with a dash — that is what `--` is for', () => {
    expect(validateAdd(stdio({ args: ['-y', '--port', '8080', '--'] }))).toBeNull();
  });

  it('refuses a control character in a child argument', () => {
    expect(validateAdd(stdio({ args: ['ok', 'bad' + NUL] }))).toEqual({
      field: 'args',
      code: 'control-character',
      at: '1',
    });
  });

  it('refuses a command that would be read as an option', () => {
    expect(validateAdd(stdio({ target: '--version' }))).toEqual({
      field: 'target',
      code: 'looks-like-a-flag',
    });
  });

  it('requires a command', () => {
    expect(validateAdd(stdio({ target: '' }))).toEqual({ field: 'target', code: 'required' });
  });

  it('takes a POSIX env name and refuses anything else', () => {
    expect(validateAdd(stdio({ env: [{ key: 'API_KEY', value: 'sk-live-1' }] }))).toBeNull();
    expect(validateAdd(stdio({ env: [{ key: '1BAD', value: 'x' }] }))).toEqual({
      field: 'env',
      code: 'format',
      at: '0',
    });
    expect(validateAdd(stdio({ env: [{ key: 'A B', value: 'x' }] }))).toEqual({
      field: 'env',
      code: 'format',
      at: '0',
    });
  });

  // ── It cannot THROW, because a throw here rejects the channel ─────────────
  //
  // This runs on a payload that crossed the IPC boundary, so it may be any
  // shape at all. `broker.handle` does not catch a handler throw, so a
  // `TypeError` in a `for…of` would REJECT `mcp:add` — and the whole family's
  // contract is that it resolves a verdict. The renderer happened to swallow
  // it, which is exactly how this would have gone unnoticed.
  describe('a hostile payload shape is refused, never thrown on', () => {
    const shapes: Array<[string, Partial<McpAddRequest>]> = [
      ['args as an object', { args: {} as unknown as string[] }],
      ['args as a number', { args: 42 as unknown as string[] }],
      ['env as an object', { env: {} as unknown as McpAddRequest['env'] }],
      ['env holding null', { env: [null] as unknown as McpAddRequest['env'] }],
      ['env holding a string', { env: ['A=1'] as unknown as McpAddRequest['env'] }],
      ['env with a non-string key', { env: [{ key: 7, value: 'x' }] as unknown as McpAddRequest['env'] }],
    ];
    for (const [label, over] of shapes) {
      it(label, () => {
        let result: unknown;
        expect(() => {
          result = validateAdd(stdio(over));
        }).not.toThrow();
        expect(result).not.toBeNull();
      });
    }

    it('headers too, on the remote branch', () => {
      for (const headers of [{}, [null], ['A: b'], [{ key: 1, value: 'x' }]]) {
        let result: unknown;
        expect(() => {
          result = validateAdd(remote({ headers: headers as unknown as McpAddRequest['headers'] }));
        }, JSON.stringify(headers)).not.toThrow();
        expect(result).not.toBeNull();
      }
    });
  });

  it('refuses a newline in an env VALUE', () => {
    expect(validateAdd(stdio({ env: [{ key: 'K', value: 'a' + LF + 'b' }] }))).toEqual({
      field: 'env',
      code: 'control-character',
      at: 'K',
    });
  });

  it('lets an env value carry the punctuation a real secret has', () => {
    expect(validateAdd(stdio({ env: [{ key: 'K', value: 'sk-live_a/b+c=d&e%f!g!' }] }))).toBeNull();
  });
});

// ── The double quote, which is refused everywhere (#714 review) ─────────────
//
// NOT FUSSINESS — a measured platform limit. On Windows the CLI is a `.cmd`
// shim, so arguments are parsed twice and the two parsers disagree about how an
// embedded quote is spelled: `\"` is what the CLI wants and is a live injection
// in cmd.exe (`a"&echo X` ran `echo X` against the real `claude.cmd`), while
// `""` is inert in cmd.exe and reaches the CLI MERGED with the following
// argument (`-- node 'q"uote' 'plain'` arrived as one argument). No spelling is
// both safe and faithful.
//
// Refused on EVERY platform on purpose: a config that is valid on Linux and
// impossible on Windows is a worse trade than one rule that holds everywhere.
describe('a double quote is refused, not escaped', () => {
  it('in a child argument', () => {
    expect(validateAdd(stdio({ args: ['ok', 'q"uote'] }))).toEqual({
      field: 'args',
      code: 'double-quote',
      at: '1',
    });
  });

  it('in the command', () => {
    expect(validateAdd(stdio({ target: 'a"b' }))).toEqual({
      field: 'target',
      code: 'double-quote',
    });
  });

  it('in an env value — including the breakout payload itself', () => {
    expect(validateAdd(stdio({ env: [{ key: 'K', value: 'a"&echo X' }] }))).toEqual({
      field: 'env',
      code: 'double-quote',
      at: 'K',
    });
  });

  it('in a header value', () => {
    expect(validateAdd(remote({ headers: [{ key: 'A', value: 'x"y' }] }))).toEqual({
      field: 'headers',
      code: 'double-quote',
      at: 'A',
    });
  });

  it('and in a name we are about to remove — but ONLY on Windows', () => {
    // THE ASYMMETRY IS THE POINT. `DOUBLE_QUOTE`'s "refuse everywhere" argument
    // is about what we WRITE: a config valid on Linux and impossible on Windows
    // is a worse trade than one rule. Deleting is the other way round — off
    // Windows `execSpec` delivers `a"b` perfectly well, and refusing there
    // would list a server and then decline to remove it, which is exactly the
    // state-you-cannot-get-out-of this function's laxity exists to prevent.
    expect(validateRemoveName('a"b', 'win32')).toEqual({ field: 'name', code: 'double-quote' });
    expect(validateRemoveName('a"b', 'linux')).toBeNull();
    expect(validateRemoveName('a"b', 'darwin')).toBeNull();
  });

  it('and a name we are about to create, on every platform', () => {
    // creating is the case the everywhere-rule is actually about
    expect(validateAddName('a"b')).toEqual({ field: 'name', code: 'double-quote' });
  });
});

describe('validateAdd — http and sse', () => {
  it('accepts an https endpoint', () => {
    expect(validateAdd(remote())).toBeNull();
    expect(validateAdd(remote({ transport: 'sse' }))).toBeNull();
  });

  it('accepts a url whose query has an ampersand — the case cmd.exe used to break', () => {
    expect(validateAdd(remote({ target: 'https://h.test/mcp?a=1&b=2' }))).toBeNull();
  });

  it('refuses a target that is not a url at all', () => {
    expect(validateAdd(remote({ target: 'not a url' }))).toEqual({
      field: 'target',
      code: 'format',
    });
  });

  it('refuses a scheme that is not http(s)', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://h/x']) {
      expect(validateAdd(remote({ target: u })), u).toEqual({ field: 'target', code: 'format' });
    }
  });

  it('takes a header token and refuses one that would split our encoding', () => {
    expect(validateAdd(remote({ headers: [{ key: 'Authorization', value: 'Bearer t' }] }))).toBeNull();
    // a colon in the NAME would produce `A: B: c`, which is a different header
    expect(validateAdd(remote({ headers: [{ key: 'A: B', value: 'c' }] }))).toEqual({
      field: 'headers',
      code: 'format',
      // the INDEX, not the key: a key that failed its own format check is not a
      // string worth echoing back into a message
      at: '0',
    });
  });

  it('refuses CRLF in a header value — the classic smuggling primitive', () => {
    expect(
      validateAdd(remote({ headers: [{ key: 'X', value: 'a' + CR + LF + 'Y: b' }] }))
    ).toEqual({ field: 'headers', code: 'control-character', at: 'X' });
  });
});

describe('buildAddArgs', () => {
  it('builds the probed stdio line, with the -- split', () => {
    expect(buildAddArgs(stdio())).toEqual([
      'mcp',
      'add',
      '-s',
      'local',
      '-t',
      'stdio',
      'my-server',
      '--',
      'npx',
      '-y',
      'some-server',
    ]);
  });

  // ── The one these tests got WRONG, and a live run caught ──────────────────
  //
  // `-e <env...>` and `-H <header...>` are VARIADIC: commander lets them eat
  // arguments until the next option or `--`. The tidy "all options, then all
  // positionals" order therefore feeds the SERVER NAME to `-e`:
  //
  //     error: Invalid environment variable format: my-server
  //
  // This file happily asserted that broken command line as correct, because a
  // unit test can only check the string we built against the string we meant.
  // Only the real CLI knows. Hence the live probe in the item.
  describe('the variadic trap', () => {
    it('puts the NAME before -e, where a variadic cannot swallow it', () => {
      const argv = buildAddArgs(stdio({ env: [{ key: 'API_KEY', value: 'x' }] }));
      expect(argv.indexOf('my-server')).toBeLessThan(argv.indexOf('-e'));
    });

    it('puts the URL before -H, for the same reason', () => {
      const argv = buildAddArgs(remote({ headers: [{ key: 'Authorization', value: 'B t' }] }));
      expect(argv.indexOf('https://mcp.sentry.dev/mcp')).toBeLessThan(argv.indexOf('-H'));
    });

    it('leaves nothing after the variadic run except the -- and the child argv', () => {
      // whatever follows `-e` must be either another `-e` pair or the `--`
      const argv = buildAddArgs(
        stdio({ env: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] })
      );
      const first = argv.indexOf('-e');
      const tail = argv.slice(first);
      expect(tail).toEqual(['-e', 'A=1', '-e', 'B=2', '--', 'npx', '-y', 'some-server']);
    });
  });

  it('puts the -- after the name and the env, before the command', () => {
    const argv = buildAddArgs(stdio());
    expect(argv[argv.indexOf('my-server') + 1]).toBe('--');
  });

  it('repeats -e once per variable, in the order they were typed', () => {
    const argv = buildAddArgs(
      stdio({
        env: [
          { key: 'API_KEY', value: 'sk-live-1' },
          { key: 'MODE', value: 'fast' },
        ],
      })
    );
    expect(argv.filter((a) => a === '-e')).toHaveLength(2);
    expect(argv.join(' ')).toContain('-e API_KEY=sk-live-1 -e MODE=fast');
  });

  it('builds the probed http line, with no -- and the url as a positional', () => {
    expect(buildAddArgs(remote())).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      '-t',
      'http',
      'sentry',
      'https://mcp.sentry.dev/mcp',
    ]);
  });

  it('encodes a header as `Name: value`, repeated', () => {
    const argv = buildAddArgs(
      remote({
        headers: [
          { key: 'Authorization', value: 'Bearer t' },
          { key: 'X-Team', value: 'core' },
        ],
      })
    );
    expect(argv.filter((a) => a === '-H')).toHaveLength(2);
    expect(argv).toContain('Authorization: Bearer t');
    expect(argv).toContain('X-Team: core');
  });

  it('never puts env on a remote server or headers on a stdio one', () => {
    expect(buildAddArgs(remote({ env: [{ key: 'K', value: 'v' }] }))).not.toContain('-e');
    expect(buildAddArgs(stdio({ headers: [{ key: 'K', value: 'v' }] }))).not.toContain('-H');
  });

  it('still emits the -- when a stdio server has no child arguments', () => {
    const argv = buildAddArgs(stdio({ target: 'node', args: [] }));
    expect(argv.slice(-3)).toEqual(['my-server', '--', 'node']);
  });
});

describe('buildRemoveArgs', () => {
  it('always passes the row’s own scope', () => {
    expect(buildRemoveArgs('sentry', 'project')).toEqual([
      'mcp',
      'remove',
      'sentry',
      '-s',
      'project',
    ]);
  });

  it('never omits -s — a scopeless remove deletes whichever scope has it', () => {
    // the pane lists one name twice when two scopes define it (on purpose), so
    // "whichever" would be the wrong row about half the time
    expect(buildRemoveArgs('github', 'local')).toContain('-s');
  });
});

describe('RESET_APPROVALS_ARGS', () => {
  it('takes no arguments — no name, no scope', () => {
    expect(RESET_APPROVALS_ARGS).toEqual(['mcp', 'reset-project-choices']);
    expect(RESET_APPROVALS_ARGS).not.toContain('-s');
  });
});
