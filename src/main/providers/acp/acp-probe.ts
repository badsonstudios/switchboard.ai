// Start an ACP agent ON ITS OWN — no session, no card — say `initialize`, and
// optionally run its own `authenticate` (E40 item 08, #1291).
//
// Two callers, both user-pressed:
//   - "Test" on a "Something else" entry: does this command speak ACP, and
//     what did it say about itself?
//   - "Log in" on an ACP AI: the AI's OWN sign-in method, run without a
//     prompt. Whatever it does (Codex's opens the browser) is the AI's; we
//     never see a password and store nothing.
//
// Here and not in `ai-catalog/` because it speaks the wire, and only
// `src/main/providers/` may (`sessions/engine-seam.test.ts`).
//
// NEVER LEAVES A PROCESS BEHIND. Every exit path — answer, error, timeout,
// abort, a child that died on its own — goes through `finish`, which ends
// stdin, tree-kills whatever is still running (through a `.cmd` shim the child
// we hold is cmd.exe and the agent is ITS child), and resolves only once the
// kill has been carried out. NEVER REJECTS.
import { spawn, type ChildProcess } from 'child_process';
import { errorText } from '../../../shared/error-text';
import { trackChild } from '../../diagnostics/live-children';
import { buildEnv } from '../../transport/env';
import { findOnPath } from '../../transport/find-on-path';
import { killTree } from '../../transport/kill-tree';
import { NdjsonDecoder, encodeFrame } from '../../transport/ndjson';
import { execSpec } from '../../transport/win-cmd';
import { classify, errorResponse, initializeParams, METHOD_NOT_FOUND, readInitialize, request } from './acp-protocol';

/** How long "Test" waits for `initialize`. npx may be fetching the package. */
export const PROBE_TIMEOUT_MS = 30_000;
/** How long "Log in" waits for the AI's own sign-in (a browser round trip). */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface AcpProbeRequest {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  clientVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** run `authenticate` after `initialize` */
  authenticate?: { methodId?: string };
  /** test seam: what `command` resolves to */
  resolve?: (command: string) => string | null;
}

export interface AcpProbeResult {
  ok: boolean;
  agentName?: string;
  agentVersion?: string;
  protocolVersion?: number;
  authMethods?: string[];
  /** the agent's own label for each method, by id, where it gave one */
  authMethodNames?: Record<string, string>;
  /** set when `authenticate` was asked for: which method ran */
  authMethod?: string;
  /** `authenticate` was asked for, but the agent offers several and none was named */
  needsMethod?: boolean;
  error?: string;
  ms: number;
  /** the pid that was started, for a test to prove it is gone */
  pid?: number;
}

const INIT_ID = 0;
const AUTH_ID = 1;

export function probeAcpAgent(req: AcpProbeRequest): Promise<AcpProbeResult> {
  const started = Date.now();
  const ms = (): number => Date.now() - started;
  return new Promise<AcpProbeResult>((resolve) => {
    const resolved = (req.resolve ?? ((c) => findOnPath(c)))(req.command);
    if (!resolved) {
      resolve({ ok: false, error: `"${req.command}" was not found on this computer`, ms: ms() });
      return;
    }
    if (req.signal?.aborted) {
      resolve({ ok: false, error: 'cancelled', ms: ms() });
      return;
    }
    let child: ChildProcess;
    try {
      const spec = execSpec(resolved, req.args);
      child = spawn(spec.file, spec.argv, {
        env: buildEnv(process.env, req.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({ ok: false, error: `could not start it: ${errorText(err)}`, ms: ms() });
      return;
    }
    trackChild('oneshot', child);

    let settled = false;
    let stderr = '';
    let info: ReturnType<typeof readInitialize> | undefined;
    /** the sign-in method `authenticate` was sent with */
    let chosen: string | undefined;
    const timeoutMs = req.timeoutMs ?? (req.authenticate ? LOGIN_TIMEOUT_MS : PROBE_TIMEOUT_MS);

    const describe = (): Omit<AcpProbeResult, 'ok' | 'ms'> => ({
      ...(info?.name ? { agentName: info.name } : {}),
      ...(info?.version ? { agentVersion: info.version } : {}),
      ...(info?.protocolVersion !== undefined ? { protocolVersion: info.protocolVersion } : {}),
      ...(info ? { authMethods: info.authMethods } : {}),
      ...(info && Object.keys(info.authMethodNames).length > 0 ? { authMethodNames: info.authMethodNames } : {}),
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
    });

    const finish = (r: Omit<AcpProbeResult, 'ms'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      try {
        child.stdin?.end();
      } catch {
        /* already gone */
      }
      const done = (): void => resolve({ ...r, ms: ms() });
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      // Resolve when the kill is DONE, so "Test finished" means "nothing is
      // left running" — with a cap, because a kill that never reports must
      // not hang the button.
      const cap = setTimeout(done, 5_000);
      killTree(child, () => {
        clearTimeout(cap);
        done();
      });
    };

    const timer = setTimeout(
      () => finish({ ok: false, ...describe(), error: `it did not answer within ${Math.round(timeoutMs / 1000)} s` }),
      timeoutMs
    );
    const onAbort = (): void => finish({ ok: false, ...describe(), error: 'cancelled' });
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const send = (frame: Record<string, unknown>): void => {
      try {
        child.stdin?.write(encodeFrame(frame));
      } catch {
        /* the exit handler reports it */
      }
    };

    const decoder = new NdjsonDecoder<unknown>();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdin?.on('error', () => {
      /* a dead child's pipe: the exit handler reports it */
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < 4096) stderr = (stderr + d).slice(0, 4096);
    });
    child.stdout?.on('data', (chunk: string) => {
      for (const f of decoder.push(chunk)) {
        if (!f.ok) continue; // a log line on stdout: skipped, as the engine does
        const m = classify(f.value);
        if (m.kind === 'request') {
          // v1 offers the agent nothing it can call back (design §4 decision 1)
          send(errorResponse(m.id, METHOD_NOT_FOUND, `method not found: ${m.method}`));
          continue;
        }
        if (m.kind !== 'response' && m.kind !== 'error') continue;
        if (m.id === INIT_ID) {
          if (m.kind === 'error') {
            finish({ ok: false, error: `it refused initialize: ${m.message}` });
            continue;
          }
          info = readInitialize(m.result);
          if (!req.authenticate) {
            finish({ ok: true, ...describe() });
            continue;
          }
          const methods = info.authMethods;
          const wanted = req.authenticate.methodId;
          const method = wanted && methods.includes(wanted) ? wanted : !wanted && methods.length === 1 ? methods[0] : undefined;
          if (!method) {
            finish({
              ok: false,
              ...describe(),
              ...(methods.length > 1 && !wanted ? { needsMethod: true } : {}),
              error: methods.length === 0
                ? 'it offers no sign-in method; it may sign in on its own the first time a session starts'
                : wanted
                  ? `it does not offer the sign-in method "${wanted}"`
                  : 'it offers more than one sign-in method; choose one',
            });
            continue;
          }
          chosen = method;
          send(request(AUTH_ID, 'authenticate', { methodId: method }));
          continue;
        }
        if (m.id === AUTH_ID) {
          finish(
            m.kind === 'error'
              ? { ok: false, ...describe(), ...(chosen ? { authMethod: chosen } : {}), error: `sign-in failed: ${m.message}` }
              : { ok: true, ...describe(), ...(chosen ? { authMethod: chosen } : {}) }
          );
        }
      }
    });
    child.on('error', (e) => finish({ ok: false, ...describe(), error: `could not start it: ${errorText(e)}` }));
    // 'close', not 'exit': 'exit' can fire before stdout's last chunk is
    // delivered, and an agent that answers and exits at once would read as one
    // that exited before answering.
    child.on('close', (code) => {
      const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
      finish({
        ok: false,
        ...describe(),
        error: `it exited (code ${code ?? '?'}) before answering${tail ? `: ${tail}` : ''}`,
      });
    });

    send(request(INIT_ID, 'initialize', initializeParams(req.clientVersion ?? '0.0.0')));
  });
}
