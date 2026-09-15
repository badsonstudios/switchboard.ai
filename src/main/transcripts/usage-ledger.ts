// One count per API response, however many times the transcript writes it (#807).
//
// ⚠️ THE CLI WRITES A RESPONSE'S `message.usage` MORE THAN ONCE, AND THE COPIES
// ARE NOT ALWAYS EQUAL. Streaming appends one line per content block, each
// carrying the whole response's usage. Measured 2026-09-15 over 265,463 lines
// through CLI 2.1.270 (`spike/probes/807/`): 24,496 of 41,641 responses repeat;
// in the parent transcript every copy is identical, but in `subagents/agent-*`
// files 12,057 responses carry a GROWING `output_tokens` — an early copy says 2,
// a later one 4,450 — with `thinking_tokens` absent early and present late. No
// other field ever differs, no copy ever decreases, every usage line has a
// `message.id`, and no response's copies span two files.
//
// So the rule is: key on `message.id`, and a later copy REPLACES the earlier
// one's contribution. Against the CLI's own `cost-state.modelUsage`:
//   - every copy summed (what the watcher did):  1.5–7.5× on every field
//   - first copy wins:        input / cache ~1.0, output 0.63–0.88
//   - LATEST copy wins:       input / cache 0.98–1.013, output 0.97–1.00
// Copies of one response need not be adjacent — a tool result can sit between
// them — which is why this is a map and not "compare with the previous line".
//
// NOT `message.id:requestId`, though that is the key §5.13 inherited: over
// 41,705 response ids, none carries two different `requestId`s, so the second
// half never separates anything — and 16 carry none, so a copy that had one
// beside a copy that did not would have split one response into two.
//
// What it cannot fix: the CLI also bills side queries (a Haiku row in its
// ledger) that it writes to no transcript. That gap is what makes our totals
// USUALLY low — but nothing here clamps them, and one measured session read
// 1.3% high on input. "Close to the CLI's figure", not "a floor".

import type { UsageTotals } from './watcher';
import { thinkingTokensOf } from './thinking-tokens';

type Contribution = UsageTotals;

/** The key one response's copies share, or undefined when the line has none. */
export function usageKey(line: Record<string, unknown>): string | undefined {
  const message = line.message as { id?: unknown } | undefined;
  const id = message?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * A count, or 0. Not `?? 0`: a contribution is SUBTRACTED when its copy is
 * superseded, so one NaN or string would poison the total for the rest of the
 * session instead of for one line.
 */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function contributionOf(usage: Record<string, unknown>): Contribution {
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheCreate: count(usage.cache_creation_input_tokens),
    // Beside `output`, from the same copy, never added INTO it (#789).
    thinking: thinkingTokensOf(usage),
  };
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheCreate', 'thinking'] as const;

/**
 * Remembers what each response has contributed, so a later copy can take its
 * place. Holds no totals of its own: the caller passes the totals it writes
 * into, so there is no second copy of the numbers to fall out of step.
 *
 * Its lifetime is the snapshot's. A continued or forked conversation can carry
 * the same message ids into a new file, and a ledger that outlived a snapshot
 * reset would treat the new file's copies as replacements for responses the
 * blank totals no longer contain, and net them to zero.
 */
export class UsageLedger {
  private readonly seen = new Map<string, Contribution>();

  absorb(totals: UsageTotals, usage: Record<string, unknown>, key: string | undefined): void {
    const next = contributionOf(usage);
    const prev = key === undefined ? undefined : this.seen.get(key);
    for (const f of FIELDS) totals[f] += next[f] - (prev?.[f] ?? 0);
    if (key !== undefined) this.seen.set(key, next);
  }
}
