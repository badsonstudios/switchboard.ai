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

interface NoteApi {
  note(cardId: string): Promise<SessionNote | null>;
  setNote(cardId: string, text: string): Promise<SessionNote | null>;
  onNoteChanged(cb: (c: SessionNoteChange) => void): () => void;
}

interface CardNoteState {
  note: SessionNote | undefined;
  /** the editor is open for this card */
  editing: boolean;
}

const EMPTY: CardNoteState = { note: undefined, editing: false };

const cards = new Map<string, CardNoteState>();
const fetched = new Set<string>();
const listeners = new Set<() => void>();
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
      patch(c.cardId, { note: c.note });
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

/**
 * Save what was typed: empty text deletes the note. Closes the editor at once
 * and shows main's answer when it comes. Resolves when the save is settled.
 */
export async function saveNote(cardId: string, text: string): Promise<void> {
  patch(cardId, { editing: false });
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
  listeners.clear();
  unsubscribePush?.();
  unsubscribePush = null;
}
