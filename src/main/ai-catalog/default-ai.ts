// Which AI a brand-new session starts on (E40 item 08, #1291; owner,
// 2026-10-15: "a setting; initially Claude").
//
// THE RULE:
//   1. the AI the user chose, when it is registered;
//   2. otherwise the FIRST REGISTERED provider — registration order is
//      precedence (P2-E15-02), and `bootstrap.ts` registers Claude first in
//      production, so "never chosen" means Claude. Leaving the setting unset
//      rather than writing `claude-code` into it is deliberate: the e2e fakes
//      depend on the first-registered rule (`SWITCHBOARD_FAKE_PROVIDER=acp`
//      registers the fake ACP agent first to make it the default), and a
//      stored `claude-code` would silently override that.
//   3. A choice that names a provider that is not registered (a custom AI
//      removed, a build without it) FALLS BACK by rule 2, says so once in the
//      log per distinct choice, and the state carries `fellBack` so the
//      renderer can say so too.
// Existing cards keep the provider they were created with (`start-plan.ts`).
import type { DefaultAiState } from '../../shared/ais';

export function resolveDefaultAi(chosen: string | undefined, registered: readonly string[]): DefaultAiState {
  const first = registered[0];
  if (first === undefined) throw new Error('no provider adapter registered — bootstrap did not run');
  if (!chosen) return { id: first, fellBack: false };
  if (registered.includes(chosen)) return { id: chosen, chosen, fellBack: false };
  return { id: first, chosen, fellBack: true };
}

/** `resolveDefaultAi` with the fallback logged once per distinct choice. */
export function defaultAiResolver(
  chosen: () => string | undefined,
  registered: () => readonly string[],
  warn: (msg: string, data: Record<string, unknown>) => void
): () => DefaultAiState {
  let warnedFor: string | undefined;
  return () => {
    const s = resolveDefaultAi(chosen(), registered());
    if (s.fellBack && s.chosen !== warnedFor) {
      warnedFor = s.chosen;
      warn('the default AI is not available; new sessions use the first registered one', {
        chosen: s.chosen,
        using: s.id,
      });
    }
    if (!s.fellBack) warnedFor = undefined;
    return s;
  };
}
