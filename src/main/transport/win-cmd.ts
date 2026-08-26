// Launching a Windows `.cmd` shim with arguments we did not write (#714).
//
// WHAT THIS IS FOR, IN ONE SENTENCE: `launchSpec()` is correct for arguments
// the app authors, and NOT SAFE for arguments a user typed. This module is the
// second one, and it exists because `claude mcp add` is the first place in the
// app where a renderer-supplied string reaches a command line.
//
// ── THE HOLE, MEASURED 2026-08-26 ────────────────────────────────────────────
//
// On Windows, PATH holds `claude.cmd`, so `launchSpec()` yields
// `cmd.exe /c claude.cmd <args…>`. Node hands that argv to libuv, whose
// `quote_cmd_arg` QUOTES ONLY WHAT CONTAINS A SPACE, A TAB OR A QUOTE
// (`wcspbrk(source, L" \t\"")`). Every other cmd.exe metacharacter is passed
// through bare — and cmd.exe parses its command line BEFORE the child ever sees
// it. Against a fake CLI that echoes its own argv:
//
//     "foo&calc"            -> ["mcp","add","foo"]     and `calc` ran
//     "x>C:/tmp/PWNED.txt"  -> ""                      and the file was created
//     "%PATH%"              -> the whole expanded PATH
//     "^caret"              -> ["mcp","add","caret"]
//     "a|b"  /  "a&&b"      -> cmd error, `b` executed as a command
//
// `checkHealth` (#632) is safe today only because its argv is the two constants
// `['mcp','list']`. The moment a server name, a command, an argv element, an
// `-e KEY=VALUE` or an `-H "Header: value"` goes on that line — which is all of
// #714 — this is a command-injection vector on the maintainer's own platform,
// reachable from any renderer surface holding `mcp.write`.
//
// ── THE FIX, ALSO MEASURED ───────────────────────────────────────────────────
//
// Stop letting libuv build the line and build it ourselves, which means
// escaping for BOTH parsers in the right order:
//
//   1. MSVCRT rules, for the CHILD's own argv splitting — always quote, double
//      the backslashes that precede a quote or the closing quote.
//   2. cmd.exe rules, for the shell that sees the line first — caret-escape
//      every metacharacter, INCLUDING the quotes we just added.
//
// Then `windowsVerbatimArguments: true` so libuv does not re-quote what we
// carefully escaped, and `/d /s /c` so cmd.exe skips AutoRun (`/d` — a registry
// key any installer can write, which would otherwise run before our command)
// and takes the rest of the line verbatim between the outer quotes (`/s`).
//
// All eleven hostile cases above round-trip byte-exact through this, `%PATH%`
// stops expanding, `>` stops redirecting, and embedded quotes and trailing
// backslashes survive. Pinned in `win-cmd.test.ts`.
//
// WHY NOT `shell: true`: it is the same hole with a friendlier name — it
// re-parses the arguments through a command interpreter, which is precisely
// what we are trying to stop. `stream-service.ts`'s `launchSpec` header rules
// it out for the same reason and that reasoning is unchanged.

import path from 'path';

/**
 * One argument, quoted so that BOTH parsers below agree about where it ends.
 *
 * ALWAYS QUOTED, even when nothing needs it. libuv's version skips the quotes
 * for a "simple" argument; ours cannot, because the whole point is that the
 * cmd.exe layer above must see every metacharacter INSIDE a quoted region
 * rather than deciding it is punctuation. An unconditional quote is also one
 * fewer branch to get wrong.
 *
 * ── AN EMBEDDED QUOTE IS `""`, NOT `\"`, AND THAT IS THE WHOLE SECURITY
 *    PROPERTY OF THIS FUNCTION ────────────────────────────────────────────────
 *
 * `\"` is the MSVCRT spelling of an escaped quote and is what libuv, Node's own
 * docs, and the first version of this file all use. It is correct for the
 * CHILD's argv parser and CATASTROPHIC for cmd.exe, which does not know the
 * backslash convention at all: to cmd, `\"` is a backslash followed by a REAL
 * quote, so one user-supplied `"` flips its quote state and everything after it
 * becomes live syntax.
 *
 * That matters here and not in most places because a `.cmd` shim parses the
 * arguments A SECOND TIME. `claude.cmd` is
 *
 *     @"%~dp0\node_modules\...\claude.exe" %*
 *
 * and `%*` re-substitutes the argument text into a line cmd then re-parses —
 * by which point the carets `escapeForCmd` added have already been consumed by
 * the outer `cmd.exe`. The quoting is the only protection left, and unbalanced
 * quotes are not protection.
 *
 * MEASURED, against the real `claude.cmd` on this machine (2026-08-26):
 *
 *     args: ['mcp','list','a"&echo INJECTED']
 *     →  No MCP servers configured. Use `claude mcp add` to add a server.
 *        INJECTED                                   ← ran as its own command
 *
 * With `""` the same payload is inert and arrives at the child intact. Verified
 * across 23 fidelity cases and 11 breakout payloads: 0 mangled, 0 executed.
 * This is the same class of defect as CVE-2024-24576, and the same fix.
 *
 * `""` INSIDE A QUOTED BLOCK IS A LITERAL QUOTE to `CommandLineToArgvW` and to
 * the MSVCRT startup code, so the child still receives exactly what was passed
 * — that is not an assumption, it is what the fidelity cases in the test pin.
 *
 * The backslash rule is still MSVCRT's and is still easy to get subtly wrong: a
 * backslash is literal EXCEPT when it precedes a quote, where each one must be
 * doubled — and that includes the run immediately before the CLOSING quote, or
 * `C:\path\` would escape the terminator and swallow the next argument.
 */
export function quoteArg(arg: string): string {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      // the run before the quote is doubled; the quote itself becomes `""`
      out += '\\'.repeat(slashes) + '""';
      slashes = 0;
      continue;
    }
    slashes = 0;
    out += ch;
  }
  // ...and the run before the CLOSING quote is doubled too
  return out + '\\'.repeat(slashes) + '"';
}

/**
 * The characters `cmd.exe` acts on, caret-escaped.
 *
 * APPLIED AFTER `quoteArg` AND TO ITS QUOTES TOO, which looks wrong and is the
 * only thing that works for the FIRST parse. Quoting alone does not save you:
 * cmd.exe still expands `%VAR%` inside double quotes. Caret-escaping every
 * metacharacter — including the quotes — takes the decision away from cmd.exe;
 * it strips the carets and passes the result on.
 *
 * THIS ONLY COVERS ONE PASS. The carets are consumed by the outer `cmd.exe`, so
 * a `.cmd` shim's `%*` re-expansion is parsed with none of them left. Balanced
 * quoting (`quoteArg`) is what protects that second pass; this protects the
 * first. Both are needed and neither is sufficient — see `quoteArg`.
 *
 * `!` IS IN THE SET AND DOES NOT ACTUALLY HELP, which is why `execSpec` passes
 * `/v:off` as well. Measured 2026-08-26: with delayed expansion on, `^!` does
 * not protect the argument —
 *
 *     /d /s /c        ['!SB_SECRET!'] -> ["!SB_SECRET!"]
 *     /d /v:on /s /c  ['!SB_SECRET!'] -> ["LEAKED"]
 *     /d /v:off /s /c ['!SB_SECRET!'] -> ["!SB_SECRET!"]
 *
 * — and `HKCU\Software\Microsoft\Command Processor\DelayedExpansion = 1` makes
 * `/v:on` the machine-wide default, which `/d` does NOT disable. The caret stays
 * because it is harmless and correct when expansion is off; the switch is what
 * makes the guarantee.
 */
export function escapeForCmd(s: string): string {
  return s.replace(/[()%!^"<>&|]/g, (c) => '^' + c);
}

/**
 * The interpreter, by ABSOLUTE PATH.
 *
 * `file: 'cmd.exe'` would be resolved through `PATH`, which is per-user
 * writable — so a planted `cmd.exe` in any directory earlier on `PATH` runs
 * instead (verified). It would be absurd to disable AutoRun on the grounds that
 * it is "a registry key any installer can write" and then let the same class of
 * attacker choose the interpreter. `providers/claude.ts` records this lesson
 * from S-01: absolute paths, because a PATH-relative binary with `cwd` set to a
 * user project is a planted-binary footgun.
 */
function cmdExePath(): string {
  // `path.WIN32.join`, and the plain `path.join` here was a CI failure — the
  // #127 lesson arriving through the door this file spent so long propping
  // open. `path` binds to the AMBIENT platform, so on the Linux leg it joined
  // with `/` and produced `C:\Windows/System32/cmd.exe`. The whole point of
  // `execSpec` taking `platform` is that the win32 branch is exercised
  // everywhere; a helper inside it that reads the real platform undoes that,
  // and it passes locally on Windows precisely when it is wrong.
  //
  // Joined rather than concatenated because a `SystemRoot` with a stray
  // trailing separator would otherwise double it — and with
  // `windowsVerbatimArguments: true` libuv joins `[file, ...argv]` on bare
  // spaces, so `file` is not somewhere to be sloppy.
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
}

/**
 * A control character makes the cmd.exe path UNSAFE IN A WAY ESCAPING CANNOT
 * FIX, so it is refused rather than mangled.
 *
 * A caret cannot escape a newline: `['a\nb']` arrives at the child as `["a"]`,
 * silently truncated, and a lone `\r` is silently dropped (`a\rb` -> `ab`). The
 * tail does not execute, so this is corruption rather than injection — but
 * `execSpec` is the app's safe launcher for arguments it did not write, and a
 * launcher that quietly delivers something OTHER than what it was given is not
 * one. `shared/mcp-args.ts` refuses these upstream too; this is the backstop
 * that keeps the guarantee a property of this module rather than of its callers
 * all remembering.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`
);

/**
 * A DOUBLE QUOTE IS REFUSED ON THE cmd.exe PATH, and this is the resolution of
 * a genuine bind rather than caution.
 *
 * There are two consumers of the same bytes and they disagree about how to
 * spell an embedded quote:
 *
 *   `\"`  — what MSVCRT and `CommandLineToArgvW` want. cmd.exe does not know
 *           the backslash convention at all, so it counts a REAL quote here,
 *           its quote state flips, and the rest of the argument becomes live
 *           syntax. MEASURED against the real `claude.cmd`: `a"&echo X` ran
 *           `echo X` as its own command. This is an INJECTION.
 *   `""`   — keeps cmd's count even and is inert (measured: 0 of 11 breakout
 *           payloads execute). But `claude.exe` does not read it the way
 *           `node.exe` does: MEASURED, `--  node 'q"uote' 'plain'` arrives as a
 *           SINGLE argument `q"uote plain`, so the config written is not the
 *           config the user asked for. This is CORRUPTION.
 *
 * The same input cannot be both spellings. Escaping cannot get out of this, so
 * the argument does not go: refusing is the only option that is neither a hole
 * nor a lie. It costs approximately nothing — a shell strips quotes before argv
 * anyway, so a literal `"` inside an MCP server argument is vanishingly rare —
 * and `shared/mcp-args.ts` refuses it up front with a sentence the user can act
 * on, so this is the backstop rather than the message.
 *
 * (Off the cmd.exe path there is no second parser and no ambiguity: `execFile`
 * hands an argv array to the OS, and a quote is just a character.)
 */
const DOUBLE_QUOTE = /"/;

/** What `child_process.execFile`/`spawn` needs to launch this safely. */
export interface ExecSpec {
  file: string;
  argv: string[];
  /** true only on the cmd.exe path, where we built the line ourselves */
  windowsVerbatimArguments: boolean;
}

/**
 * How to run `<cli> <args…>` with arguments we do not trust.
 *
 * The non-Windows branch, and the Windows-native-`.exe` branch, are the boring
 * ones: `execFile` passes an argv array to the OS and no shell is involved, so
 * there is nothing to escape and nothing to get wrong. Only a `.cmd`/`.bat`
 * needs cmd.exe, and only that path pays for the escaping above.
 *
 * `platform` IS A PARAMETER for the #127 reason `launchSpec` and `samePath`
 * both document: read from the ambient process, the Windows branch would pass
 * vacuously on the ubuntu and macOS CI legs — a green half-suite proving
 * nothing on two of three platforms. Injected, every runner exercises both.
 */
export function execSpec(
  cli: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): ExecSpec {
  const isWindowsShellScript = platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
  if (!isWindowsShellScript) {
    return { file: cli, argv: [...args], windowsVerbatimArguments: false };
  }
  for (const a of args) {
    // THROWS rather than mangles — see `CONTROL_CHARS` and `DOUBLE_QUOTE`.
    // Every caller in this family already resolves a verdict for a throw
    // (`mcp/cli.ts` catches it into `cli-failed`), so this surfaces as a
    // refusal, not a crash.
    if (CONTROL_CHARS.test(a)) {
      throw new Error('cmd.exe arguments cannot contain control characters');
    }
    if (DOUBLE_QUOTE.test(a)) {
      throw new Error('cmd.exe arguments cannot contain a double quote');
    }
  }
  const line = [cli, ...args].map((a) => escapeForCmd(quoteArg(a))).join(' ');
  // The OUTER quotes are `/s`'s contract: cmd.exe strips the first and last
  // character of the remainder and uses what is between them verbatim. Without
  // them cmd.exe applies its own (much stranger) rules about which quotes to
  // keep.
  //
  // `/d`     skip AutoRun — a registry key any installer can write, which would
  //          otherwise run a command of its choosing before ours.
  // `/v:off` pin delayed expansion OFF, so `!VAR!` in an argument cannot be
  //          substituted. Not the default everywhere: a registry value makes
  //          `/v:on` machine-wide, and `/d` does not cover it. See
  //          `escapeForCmd` for the measurement.
  return {
    file: cmdExePath(),
    argv: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
