// Codex's plan limits — the 5-hour and weekly windows (E40 item 07, #1290).
//
// WHY A SEPARATE READER. Over ACP, Codex's limits reach a client only as
// markdown inside the `/status` reply (#1285 Q6). The same numbers come
// STRUCTURED, with no model turn and no session, from one
// `account/rateLimits/read` to `codex app-server` — the protocol the ACP
// adapter itself is a client of. So this is a reader beside the engine, not a
// second engine. Measured shape (`d-app-server.jsonl`):
//
//   {"rateLimits":{"limitId":"codex",
//     "primary":  {"usedPercent":3,"windowDurationMins":300,  "resetsAt":1792178362},
//     "secondary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1792765162}, …}, …}
//
// `primary` is the 5-hour window, `secondary` the weekly; `resetsAt` is epoch
// SECONDS. Logged out it answers -32600 "codex account authentication required
// to read rate limits" (#1290 addendum) — no windows, which is what is shown.
//
// THE RULES: fail-open (any failure is `undefined`, never a throw, never a
// made-up 0%), at most ONE read in flight (callers share it), and a short cache
// so a burst of turn ends costs one child process, not one each.
import { errorText } from '../../../shared/error-text';
import type { PlanLimitWindow } from '../../../shared/usage-report';
import type { AppServerAnswer } from './codex-app-server';
import { askAppServer } from './codex-app-server';
import { codexInstalled } from './codex-detect';

/** One window: `shared/usage-report.ts` `PlanLimitWindow` (#1288). */
export type CodexLimitWindow = PlanLimitWindow;

/** How long a read is reused. Long enough to absorb a burst, short enough to move. */
export const LIMITS_TTL_MS = 60_000;

const WINDOW_KEYS = ['primary', 'secondary'] as const;

/** "5-hour limit", "Weekly limit" — the status-bar line reads "<label>: 9% used". From the window's length, which is all Codex names it by. */
export function windowLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (minutes === 10_080) return 'Weekly limit';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/**
 * The windows in an `account/rateLimits/read` result, read tolerantly: a window
 * without a usable percentage is dropped rather than drawn as 0% (which would
 * claim headroom nobody reported). `undefined` when nothing usable was there.
 */
export function parseRateLimits(result: unknown): CodexLimitWindow[] | undefined {
  const limits = obj(obj(result)?.rateLimits);
  if (!limits) return undefined;
  const out: CodexLimitWindow[] = [];
  for (const key of WINDOW_KEYS) {
    const w = obj(limits[key]);
    if (!w) continue;
    const pct = w.usedPercent;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;
    const mins = w.windowDurationMins;
    const windowMinutes = typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? mins : undefined;
    const reset = w.resetsAt;
    const resetsAt =
      typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    const label = windowLabel(windowMinutes);
    out.push({
      id: key,
      usedPercent: Math.min(100, Math.max(0, pct)),
      ...(label ? { label } : {}),
      ...(windowMinutes ? { windowMinutes } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return out.length ? out : undefined;
}

export interface LimitsReaderDeps {
  /** the `codex` CLI, or null when it is not installed */
  cliPath?: () => string | null;
  ask?: (cliPath: string) => Promise<AppServerAnswer>;
  now?: () => number;
  ttlMs?: number;
  log?: (msg: string) => void;
}

/**
 * A reader: call it as often as you like; it reads at most once per TTL and
 * never twice at once. Resolves `undefined` whenever there is nothing to show.
 */
export function createLimitsReader(deps: LimitsReaderDeps = {}): () => Promise<CodexLimitWindow[] | undefined> {
  const cliPath = deps.cliPath ?? (() => codexInstalled());
  const ask = deps.ask ?? ((cli: string) => askAppServer(cli, 'account/rateLimits/read', undefined));
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? LIMITS_TTL_MS;
  let cached: { at: number; value: CodexLimitWindow[] | undefined } | undefined;
  let inFlight: Promise<CodexLimitWindow[] | undefined> | undefined;

  return () => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    const read = (async () => {
      let value: CodexLimitWindow[] | undefined;
      try {
        const cli = cliPath();
        if (cli) {
          const answer = await ask(cli);
          if (answer.ok) value = parseRateLimits(answer.result);
          else deps.log?.(`codex limits not read: ${answer.reason}`);
        }
      } catch (err) {
        deps.log?.(`codex limits not read: ${errorText(err)}`);
        value = undefined;
      }
      // a failure is cached too: a logged-out or missing Codex is not asked
      // again on every turn end
      cached = { at: now(), value };
      return value;
    })();
    // Cleared AFTER the read settles, and only if it is still this read. A
    // read that never awaits (no CLI) runs to the end before `read` is even
    // assigned, so clearing from inside would leave a settled promise in the
    // slot for ever — and every later call, past the cache, would get it.
    inFlight = read;
    void read.finally(() => {
      if (inFlight === read) inFlight = undefined;
    });
    return read;
  };
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
