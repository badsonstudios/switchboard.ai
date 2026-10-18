// Which AI a sentence is about (#1316) — the name to say, and whether the
// Claude-only half of a sentence applies.
//
// E40 made the app host more than one AI, and a handful of words still said
// "Claude" whatever the session ran: the Stop button's title, the working
// strip, the autonomy tooltips. They now take the session's AI by NAME, and the
// name comes from the AI catalog (main's `ai-catalog/`, through the AIs store),
// never from a literal here — so a new AI is named correctly with no new code.
//
// TWO ANSWERS, AND NEITHER GUESSES:
//   - `name` is null when nobody knows (no provider id yet, or a list that has
//     not arrived and no controls answer to fall back on). A caller then says
//     its unnamed sentence ("Stop — interrupts the current turn") rather than
//     printing a raw provider id or assuming Claude.
//   - `claude` is true only when the id IS Claude's. An unknown AI gets the
//     neutral sentence without the Claude Code details, which is the honest
//     direction: those details are claims about one CLI.
import React from 'react';
import { CLAUDE_AI_ID } from '../../../shared/ais';
import { aiItemFor, getAisState, subscribeAis, type AisState } from './ais-store';

export interface SessionAi {
  /** the AI's display name, e.g. "Codex"; null when it is not known */
  name: string | null;
  /** the session's AI is Claude, so Claude-only words apply */
  claude: boolean;
}

/**
 * Pure, for the tests and for callers that already hold the store's state.
 * `fallbackName` is the provider's own display name off `sessions:controls`,
 * used only when the catalog has no entry for the id.
 */
export function sessionAi(state: AisState, providerId: string | undefined, fallbackName?: string | null): SessionAi {
  const item = aiItemFor(state.items, providerId);
  const name = item?.entry.name || fallbackName || null;
  const claude = isClaudeAi(providerId) || (item?.kind === 'catalog' && item.entry.id === CLAUDE_AI_ID);
  return { name, claude };
}

/** Whether a provider id is Claude's — the whole test, for a caller with no name to say. */
export function isClaudeAi(providerId: string | null | undefined): boolean {
  return providerId === CLAUDE_AI_ID;
}

/** The same, kept current as the list of AIs changes. */
export function useSessionAi(providerId: string | undefined, fallbackName?: string | null): SessionAi {
  const state = React.useSyncExternalStore(subscribeAis, getAisState);
  return sessionAi(state, providerId, fallbackName);
}
