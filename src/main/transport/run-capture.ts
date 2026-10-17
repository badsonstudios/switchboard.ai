// Run a short command, capture what it prints, and be able to abandon it
// (E40 item 08, #1291) — the shape detection needs: `claude --version`,
// `claude auth status`, and whatever a future provider's probe asks.
//
// NEVER REJECTS, for the reason `providers/claude-oneshot.ts` gives: the
// caller is a startup probe, and a probe that failed must cost the app
// nothing. `execSpec` builds the line (it throws on an argument cmd.exe could
// misread, which lands here as a failed result), and abandoning goes through
// `killTree`, because through a `.cmd` shim the process we hold is cmd.exe and
// the real program is its child.
import { spawn, type ChildProcess } from 'child_process';
import { errorText } from '../../shared/error-text';
import { trackChild } from '../diagnostics/live-children';
import { buildEnv } from './env';
import { killTree } from './kill-tree';
import { execSpec } from './win-cmd';

export interface CaptureResult {
  /** the exit code, or null when it never exited on its own (spawn failed, aborted) */
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn failure, argv refusal, or "aborted" */
  error?: string;
}

const MAX_OUTPUT = 64 * 1024;

export function runCapture(
  file: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; env?: Record<string, string | undefined>; cwd?: string } = {}
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', error: 'aborted' });
      return;
    }
    let spec: ReturnType<typeof execSpec>;
    let child: ChildProcess;
    try {
      spec = execSpec(file, args);
      child = spawn(spec.file, spec.argv, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: buildEnv(process.env, opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: errorText(err) });
      return;
    }
    trackChild('oneshot', child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: CaptureResult): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => {
      if (child.exitCode === null && child.signalCode === null) killTree(child);
      finish({ code: null, stdout, stderr, error: 'aborted' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout = (stdout + d).slice(0, MAX_OUTPUT);
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < 4096) stderr = (stderr + d).slice(0, 4096);
    });
    child.on('error', (e) => finish({ code: null, stdout, stderr, error: errorText(e) }));
    child.on('close', (code) => finish({ code: code ?? null, stdout, stderr }));
  });
}
