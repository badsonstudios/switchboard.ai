// One-shot, CONTAINED `claude -p` runs (#758) — the seam #722 will share.
//
// ── WHY THIS MODULE IS ALLOWED TO EXIST AT ALL ─────────────────────────────
//
// `sessions/context-package.ts` records that a headless `claude -p` pass was
// considered and REJECTED for the neighbouring feature, citing #760: a `-p`
// probe in a temp cwd with `--permission-mode bypassPermissions` enumerated the
// machine's other live sessions, read the user's transcripts, and sent messages
// to six sessions across four unrelated projects. **A CWD IS NOT A SANDBOX**,
// and that finding names its own heirs — anything running a headless pass over
// a transcript inherits the question.
//
// This module is the answer, and the answer is the one the finding itself gives:
// *the real containment is not giving the turn a permission or a reason to act.*
// It is measured, not argued — `spike/findings/758-label-containment.md`,
// claude 2.1.272:
//
//   | run                                        | tools | MCP servers |
//   |--------------------------------------------|-------|-------------|
//   | control (no flags)                         |  33   | 1           |
//   | `--restricted` alone                       |  34   | 1           |
//   | `--strict-mcp-config` alone                |  33   | 0           |
//   | all three, as `CONTAINED_ARGS` below       |   0   | 0           |
//
// ⚠️ **`--restricted` ALONE WOULD HAVE REPRODUCED #760 ALMOST EXACTLY.** It
// removes the command runners (`Bash`, `PowerShell`, `Monitor`, `Workflow`,
// `CronCreate`, `RemoteTrigger`) and `WebFetch` — and LEAVES `Read`, `Glob`,
// `Grep` (read the user's transcripts) plus `SendMessage` and `ListAgents`
// (enumerate and message other sessions). The flag whose NAME sounds like
// containment is not the one that provides it. Every element of
// `CONTAINED_ARGS` is load-bearing and none substitutes for another.
//
// ── THE PROMPT GOES ON STDIN, AND THAT IS A CONTRACT ──────────────────────
//
// `resolveCliPath` returns **`claude.cmd`** on Windows, and argv bound for a
// `.cmd` goes through `execSpec`, which THROWS on a double quote and on control
// characters (#714). A transcript excerpt is made of both. Measured: `-p` with
// **no prompt argument reads the prompt from stdin**, through the shim as well
// as the exe (3.5–4.6 s, repeatable). So the argv here stays APP-AUTHORED —
// flags only — nothing untrusted ever meets cmd.exe's parser, and `execSpec`
// keeps its guard rather than being routed around. That is the whole
// proposition: #714's rule is never even approached.
//
// The `''` in `CONTAINED_ARGS` is an EMPTY ARGUMENT through that same shim, and
// it is not a leap of faith: `win-cmd.test.ts` builds a real `.cmd` and asserts
// `['a', '', 'b']` round-trips byte-exact. If it did not, the labeler would
// silently receive all 33 tools — the loudest possible silent failure.
import { ChildProcess, spawn } from 'child_process';
import { resolveCliPath } from './claude';
import { execSpec } from '../transport/win-cmd';
import { buildEnv } from '../transport/env';
import { killTree } from '../transport/kill-tree';
import type { Logger } from '../log/logger';

/**
 * The containment posture, as one list so no caller can assemble a weaker one.
 *
 * Exported because it is the CONTRACT, and because `claude-mcp.test.ts`'s source
 * guard exempts this file on the strength of it: the exemption is earned by what
 * is in this array, and a test asserts that rather than trusting the comment.
 *
 * `--permission-mode default` and not `bypassPermissions`: measured, the CLI
 * REFUSES the combination anyway (`--restricted` + bypass → exit 1,
 * "bypassPermissions not supported in restricted mode"), so asking for it would
 * turn every label run into an error. `default` is Manual mode's config value —
 * see `AUTONOMY_PERMISSION_MODE` for why that spelling and not `manual`.
 */
export const CONTAINED_ARGS: readonly string[] = [
  // no built-in tools AT ALL — this is the one that empties the list
  '--tools',
  '',
  // drops the code runners and WebFetch, ignores user/project/local settings
  // files, confines file tools to the cwd, and refuses bypassPermissions
  '--restricted',
  // …and none of the user's own MCP servers. No `--mcp-config` is passed, so
  // this leaves the turn with nothing — including no Session Bus.
  '--strict-mcp-config',
  '--permission-mode',
  'default',
];

/** Small model, because a six-word label does not need a large one. */
export const DEFAULT_ONESHOT_MODEL = 'haiku';

/**
 * Measured at ~14 s for a 24 KB excerpt and ~4 s for a small one, so this is
 * roughly 3× the observed worst case. A labeler that hangs must give up rather
 * than hold a slot for ever; `killTree` is what makes the giving-up real.
 */
export const DEFAULT_ONESHOT_TIMEOUT_MS = 45_000;

/**
 * Enough for any label and its preamble, and a bound on a model that will not
 * stop talking. Not a failure: the label comes off the FIRST LINE anyway
 * (`sessions/ai-label.ts`), so a capped buffer still contains the answer.
 */
export const MAX_ONESHOT_OUTPUT = 64 * 1024;

export type OneShotFailure =
  /** no `claude` on PATH — the app's normal "not installed" state, not an error */
  | 'no-cli'
  /** our deadline fired and the tree was killed */
  | 'timeout'
  /** the child never started, or `execSpec` refused the argv */
  | 'spawn-failed'
  /** the CLI ran and exited non-zero (a bad model name, a rate limit) */
  | 'cli-failed';

export type OneShotResult =
  | { ok: true; text: string; ms: number; truncated: boolean }
  | { ok: false; failure: OneShotFailure; ms: number; detail?: string };

export interface OneShotRequest {
  /** the whole prompt. Goes on STDIN and is NEVER an argument. */
  prompt: string;
  /**
   * Where to run. `--restricted` confines the file tools to it — but the #760
   * lesson is that this is a convenience, not the containment. The containment
   * is that there are no tools.
   */
  cwd: string;
  model?: string;
  timeoutMs?: number;
}

export interface OneShotDeps {
  log: Logger;
}

/**
 * Run one contained prompt and hand back what the CLI said.
 *
 * **NEVER REJECTS.** Every outcome is a resolved value, which is the same
 * discipline `mcp/cli.ts` and `mcp/health.ts` use and the reason fail-open (P6)
 * is structural here rather than a promise: the caller is a label refresher, and
 * a label that failed to arrive must cost the session nothing at all.
 */
export function runContainedPrompt(
  req: OneShotRequest,
  deps: OneShotDeps
): Promise<OneShotResult> {
  const started = Date.now();
  const ms = (): number => Date.now() - started;

  const cli = resolveCliPath();
  if (!cli) {
    // Not a warning: a machine without the CLI is a machine where this feature
    // is simply unavailable, and the app says so elsewhere (`preflight.ts`).
    deps.log.debug('one-shot skipped: no claude on PATH');
    return Promise.resolve({ ok: false, failure: 'no-cli', ms: ms() });
  }

  const args = [...CONTAINED_ARGS, '--model', req.model ?? DEFAULT_ONESHOT_MODEL, '-p'];

  return new Promise<OneShotResult>((resolve) => {
    let spec: ReturnType<typeof execSpec>;
    try {
      // App-authored argv only. If a future edit ever puts the excerpt in here,
      // `execSpec` throws and this becomes a refusal instead of a shell
      // injection — which is why the call is guarded rather than trusted.
      spec = execSpec(cli, args);
    } catch (err) {
      deps.log.warn('one-shot argv refused', { error: String(err) });
      resolve({ ok: false, failure: 'spawn-failed', ms: ms(), detail: String(err) });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.file, spec.argv, {
        cwd: req.cwd,
        env: buildEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      // `spawn` reports some failures as an 'error' event and THROWS others
      // (ENOMEM and friends) — the same asymmetry `killTree` documents.
      deps.log.warn('one-shot spawn threw', { error: String(err) });
      resolve({ ok: false, failure: 'spawn-failed', ms: ms(), detail: String(err) });
      return;
    }

    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: OneShotResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on('data', (d: Buffer | string) => {
      if (out.length >= MAX_ONESHOT_OUTPUT) {
        truncated = true;
        return;
      }
      out += String(d);
      if (out.length > MAX_ONESHOT_OUTPUT) {
        out = out.slice(0, MAX_ONESHOT_OUTPUT);
        truncated = true;
      }
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      if (err.length < 4_096) err += String(d);
    });

    // OUR timer, not `execFile`'s — and `killTree` rather than `kill()`, because
    // through the `.cmd` shim the process we hold is cmd.exe and the 230 MB
    // `claude.exe` is its child. Killing the shim alone would leave a model call
    // running with nobody waiting for it. Proven abandonable: a 1,500 ms
    // deadline ended a live turn at 1,534 ms.
    const timeoutMs = req.timeoutMs ?? DEFAULT_ONESHOT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killTree(child);
        deps.log.warn('one-shot timed out', { timeoutMs });
        finish({ ok: false, failure: 'timeout', ms: ms() });
      }, timeoutMs);
    }

    child.on('error', (e) => {
      deps.log.warn('one-shot failed to start', { error: String(e) });
      finish({ ok: false, failure: 'spawn-failed', ms: ms(), detail: String(e) });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, text: out, ms: ms(), truncated });
        return;
      }
      // A bad model name exits 1 in ~1.6 s; a rate limit lands here too. One
      // line at warn, not per-attempt noise — the caller's own debounce is what
      // stops this repeating.
      deps.log.warn('one-shot exited non-zero', { code, stderr: err.slice(-300) });
      finish({ ok: false, failure: 'cli-failed', ms: ms(), detail: err.slice(-300) });
    });

    // THE PROMPT, on stdin, never as an argument. `end()` closes the pipe, which
    // is what tells `-p` the prompt is complete.
    child.stdin?.on('error', () => {
      /* the CLI may close stdin first; `close` carries the verdict */
    });
    child.stdin?.end(req.prompt);
  });
}
