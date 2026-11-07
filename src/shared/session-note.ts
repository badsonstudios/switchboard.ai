// A session's sticky note (#1544, §5.11): one short line saying where you left
// off ("Waiting on Tanner"), so coming back to a parked session tells you why
// it is parked.
//
// ONE note per card. No stack, no history: writing replaces it, saving empty
// text deletes it. Who wrote it is recorded so the card can say so ("You ·
// Today 2:18 PM"); `'ai'` is reserved for the session's own AI, which sets the
// note through the switchboard MCP tool (a later part of #1544). Last writer
// wins either way.
//
// THE NOTE IS NEVER SENT TO THE AI. It is the user's private label on the card,
// stored with the card in `workspace.json`, not in the conversation — so it
// survives restart and resume, and it costs nothing in context.

/** Who wrote the note. */
export type SessionNoteAuthor = 'user' | 'ai';

export interface SessionNote {
  /** plain text, one line, at most `SESSION_NOTE_MAX` characters */
  text: string;
  by: SessionNoteAuthor;
  /** when it was last written, ISO 8601 */
  at: string;
}

/**
 * The cap. Short on purpose: the note is a reminder, not a document, and the
 * tighter placements (a one-line strip, a header chip, the rail's tooltip)
 * ellipsize it. Applied to AI-written text too, which is the reason it is
 * enforced in main rather than by the text box.
 */
export const SESSION_NOTE_MAX = 200;

/**
 * Clean what was typed (or what an AI sent) into the text that is stored.
 *
 * - Line breaks and tabs become spaces, and runs of spaces collapse: the note
 *   is one line, and every placement draws it as one.
 * - Other control characters are removed. They are invisible on screen and
 *   have no business in a label.
 * - Trimmed, then cut to the cap by CODE POINT, so an emoji at the boundary is
 *   kept whole or dropped, never split into half a surrogate pair.
 *
 * Answers `''` for anything that is not a string, or nothing but whitespace,
 * which every caller reads as "delete the note".
 */
export function cleanNoteText(raw: unknown): string {
  const points = Array.from(oneLine(raw));
  return points.length > SESSION_NOTE_MAX ? points.slice(0, SESSION_NOTE_MAX).join('').trimEnd() : points.join('');
}

/** Would `cleanNoteText` cut this text at the cap? (The AI's receipt says so.) */
export function noteWouldBeCut(raw: unknown): boolean {
  return Array.from(oneLine(raw)).length > SESSION_NOTE_MAX;
}

/** Every cleaning step except the cap. */
function oneLine(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) out += ' ';
    else if (code < 32 || code === 127 || (code >= 128 && code < 160)) continue;
    else out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/**
 * A stored note, checked on the way in from `workspace.json`. Undefined for
 * anything that is not a usable note: a hand-edited file must not put text on
 * screen that the setter would have refused.
 */
export function sanitizeNote(raw: unknown): SessionNote | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const text = cleanNoteText(r.text);
  if (!text) return undefined;
  const by: SessionNoteAuthor = r.by === 'ai' ? 'ai' : 'user';
  // a bad time reads as "now" (the load), not as 1 January 1970
  const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date().toISOString();
  return { text, by, at };
}

/** The push main sends when a card's note changes: `note` absent = deleted. */
export interface SessionNoteChange {
  cardId: string;
  note?: SessionNote;
}

/** The quick picks under the edit box, as i18n keys (the words live in en.json). */
export const NOTE_QUICK_PICK_KEYS = [
  'sessionNote.pick.waiting',
  'sessionNote.pick.review',
  'sessionNote.pick.research',
  'sessionNote.pick.blocked',
] as const;
