// The renderer's copy of every card's sticky note (#1544, §5.11).
//
// One module-level store rather than state in a component, because three
// surfaces read the same note and none of them owns it: the card header's 📝
// button opens the editor, the note strip (in the Session tab, next to the
// composer) draws it, and — in a later part — the sessions rail marks it. A
// popout renders in this window's JS realm, so it reads this same store.
//
// MAIN IS THE TRUTH. A note is fetched the first time a card asks for it and
// kept current by `sessions:noteChanged`; a save shows what main answered, not
// what was typed. FAIL-OPEN: with no bridge (unit tests, an old preload) every
// call is a no-op and every card simply has no note.
import * as React from 'react';
import type { SessionNote, SessionNoteChange } from '../../../shared/session-note';
import { uiGet, uiSet } from './ui-state';

/**
 * Where a card draws its note (#1544 part 2), one choice for every card:
 *   prompt  A, a band above the prompt box (the default)
 *   header  B, a one-line strip under the card's title bar
 *   corner  C, a small tilted sticky in the conversation's top-right corner
 *   chip    D, a chip in the title bar that opens the note in a popover
 */
export const NOTE_PLACEMENTS = ['prompt', 'header', 'corner', 'chip'] as const;
export type NotePlacement = (typeof NOTE_PLACEMENTS)[number];
export const DEFAULT_NOTE_PLACEMENT: NotePlacement = 'prompt';
/** the ui-blob key the choice is stored under */
export const NOTE_PLACEMENT_KEY = 'notePlacement';

/** What was stored, as a placement; anything else reads as the default. */
export function notePlacementOf(raw: unknown): NotePlacement {
  return NOTE_PLACEMENTS.includes(raw as NotePlacement) ? (raw as NotePlacement) : DEFAULT_NOTE_PLACEMENT;
}

/** What "Let Claude write it" needs to know about a card's live session. */
export interface NoteSession {
  liveId: string;
  /** the session's status: anything but idle or done means "busy, ask first" */
  status: string;
  /** the AI's name, for the button's words */
  aiName?: string;
}

export type AskForNoteAnswer = { ok: true } | { ok: false; reason: 'no-session' | 'no-tools' | 'not-sent' };

interface NoteApi {
  askForNote?(liveId: string): Promise<AskForNoteAnswer>;
  note(cardId: string): Promise<SessionNote | null>;
  setNote(cardId: string, text: string): Promise<SessionNote | null>;
  onNoteChanged(cb: (c: SessionNoteChange) => void): () => void;
}

interface CardNoteState {
  note: SessionNote | undefined;
  /** the editor is open for this card */
  editing: boolean;
  /** placement D: the chip's popover is open on the note (not editing it) */
  open: boolean;
}

const EMPTY: CardNoteState = { note: undefined, editing: false, open: false };
let placement: NotePlacement = DEFAULT_NOTE_PLACEMENT;

const cards = new Map<string, CardNoteState>();
const fetched = new Set<string>();
const listeners = new Set<() => void>();
const liveOf = new Map<string, NoteSession>();
let unsubscribePush: (() => void) | null = null;

function api(): NoteApi | undefined {
  const s = (globalThis as { window?: { switchboard?: { sessions?: Partial<NoteApi> } } }).window?.switchboard
    ?.sessions;
  return s && typeof s.note === 'function' && typeof s.setNote === 'function' ? (s as NoteApi) : undefined;
}

function emit(): void {
  for (const l of listeners) l();
}

function patch(cardId: string, next: Partial<CardNoteState>): void {
  const prev = cards.get(cardId) ?? EMPTY;
  cards.set(cardId, { ...prev, ...next });
  emit();
}

function listen(): void {
  if (unsubscribePush) return;
  const a = api();
  if (!a || typeof a.onNoteChanged !== 'function') return;
  try {
    unsubscribePush = a.onNoteChanged((c) => {
      if (!c || typeof c.cardId !== 'string') return;
      fetched.add(c.cardId);
      // a note deleted elsewhere takes its open popover with it
      patch(c.cardId, { note: c.note, ...(c.note ? {} : { open: false }) });
    });
  } catch {
    /* fail-open: no live updates, the fetch still works */
  }
}

function ensure(cardId: string): void {
  listen();
  if (fetched.has(cardId)) return;
  fetched.add(cardId);
  const a = api();
  if (!a) return;
  void a
    .note(cardId)
    .then((n) => patch(cardId, { note: n ?? undefined }))
    .catch(() => {
      /* fail-open: the card shows no note */
    });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The note state for one card (fetched on first use). */
export function noteStateOf(cardId: string): CardNoteState {
  return cards.get(cardId) ?? EMPTY;
}

/** Open the editor on a card: edits the note, or starts a new one. */
export function startEditingNote(cardId: string): void {
  patch(cardId, { editing: true });
}

/** Close the editor without saving. */
export function cancelEditingNote(cardId: string): void {
  patch(cardId, { editing: false });
}

/** Placement D: open or close the chip's popover on the note. */
export function setNotePopoverOpen(cardId: string, open: boolean): void {
  patch(cardId, { open });
}

/** Read the stored placement, once the ui blob has loaded (App calls this). */
export function initNotePlacement(): void {
  placement = notePlacementOf(uiGet<unknown>(NOTE_PLACEMENT_KEY, undefined));
  emit();
}

/** Settings ▸ Appearance: every card moves its note at once. */
export function setNotePlacement(next: NotePlacement): void {
  placement = notePlacementOf(next);
  // a popover open under the old placement must not reappear later
  for (const [id, st] of cards) if (st.open) cards.set(id, { ...st, open: false });
  uiSet(NOTE_PLACEMENT_KEY, placement);
  emit();
}

/** The card reports its live session (or none) — SessionGrid does this. */
export function setNoteSession(cardId: string, s: NoteSession | null): void {
  const prev = liveOf.get(cardId);
  if (!s) {
    if (!prev) return;
    liveOf.delete(cardId);
  } else {
    if (prev && prev.liveId === s.liveId && prev.status === s.status && prev.aiName === s.aiName) return;
    liveOf.set(cardId, s);
  }
  emit();
}

/** The card's live session, for "Let Claude write it"; undefined when none. */
export function useNoteSession(cardId: string): NoteSession | undefined {
  return React.useSyncExternalStore(
    subscribe,
    () => liveOf.get(cardId),
    () => undefined
  );
}

/** A session that is mid-turn or waiting on an answer: ask before sending it a prompt. */
export function sessionIsBusy(status: string): boolean {
  return status !== 'idle' && status !== 'done';
}

/** Send the prompt that asks the session's AI to write the note. Fail-open. */
export async function askAiForNote(liveId: string): Promise<AskForNoteAnswer> {
  const a = api();
  if (!a || typeof a.askForNote !== 'function') return { ok: false, reason: 'no-tools' };
  try {
    return await a.askForNote(liveId);
  } catch {
    return { ok: false, reason: 'not-sent' };
  }
}

/** React binding for the placement. */
export function useNotePlacement(): NotePlacement {
  return React.useSyncExternalStore(
    subscribe,
    () => placement,
    () => DEFAULT_NOTE_PLACEMENT
  );
}

/**
 * Save what was typed: empty text deletes the note. Closes the editor at once
 * and shows main's answer when it comes. Resolves when the save is settled.
 */
export async function saveNote(cardId: string, text: string): Promise<void> {
  patch(cardId, { editing: false, ...(text.trim() ? {} : { open: false }) });
  const a = api();
  if (!a) return;
  try {
    const stored = await a.setNote(cardId, text);
    patch(cardId, { note: stored ?? undefined });
  } catch {
    /* fail-open: the note on screen stays what main last said */
  }
}

/** The × button: delete the note for good. */
export function deleteNote(cardId: string): Promise<void> {
  return saveNote(cardId, '');
}

/** React binding: re-renders when this card's note or editor state moves. */
export function useSessionNote(cardId: string | undefined): CardNoteState {
  React.useEffect(() => {
    if (cardId) ensure(cardId);
  }, [cardId]);
  return React.useSyncExternalStore(
    subscribe,
    () => (cardId ? noteStateOf(cardId) : EMPTY),
    () => EMPTY
  );
}

/** Tests only: forget everything, including the push subscription. */
export function resetSessionNotesForTests(): void {
  cards.clear();
  fetched.clear();
  liveOf.clear();
  listeners.clear();
  placement = DEFAULT_NOTE_PLACEMENT;
  unsubscribePush?.();
  unsubscribePush = null;
}
