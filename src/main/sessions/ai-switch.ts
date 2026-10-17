// Moving a card from one AI to another (E40 item 11, #1294) — the decisions,
// as pure functions over the persisted card.
//
// THE SHAPE, and why it is not a map of every AI. The card's HEAD stays what it
// has always been: `identity.providerId` and that AI's conversation in
// `nativeSessionId` / `nativeSessionLineage` / `cededNativeIds`. Every resume
// path in the app reads those fields and none of them had to change. Only the
// AIs the card is NOT on live in `conversations`. Storing the current AI there
// too would give one conversation two copies that the lineage writer
// (`recordNativeId`) updates one of — and it is also what keeps an older build
// honest: one that predates this field still finds the AI the card is on, and
// its conversation, exactly where it always looked (see the store's v4 note).
//
// A switch PARKS the head under the AI it belonged to and UN-PARKS the target's,
// so switching back resumes that AI's own conversation through that AI's own
// `resume` capability (`start-plan.ts`, untouched). A target with nothing parked
// starts fresh — the first switch, which #1295 briefs. Nothing here deletes an
// id: the worst a switch can do to a conversation is move it.
import type { AiSwitchMark, AiSwitchParty } from '../../shared/ai-switch';
import { MAX_AI_SWITCHES } from '../../shared/ai-switch';
import type { PersistedParked, PersistedSession } from '../workspace/store';

/**
 * The card after switching it to `to` — park the head, un-park the target's,
 * append the mark. Never mutates `card`.
 *
 * `to.providerId === card.identity.providerId` is the caller's no-op to spot;
 * here it would park and immediately un-park the same conversation, which is
 * harmless, but a mark saying "Claude → Claude" would be a lie on screen.
 */
export function switchCardAi(
  card: PersistedSession,
  from: AiSwitchParty,
  to: AiSwitchParty,
  at: string,
  markId: string
): PersistedSession {
  const conversations: Record<string, PersistedParked> = { ...(card.conversations ?? {}) };
  // Park what the card has with the AI it is leaving — when it has anything. A
  // card that never got a conversation id on this AI has nothing to come back
  // to, and parking an empty entry would make the first switch BACK look like a
  // resume that then silently starts fresh.
  let parked = false;
  if (card.nativeSessionId) {
    parked = true;
    conversations[from.providerId] = {
      nativeSessionId: card.nativeSessionId,
      nativeSessionLineage: card.nativeSessionLineage,
      cededNativeIds: card.cededNativeIds,
      usage: card.usage,
      model: card.model,
      cliCost: card.cliCost,
      parkedAt: at,
    };
  } else if (card.nativeSessionLineage?.length) {
    // ancestors with no head: not a shape we write, but a hand-edited file can
    // hold one, and they are this AI's conversations all the same (#484)
    parked = true;
    conversations[from.providerId] = {
      nativeSessionId: card.nativeSessionLineage[0],
      nativeSessionLineage: card.nativeSessionLineage.slice(1),
      cededNativeIds: card.cededNativeIds,
      parkedAt: at,
    };
  }
  const back = conversations[to.providerId];
  delete conversations[to.providerId];
  // Ceded ids with nothing to park them WITH (no head, no chain) stay on the
  // card: they are the hold #539 relies on, and a switch must not loosen it.
  const ceded = [...(back?.cededNativeIds ?? []), ...(parked ? [] : (card.cededNativeIds ?? []))];
  const mark: AiSwitchMark = { kind: 'ai-switch', id: markId, from, to, at, briefed: false };
  const marks = [...(card.aiSwitches ?? []), mark].slice(-MAX_AI_SWITCHES);
  return {
    ...card,
    identity: { ...card.identity, providerId: to.providerId },
    // The target's own conversation, or nothing: a fresh start on that AI. Every
    // field written, even when absent, because the caller spreads this over the
    // card and an omitted field would leave the OTHER AI's value behind.
    nativeSessionId: back?.nativeSessionId,
    nativeSessionLineage: back?.nativeSessionLineage?.length ? back.nativeSessionLineage : undefined,
    cededNativeIds: ceded.length ? [...new Set(ceded)] : undefined,
    // The strip's starting point is the conversation the card is going INTO —
    // the numbers it had there, or none. `sessions:create` hands these back.
    usage: back?.usage,
    model: back?.model,
    cliCost: back?.cliCost,
    conversations: Object.keys(conversations).length > 0 ? conversations : undefined,
    aiSwitches: marks,
  };
}

/**
 * The divider for the conversation the card is in now: the latest switch INTO
 * the AI it is on. Earlier arrivals and the departures belong to other
 * conversations' timelines — #1295 may draw more; this item draws the one.
 */
export function arrivalMark(card: PersistedSession | undefined): AiSwitchMark | undefined {
  const marks = card?.aiSwitches ?? [];
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].to.providerId === card?.identity.providerId) return marks[i];
  }
  return undefined;
}

/**
 * The switch whose FIRST start this is, or nothing. Only the newest mark can
 * be pending, and only while the card is still on the AI it switched to and no
 * session on it has started yet — so a Retry after a failed start is still the
 * first start, and a relaunch a week later is not.
 */
export function pendingArrival(card: PersistedSession | undefined): AiSwitchMark | undefined {
  const marks = card?.aiSwitches ?? [];
  const last = marks[marks.length - 1];
  if (!last || last.arrivedAt || last.to.providerId !== card?.identity.providerId) return undefined;
  return last;
}

/**
 * The marks with `id` given what its first start turned out to be (#1295) —
 * resumed, or a briefing that could not be built or sent. Only these two
 * outcome fields: a briefing is recorded by `markArrived`, the one place that
 * may say `briefed: true`.
 */
export function patchMark(
  marks: readonly AiSwitchMark[] | undefined,
  id: string,
  patch: { resumed?: true; briefingFailed?: true; startedFresh?: true }
): AiSwitchMark[] | undefined {
  if (!marks) return undefined;
  return marks.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

/** The marks with `id` stamped as arrived — the first start on it has happened. */
export function markArrived(
  marks: readonly AiSwitchMark[] | undefined,
  id: string,
  at: string,
  briefing?: { turnsSummarised?: number; briefingRef?: string; summaryPartial?: true }
): AiSwitchMark[] | undefined {
  if (!marks) return undefined;
  return marks.map((m) =>
    m.id === id
      ? {
          ...m,
          arrivedAt: at,
          ...(briefing ? { briefed: true, ...briefing } : {}),
        }
      : m
  );
}
