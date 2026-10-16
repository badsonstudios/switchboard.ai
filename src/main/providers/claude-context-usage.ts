// How full a session's context window is (#715).
//
// ── THE CONTRACT, MEASURED AGAINST THE CLI ON PATH (2.1.288, 2026-10-09) ─────
//
// `spike/probes/715/` holds the probe; `spike/findings/715-context-usage.md`
// the captures. The same answer came back from 2.1.226.
//
//  * `get_context_usage` answers on a COLD session (no turn taken), during a
//    turn, after it, and on a resumed session before any prompt (where it
//    already counts the old conversation).
//  * The answer is large (~17 top-level keys: every memory file's path, every
//    MCP tool, a ready-made grid). The four numbers this file reads are
//    scalars at the top: `percentage` (a whole number, the CLI's own
//    `totalTokens / maxTokens`), `totalTokens`, `maxTokens`, and
//    `autoCompactThreshold` with `isAutoCompactEnabled`.
//  * `maxTokens` follows the model: 1,000,000 on Opus here, 200,000 after
//    `set_model haiku`, and `percentage` moves with it (4 → 18) with no turn.
//  * A cold session is NOT at zero: the system prompt, tools, skills and
//    memory files are already in the window (4% of a million here).
//
// HOST, DON'T REIMPLEMENT: the percentage shown is the CLI's own. Nothing here
// counts tokens or knows a model's window size.
//
// ONLY THE NUMBERS CROSS IPC. The full answer carries file paths from the
// user's machine and is fifty times the size; `readContextUsage` picks the
// four fields and drops the rest in main.
//
// CLAUDE'S HALF (E40 item 04, #1287): the verb and the reader of its answer.
// The neutral shape the renderer draws, `ContextUsage`, stays in
// `shared/context-usage.ts`; reaching this is `SessionControls.contextUsage`.
import type { ContextUsage } from '../../shared/context-usage';
import { controlRequest, StreamControlRequest } from './claude-protocol';

/** `get_context_usage` — what is in the session's context window. */
export function getContextUsageRequest(requestId: string): StreamControlRequest {
  return controlRequest(requestId, { subtype: 'get_context_usage' });
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * The numbers out of a `get_context_usage` answer, or `null` when it does not
 * carry a usable fill.
 *
 * `null` is "this CLI did not say" and the surface shows NOTHING, never 0%: a
 * confident zero on a full window is the one wrong answer this exists to
 * avoid. The CLI's own `percentage` is used when it is there; it is worked out
 * from the two token counts only when it is missing and both are present.
 */
export function readContextUsage(response: Record<string, unknown>): ContextUsage | null {
  const totalTokens = count(response.totalTokens);
  const maxTokens = count(response.maxTokens);
  let percentage = count(response.percentage);
  if (percentage === null && totalTokens !== null && maxTokens !== null && maxTokens > 0) {
    percentage = (totalTokens / maxTokens) * 100;
  }
  if (percentage === null) return null;
  const threshold = count(response.autoCompactThreshold);
  return {
    percentage: Math.max(0, Math.min(100, Math.round(percentage))),
    totalTokens,
    maxTokens,
    autoCompactAt: response.isAutoCompactEnabled === true && threshold ? threshold : null,
  };
}
