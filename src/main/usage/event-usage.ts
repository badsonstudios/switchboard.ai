// Usage for an AI that reports it per turn instead of writing a transcript we
// can read (#1288). The consumer of the neutral `usage` event (#1286).
//
// ONE USAGE PATH PER PROVIDER. A provider that declares `transcripts` is
// counted by the transcript ledger (`transcripts/usage-ledger.ts`) and its
// usage events, if it sends any, are not added here — the caller checks, so
// the same tokens are never counted twice. Claude's translator sends none.
//
// What is kept per session: the running token totals (each event is one turn's
// delta), the last model named, and the latest plan-limit windows (account-wide
// and not a delta, so the latest report replaces the last). Nothing is
// persisted: a relaunch starts the count again, which is the honest answer
// for an AI whose only record of past turns is its own.
import type { PlanLimitWindow, UsageTokens } from '../../shared/usage-report';
import type { UsageEvent } from '../sessions/engine-events';

export interface EventUsage {
  usage: Required<UsageTokens>;
  model?: string;
  limits?: PlanLimitWindow[];
}

/** More windows than this is not a plan; it is a report we should not draw. */
const MAX_WINDOWS = 8;
const MAX_TEXT = 80;

/** A token count we will add: finite and not negative. Anything else adds 0. */
function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : undefined;
}

/**
 * The windows, read tolerantly: a window without an id or a usable percentage
 * is dropped rather than drawn as 0%, which would claim headroom nobody
 * reported. `undefined` when nothing usable was there.
 */
export function readLimits(v: unknown): PlanLimitWindow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PlanLimitWindow[] = [];
  for (const raw of v as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    const id = text(w.id);
    const pct = w.usedPercent;
    if (!id || typeof pct !== 'number' || !Number.isFinite(pct)) continue;
    const label = text(w.label);
    const resetsAt = text(w.resetsAt);
    const mins = w.windowMinutes;
    out.push({
      id,
      usedPercent: Math.min(100, Math.max(0, pct)),
      ...(label ? { label } : {}),
      ...(typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? { windowMinutes: mins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
    if (out.length >= MAX_WINDOWS) break;
  }
  return out.length ? out : undefined;
}

export class EventUsageLedger {
  private readonly bySession = new Map<string, EventUsage>();

  /** Add one turn's report and answer the session's running totals. */
  absorb(sessionId: string, ev: UsageEvent): EventUsage {
    const prior = this.bySession.get(sessionId);
    const u = prior?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 };
    const output = count(ev.outputTokens);
    // Thinking is a PART of output (#789): a report claiming more thinking than
    // output is not believed past the output it came with.
    const thinking = Math.min(count(ev.thinkingTokens), output);
    const next: EventUsage = {
      usage: {
        input: u.input + count(ev.inputTokens),
        output: u.output + output,
        cacheRead: u.cacheRead + count(ev.cacheReadTokens),
        cacheCreate: u.cacheCreate + count(ev.cacheWriteTokens),
        thinking: u.thinking + thinking,
      },
    };
    const model = text(ev.model) ?? prior?.model;
    if (model) next.model = model;
    const limits = readLimits(ev.limits) ?? prior?.limits;
    if (limits) next.limits = limits;
    this.bySession.set(sessionId, next);
    return next;
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
