// The hostile-argument launch spec (#714).
//
// THE PAYLOADS BELOW ARE THE ONES THAT ACTUALLY WORKED. Each was executed
// against a throwaway `.cmd` shim on 2026-08-26 through the OLD path
// (`launchSpec` -> `cmd.exe /c`) and observed to do the thing named in its
// comment. They are not imagined attacks; they are a recorded exploit, and this
// file is the pin that keeps it fixed.
//
// There are two layers of test here on purpose:
//
//   1. STRING-LEVEL, on every platform, with `platform` injected — so the
//      Windows branch is exercised on the ubuntu and macOS CI legs instead of
//      passing vacuously (#127).
//   2. END-TO-END, win32 only — actually spawn `cmd.exe` with a real `.cmd`
//      shim and assert the child's `process.argv` is byte-identical to what we
//      passed. This is the only layer that can prove the escaping is right,
//      because the thing being escaped for is cmd.exe's parser and we do not
//      own it. It is also how the hole was found: the string layer looked fine.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { escapeForCmd, execSpec, quoteArg } from './win-cmd';

const WIN_CMD = 'C:\\Users\\d\\AppData\\Roaming\\npm\\claude.cmd';
const MARK = 'BROKE_OUT';

/**
 * The recorded exploit set.
 *
 * `label` says what the old path DID with it, not what it looks like. The
 * `a"…` family is the SECOND round: the first fix (MSVCRT `\"`) stopped
 * everything above it and none of these, because `\"` is an escaped quote to
 * the child and a REAL closing quote to cmd — so one user quote flipped cmd's
 * state and the rest of the argument became syntax. Caught in review with a
 * live reproduction against the real `claude.cmd`.
 */
const HOSTILE: ReadonlyArray<{ arg: string; label: string }> = [
  { arg: 'foo&calc', label: 'ran calc and truncated the argument' },
  { arg: 'a|b', label: 'piped into a command named b' },
  { arg: 'a&&b', label: 'chained a command named b' },
  { arg: 'x>PWNED.txt', label: 'redirected stdout and created a file' },
  { arg: '%PATH%', label: 'expanded to the whole environment variable' },
  { arg: '^caret', label: 'lost the caret' },
  { arg: 'https://h/p?a=1&b=2', label: 'a LEGITIMATE url the old path broke' },
  { arg: 'has space', label: 'the one case libuv did quote' },
  { arg: 'C:\\path\\with\\back\\', label: 'a trailing backslash run' },
  { arg: '(paren)', label: 'a grouping character' },
  { arg: '!bang!', label: 'delayed expansion, if the machine has it on' },
  { arg: 'a<b', label: 'an input redirect' },
];

/**
 * The payloads that are REFUSED rather than escaped, and the reason there is
 * such a category at all.
 *
 * A `.cmd` shim's `%*` makes cmd parse the arguments a second time, and the two
 * parsers disagree about how to spell an embedded quote: `\"` is what the CLI
 * wants and is a live injection in cmd.exe, `""` is inert in cmd.exe and
 * arrives at the CLI merged with the next argument. Both measured. No spelling
 * is both safe and faithful, so a quote does not go — see `DOUBLE_QUOTE`.
 */
const REFUSED: ReadonlyArray<{ arg: string; label: string }> = [
  { arg: 'q"uote', label: 'an ordinary embedded quote' },
  { arg: 'trail\\"quote', label: 'backslash immediately before a quote' },
  { arg: `a">PWNED.txt`, label: 'quote-breakout into a redirect' },
  { arg: `a" & echo ${MARK} & rem `, label: 'quote-breakout into a second command' },
  { arg: `a"&echo ${MARK}`, label: 'quote-breakout with no spaces' },
  { arg: `a"|echo ${MARK}`, label: 'quote-breakout into a pipe' },
  { arg: `"&echo ${MARK}`, label: 'a LEADING quote' },
  { arg: `a\\"&echo ${MARK}`, label: 'backslash-quote, the MSVCRT spelling itself' },
  { arg: `a""&echo ${MARK}`, label: 'a doubled quote in the INPUT' },
  { arg: '"""', label: 'nothing but quotes' },
  { arg: '"', label: 'a single lone quote' },
];

describe('quoteArg', () => {
  it('always quotes, even when nothing needs it', () => {
    expect(quoteArg('plain')).toBe('"plain"');
  });

  it('DOUBLES an embedded quote rather than backslash-escaping it', () => {
    // THE SECURITY PROPERTY. `\"` is an escaped quote to the child and a real
    // closing quote to cmd.exe, which does not know the backslash convention —
    // so one user quote desynchronises cmd and the tail becomes live syntax.
    // `""` keeps cmd's count even and still reads as a literal quote to
    // `CommandLineToArgvW`. Same class as CVE-2024-24576, same fix.
    expect(quoteArg('a"b')).toBe('"a""b"');
    expect(quoteArg('a"b')).not.toContain('\\"');
  });

  it('doubles the backslash run before an embedded quote', () => {
    expect(quoteArg('a\\"b')).toBe('"a\\\\""b"');
  });

  it('doubles the backslash run before the CLOSING quote', () => {
    // `C:\dir\` must not end up as `"C:\dir\"` — that backslash would escape
    // the terminator and swallow the following argument.
    expect(quoteArg('C:\\dir\\')).toBe('"C:\\dir\\\\"');
  });

  it('leaves interior backslashes alone', () => {
    expect(quoteArg('C:\\a\\b')).toBe('"C:\\a\\b"');
  });

  it('emits an even number of quotes for any input', () => {
    // The invariant behind the fix, stated directly: cmd decides what is inside
    // a quoted region by counting, so an odd count is the bug. Still asserted
    // even though `execSpec` now refuses a quote outright — this function is the
    // belt to that braces, and an encoding that can go odd is one refactor away
    // from being the hole again.
    const all = [...HOSTILE, ...REFUSED].map((h) => h.arg);
    for (const a of all.concat(['', 'a', '""""', '\\', '\\\\"'])) {
      const count = [...quoteArg(a)].filter((c) => c === '"').length;
      expect(count % 2, `${JSON.stringify(a)} -> ${quoteArg(a)}`).toBe(0);
    }
  });
});

describe('escapeForCmd', () => {
  it('carets every cmd.exe metacharacter, including the quotes we added', () => {
    expect(escapeForCmd('"a&b"')).toBe('^"a^&b^"');
  });

  it('carets percent, so cmd.exe cannot expand a variable', () => {
    expect(escapeForCmd('%PATH%')).toBe('^%PATH^%');
  });

  it('carets bang, for a shim that turned delayed expansion on', () => {
    expect(escapeForCmd('!x!')).toBe('^!x^!');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeForCmd('mcp add my-server')).toBe('mcp add my-server');
  });
});

describe('execSpec', () => {
  it('passes an argv array straight through off Windows — no shell, nothing to escape', () => {
    const spec = execSpec('/usr/local/bin/claude', ['mcp', 'add', 'foo&calc'], 'linux');
    expect(spec).toEqual({
      file: '/usr/local/bin/claude',
      argv: ['mcp', 'add', 'foo&calc'],
      windowsVerbatimArguments: false,
    });
  });

  it('passes a Windows .exe straight through too — only a shell script needs cmd.exe', () => {
    const spec = execSpec('C:\\tools\\claude.exe', ['mcp', 'list'], 'win32');
    expect(spec.file).toBe('C:\\tools\\claude.exe');
    expect(spec.windowsVerbatimArguments).toBe(false);
  });

  it('wraps a .cmd in cmd.exe /d /s /c with a verbatim, self-built line', () => {
    const spec = execSpec(WIN_CMD, ['mcp', 'list'], 'win32');
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.argv.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
    // one argument, outer-quoted — `/s`'s contract
    expect(spec.argv).toHaveLength(5);
    expect(spec.argv[4]?.startsWith('"')).toBe(true);
    expect(spec.argv[4]?.endsWith('"')).toBe(true);
  });

  it('names cmd.exe by ABSOLUTE PATH, not through PATH', () => {
    // PATH is per-user writable, so `file: 'cmd.exe'` would let the very
    // attacker this module disables AutoRun against choose the interpreter.
    expect(execSpec(WIN_CMD, [], 'win32').file).toMatch(/^[A-Za-z]:\\.*System32\\cmd\.exe$/i);
  });

  it('/d is present, so a registry AutoRun cannot run before our command', () => {
    expect(execSpec(WIN_CMD, [], 'win32').argv).toContain('/d');
  });

  it('/v:off is present, so !VAR! in an argument cannot be substituted', () => {
    // Not the default everywhere: a registry value makes delayed expansion
    // machine-wide, `/d` does not cover it, and `^!` does not protect against
    // it. Measured — see `escapeForCmd`.
    expect(execSpec(WIN_CMD, [], 'win32').argv).toContain('/v:off');
  });

  describe('REFUSES a double quote rather than choosing between two wrong spellings', () => {
    for (const { arg, label } of REFUSED) {
      it(`${JSON.stringify(arg)} — ${label}`, () => {
        expect(() => execSpec(WIN_CMD, ['mcp', 'add', arg], 'win32')).toThrow(/double quote/);
      });
    }

    it('but not off the cmd.exe path, where there is no second parser', () => {
      // `execFile` hands an argv array to the OS; a quote is just a character.
      expect(() => execSpec('/usr/bin/claude', ['q"uote'], 'linux')).not.toThrow();
      expect(execSpec('/usr/bin/claude', ['q"uote'], 'linux').argv).toEqual(['q"uote']);
    });

    it('and not for the CLI PATH itself, which the caller did not type', () => {
      // `resolveCliPath` produced it by scanning PATH; a Windows path cannot
      // contain a quote, and refusing here would be refusing our own install.
      expect(() => execSpec(WIN_CMD, ['mcp', 'list'], 'win32')).not.toThrow();
    });
  });

  it('REFUSES a control character rather than silently truncating', () => {
    // A caret cannot escape a newline: `a\nb` reaches the child as `a`. A
    // launcher that quietly delivers something other than what it was given is
    // not a safe launcher, so this throws — and `mcp/cli.ts` turns the throw
    // into a refusal the user can read.
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    expect(() => execSpec(WIN_CMD, ['a' + LF + 'b'], 'win32')).toThrow(/control character/);
    expect(() => execSpec(WIN_CMD, ['a' + NUL], 'win32')).toThrow(/control character/);
    // ...and off the cmd.exe path there is no shell to confuse, so no refusal
    expect(() => execSpec('/usr/bin/claude', ['a' + LF + 'b'], 'linux')).not.toThrow();
  });

  it('treats .bat like .cmd, and matches case-insensitively', () => {
    expect(execSpec('C:\\x\\claude.BAT', [], 'win32').file).toMatch(/cmd\.exe$/i);
  });

  // The string-level half of the exploit pin: on EVERY platform, every hostile
  // payload comes out with each metacharacter caret-escaped rather than bare.
  describe('the recorded exploit set is neutralised on the cmd.exe path', () => {
    for (const { arg, label } of HOSTILE) {
      it(`${JSON.stringify(arg)} — ${label}`, () => {
        const line = execSpec(WIN_CMD, ['mcp', 'add', arg], 'win32').argv[4] ?? '';
        // Everything cmd.exe would act on is preceded by a caret. Scanning the
        // built line directly is the assertion that cannot be satisfied by a
        // half-fix: a single unescaped `&` anywhere in it fails here.
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (!'()%!^"<>&|'.includes(ch)) continue;
          if (ch === '^') {
            i += 1; // the caret consumes whatever follows
            continue;
          }
          // an outer quote is ours and is deliberately bare
          if (ch === '"' && (i === 0 || i === line.length - 1)) continue;
          expect.fail(`unescaped ${ch} at ${i} in ${line}`);
        }
      });
    }
  });
});

// ── The layer that actually proves it ────────────────────────────────────────
//
// Windows only, because the thing under test is cmd.exe. Skipped elsewhere
// rather than faked: a mock of cmd.exe's parser would be a mock of our own
// belief about it, which is exactly the belief that was wrong.
const onWindows = process.platform === 'win32' ? describe : describe.skip;

onWindows('end to end through the real cmd.exe', () => {
  /**
   * A throwaway `.cmd` shim that echoes its argv as JSON, plus its temp dir.
   *
   * `%*` IS THE WHOLE POINT, and is what `claude.cmd` really does. It makes cmd
   * parse the arguments a SECOND time, after the carets have been consumed —
   * which is the pass the quote-breakout family lives in, and the reason a shim
   * without `%*` would prove nothing.
   */
  function makeShim(): { dir: string; cmd: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wincmd-'));
    const echo = path.join(dir, 'echoargs.cjs');
    fs.writeFileSync(echo, 'console.log("ARGV:"+JSON.stringify(process.argv.slice(2)));');
    const cmd = path.join(dir, 'fakecli.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "${echo}" %*\r\n`);
    return { dir, cmd };
  }

  /** the raw output, because "did anything else run" is not visible in argv */
  function runRaw(cmd: string, args: readonly string[]): string {
    const spec = execSpec(cmd, args, 'win32');
    try {
      return String(
        execFileSync(spec.file, spec.argv, {
          encoding: 'utf8',
          windowsHide: true,
          // `@types/node` omits this from the SYNC options (it is declared on
          // the async `execFile` and on `spawn`), but libuv honours it on all
          // three — and the byte-exact round-trips below are the proof: without
          // it libuv would re-quote the line we already escaped and every case
          // would mangle.
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        } as Parameters<typeof execFileSync>[2])
      );
    } catch (e) {
      // a breakout can make cmd exit non-zero; we still want to see the output
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
      const text = (v: string | Buffer | undefined): string =>
        typeof v === 'string' ? v : (v?.toString('utf8') ?? '');
      return text(err.stdout) + text(err.stderr);
    }
  }

  function argvOf(out: string): string[] | null {
    const m = /ARGV:(.*)/.exec(out);
    return m ? (JSON.parse(m[1]) as string[]) : null;
  }

  const runThrough = (cmd: string, args: readonly string[]): string[] | null =>
    argvOf(runRaw(cmd, args));

  it('every recorded payload round-trips byte-exact, and nothing else runs', () => {
    const { dir, cmd } = makeShim();
    const pwned = path.join(dir, 'PWNED.txt');
    const cwdPwned = path.join(process.cwd(), 'PWNED.txt');
    // Cleared FIRST so the result is about this run. A red run really does
    // create these — the file is how the regression was confirmed — and a
    // leftover would then fail the next, green run for the previous run's sin.
    for (const f of [pwned, cwdPwned]) fs.rmSync(f, { force: true });
    try {
      for (const { arg, label } of HOSTILE) {
        const why = `${JSON.stringify(arg)} — ${label}`;
        const out = runRaw(cmd, ['mcp', 'add', arg]);
        expect(argvOf(out), why).toEqual(['mcp', 'add', arg]);
        // THE ASSERTION THAT ARGV ALONE CANNOT MAKE. When a payload breaks out
        // into a pipe, argv may never arrive at all — so "argv matched" is not
        // the same claim as "nothing executed", and the first fix passed an
        // argv-only version of this test while being exploitable. A line that
        // is EXACTLY the marker means `echo` ran as its own command; the marker
        // appearing INSIDE the echoed argv is just the payload being reported.
        const ran = out.split(/\r?\n/).some((l) => l.trim() === MARK);
        expect(ran, `${why} — a second command executed`).toBe(false);
      }
      // The redirect payloads create a file. cwd for the child is this process's
      // cwd, so check both there and beside the shim.
      expect(fs.existsSync(pwned)).toBe(false);
      expect(fs.existsSync(cwdPwned)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwdPwned, { force: true });
    }
  });

  it('carries an argument that is a lone metacharacter, and an empty one', () => {
    const { dir, cmd } = makeShim();
    try {
      expect(runThrough(cmd, ['&'])).toEqual(['&']);
      expect(runThrough(cmd, ['a', '', 'b'])).toEqual(['a', '', 'b']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not substitute !VAR! even when delayed expansion is the default', () => {
    // `/v:off` is what makes this true; `^!` alone does not. Forced on here via
    // an explicit `/v:on` equivalent — the registry default this defends
    // against — by checking the value simply does not appear.
    const { dir, cmd } = makeShim();
    try {
      const out = runRaw(cmd, ['!SB_WINCMD_PROBE!']);
      expect(argvOf(out)).toEqual(['!SB_WINCMD_PROBE!']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
