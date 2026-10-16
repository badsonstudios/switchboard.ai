// Claude Code's `detect` capability (E40 item 08, #1291): is the CLI here,
// which version, and is it signed in — ALL answered by the CLI itself.
//
// THE CONTRACT, MEASURED on the PATH CLI 2.1.288 (2026-10-16), not guessed:
//   - `claude --version` prints `2.1.288 (Claude Code)`.
//   - `claude auth status --json` is a documented subcommand (`claude auth
//     --help`: "Show authentication status"; `--json` is the default). It
//     prints `{loggedIn, authMethod, apiProvider, …}`, plus `email` and
//     `subscriptionType` for a claude.ai login, and EXITS 1 when not logged in
//     (read off the binary: `mo(y?0:1)` after rendering the object).
// So login state is the CLI's own answer — no credential file of Claude's is
// opened, and nothing it prints is stored beyond this run's memory.
//
// Fail-open: anything unreadable is `unknown`, never a guess.
import type { AiLoginResult, DetectionResult } from '../../shared/ais';
import type { DetectCapability } from '../extensibility/contributions';
import { runCapture, type CaptureResult } from '../transport/run-capture';

type Detected = Omit<DetectionResult, 'probedAt' | 'ms'>;

/** `2.1.288 (Claude Code)` -> `2.1.288`; anything else as printed, trimmed. */
export function parseClaudeVersion(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!line) return undefined;
  const m = /^(\d+\.\d+\.\d+\S*)/.exec(line);
  return m ? m[1] : line.slice(0, 40);
}

/** `claude auth status --json`'s answer, read tolerantly. */
export function parseAuthStatus(r: CaptureResult): Pick<Detected, 'login' | 'account' | 'plan' | 'detail'> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const v: unknown = JSON.parse(r.stdout.trim());
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!parsed || typeof parsed.loggedIn !== 'boolean') {
    return { login: 'unknown', detail: r.error ? `auth status: ${r.error}` : 'auth status printed nothing readable' };
  }
  if (!parsed.loggedIn) return { login: 'logged-out' };
  return {
    login: 'logged-in',
    ...(typeof parsed.email === 'string' && parsed.email ? { account: parsed.email } : {}),
    ...(typeof parsed.subscriptionType === 'string' && parsed.subscriptionType
      ? { plan: parsed.subscriptionType }
      : {}),
  };
}

export interface ClaudeDetectDeps {
  /** the CLI's absolute path, re-scanned (installed since the last look must be seen) */
  resolve: () => string | null;
  run?: (file: string, args: string[], signal: AbortSignal) => Promise<CaptureResult>;
}

const realRun = (file: string, args: string[], signal: AbortSignal): Promise<CaptureResult> =>
  runCapture(file, args, { signal });

export function claudeDetect(deps: ClaudeDetectDeps): DetectCapability {
  const run = deps.run ?? realRun;
  return {
    async detect(signal: AbortSignal): Promise<Detected> {
      const cli = deps.resolve();
      if (!cli) return { installed: false, login: 'unknown' };
      // Concurrently: two short processes, and the runner's timeout is per AI.
      const [ver, auth] = await Promise.all([
        run(cli, ['--version'], signal),
        run(cli, ['auth', 'status', '--json'], signal),
      ]);
      const version = ver.code === 0 ? parseClaudeVersion(ver.stdout) : undefined;
      return { installed: true, ...(version ? { version } : {}), ...parseAuthStatus(auth) };
    },
    // `claude auth login` is interactive and opens the user's browser from a
    // terminal; hosting that is out of this item's scope.
    login(): Promise<AiLoginResult> {
      return Promise.resolve({
        supported: false,
        reason: 'Claude Code signs in from a terminal: run `claude auth login` there.',
      });
    },
  };
}
