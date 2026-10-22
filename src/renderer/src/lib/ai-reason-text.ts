// A main-process reason, in the user's language (#1365). See `shared/ai-reason.ts`.
import { aiReasonKey } from '../../../shared/ai-reason';

/**
 * The words for a reason main sent: its code through `t` when it is one we
 * know with the values it needs, else the English main sent beside it (which
 * may be `undefined`, for a caller that has its own "no reason" sentence).
 */
export function aiReasonText(
  code: unknown,
  english: string | undefined,
  t: (k: string, o?: Record<string, unknown>) => string
): string | undefined {
  const k = aiReasonKey(code);
  return k ? t(k.key, k.vars) : english;
}
