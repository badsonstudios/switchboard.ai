// The window's side of a card's sticky note (#1544, §5.11).
//
//   sessions:note          IN   read a card's note
//   sessions:setNote       IN   write it (empty text deletes it)
//   sessions:noteChanged   OUT  a card's note moved — carries the new value
//
// Same read/write-answering-the-truth shape as `delivery-ipc.ts`: a refused
// write resolves what the store holds, so the card shows the truth rather than
// what was typed.
//
// The push exists for the readers that did not make the change: the sessions
// rail, and (in a later part of #1544) a note the session's AI sets through the
// MCP tool. It carries the VALUE, for the reason `sessions:taskLabel` does —
// every reader holds the note in local state and has nothing to re-read.
//
// FAIL-OPEN: nothing here touches a session. A refused or failed write is a
// log line and an unchanged note, and the conversation never hears of it.
import { IpcBroker } from '../ipc/broker';
import { errorText } from '../../shared/error-text';
import { LogFields, Logger } from '../log/logger';
import { cleanNoteText, type SessionNote, type SessionNoteChange } from '../../shared/session-note';

export interface NoteIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: {
    cardNote(cardId: string): SessionNote | undefined;
    setCardNote(cardId: string, note: SessionNote | undefined): SessionNote | undefined;
  };
  knownCard: (cardId: string) => boolean;
  /** tell the window a card's note changed */
  push: (change: SessionNoteChange) => void;
  /** injectable for tests */
  now?: () => Date;
}

/**
 * Write a card's note as `by`, or delete it when the cleaned text is empty.
 * Answers what the store holds afterwards. Shared by the IPC handler and (in a
 * later part of #1544) the MCP tool, so both apply the same cap and cleaning.
 */
export function writeCardNote(
  deps: Pick<NoteIpcDeps, 'store' | 'push' | 'now'>,
  cardId: string,
  raw: unknown,
  by: SessionNote['by']
): SessionNote | null {
  const text = cleanNoteText(raw);
  const next: SessionNote | undefined = text
    ? { text, by, at: (deps.now?.() ?? new Date()).toISOString() }
    : undefined;
  const stored = deps.store.setCardNote(cardId, next);
  deps.push({ cardId, ...(stored ? { note: stored } : {}) });
  return stored ?? null;
}

export function registerNoteIpc(deps: NoteIpcDeps): void {
  const { broker, log, store } = deps;

  const refuse = (channel: string, reason: string, fields: LogFields = {}): null => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return null;
  };

  broker.handle('sessions:note', (_e, cardId: unknown): SessionNote | null => {
    if (typeof cardId !== 'string') return refuse('sessions:note', 'cardId must be a string');
    return store.cardNote(cardId) ?? null;
  });

  broker.handle('sessions:setNote', (_e, cardId: unknown, text: unknown): SessionNote | null => {
    if (typeof cardId !== 'string') return refuse('sessions:setNote', 'cardId must be a string');
    // §5.29: renderer input is untrusted. Anything but a string is refused,
    // not read as "delete" — a bug that sent a number must not wipe a note.
    if (typeof text !== 'string') return refuse('sessions:setNote', 'the text must be a string', { cardId });
    if (!deps.knownCard(cardId)) return refuse('sessions:setNote', 'unknown card', { cardId });
    try {
      const stored = writeCardNote(deps, cardId, text, 'user');
      // INFO, without the text: the note is the user's own words, and the log
      // is a file that gets attached to bug reports.
      log.info(stored ? 'session note set' : 'session note deleted', {
        cardId,
        ...(stored ? { chars: stored.text.length } : {}),
      });
      return stored;
    } catch (err) {
      log.error('sessions:setNote failed', { cardId, error: errorText(err) });
      return store.cardNote(cardId) ?? null;
    }
  });
}
