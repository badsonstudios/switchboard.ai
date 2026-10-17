// Is Codex here, which version, and is it logged in? (E40 item 07, #1290.)
//
// PLAIN FUNCTIONS, NOT A CAPABILITY. The detection capability and the startup
// runner that calls these are #1291's (the AI catalog); this module only knows
// how to ask Codex. Each answer is cheap, bounded and fail-open: a probe that
// hangs or fails answers `null` / `'unknown'`, never throws.
//
// What each one costs, measured (`spike/findings/e40-codex-acp.md`, #1290
// addendum):
//   - `codexInstalled` / `npxPath`: a PATH scan, no child process;
//   - `codexVersion`: `codex --version` → `codex-cli 0.163.0`;
//   - `codexLoginState`: one `codex app-server` `account/read`, zero tokens,
//     ~1.6 s logged in. Logged in → `{"account":{"type":"chatgpt",
//     "planType":"team",…}}`; logged out → `{"account":null,
//     "requiresOpenaiAuth":true}`.
//
// The login itself is never ours: nothing here reads a credential or Codex's
// config files, and nothing signs in or out.
import { execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildEnv } from '../../transport/env';
import { killTree } from '../../transport/kill-tree';
import { launchSpec } from '../../transport/stream-service';
import { askAppServer, type AppServerAnswer } from './codex-app-server';

/** First match for any of `names` in a PATH-style string, or null. */
export function findOnPath(names: readonly string[], envPath: string): string | null {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** The `codex` CLI's absolute path, or null when it is not on PATH. */
export function codexInstalled(
  envPath: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform
): string | null {
  return findOnPath(platform === 'win32' ? ['codex.cmd', 'codex.exe'] : ['codex'], envPath);
}

/**
 * `npx`'s absolute path, or null. What the Codex provider runs: the pinned ACP
 * adapter installs itself through it on first use, so this — not the `codex`
 * CLI — is what decides whether a Codex session can be started at all.
 */
export function npxPath(
  envPath: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform
): string | null {
  return findOnPath(platform === 'win32' ? ['npx.cmd'] : ['npx'], envPath);
}

export const DETECT_TIMEOUT_MS = 10_000;

/** Runs a program to completion; resolves its stdout, or null on any failure. */
export type RunForOutput = (
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<string | null>;

const runForOutput: RunForOutput = (command, args, timeoutMs, signal) =>
  new Promise((resolve) => {
    // `launchSpec`: a `.cmd` shim goes through `cmd.exe /c` (app-authored argv
    // only — the path is our PATH scan's, the argument is a literal).
    const { file, argv } = launchSpec(command, args);
    let settled = false;
    const settle = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    // Our own deadline rather than execFile's `timeout`: that one kills only
    // `cmd.exe` on Windows and would leave a hung `codex` behind it. The tree
    // kill takes both.
    const timer = setTimeout(() => {
      if (child) killTree(child);
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    // the caller's deadline (the detection runner's) kills the tree too
    const onAbort = (): void => {
      if (child) killTree(child);
      settle(null);
    };
    let child: ChildProcess | undefined;
    if (signal?.aborted) {
      settle(null);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = execFile(
        file,
        argv,
        { windowsHide: true, env: buildEnv(process.env), maxBuffer: 64 * 1024 },
        (err, stdout) => settle(err ? null : String(stdout))
      );
    } catch {
      settle(null);
    }
  });

/** `codex --version` → `0.163.0`, or null (not installed, failed, timed out, unreadable). */
export async function codexVersion(
  cliPath: string | null = codexInstalled(),
  run: RunForOutput = runForOutput,
  signal?: AbortSignal
): Promise<string | null> {
  if (!cliPath) return null;
  try {
    const out = await run(cliPath, ['--version'], DETECT_TIMEOUT_MS, signal);
    const m = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(out ?? '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export type CodexLoginState = 'logged-in' | 'logged-out' | 'unknown';

export interface CodexLogin {
  state: CodexLoginState;
  /** Codex's own plan name (`planType`, e.g. `team`), when it gives one */
  plan?: string;
}

/** Read an `account/read` answer. Anything that is not one of the measured shapes is `unknown`. */
export function parseAccount(answer: AppServerAnswer): CodexLogin {
  if (!answer.ok) return { state: 'unknown' };
  const account = answer.result.account;
  if (account === null) return { state: 'logged-out' };
  if (typeof account === 'object' && account !== null && !Array.isArray(account)) {
    const a = account as Record<string, unknown>;
    if (typeof a.type !== 'string' || !a.type) return { state: 'unknown' };
    const plan = typeof a.planType === 'string' && a.planType ? a.planType.slice(0, 40) : undefined;
    return { state: 'logged-in', ...(plan ? { plan } : {}) };
  }
  return { state: 'unknown' };
}

/** Logged in, logged out, or unknown (not installed, slow, or an answer we do not know). */
export async function codexLoginState(
  cliPath: string | null = codexInstalled(),
  ask: (cli: string, signal?: AbortSignal) => Promise<AppServerAnswer> = (cli, signal) =>
    askAppServer(cli, 'account/read', { refreshToken: false }, { deadlineMs: DETECT_TIMEOUT_MS, signal }),
  signal?: AbortSignal
): Promise<CodexLogin> {
  if (!cliPath) return { state: 'unknown' };
  try {
    return parseAccount(await ask(cliPath, signal));
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * One detection answer for Codex, in the shape #1291's `DetectCapability.detect`
 * returns (`shared/ais.ts` `DetectionResult` minus `probedAt` / `ms`), declared
 * structurally so this module does not depend on the catalog.
 */
export interface CodexDetection {
  installed: boolean | 'unknown';
  version?: string;
  login: CodexLoginState;
  plan?: string;
  detail?: string;
}

export interface DetectCodexDeps {
  cliPath?: () => string | null;
  version?: (cli: string, signal: AbortSignal) => Promise<string | null>;
  login?: (cli: string, signal: AbortSignal) => Promise<CodexLogin>;
}

/**
 * Is Codex installed, which version, and is it logged in? INSTALLED MEANS THE
 * `codex` CLI, not `npx`: the adapter could run through npx alone, but an AI
 * the user never installed (or signed in to) must not read as "found". Honours
 * `signal` (the runner's deadline): both probes are killed and the answer is
 * `unknown`. Never rejects.
 */
export async function detectCodex(signal: AbortSignal, deps: DetectCodexDeps = {}): Promise<CodexDetection> {
  try {
    const cli = (deps.cliPath ?? (() => codexInstalled()))();
    if (!cli) return { installed: false, login: 'unknown', detail: 'the codex CLI is not on PATH' };
    const [version, login] = await Promise.all([
      (deps.version ?? ((c, s) => codexVersion(c, runForOutput, s)))(cli, signal).catch(() => null),
      (deps.login ?? ((c, s) => codexLoginState(c, undefined, s)))(cli, signal).catch(
        (): CodexLogin => ({ state: 'unknown' })
      ),
    ]);
    if (signal.aborted) {
      return { installed: true, login: 'unknown', detail: 'Codex did not answer in time' };
    }
    return {
      installed: true,
      login: login.state,
      ...(version ? { version } : {}),
      ...(login.plan ? { plan: login.plan } : {}),
      ...(login.state === 'unknown' ? { detail: 'Codex did not say whether it is signed in' } : {}),
    };
  } catch {
    return { installed: 'unknown', login: 'unknown', detail: 'the Codex check failed' };
  }
}
