import { describe, it, expect } from 'vitest';
import { SESSION_NOTE_MAX, cleanNoteText, sanitizeNote } from './session-note';

describe('cleanNoteText (#1544)', () => {
  it('makes one line: breaks and tabs become single spaces, ends trimmed', () => {
    expect(cleanNoteText(' a\r\n\tb   c \n')).toBe('a b c');
  });

  it('drops other control characters', () => {
    const bell = String.fromCodePoint(7);
    const c1 = String.fromCodePoint(0x9b);
    expect(cleanNoteText(`a${bell}b${c1}c`)).toBe('abc');
  });

  it('answers empty for nothing but whitespace, and for a non-string', () => {
    expect(cleanNoteText('  \n ')).toBe('');
    expect(cleanNoteText(undefined)).toBe('');
    expect(cleanNoteText(12)).toBe('');
  });

  it('caps by code point, never splitting an emoji', () => {
    const emoji = String.fromCodePoint(0x1f4dd);
    const out = cleanNoteText('a'.repeat(SESSION_NOTE_MAX - 1) + emoji + 'zzz');
    expect(Array.from(out)).toHaveLength(SESSION_NOTE_MAX);
    expect(out.endsWith(emoji)).toBe(true);
  });

  it('keeps markup as literal text (it is drawn as plain text, never parsed)', () => {
    expect(cleanNoteText('<b>hi</b> **x**')).toBe('<b>hi</b> **x**');
  });
});

describe('sanitizeNote', () => {
  it('keeps a good note', () => {
    const n = { text: 'Need a PR review', by: 'ai', at: '2026-11-06T10:00:00.000Z' };
    expect(sanitizeNote(n)).toEqual(n);
  });

  it('drops a note with no usable text, or one that is not an object', () => {
    expect(sanitizeNote({ text: '  ', by: 'user', at: '2026-11-06T10:00:00.000Z' })).toBeUndefined();
    expect(sanitizeNote('hello')).toBeUndefined();
    expect(sanitizeNote(null)).toBeUndefined();
  });

  it('reads an unknown author as the user, and a bad time as now', () => {
    const before = Date.now();
    const n = sanitizeNote({ text: 'x'.repeat(300), by: 'robot', at: 'yesterday' })!;
    expect(n.text).toBe('x'.repeat(SESSION_NOTE_MAX));
    expect(n.by).toBe('user');
    expect(Date.parse(n.at)).toBeGreaterThanOrEqual(before);
  });
});
