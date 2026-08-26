// Running `claude mcp <verb>` — the write half of §5.17 (#714).
//
// "Read the real config files; mutate via the real CLI." `config.ts` is the
// read half and never spawns anything. This is the only file in the app that
// makes the CLI CHANGE something, and it is deliberately thin: `args.ts` decides
// what goes on the command line, `transport/win-cmd.ts` decides how it survives
// the shell, and this decides nothing at all except how to wait and what to do
// when it goes wrong.
//
// ── THREE TRAPS, ALL OF THEM ALREADY PAID FOR ────────────────────────────────
//
// 1. `execFile('claude', …)` DOES NOT WORK ON WINDOWS, and fails invisibly.
//    `child_process` without a shell does not apply PATHEXT, and what PATH
//    holds is `claude.cmd`, which Node >=18.20 refuses to spawn directly. This
//    was #632's shipped-and-caught-in-review blocker; `resolveCliPath()` is the
//    answer and every invocation in this family goes through it.
//
// 2. THE ARGUMENTS ARE NOT OURS. `execSpec` rather than `launchSpec`, because
//    everything here carries renderer input — a server name, a command, argv,
//    an `-e KEY=VALUE`, an `-H "Header: value"` — and libuv's quoting leaves
//    `&`, `|`, `>`, `%` and `^` live on the cmd.exe line. See that file's
//    header for the measured exploit. NOT `shell: true`, which is the same hole
//    wearing a hat.
//
// 3. `execFile` CAN THROW SYNCHRONOUSLY (EINVAL, on a hostile PATH entry) —
//    `update/token.ts` documents the same trap. Inside a promise executor that
//    is a rejection, and nothing in this family is allowed to have one.
//
// ── WHAT WE DO NOT DO: TRANSLATE THE CLI'S ERRORS ────────────────────────────
//
// A failed `mcp add` says "MCP server sentry already exists in .mcp.json". A
// failed `mcp remove` says 'No MCP server named "x" in .mcp.json'. Those are
// better sentences than any we would write, they name the exact file, and they
// stay correct when the CLI changes its mind about something. They go to the
// user verbatim (`reason: 'cli-failed'`, `detail`), and the only thing we add
// is a length bound so a runaway stack trace cannot become the dialog.
import { execFile } from 'child_process';
import { resolveCliPath } from '../providers/claude';
import { execSpec } from '../transport/win-cmd';
import type { McpMutationResult } from '../../shared/mcp';

/**
 * How long a mutation gets.
 *
 * Much shorter than `HEALTH_TIMEOUT_MS` (20s) and that asymmetry is the point:
 * a health check CONNECTS to every configured server and legitimately takes
 * seconds, while `mcp add` edits a JSON file and returns. Ten seconds is
 * already an eternity for a file write; anything longer is a CLI that is stuck,
 * and the user is sitting in front of a spinner on a button they just pressed.
 */
export const MUTATION_TIMEOUT_MS = 10_000;

/** Enough of the CLI's own message to be useful, bounded so a stack trace
 *  cannot become the dialog. */
const DETAIL_LIMIT = 600;

/**
 * Take the credentials the caller just submitted back OUT of the CLI's words.
 *
 * `cli-failed` shows the CLI's own message verbatim, which is the right call —
 * "MCP server sentry already exists in .mcp.json" names the exact file and
 * beats anything we would write. But the CLI QUOTES THE OFFENDING ARGUMENT when
 * it rejects one, and we have watched it do exactly that:
 *
 *     Invalid environment variable format: probe-stdio
 *
 * Substitute an `-e API_KEY=sk-live-…` it did not like and the credential is in
 * a dialog, possibly mid-screen-share. We know every secret in the request
 * because the caller just handed them over, so this is exact-substring
 * replacement rather than a guess — which is the same reason
 * `McpServerWire.args` could NOT be redacted and this can.
 *
 * Short values are left alone deliberately: a one- or two-character "secret" is
 * a substring of half the words in any sentence, and blanking every `x` in the
 * message would destroy it to protect nothing.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 4) continue;
    out = out.split(s).join('***');
  }
  return out;
}

/**
 * stderr first — the CLI puts its refusals there — then stdout, because some of
 * its "no" answers (`MCP server x already exists`) come out on stdout.
 *
 * REDACT BEFORE TRUNCATING, and the order is the bug this parameter exists to
 * fix. Redaction used to happen a layer up in `ipc.ts`, AFTER this function had
 * already sliced the text to `DETAIL_LIMIT` — so a secret straddling the 600th
 * character was no longer an exact substring and its prefix survived
 * (`…yysk-live-AB…`, measured in review). Doing both here means the two can
 * never be reordered by accident again.
 */
function detailFrom(stdout: string, stderr: string, secrets: readonly string[]): string {
  const joined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').trim();
  const text = redactSecrets(joined, secrets);
  return text.length > DETAIL_LIMIT ? text.slice(0, DETAIL_LIMIT) + '…' : text;
}

export interface RunMcpOptions {
  /** `undefined` = resolve from PATH; an explicit `null` = "there is no CLI",
   *  which is the seam `health.ts` already uses to test the miss */
  bin?: string | null;
  timeoutMs?: number;
  /** injected for the #127 reason — see `execSpec` */
  platform?: NodeJS.Platform;
  /**
   * Values the caller submitted that must not come back on screen.
   *
   * Passed IN rather than filtered out afterwards, so redaction happens before
   * the length bound — see `detailFrom` for the off-by-600 that made this a
   * parameter instead of a post-processing step in `ipc.ts`.
   */
  secrets?: readonly string[];
}

/**
 * Run one `claude mcp …` invocation in a folder.
 *
 * RESOLVES A VERDICT, NEVER REJECTS. Every caller is behind a button in a
 * modal, and an exception there is a button that does nothing and says nothing
 * — the failure mode `main/mcp/ipc.ts`'s header argues about at length.
 *
 * `folder` is the cwd and therefore decides which `.mcp.json` a project-scope
 * write lands in. It has already been through the §5.29 session-folder gate by
 * the time it reaches here; this function does not re-check, because a
 * duplicated gate is a gate that can drift out of agreement with itself.
 */
export function runMcp(
  folder: string,
  args: readonly string[],
  opts: RunMcpOptions = {}
): Promise<McpMutationResult> {
  return new Promise((resolve) => {
    const cli = opts.bin === undefined ? resolveCliPath() : opts.bin;
    if (!cli) return resolve({ ok: false, reason: 'no-cli' });

    // INSIDE THE TRY, and that is not tidiness. `execSpec` THROWS for an
    // argument it cannot deliver faithfully through cmd.exe — a control
    // character or a double quote (see `transport/win-cmd.ts`). Built outside,
    // that throw escapes the promise executor as a REJECTION, and this
    // function's whole contract is that it never has one.
    try {
      const spec = execSpec(cli, args, opts.platform);
      execFile(
        spec.file,
        spec.argv,
        {
          cwd: folder,
          encoding: 'utf8',
          timeout: opts.timeoutMs ?? MUTATION_TIMEOUT_MS,
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          maxBuffer: 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          // A KILLED PROCESS IS A TIMEOUT, not a refusal, and the two need
          // different sentences: "the CLI is not responding" is our problem to
          // report, while "already exists" is the user's to fix.
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          if (killed) return resolve({ ok: false, reason: 'timeout' });
          const detail = detailFrom(stdout ?? '', stderr ?? '', opts.secrets ?? []);
          // A non-zero exit with NOTHING to say is still a failure, and an empty
          // detail would render as a dialog with a blank body — so there has to
          // be a fallback.
          //
          // NOT `err.message`, WHICH IS A SECRET LEAK. Node builds it as
          // `Command failed: <the entire command line>` — which on Windows is
          // our escaped line, `-e API_KEY=…` and all. Worse, it is escaped, so
          // `ipc.ts`'s exact-substring `redactSecrets` cannot match it: a
          // credential containing any of `()%!^<>&|` arrives as
          // `p@ss^&word-123` and survives redaction verbatim. Measured in
          // review. The exit code says the same useful thing and cannot carry
          // an argument.
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve({
            ok: false,
            reason: 'cli-failed',
            detail: detail || `the claude command exited with ${String(code ?? 'an error')}`,
          });
        }
      );
    } catch (e) {
      // trap 3 — synchronous throw, before any callback exists
      resolve({ ok: false, reason: 'cli-failed', detail: String((e as Error)?.message ?? e) });
    }
  });
}
