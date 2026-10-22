// Detection: for each AI, is it installed, which version, is it signed in
// (E40 item 08, #1291; design record §6: "Detection never blocks startup").
//
// THE RULES, each tested:
//   - every probe runs under a HARD timeout; at the deadline the probe's
//     signal is aborted (so it can kill what it started) and the answer is
//     `unknown`, whether or not the probe ever settles;
//   - a probe that throws, rejects or answers nonsense is `unknown`, with the
//     reason in `detail` — never a crash, never a guess;
//   - all probes run CONCURRENTLY, so one slow AI costs one timeout, not N;
//   - a run that is already in flight is SHARED: "Look again" pressed twice,
//     or pressed during the startup run, does not start a second set.
//
// The runner is started by `index.ts` after the main window's first paint
// (`ready-to-show` -> `show()`), never before.
import type { DetectionResult, LoginState } from '../../shared/ais';
import { errorText } from '../../shared/error-text';
import { aiReason, aiReasonKey, type AiReason } from '../../shared/ai-reason';
import { findOnPath } from '../transport/find-on-path';

/** Per-probe deadline. A slow probe answers "unknown"; "Look again" retries. */
export const DETECTION_TIMEOUT_MS = 5_000;

export type DetectAnswer = Omit<DetectionResult, 'probedAt' | 'ms'>;
export type Probe = (signal: AbortSignal) => Promise<DetectAnswer>;

const LOGINS: readonly LoginState[] = ['logged-in', 'logged-out', 'unknown'];

/** Whatever a probe resolved with, as a DetectionResult — or null when it is not one. */
export function normalizeAnswer(v: unknown): DetectAnswer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const installed = o.installed;
  if (installed !== true && installed !== false && installed !== 'unknown') return null;
  const login = LOGINS.includes(o.login as LoginState) ? (o.login as LoginState) : 'unknown';
  const str = (k: string): string | undefined =>
    typeof o[k] === 'string' && (o[k]).trim() ? (o[k]).trim().slice(0, 200) : undefined;
  const version = str('version');
  const account = str('account');
  const plan = str('plan');
  const detail = str('detail');
  // a code is passed through only with its English beside it, and only if it
  // is one the renderer can read (#1365)
  const detailCode = detail && aiReasonKey(o.detailCode) ? (o.detailCode as AiReason) : undefined;
  return {
    installed,
    login,
    ...(version ? { version } : {}),
    ...(account ? { account } : {}),
    ...(plan ? { plan } : {}),
    ...(detail ? { detail } : {}),
    ...(detailCode ? { detailCode } : {}),
  };
}

/** A probe that threw: its own words, under "the check failed". */
function checkFailed(err: unknown): DetectAnswer {
  return {
    installed: 'unknown',
    login: 'unknown',
    detail: `the check failed: ${errorText(err)}`,
    detailCode: aiReason('check-failed', { message: errorText(err) }),
  };
}

/**
 * Run one probe under `timeoutMs`. Never rejects, and settles by the deadline
 * — or at once when `cancel` fires (app quit), aborting the probe either way
 * so it kills what it started.
 */
export function runProbe(
  probe: Probe,
  timeoutMs: number = DETECTION_TIMEOUT_MS,
  now: () => number = Date.now,
  cancel?: AbortSignal
): Promise<DetectionResult> {
  const started = now();
  const controller = new AbortController();
  return new Promise<DetectionResult>((resolve) => {
    let settled = false;
    const done = (a: DetectAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
      const end = now();
      resolve({ ...a, probedAt: end, ms: end - started });
    };
    const timer = setTimeout(() => {
      controller.abort();
      done({
        installed: 'unknown',
        login: 'unknown',
        detail: `the check did not answer within ${Math.round(timeoutMs / 1000)} s`,
        detailCode: aiReason('check-timed-out', { seconds: Math.round(timeoutMs / 1000) }),
      });
    }, timeoutMs);
    const onCancel = (): void => {
      controller.abort();
      done({ installed: 'unknown', login: 'unknown', detail: 'the check was cancelled', detailCode: aiReason('check-cancelled') });
    };
    if (cancel?.aborted) {
      onCancel();
      return;
    }
    cancel?.addEventListener('abort', onCancel, { once: true });
    let pending: Promise<DetectAnswer>;
    try {
      pending = probe(controller.signal);
    } catch (err) {
      done(checkFailed(err));
      return;
    }
    Promise.resolve(pending).then(
      (v) =>
        done(
          normalizeAnswer(v) ?? {
            installed: 'unknown',
            login: 'unknown',
            detail: 'the check answered something unreadable',
            detailCode: aiReason('check-unreadable'),
          }
        ),
      (err: unknown) => done(checkFailed(err))
    );
  });
}

/**
 * The fallback probe: is `command` on PATH. Reads directories; starts nothing.
 * `find` is normally one run's shared `pathIndex` lookup (`service.ts`), so
 * fifteen probes cost one asynchronous pass over PATH, not thousands of
 * synchronous stats on the main thread.
 */
export function pathProbe(
  command: string,
  find: (c: string) => string | null | Promise<string | null> = (c) => findOnPath(c)
): Probe {
  return async () => ({ installed: (await find(command)) !== null, login: 'unknown' });
}

export interface DetectionTarget {
  /** the list item id the answer belongs to */
  id: string;
  probe: Probe;
}

export interface DetectionRunnerOptions {
  /** what to probe, asked afresh at every run (custom AIs come and go) */
  targets: () => DetectionTarget[];
  timeoutMs?: number;
  log?: (msg: string, data: Record<string, unknown>) => void;
  /** a run finished; the results are already stored */
  onDone?: () => void;
  now?: () => number;
}

export class DetectionRunner {
  private readonly stored = new Map<string, DetectionResult>();
  private inFlight: Promise<void> | null = null;
  /** aborts every probe of the run in flight (app quit) */
  private cancel: AbortController | null = null;
  private disposed = false;

  constructor(private readonly opts: DetectionRunnerOptions) {}

  /** The latest answer per id. */
  result(id: string): DetectionResult | undefined {
    return this.stored.get(id);
  }

  /** Store an answer produced elsewhere (a narrower run for one AI) — unless a newer one is already here. */
  adopt(id: string, r: DetectionResult): void {
    const have = this.stored.get(id);
    if (have && have.probedAt > r.probedAt) return;
    this.stored.set(id, r);
  }

  /** App quit: end the run in flight now (its probes kill what they started), and start no more. */
  abort(): void {
    this.disposed = true;
    this.cancel?.abort();
  }

  /** Drop an AI's answer (it was removed). */
  forget(id: string): void {
    this.stored.delete(id);
  }

  get running(): boolean {
    return this.inFlight !== null;
  }

  /** Probe everything, concurrently. Shared while one is in flight. Never rejects. */
  run(reason: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve();
    const now = this.opts.now ?? Date.now;
    const timeoutMs = this.opts.timeoutMs ?? DETECTION_TIMEOUT_MS;
    const started = now();
    const cancel = new AbortController();
    this.cancel = cancel;
    const work = (async (): Promise<void> => {
      let targets: DetectionTarget[] = [];
      try {
        targets = this.opts.targets();
      } catch (err) {
        this.opts.log?.('AI detection could not list what to check', { error: errorText(err) });
      }
      const answers = await Promise.all(
        targets.map(async (t) => [t.id, await runProbe(t.probe, timeoutMs, now, cancel.signal)] as const)
      );
      // Newer wins: a one-AI re-check (after a sign-in) that finished while
      // this run was still going is not overwritten by this run's older answer.
      for (const [id, r] of answers) this.adopt(id, r);
      this.opts.log?.('AI detection finished', {
        reason,
        ms: now() - started,
        checked: answers.length,
        installed: answers.filter(([, r]) => r.installed === true).map(([id]) => id),
        unknown: answers.filter(([, r]) => r.installed === 'unknown').map(([id, r]) => ({ id, detail: r.detail })),
      });
    })();
    this.inFlight = work.finally(() => {
      this.inFlight = null;
      this.cancel = null;
      try {
        this.opts.onDone?.();
      } catch {
        /* the listener's problem */
      }
    });
    return this.inFlight;
  }
}
