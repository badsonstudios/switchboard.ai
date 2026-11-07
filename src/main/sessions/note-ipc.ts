// The window's side of a card's sticky note (#1544, §5.11).
//
//   sessions:note          IN   read a card's note
//   sessions:setNote       IN   write it (empty text deletes it)
//   sessions:noteChanged   OUT  a card's note moved — carries the new value
//   sessions:askForNote    IN   "Let Claude write it": ask the session's AI to set it
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
import { cleanNoteText, noteWouldBeCut, type SessionNote, type SessionNoteChange } from '../../shared/session-note';
import type { BusNotes } from '../bus/host-channel';

/**
 * What "Let Claude write it" sends the session (#1544). An ordinary prompt,
 * deliberately: the session already knows what it is waiting on, so asking
 * IT costs one short turn, where a separate request would have to rebuild
 * the whole context. It shows in the conversation, which is honest about
 * what happened. English on purpose: it is read by the AI, not shown as UI.
 */
export const NOTE_REQUEST_PROMPT =
  'Please use the switchboard tool set_session_note to leave a one-line note on this session ' +
  '(under 200 characters) saying what you are waiting on, or where things stand right now. ' +
  'That is all: do not change anything else.';

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
  /**
   * "Let Claude write it" (#1544): the live session's card, whether its AI
   * can reach the switchboard tools at all, and how to send it a prompt.
   * Absent = the button's channel refuses every call.
   */
  ask?: {
    cardFor: (liveId: string) => string | null;
    hasBus: (liveId: string) => boolean;
    submit: (liveId: string, text: string) => Promise<boolean>;
  };
}

/** What `sessions:askForNote` answers: sent, or why not. */
export type AskForNoteResult = { ok: true } | { ok: false; reason: 'no-session' | 'no-tools' | 'not-sent' };

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

/**
 * `set_session_note`'s host side (#1544): the CALLER's live id comes from the
 * bus token, so a session can only ever write its own card's note. Same
 * cleaning and cap as the window's path (`writeCardNote`), written as `'ai'`.
 */
export function busNotes(
  deps: Pick<NoteIpcDeps, 'store' | 'push' | 'now' | 'log'> & { cardFor: (liveId: string) => string | null }
): BusNotes {
  return {
    set(callerLiveId, text) {
      if (typeof text !== 'string') return { ok: false, reason: 'text must be a string (use "" to clear the note)' };
      const cardId = deps.cardFor(callerLiveId);
      if (!cardId) return { ok: false, reason: 'this session has no card to put a note on' };
      try {
        const prior = deps.store.cardNote(cardId);
        const stored = writeCardNote(deps, cardId, text, 'ai');
        const truncated = !!stored && noteWouldBeCut(text);
        deps.log.info(stored ? 'session note set by the AI' : 'session note cleared by the AI', {
          cardId,
          ...(stored ? { chars: stored.text.length } : {}),
        });
        return {
          ok: true,
          value: {
            cleared: !stored,
            ...(stored ? { text: stored.text } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(prior ? { replaced: prior.by } : {}),
          },
        };
      } catch (err) {
        deps.log.error('set_session_note failed', { cardId, error: errorText(err) });
        return { ok: false, reason: 'switchboard could not save the note' };
      }
    },
  };
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

  // "Let Claude write it" (#1544). The WINDOW decides whether to ask first
  // (it knows the session is mid-turn and owns the confirm box); this side
  // only refuses what cannot work. A prompt sent mid-turn queues behind the
  // running one, which is the CLI's own behaviour, not something added here.
  broker.handle('sessions:askForNote', async (_e, liveId: unknown): Promise<AskForNoteResult> => {
    const ask = deps.ask;
    if (typeof liveId !== 'string' || !ask || !ask.cardFor(liveId)) {
      log.warn('sessions:askForNote refused: no such session');
      return { ok: false, reason: 'no-session' };
    }
    if (!ask.hasBus(liveId)) {
      log.info('sessions:askForNote refused: this session cannot reach the switchboard tools', { liveId });
      return { ok: false, reason: 'no-tools' };
    }
    try {
      const sent = await ask.submit(liveId, NOTE_REQUEST_PROMPT);
      log.info(sent ? 'asked the AI to write the session note' : 'could not send the note request', { liveId });
      return sent ? { ok: true } : { ok: false, reason: 'not-sent' };
    } catch (err) {
      log.error('sessions:askForNote failed', { liveId, error: errorText(err) });
      return { ok: false, reason: 'not-sent' };
    }
  });
}
