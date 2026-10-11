// @vitest-environment jsdom
// The line that says a card was put away on submit, and why (#1210).
//
// The owner pressed Enter and the card he was typing in left the screen; the
// setting responsible had been on for hours. The claims here: the sentence
// names the session, the setting and the LEVEL that decided; "Stop doing this"
// turns the setting off at that level and not another; the strip leaves by
// itself when the card is back; and the status region exists before it speaks.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import {
  resetSubmitNoticeMuteForTests,
  SubmitNotice,
  SubmitPolicyNotice,
  submitNoticeMuted,
} from './SubmitPolicyNotice';
import { sessionStore } from '../store/session-store';
import { DEFAULT_BOOK, withCard, withGlobal, withGroup } from '../lib/presentation-policy';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const onRestore = vi.fn<(cardId: string) => void>();
const onDismiss = vi.fn<() => void>();

async function show(notice: SubmitNotice | null): Promise<void> {
  await act(async () => {
    root!.render(
      <SubmitPolicyNotice notice={notice} onRestore={onRestore} onDismiss={onDismiss} />
    );
  });
}

const strip = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="submit-notice"]')!;
const button = (id: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-testid="submit-notice-${id}"]`)!;
const click = async (id: string): Promise<void> => {
  await act(async () => button(id).click());
};

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onRestore.mockReset();
  onDismiss.mockReset();
  resetSubmitNoticeMuteForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sessionStore.setPolicies(DEFAULT_BOOK);
  sessionStore.setSessions([
    { id: 'a', title: 'alpha', status: 'working' },
    { id: 'b', title: 'beta', status: 'working', groupId: 'g1' },
  ]);
  sessionStore.setPresentation('a', { ladder: 'expanded' });
  sessionStore.setPresentation('b', { ladder: 'expanded' });
});

afterEach(async () => {
  const r = root;
  root = null;
  await act(async () => r?.unmount());
  vi.restoreAllMocks();
});

describe('the submit notice (#1210)', () => {
  it('says nothing, and offers nothing, until a card has been put away', async () => {
    await show(null);
    // the region is there BEFORE it has anything to say, or a screen reader
    // is not told when the words arrive
    expect(strip().querySelector('[role="status"]')).not.toBeNull();
    expect(strip().textContent).toBe('');
    expect(strip().querySelectorAll('button')).toHaveLength(0);
    expect(strip().className).toBe('');
  });

  it('names the session and the setting that hid it', async () => {
    sessionStore.setPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    await show({ cardId: 'a', rung: 'hidden' });
    const said = strip().querySelector('[role="status"]')!.textContent;
    expect(said).toContain('alpha was hidden because “Hide on submit” is on.');
    // the buttons are OUTSIDE the live region: it announces the sentence only
    expect(strip().querySelector('[role="status"] button')).toBeNull();
    expect(strip().querySelectorAll('button')).toHaveLength(3);
  });

  it('says which LEVEL decided: this session, its group, or everything', async () => {
    sessionStore.setPolicies(withGroup(DEFAULT_BOOK, 'g1', 'auto-collapse'));
    await show({ cardId: 'b', rung: 'collapsed' });
    expect(strip().textContent).toContain('“Collapse on submit” is on for its group');

    sessionStore.setPolicies(withCard(DEFAULT_BOOK, 'b', 'auto-hide'));
    await show({ cardId: 'b', rung: 'hidden' });
    expect(strip().textContent).toContain('“Hide on submit” is on for this session');
  });

  it('Bring it back asks for the card and leaves the setting alone', async () => {
    sessionStore.setPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    await show({ cardId: 'a', rung: 'hidden' });
    await click('restore');
    expect(onRestore).toHaveBeenCalledWith('a');
    expect(sessionStore.getPolicies().global).toBe('auto-hide');
  });

  it('Stop doing this turns the setting off AT THE LEVEL THAT DECIDED, and brings the card back', async () => {
    // the group says hide; the global says hide too. Clearing the global would
    // leave this card hiding on the next prompt, and the button would look dead.
    sessionStore.setPolicies(withGroup(withGlobal(DEFAULT_BOOK, 'auto-hide'), 'g1', 'auto-hide'));
    await show({ cardId: 'b', rung: 'hidden' });
    await click('off');
    expect(sessionStore.policyFor('b')).toBe('always-visible');
    expect(sessionStore.getPolicies().groups.g1).toBe('always-visible');
    // ...and ONLY that level: the ungrouped card still follows the global
    expect(sessionStore.policyFor('a')).toBe('auto-hide');
    expect(onRestore).toHaveBeenCalledWith('b');
  });

  it('leaves by itself once the card is back on screen', async () => {
    sessionStore.setPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    // the notice can arrive a beat BEFORE the store records the move: the old
    // rung at that instant must not read as "it came back"
    await show({ cardId: 'a', rung: 'hidden' });
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => sessionStore.setPresentation('a', { ladder: 'hidden' }));
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => sessionStore.setPresentation('a', { ladder: 'expanded' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a card brought back as a TAB is back too', async () => {
    // it has a panel and is on screen; a strip still saying "was hidden" is stale
    await act(async () => sessionStore.setPresentation('a', { ladder: 'hidden' }));
    await show({ cardId: 'a', rung: 'hidden' });
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => sessionStore.setPresentation('a', { ladder: 'tabbed' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a second notice, about another card, starts its own watch', async () => {
    await act(async () => sessionStore.setPresentation('a', { ladder: 'hidden' }));
    await show({ cardId: 'a', rung: 'hidden' });
    // b is put away while a's notice is up; a coming back is no longer the subject
    await act(async () => sessionStore.setPresentation('b', { ladder: 'collapsed' }));
    await show({ cardId: 'b', rung: 'collapsed' });
    await act(async () => sessionStore.setPresentation('a', { ladder: 'expanded' }));
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => sessionStore.setPresentation('b', { ladder: 'expanded' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Stop doing this acts at the level the SENTENCE named, even if the book moved since', async () => {
    sessionStore.setPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    await show({ cardId: 'b', rung: 'hidden' });
    expect(strip().textContent).toContain('“Hide on submit” is on.');
    // an override appears while the strip is up; the button still says "every session"
    await act(async () =>
      sessionStore.setPolicies(withCard(sessionStore.getPolicies(), 'b', 'auto-collapse'))
    );
    await click('off');
    expect(sessionStore.getPolicies().global).toBe('always-visible');
  });

  it('keeps the keyboard when the buttons go: focus rests on the strip, not the body', async () => {
    await act(async () => sessionStore.setPresentation('a', { ladder: 'hidden' }));
    await show({ cardId: 'a', rung: 'hidden' });
    button('mute').focus();
    expect(document.activeElement).toBe(button('mute'));
    // the card comes back by itself while a button has focus
    await act(async () => sessionStore.setPresentation('a', { ladder: 'expanded' }));
    await show(null);
    expect(document.activeElement).toBe(strip());
  });

  it('...and leaves focus alone when the keyboard was somewhere else', async () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    await act(async () => sessionStore.setPresentation('a', { ladder: 'hidden' }));
    await show({ cardId: 'a', rung: 'hidden' });
    elsewhere.focus();
    await act(async () => sessionStore.setPresentation('a', { ladder: 'expanded' }));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('leaves when the session it is about is closed', async () => {
    await show({ cardId: 'a', rung: 'hidden' });
    await act(async () =>
      sessionStore.setSessions([{ id: 'b', title: 'beta', status: 'working', groupId: 'g1' }])
    );
    expect(onDismiss).toHaveBeenCalled();
    expect(strip().querySelectorAll('button')).toHaveLength(0);
  });

  it('Stop telling me silences it for this run and changes no setting', async () => {
    sessionStore.setPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    await show({ cardId: 'a', rung: 'hidden' });
    expect(submitNoticeMuted()).toBe(false);
    await click('mute');
    expect(submitNoticeMuted()).toBe(true);
    expect(onDismiss).toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(sessionStore.getPolicies().global).toBe('auto-hide');
  });
});
