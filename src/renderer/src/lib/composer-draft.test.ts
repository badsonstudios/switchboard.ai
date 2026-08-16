// The saved composer draft, and the debounce underneath it (#485).
//
// The seam this pins is the one the feature actually rests on: the cache is
// correct SYNCHRONOUSLY (which is what makes a remount survivable) while the
// IPC is coalesced (which is what makes save-on-every-keystroke affordable).
// A test that only checked "it eventually saves" would stay green if the write
// were moved onto the timer, and the popout would still lose the draft.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearDraft,
  draftKey,
  loadDraft,
  MAX_DRAFT_CHARS,
  pruneDrafts,
  saveDraft,
  staleDraftKeys,
} from './composer-draft';
import { loadUiState, uiFlush, uiGet, UI_PUSH_DELAY_MS } from './ui-state';

let sent: Array<Record<string, unknown>>;

/** the preload bridge, and nothing else */
function bridge(initial: Record<string, unknown> = {}) {
  sent = [];
  vi.stubGlobal('window', {
    switchboard: {
      workspace: {
        getUi: () => Promise.resolve(initial),
        // structuredClone-ish: main receives a snapshot, so a later mutation of
        // the live cache must not appear to have been sent
        setUi: (ui: unknown) => sent.push({ ...(ui as Record<string, unknown>) }),
      },
    },
  });
}

/** what main has actually been told, last write wins */
const persisted = (key: string): unknown =>
  sent.length === 0 ? undefined : sent[sent.length - 1][key];

beforeEach(async () => {
  vi.useFakeTimers();
  bridge();
  await loadUiState(); // start from an empty blob every time
});

afterEach(() => {
  uiFlush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saveDraft', () => {
  it('is readable IMMEDIATELY, before any IPC — this is what survives a remount', () => {
    saveDraft('card-1', 'half a thought');
    // no timer has run, nothing has been sent...
    expect(sent).toHaveLength(0);
    // ...and a component that mounts on the very next tick still gets it
    expect(loadDraft('card-1')).toBe('half a thought');
  });

  it('coalesces a burst of keystrokes into ONE push, within the delay', () => {
    for (const text of ['w', 'wr', 'wri', 'writ', 'write']) saveDraft('card-1', text);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(sent).toHaveLength(1);
    expect(persisted(draftKey('card-1'))).toBe('write');
  });

  it('measures the delay from the FIRST unsent change, so typing cannot starve it', () => {
    // A trailing debounce that reset on every keystroke would never fire for
    // someone who keeps typing — the one user who has the most to lose.
    saveDraft('card-1', 'a');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS - 50);
    saveDraft('card-1', 'ab');
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);
    expect(persisted(draftKey('card-1'))).toBe('ab');
  });

  it('keeps drafts per card', () => {
    saveDraft('card-1', 'for one');
    saveDraft('card-2', 'for two');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(loadDraft('card-1')).toBe('for one');
    expect(loadDraft('card-2')).toBe('for two');
    expect(persisted(draftKey('card-1'))).toBe('for one');
    expect(persisted(draftKey('card-2'))).toBe('for two');
  });

  it('stores NOTHING for an empty draft — an untouched card costs no entry', () => {
    saveDraft('card-1', 'typed');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    saveDraft('card-1', '');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(Object.keys(sent[sent.length - 1])).not.toContain(draftKey('card-1'));
    expect(loadDraft('card-1')).toBe('');
  });

  it('treats whitespace as empty, like the send button already does', () => {
    saveDraft('card-1', '   \n  ');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(loadDraft('card-1')).toBe('');
  });

  it('refuses a draft past the ceiling rather than parking it in the workspace file', () => {
    // The whole blob is cloned to main on every push and re-serialized on every
    // save, so one card's paste must not be a tax on every other preference.
    // It stays in the BOX — this only declines to persist it.
    saveDraft('card-1', 'x'.repeat(MAX_DRAFT_CHARS + 1));
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(loadDraft('card-1')).toBe('');
    saveDraft('card-2', 'x'.repeat(MAX_DRAFT_CHARS));
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(loadDraft('card-2')).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('does nothing at all without a card id — never files a draft under a guess', () => {
    saveDraft(undefined, 'homeless');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(sent).toHaveLength(0);
    expect(loadDraft(undefined)).toBe('');
  });
});

describe('clearDraft', () => {
  it('forgets it IMMEDIATELY, not on the timer', () => {
    // A deletion left on the debounce can be beaten by a quit or a remount, and
    // then a prompt the user already sent reappears in an empty composer.
    saveDraft('card-1', 'about to be sent');
    clearDraft('card-1');
    expect(sent).toHaveLength(1); // pushed now, without advancing anything
    expect(Object.keys(sent[0])).not.toContain(draftKey('card-1'));
    expect(loadDraft('card-1')).toBe('');
  });

  it('cancels a save that was still in flight', () => {
    saveDraft('card-1', 'about to be sent');
    clearDraft('card-1');
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS * 2);
    // the pending timer must not resurrect the draft it was going to save
    expect(sent).toHaveLength(1);
    expect(loadDraft('card-1')).toBe('');
  });
});

describe('staleDraftKeys / pruneDrafts', () => {
  const blob = {
    [draftKey('gone')]: 'orphan',
    [draftKey('alive')]: 'still typing',
    railHidden: true,
    'feedVerbosity.gone': 'quiet',
  };

  it('names only the draft keys whose card is gone', () => {
    expect(staleDraftKeys(blob, new Set(['alive']))).toEqual([draftKey('gone')]);
  });

  it('leaves everything that is not a draft alone', () => {
    // the sweep runs beside five siblings that own the other prefixes; a
    // prefix match that was too loose would delete their records too
    const stale = staleDraftKeys(blob, new Set(['alive']));
    expect(stale).not.toContain('railHidden');
    expect(stale).not.toContain('feedVerbosity.gone');
  });

  it('deletes NOTHING when the card list came back empty', () => {
    // "the IPC failed" and "you have no cards" are the same value here, and
    // only one of them makes it safe to throw away unsent prompts.
    expect(staleDraftKeys(blob, new Set())).toEqual([]);
  });

  it('pruneDrafts writes the survivors back through the store', async () => {
    bridge(blob);
    await loadUiState();
    pruneDrafts(new Set(['alive']));
    expect(loadDraft('gone')).toBe('');
    expect(loadDraft('alive')).toBe('still typing');
    expect(persisted(draftKey('gone'))).toBeUndefined();
    expect(persisted('railHidden')).toBe(true);
  });
});

describe('loadDraft', () => {
  it('reads what a previous run left in the blob — the relaunch case', async () => {
    bridge({ [draftKey('card-7')]: 'from last launch', railHidden: true });
    await loadUiState();
    expect(loadDraft('card-7')).toBe('from last launch');
    // and it left the rest of the blob alone
    expect(uiGet('railHidden', false)).toBe(true);
  });

  it('shrugs off a value that is not a string', async () => {
    // a hand-edited workspace file, or a key an older build wrote. A composer
    // that throws on mount is a card you cannot use, over a draft.
    bridge({ [draftKey('card-7')]: { not: 'a string' } });
    await loadUiState();
    expect(loadDraft('card-7')).toBe('');
  });
});
