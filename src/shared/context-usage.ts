// How full a session's context window is (#715): the NEUTRAL half.
//
// What `sessions:contextUsage` answers and how the meter grades it. Asking an
// engine for it is a provider control (E40 item 04, #1287): Claude's verb and
// the reader of its answer are `main/providers/claude-context-usage.ts`, which
// has the measured contract.

/** What `sessions:contextUsage` answers, inside a success verdict's `response`. */
export interface ContextUsage {
  /** 0 to 100, whole: how full the window is, by the CLI's own count */
  percentage: number;
  /** tokens in the window now, when the CLI said */
  totalTokens: number | null;
  /** the window's size for this session's model, when the CLI said */
  maxTokens: number | null;
  /**
   * The token count at which the CLI compacts on its own, or `null` when
   * auto-compact is off or the CLI did not say. It is BELOW `maxTokens`: the
   * conversation is compacted before the window is full.
   */
  autoCompactAt: number | null;
}

/** from here the meter stops being plain: worth a look, and Compact is beside it */
export const CONTEXT_FILLING_AT = 60;
/** from here it is nearly full */
export const CONTEXT_NEARLY_FULL_AT = 80;

export type ContextLevel = 'normal' | 'filling' | 'nearly-full';

/**
 * Which of the three states a fill is in.
 *
 * The owner's numbers (#715): act at about 60, and 80 is nearly full. The
 * level picks the meter's emphasis; the NUMBER is the signal, so the three are
 * told apart without colour.
 */
export function contextLevel(percentage: number): ContextLevel {
  if (percentage >= CONTEXT_NEARLY_FULL_AT) return 'nearly-full';
  if (percentage >= CONTEXT_FILLING_AT) return 'filling';
  return 'normal';
}
