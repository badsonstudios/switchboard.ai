// @vitest-environment jsdom
// The sticky note strip (#1544): draws main's note, edits it, deletes it, and
// shows what main ANSWERED rather than what was typed.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import type { SessionNote, SessionNoteChange } from '../../../shared/session-note';
import { resetSessionNotesForTests, startEditingNote } from '../lib/session-notes';
import { SessionNoteStrip, noteMeta, pickText } from './SessionNoteStrip';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const CARD = 'card-1';
const AT = '2026-11-06T14:18:00.000Z';

let host: HTMLDivElement;
let root: Root;
let stored: SessionNote | null;
let push: ((c: SessionNoteChange) => void) | null;
const setNote = vi.fn();

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  resetSessionNotesForTests();
  stored = null;
  push = null;
  setNote.mockReset();
  setNote.mockImplementation(async (_card: string, text: string) => {
    const clean = text.trim();
    stored = clean ? { text: clean, by: 'user', at: AT } : null;
    return stored;
  });
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      note: async () => stored,
      setNote,
      onNoteChanged: (cb: (c: SessionNoteChange) => void) => {
        push = cb;
        return () => {
          push = null;
        };
      },
    },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { switchboard?: unknown }).switchboard;
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SessionNoteStrip cardId={CARD} aiName="Claude" />);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);

function type(el: HTMLTextAreaElement, value: string): void {
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  valueProp.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe('SessionNoteStrip', () => {
  it('draws nothing when the card has no note and is not being edited', async () => {
    await render();
    expect(q('[data-session-note]')).toBeNull();
  });

  it('draws the note main holds, as plain text, with its author', async () => {
    stored = { text: '<b>Waiting</b> on Tanner', by: 'user', at: AT };
    await render();
    expect(q('[data-note-text]')?.textContent).toBe('<b>Waiting</b> on Tanner');
    expect(q('b')).toBeNull();
    expect(q('[data-note-meta]')?.textContent).toMatch(/^You · /);
  });

  it('marks an AI-written note with the AI name', async () => {
    stored = { text: 'Blocked: need your call', by: 'ai', at: AT };
    await render();
    expect(q('[data-session-note]')?.getAttribute('data-note-by')).toBe('ai');
    expect(q('[data-note-meta]')?.textContent).toMatch(/^✦ Claude · /);
  });

  it('opens the editor from outside (the header button), saves on Enter', async () => {
    await render();
    await act(async () => startEditingNote(CARD));
    const box = q<HTMLTextAreaElement>('[data-note-input]')!;
    expect(document.activeElement).toBe(box);
    await act(async () => type(box, 'Need a PR review'));
    await key(box, 'Enter');
    expect(setNote).toHaveBeenCalledWith(CARD, 'Need a PR review');
    expect(q('[data-note-input]')).toBeNull();
    expect(q('[data-note-text]')?.textContent).toBe('Need a PR review');
  });

  it('Esc cancels without saving, and does not reach the card', async () => {
    stored = { text: 'keep', by: 'user', at: AT };
    await render();
    const outer = vi.fn();
    // above React's root: where a window-level shortcut (Esc stops a turn) listens
    document.addEventListener('keydown', outer);
    await act(async () => (q('[data-note-text]') as HTMLButtonElement).click());
    const box = q<HTMLTextAreaElement>('[data-note-input]')!;
    expect(box.value).toBe('keep');
    await act(async () => type(box, 'changed'));
    await key(box, 'Escape');
    expect(setNote).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(q('[data-note-text]')?.textContent).toBe('keep');
  });

  it('saving empty text deletes the note', async () => {
    stored = { text: 'old', by: 'user', at: AT };
    await render();
    await act(async () => (q('[data-note-text]') as HTMLButtonElement).click());
    const box = q<HTMLTextAreaElement>('[data-note-input]')!;
    await act(async () => type(box, '   '));
    await key(box, 'Enter');
    expect(q('[data-session-note]')).toBeNull();
  });

  it('× deletes it for good', async () => {
    stored = { text: 'old', by: 'user', at: AT };
    await render();
    await act(async () => (q('[data-note-delete]') as HTMLButtonElement).click());
    expect(setNote).toHaveBeenCalledWith(CARD, '');
    expect(q('[data-session-note]')).toBeNull();
  });

  it('a quick pick fills the box, ready to finish by typing', async () => {
    await render();
    await act(async () => startEditingNote(CARD));
    await act(async () => (q('[data-note-pick="sessionNote.pick.waiting"]') as HTMLButtonElement).click());
    expect(q<HTMLTextAreaElement>('[data-note-input]')!.value).toBe('Waiting on ');
  });

  it('follows a change main pushes (another surface, or the AI later)', async () => {
    await render();
    await act(async () => push?.({ cardId: CARD, note: { text: 'from elsewhere', by: 'user', at: AT } }));
    expect(q('[data-note-text]')?.textContent).toBe('from elsewhere');
    await act(async () => push?.({ cardId: CARD }));
    expect(q('[data-session-note]')).toBeNull();
  });

  it('fails open: a save that throws closes the editor and keeps the old note', async () => {
    stored = { text: 'old', by: 'user', at: AT };
    setNote.mockRejectedValue(new Error('gone'));
    await render();
    await act(async () => (q('[data-note-text]') as HTMLButtonElement).click());
    const box = q<HTMLTextAreaElement>('[data-note-input]')!;
    await act(async () => type(box, 'new'));
    await key(box, 'Enter');
    expect(q('[data-note-text]')?.textContent).toBe('old');
  });
});

describe('helpers', () => {
  it('pickText turns a trailing ellipsis into a space', () => {
    expect(pickText(en.sessionNote.pick.waiting)).toBe('Waiting on ');
    expect(pickText('Blocked: ')).toBe('Blocked: ');
  });

  it('noteMeta says Today for a note written today', () => {
    const t = (k: string, v?: Record<string, string>): string =>
      k === 'sessionNote.today' ? `Today ${v?.time}` : k === 'sessionNote.meta' ? `${v?.who} · ${v?.when}` : k;
    const now = Date.parse(AT);
    expect(noteMeta({ text: 'x', by: 'user', at: AT }, t, now, 'en-US')).toMatch(/^sessionNote\.byYou · Today /);
    expect(noteMeta({ text: 'x', by: 'user', at: AT }, t, now + 3 * 86400000, 'en-US')).not.toContain('Today');
  });
});
