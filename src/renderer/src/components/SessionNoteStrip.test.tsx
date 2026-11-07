// @vitest-environment jsdom
// The sticky note strip (#1544): draws main's note, edits it, deletes it, and
// shows what main ANSWERED rather than what was typed.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import type { SessionNote, SessionNoteChange } from '../../../shared/session-note';
import {
  notePlacementOf,
  resetSessionNotesForTests,
  setNoteSession,
  setNotePlacement,
  startEditingNote,
} from '../lib/session-notes';
import * as nativeDialog from '../lib/native-dialog';
import {
  SessionNoteChip,
  SessionNoteCorner,
  SessionNoteLine,
  SessionNoteStrip,
  noteMeta,
  pickText,
} from './SessionNoteStrip';

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
const askForNote = vi.fn();

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  resetSessionNotesForTests();
  stored = null;
  push = null;
  setNote.mockReset();
  askForNote.mockReset();
  askForNote.mockResolvedValue({ ok: true });
  setNote.mockImplementation(async (_card: string, text: string) => {
    const clean = text.trim();
    stored = clean ? { text: clean, by: 'user', at: AT } : null;
    return stored;
  });
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      note: async () => stored,
      setNote,
      askForNote,
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

describe('placements (part 2)', () => {
  async function renderAll(): Promise<void> {
    await act(async () => {
      root.render(
        <>
          <SessionNoteStrip cardId={CARD} />
          <SessionNoteLine cardId={CARD} />
          <SessionNoteCorner cardId={CARD} />
          <SessionNoteChip cardId={CARD} />
        </>
      );
    });
  }
  const placements = (): string[] =>
    Array.from(host.querySelectorAll('[data-session-note]')).map((e) => e.getAttribute('data-note-placement') ?? '');

  it('draws the note in exactly one place, the chosen one, and moves when the choice does', async () => {
    stored = { text: 'Need a PR review', by: 'user', at: AT };
    await renderAll();
    expect(placements()).toEqual(['band']);
    await act(async () => setNotePlacement('header'));
    expect(placements()).toEqual(['line']);
    await act(async () => setNotePlacement('corner'));
    expect(placements()).toEqual(['corner']);
    // D draws a chip, and the note itself only once the chip is clicked
    await act(async () => setNotePlacement('chip'));
    expect(placements()).toEqual([]);
    expect(q('[data-note-chip]')?.textContent).toBe('Need a PR review');
  });

  it('D: the chip opens the note in a popover; Esc and a click elsewhere close it', async () => {
    stored = { text: 'Waiting on Tanner', by: 'user', at: AT };
    setNotePlacement('chip');
    await renderAll();
    const chip = q<HTMLButtonElement>('[data-note-chip]')!;
    await act(async () => chip.click());
    expect(placements()).toEqual(['popover']);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    await key(q('[data-note-text]')!, 'Escape');
    expect(placements()).toEqual([]);
    await act(async () => chip.click());
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(placements()).toEqual([]);
  });

  it('D: the 📝 button opens the editor in the popover even with no note yet', async () => {
    setNotePlacement('chip');
    await renderAll();
    expect(q('[data-note-chip]')).toBeNull();
    await act(async () => startEditingNote(CARD));
    expect(placements()).toEqual(['popover']);
    expect(q('[data-note-input]')).not.toBeNull();
  });

  it('D: Esc closes the popover with focus still on the chip', async () => {
    stored = { text: 'Waiting on Tanner', by: 'user', at: AT };
    setNotePlacement('chip');
    await renderAll();
    const chip = q<HTMLButtonElement>('[data-note-chip]')!;
    await act(async () => chip.click());
    expect(placements()).toEqual(['popover']);
    await key(chip, 'Escape');
    expect(placements()).toEqual([]);
  });

  it('D: a note deleted elsewhere closes its popover, and the next note does not reopen it', async () => {
    stored = { text: 'first', by: 'user', at: AT };
    setNotePlacement('chip');
    await renderAll();
    await act(async () => q<HTMLButtonElement>('[data-note-chip]')!.click());
    await act(async () => push?.({ cardId: CARD }));
    expect(placements()).toEqual([]);
    await act(async () => push?.({ cardId: CARD, note: { text: 'second', by: 'ai', at: AT } }));
    expect(placements()).toEqual([]);
    expect(q('[data-note-chip]')?.textContent).toBe('second');
  });

  it('D: switching placement away and back does not bring an open popover back', async () => {
    stored = { text: 'n', by: 'user', at: AT };
    setNotePlacement('chip');
    await renderAll();
    await act(async () => q<HTMLButtonElement>('[data-note-chip]')!.click());
    await act(async () => setNotePlacement('header'));
    await act(async () => setNotePlacement('chip'));
    expect(placements()).toEqual([]);
  });

  it('B: a long note is one line, and its whole text is on hover', async () => {
    const long = 'x'.repeat(180);
    stored = { text: long, by: 'user', at: AT };
    setNotePlacement('header');
    await renderAll();
    const text = q<HTMLElement>('[data-note-text]')!;
    expect(text.style.whiteSpace).toBe('nowrap');
    expect(text.title).toBe(long);
  });

  it('reads a stored placement it does not know as the default', () => {
    expect(notePlacementOf('corner')).toBe('corner');
    expect(notePlacementOf('sideways')).toBe('prompt');
    expect(notePlacementOf(undefined)).toBe('prompt');
  });
});

describe('"Let Claude write it" (part 3)', () => {
  const askButton = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-note-ask-ai]');

  it('is not offered when the card has no live session', async () => {
    await render();
    await act(async () => startEditingNote(CARD));
    expect(askButton()).toBeNull();
  });

  it('on an idle session, sends the request at once and closes the editor', async () => {
    await render();
    await act(async () => setNoteSession(CARD, { liveId: 'live-1', status: 'idle', aiName: 'Claude' }));
    await act(async () => startEditingNote(CARD));
    expect(askButton()?.textContent).toBe('✦ Let Claude write it');
    const confirm = vi.spyOn(nativeDialog, 'nativeConfirm');
    await act(async () => askButton()!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(askForNote).toHaveBeenCalledWith('live-1');
    expect(q('[data-note-input]')).toBeNull();
    confirm.mockRestore();
  });

  it('on a busy session, asks first, and a No sends nothing', async () => {
    await render();
    await act(async () => setNoteSession(CARD, { liveId: 'live-1', status: 'working', aiName: 'Claude' }));
    await act(async () => startEditingNote(CARD));
    const confirm = vi.spyOn(nativeDialog, 'nativeConfirm').mockReturnValue(false);
    await act(async () => askButton()!.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(askForNote).not.toHaveBeenCalled();
    expect(q('[data-note-input]')).not.toBeNull();
    confirm.mockReturnValue(true);
    await act(async () => askButton()!.click());
    expect(askForNote).toHaveBeenCalledWith('live-1');
    confirm.mockRestore();
  });

  it('keeps a half-typed note when the request is sent, and says what happens next', async () => {
    await render();
    await act(async () => setNoteSession(CARD, { liveId: 'live-1', status: 'idle' }));
    await act(async () => startEditingNote(CARD));
    const box = q<HTMLTextAreaElement>('[data-note-input]')!;
    await act(async () => type(box, 'my own words'));
    await act(async () => askButton()!.click());
    expect(askForNote).toHaveBeenCalledWith('live-1');
    expect(q<HTMLTextAreaElement>('[data-note-input]')?.value).toBe('my own words');
    expect(q('[data-note-ask-error]')?.textContent).toBe(en.sessionNote.askSent);
  });

  it('an answer it does not know reads as "could not be sent", never a raw key', async () => {
    askForNote.mockResolvedValue({ ok: false, reason: 'something-new' });
    await render();
    await act(async () => setNoteSession(CARD, { liveId: 'live-1', status: 'idle' }));
    await act(async () => startEditingNote(CARD));
    await act(async () => askButton()!.click());
    expect(q('[data-note-ask-error]')?.textContent).toBe(en.sessionNote.askFailed['not-sent']);
  });

  it('says why when it cannot, and keeps the editor open to type it instead', async () => {
    askForNote.mockResolvedValue({ ok: false, reason: 'no-tools' });
    await render();
    await act(async () => setNoteSession(CARD, { liveId: 'live-1', status: 'idle' }));
    await act(async () => startEditingNote(CARD));
    await act(async () => askButton()!.click());
    expect(q('[data-note-ask-error]')?.textContent).toBe(en.sessionNote.askFailed['no-tools']);
    expect(q('[data-note-input]')).not.toBeNull();
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
