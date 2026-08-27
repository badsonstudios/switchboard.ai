// Turning a form into a `claude mcp` command line (#714) — pure, no CLI, no fs.
//
// §5.17: "read the real config files; mutate via the real CLI". `config.ts` is
// the read half. This is the argv half of the write, kept separate from
// `cli.ts` (which spawns) so that every rule about what we will and will not
// put on a command line is unit-tested without a process.
//
// IN `shared/`, NOT IN `main/mcp/`, and for the #618 reason the rest of this
// family already follows: the add form has to tell the user their server name
// is invalid BEFORE a round trip, and main has to refuse the same request when
// a caller skips the form. Two copies of that rule is two copies that drift —
// and the direction they drift in is a form that accepts what main rejects, so
// the button appears to do nothing. One declaration, imported by both.
//
// MAIN STILL VALIDATES. The renderer's call is a courtesy, not a gate: nothing
// on the other side of an IPC boundary is trusted, and `main/mcp/ipc.ts` runs
// `validateAdd` again on everything it is handed (§5.29).
//
// ── TWO DIFFERENT INJECTIONS, AND ONLY ONE IS THE SHELL'S ────────────────────
//
// `transport/win-cmd.ts` fixes the SHELL one: metacharacters reaching cmd.exe.
// That is necessary and it is not sufficient, because there is a second parser
// downstream — commander, inside the CLI itself. An argument that begins with
// `-` is read by commander as an OPTION no matter how perfectly it survived the
// shell, so a server named `--help` or `-s` is a way to steer the CLI's own
// invocation from the renderer. Escaping cannot help with that; refusing can.
// Hence `looks-like-a-flag`, applied to every positional we emit.
//
// The child process's own arguments are the one exception and are safe for a
// structural reason rather than a hopeful one: they go after the CLI's `--`,
// which is precisely commander's "stop reading options" marker. `npx -y srv`
// is a documented install form and must keep working (probed 2026-08-26 — it
// does, and the `--` is what makes it work).
//
// ── PROBED 2026-08-26, against the CLI on PATH ───────────────────────────────
//
//   claude mcp add [-s scope] [-t stdio|sse|http] [-e K=V…] [-H "K: V"…]
//                  <name> <commandOrUrl> [args…]
//   claude mcp remove <name> [-s scope]
//   claude mcp reset-project-choices            (no arguments, no -s)
//
//   `-e` and `-H` repeat and accumulate into the `env` / `headers` maps.
//   A duplicate name exits 1 with "MCP server <n> already exists in .mcp.json".
//   Removing an absent name exits 1 with 'No MCP server named "<n>" in …'.
//   Both messages are better than anything we would write, so `cli.ts` passes
//   them through rather than translating them.
//
// A NOTE ON PROBING THIS FROM POWERSHELL: don't. PowerShell 5.1 strips a bare
// `--` before the native command sees it, which makes the documented stdio form
// look broken ("error: unknown option '-y'") when it is fine. The same probe
// from bash passes. This cost half an hour; it costs you nothing now.
import type { McpAddRequest, McpFieldError, McpScope } from './mcp';

/** Anything a command line has no meaning for: C0, DEL. A newline in an argv
 *  element is never something a user meant, and is the classic smuggling
 *  primitive for the `-H` header form (`X: y\r\nZ: w` is two headers). */
// MATCHING them is the entire point, so `no-control-regex` is off for this one
// line. That rule exists to catch a control character typed into a pattern by
// accident; here it is the subject. Written as escapes rather than raw bytes
// because this repo forbids control bytes in source files
// (`scripts/check-nul.js`, and the S-03 lesson `lib/composer.ts` records).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A double quote cannot be delivered through the Windows launcher AT ALL, and
 * that is a measured platform limit, not fussiness.
 *
 * On Windows the CLI is a `.cmd` shim, so every argument is parsed twice — once
 * by `cmd.exe` and once by the CLI — and the two disagree about how an embedded
 * quote is spelled. `\\"` is what the CLI wants and flips cmd.exe's quote state,
 * which is a command-injection hole (measured: `a"&echo X` ran `echo X`). `""` is
 * inert in cmd.exe and reaches the CLI MERGED with the next argument (measured:
 * `-- node 'q"uote' 'plain'` arrives as one argument, `q"uote plain`).
 *
 * No spelling satisfies both, so the value is refused with a sentence the user
 * can act on rather than written to their config as something they did not type.
 * Refused on EVERY platform, deliberately: a config that is valid on Linux and
 * impossible on Windows is a worse trade than one rule that holds everywhere.
 * `main/transport/win-cmd.ts` backstops this and carries the measurements.
 */
const DOUBLE_QUOTE = /"/;

/**
 * What a server may be called when WE create it.
 *
 * Deliberately narrower than what the CLI accepts, and narrower still than what
 * a config file can contain — `validateRemoveName` below is the lax twin, for
 * exactly that reason. Three things fall out of the leading `[A-Za-z0-9]`:
 * a name can never look like a flag, can never be `__proto__` (the key
 * `config.ts` documents having had to defend against), and can never be empty.
 *
 * Every published MCP server is named inside this set. Someone who genuinely
 * wants a space in a server name still has `claude mcp add`, and the manual
 * says so.
 */
const ADD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** POSIX environment variable naming — what a shell would let you export. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 9110 field-name token. Narrow on purpose: a header NAME with a colon or
 *  a space in it would split our own `Name: value` encoding. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const SCOPES: readonly McpScope[] = ['project', 'local', 'user'];
const TRANSPORTS = ['stdio', 'http', 'sse'] as const;

const err = (
  field: McpFieldError['field'],
  code: McpFieldError['code'],
  at?: string
): McpFieldError => (at === undefined ? { field, code } : { field, code, at });

/** a plain object — the guard `config.ts` uses, for the same reason: everything
 *  reaching this file crossed an IPC boundary and may be any shape at all */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A positional argument the CLI's own parser must not read as an option.
 *
 * `--` alone is also refused: it is commander's terminator, and letting one
 * through as a name or a target would end option parsing early and shift every
 * argument after it into a different role.
 */
function flagLike(s: string): boolean {
  return s.startsWith('-');
}

/**
 * The name of a server we are about to CREATE.
 *
 * Order matters for the message: "you typed a control character" is more useful
 * than "that does not match the pattern", even though the pattern would also
 * have caught it.
 */
export function validateAddName(name: unknown): McpFieldError | null {
  if (typeof name !== 'string' || name.length === 0) return err('name', 'required');
  if (CONTROL.test(name)) return err('name', 'control-character');
  // BEFORE the pattern check, which would also catch it — but as a generic
  // "that is not a valid value", and the manual promises the specific
  // explanation "double quotes aren't accepted anywhere in this form". Every
  // other field delivers that sentence; this one used not to.
  if (DOUBLE_QUOTE.test(name)) return err('name', 'double-quote');
  if (name.length > 64) return err('name', 'too-long');
  if (flagLike(name)) return err('name', 'looks-like-a-flag');
  if (!ADD_NAME.test(name)) return err('name', 'format');
  return null;
}

/**
 * The name of a server that ALREADY EXISTS, on its way to `mcp remove`.
 *
 * LAX WHERE `validateAddName` IS STRICT, because this name did not come from a
 * form — it came off a row the pane read out of a config file somebody else
 * wrote, and refusing to remove a server because we would not have created it
 * is a manager that can get you into a state it cannot get you out of.
 *
 * What survives is what the two parsers below genuinely cannot take: a control
 * character, and a leading `-` (which commander would read as an option — so a
 * server literally named `-x` is not removable through the CLI at all, by
 * anyone, and saying so is better than sending it and hoping).
 */
export function validateRemoveName(
  name: unknown,
  // WINDOWS-ONLY for the quote, and injected for the #127 reason `execSpec` and
  // `samePath` both document — read from the ambient platform, one branch would
  // pass vacuously on two of the three CI legs.
  platform: NodeJS.Platform = process.platform
): McpFieldError | null {
  if (typeof name !== 'string' || name.length === 0) return err('name', 'required');
  if (CONTROL.test(name)) return err('name', 'control-character');
  // THE QUOTE RULE IS NOT UNIVERSAL HERE, and that is the difference between
  // creating and deleting. `DOUBLE_QUOTE`'s "refuse it everywhere" argument is
  // about a config that would be valid on Linux and impossible on Windows —
  // an argument about what we WRITE. This function deletes something that
  // already exists, and off Windows `execSpec` delivers `a"b` perfectly well.
  // Refusing there would list a server and then decline to remove it: exactly
  // the state-you-cannot-get-out-of this function's laxity exists to prevent.
  if (platform === 'win32' && DOUBLE_QUOTE.test(name)) return err('name', 'double-quote');
  if (flagLike(name)) return err('name', 'looks-like-a-flag');
  return null;
}

export function validateScope(scope: unknown): McpFieldError | null {
  return SCOPES.includes(scope as McpScope) ? null : err('scope', 'format');
}

/** The whole add request. `null` when it is safe to build a command line from. */
export function validateAdd(req: McpAddRequest): McpFieldError | null {
  const nameErr = validateAddName(req.name);
  if (nameErr) return nameErr;
  const scopeErr = validateScope(req.scope);
  if (scopeErr) return scopeErr;
  if (!(TRANSPORTS as readonly string[]).includes(req.transport)) {
    return err('transport', 'format');
  }

  if (typeof req.target !== 'string' || req.target.length === 0) return err('target', 'required');
  if (CONTROL.test(req.target)) return err('target', 'control-character');
  if (DOUBLE_QUOTE.test(req.target)) return err('target', 'double-quote');
  if (flagLike(req.target)) return err('target', 'looks-like-a-flag');

  if (req.transport === 'stdio') {
    // ARRAY-CHECKED BEFORE ITERATING, and that is not defensive noise: this
    // function runs on a payload that crossed the IPC boundary, so `args: {}`
    // or `env: 42` is a `TypeError` in a `for…of` — which becomes a REJECTED
    // channel, and this family's contract (`McpMutationResult`, and
    // `main/mcp/ipc.ts`'s header) is that it resolves a verdict and never
    // rejects. A dialog whose button throws is a button that does nothing.
    if (req.args !== undefined && !Array.isArray(req.args)) return err('args', 'format');
    if (req.env !== undefined && !Array.isArray(req.env)) return err('env', 'format');
    for (const [i, a] of (req.args ?? []).entries()) {
      // NOT checked for a leading `-`: these live after the CLI's `--`, which
      // is what makes `npx -y some-server` work. See the header.
      if (typeof a !== 'string') return err('args', 'format', String(i));
      if (CONTROL.test(a)) return err('args', 'control-character', String(i));
      if (DOUBLE_QUOTE.test(a)) return err('args', 'double-quote', String(i));
    }
    for (const [i, pair] of (req.env ?? []).entries()) {
      if (!isRecord(pair)) return err('env', 'format', String(i));
      const { key, value } = pair;
      if (typeof key !== 'string' || !ENV_KEY.test(key)) return err('env', 'format', String(i));
      if (typeof value !== 'string' || CONTROL.test(value)) {
        return err('env', 'control-character', key);
      }
      if (DOUBLE_QUOTE.test(value)) return err('env', 'double-quote', key);
    }
  } else {
    // A REAL URL, not "a string with a colon in it". The CLI would reject a
    // bad one too, but it would reject it after we had already told the user
    // the server was being created — and `http:` / `https:` is the check that
    // keeps `file:` and `javascript:` off the line entirely.
    let parsed: URL;
    try {
      parsed = new URL(req.target);
    } catch {
      return err('target', 'format');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return err('target', 'format');
    }
    if (req.headers !== undefined && !Array.isArray(req.headers)) return err('headers', 'format');
    for (const [i, pair] of (req.headers ?? []).entries()) {
      if (!isRecord(pair)) return err('headers', 'format', String(i));
      const { key, value } = pair;
      if (typeof key !== 'string' || !HEADER_NAME.test(key)) {
        return err('headers', 'format', String(i));
      }
      if (typeof value !== 'string' || CONTROL.test(value)) {
        return err('headers', 'control-character', key);
      }
      if (DOUBLE_QUOTE.test(value)) return err('headers', 'double-quote', key);
    }
  }
  return null;
}

/**
 * The `claude mcp add …` argv for a validated request.
 *
 * VALIDATE FIRST — this function assumes it. Kept separate rather than folded
 * into one `buildOrFail` because the two questions are genuinely different: the
 * IPC layer wants to know whether to refuse and what to say, and the tests want
 * to read the command line for a request that is already known good.
 *
 * ── THE ORDER IS NOT COSMETIC, AND THE OBVIOUS ONE IS WRONG ─────────────────
 *
 * `-e <env...>` and `-H <header...>` are VARIADIC. commander lets a variadic
 * option keep eating arguments until it meets the next option or `--` — so the
 * tidy-looking "all options, then all positionals" produces:
 *
 *     mcp add -s local -t stdio -e API_KEY=x my-server -- npx
 *     → error: Invalid environment variable format: my-server
 *
 * The server NAME is consumed as a second environment variable. That is not a
 * hypothetical: it is what the first version of this function did, it is what
 * this file's unit tests asserted as correct, and it was caught only by running
 * the real CLI. Unit tests cannot find this — they were happy to pin the wrong
 * command line — which is why a live probe is part of the item and not an extra.
 *
 * So: SCOPE AND TRANSPORT FIRST (both take exactly one value), then the
 * POSITIONALS, then the variadics, which have nothing left to swallow. That is
 * also the shape of the CLI's own documented examples, read correctly:
 *
 *     claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server
 *     claude mcp add --transport http corridor https://… --header "Authorization: …"
 */
export function buildAddArgs(req: McpAddRequest): string[] {
  const argv = ['mcp', 'add', '-s', req.scope, '-t', req.transport, req.name];

  if (req.transport === 'stdio') {
    for (const { key, value } of req.env ?? []) argv.push('-e', `${key}=${value}`);
    // `--` SPLITS THE CLI'S OPTIONS FROM THE CHILD'S, and does double duty: it
    // terminates the variadic `-e` above, and it is what makes a command that
    // takes `-y` work at all. Without it `npx -y some-server` — the single most
    // common install form there is — fails with "unknown option '-y'" raised by
    // OUR invocation, about a flag the user never meant for us.
    argv.push('--', req.target, ...(req.args ?? []));
    return argv;
  }

  argv.push(req.target);
  for (const { key, value } of req.headers ?? []) argv.push('-H', `${key}: ${value}`);
  return argv;
}

/**
 * `claude mcp remove <name> -s <scope>`.
 *
 * THE SCOPE IS ALWAYS PASSED, and it comes off the row the user clicked rather
 * than being inferred. Omitting it is a real option the CLI offers — it removes
 * from "whichever scope it exists in" — and it is the wrong one here: the pane
 * deliberately lists the same name twice when two scopes define it (`config.ts`
 * does not deduplicate, so that the collision is visible), which means a
 * scopeless remove would delete the row the user did not click roughly half the
 * time.
 */
export function buildRemoveArgs(name: string, scope: McpScope): string[] {
  return ['mcp', 'remove', name, '-s', scope];
}

/**
 * `claude mcp reset-project-choices` — no arguments, and there is nothing to
 * pass it.
 *
 * A CONSTANT, exported so the call site cannot drift and so the "this takes no
 * scope" fact has somewhere to be written down. It is PROJECT-WIDE and resets
 * approved AND rejected servers together; it does not approve anything. That is
 * the CLI's design, not a limitation of this call, and it is why the button
 * this builds is worded as a reset rather than as an approve.
 */
export const RESET_APPROVALS_ARGS: readonly string[] = ['mcp', 'reset-project-choices'];
