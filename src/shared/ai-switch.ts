// Switching a card from one AI to another (E40 item 11, #1294; design record
// `docs/plans/e40-multi-ai-design.md` §5 screen 2 and §6).
//
// ONE CARD, ONE NATIVE CONVERSATION PER AI. A card is ON one AI at a time —
// `identity.providerId`, and that AI's conversation in `nativeSessionId` and its
// lineage, exactly as before E40. The conversations of the AIs it is NOT on are
// PARKED beside them (`ParkedConversation`, main's `PersistedSession.
// conversations`). Switching parks the current one and un-parks the target's,
// so switching BACK resumes that AI's own conversation through its own
// `resume` capability — a real resume, the only kind §5.5 allows to be called
// one. Only a FIRST switch to an AI starts fresh, and that start is a briefed
// continuation (#1295), never a resume.
//
// Shared because both sides read it: main writes the marks and the refusal, the
// renderer draws the divider and asks the question.

/** One AI, as a mark names it: the id the card ran on and what it was called. */
export interface AiSwitchParty {
  providerId: string;
  /** the AI's display name AT THE TIME — a renamed or removed AI still reads */
  name: string;
}

/**
 * One switch, persisted with the card so the divider survives a relaunch. The
 * Feed draws it as a divider in the conversation of the AI switched TO.
 *
 * `briefed`, `turnsSummarised` and `briefingRef` are #1295's: this item writes
 * `briefed: false` and leaves the other two absent. The renderer must not
 * claim a briefing that `briefed` does not record.
 */
export interface AiSwitchMark {
  kind: 'ai-switch';
  /** unique per mark — the Feed block's identity */
  id: string;
  from: AiSwitchParty;
  to: AiSwitchParty;
  /** ISO timestamp of the switch */
  at: string;
  /** the AI switched to was handed a summary (#1295) */
  briefed: boolean;
  /** how many turns the summary covered (#1295) */
  turnsSummarised?: number;
  /** where "see what it was told" opens (#1295) */
  briefingRef?: string;
  /**
   * When the AI switched to first STARTED after this switch. Absent while the
   * switch is pending: the briefing hook is asked only on that first start, so
   * a Retry after a failed start is still the first, and a relaunch is not.
   */
  arrivedAt?: string;
}

/** How many marks a card keeps; the oldest are dropped. */
export const MAX_AI_SWITCHES = 20;

/** Why `sessions:switchAi` would not switch. Decided before the card is touched. */
export type SwitchAiRefusal =
  /** not a card id and a provider id */
  | 'bad-request'
  /** main has no such card */
  | 'no-card'
  /** that AI is not registered (not installed, or removed) */
  | 'unavailable'
  /** the card's session is working, or waiting on the user — ask first */
  | 'busy';

/** What `sessions:switchAi` answers. */
export type SwitchAiResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly reason: SwitchAiRefusal;
      /** present on `busy` only: what the session would be stopped in the middle of */
      readonly busy?: 'working' | 'waiting';
    };

/** Is this a provider id we would accept from the renderer? Shape only. */
export function isProviderIdShape(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(v);
}

/** Is this persisted value a usable mark? Used by the store's load. */
export function isSaneAiSwitchMark(v: unknown): v is AiSwitchMark {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const party = (p: unknown): boolean =>
    !!p &&
    typeof p === 'object' &&
    isProviderIdShape((p as Record<string, unknown>).providerId) &&
    typeof (p as Record<string, unknown>).name === 'string';
  return (
    m.kind === 'ai-switch' &&
    typeof m.id === 'string' &&
    m.id.length > 0 &&
    party(m.from) &&
    party(m.to) &&
    typeof m.at === 'string' &&
    Number.isFinite(Date.parse(m.at)) &&
    typeof m.briefed === 'boolean'
  );
}
