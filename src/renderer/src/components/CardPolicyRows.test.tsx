// @vitest-environment jsdom
// The two per-session settings on the session's own card (#1168).
//
// They used to be two ticked lists on the left list's right-click menu. The
// owner chose one short session menu for both placements, and these moved to
// the card's "…" menu. The claims: each row shows the choice in force, each
// choice writes the same book the old menu wrote, and "follow the default" is
// a way back that stores nothing.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { CardPolicyRows } from './CardPolicyRows';
import { sessionStore } from '../store/session-store';
import {
  cardOverride,
  DEFAULT_BOOK,
  resolvePolicy,
  withGlobal,
  withGroup,
} from '../lib/presentation-policy';
import {
  DEFAULT_FOCUS_BOOK,
  focusOverride,
  resolveFocusPolicy,
  withFocusGlobal,
} from '../lib/focus-policy';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(cardId = 'a'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<CardPolicyRows cardId={cardId} />);
  });
  return host;
}

const select = (host: HTMLElement, id: string): HTMLSelectElement =>
  host.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!;

const optionsOf = (el: HTMLSelectElement): string[] =>
  Array.from(el.options).map((o) => o.textContent ?? '');

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  sessionStore.setPolicies(DEFAULT_BOOK);
  sessionStore.setFocusPolicies(DEFAULT_FOCUS_BOOK);
  sessionStore.setSessions([
    { id: 'a', title: 'alpha', status: 'idle' },
    { id: 'b', title: 'beta', status: 'idle', groupId: 'g1' },
  ]);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  sessionStore.setPolicies(DEFAULT_BOOK);
  sessionStore.setFocusPolicies(DEFAULT_FOCUS_BOOK);
  sessionStore.setSessions([]);
});

describe('"On submit", for this one session (issue 1168)', () => {
  it('starts on "follow the default", and says what the default is right now', async () => {
    const host = await mount();
    const el = select(host, 'card-policy');
    expect(el.value).toBe('default');
    expect(optionsOf(el)).toEqual([
      'Follow the default (Keep visible)',
      'Keep visible',
      'Collapse on submit',
      'Hide on submit',
    ]);
  });

  it('is named by the words beside it', async () => {
    const host = await mount();
    const el = select(host, 'card-policy');
    expect(host.querySelector(`label[for="${el.id}"]`)!.textContent).toBe('On submit');
  });

  it('a choice is stored for THIS session, and shown as the choice in force', async () => {
    const host = await mount();
    await choose(select(host, 'card-policy'), 'auto-hide');
    expect(cardOverride(sessionStore.getPolicies(), 'a')).toBe('auto-hide');
    expect(cardOverride(sessionStore.getPolicies(), 'b')).toBeUndefined();
    expect(select(host, 'card-policy').value).toBe('auto-hide');
  });

  it('"follow the default" stores nothing, so a later change to the default is followed', async () => {
    const host = await mount();
    await choose(select(host, 'card-policy'), 'auto-collapse');
    await choose(select(host, 'card-policy'), 'default');
    expect(cardOverride(sessionStore.getPolicies(), 'a')).toBeUndefined();
    await act(async () => {
      sessionStore.setPolicies(withGlobal(sessionStore.getPolicies(), 'auto-hide'));
    });
    expect(resolvePolicy(sessionStore.getPolicies(), 'a', undefined)).toBe('auto-hide');
    expect(optionsOf(select(host, 'card-policy'))[0]).toBe('Follow the default (Hide on submit)');
  });

  it('for a session in a group, the default it names is the GROUP’s when the group has one', async () => {
    sessionStore.setPolicies(withGroup(DEFAULT_BOOK, 'g1', 'auto-collapse'));
    const host = await mount('b');
    expect(optionsOf(select(host, 'card-policy'))[0]).toBe(
      'Follow the default (Collapse on submit)'
    );
  });
});

describe('"When it needs you", for this one session (issue 1168)', () => {
  it('starts on "follow the default", with the four named choices after it', async () => {
    const host = await mount();
    const el = select(host, 'card-focus-policy');
    expect(el.value).toBe('default');
    expect(optionsOf(el).slice(1)).toEqual([
      'Always jump to it',
      "Jump if it's on screen",
      'Never jump, just mark it',
      'Never jump, skip the queue',
    ]);
    expect(host.querySelector(`label[for="${el.id}"]`)!.textContent).toBe('When it needs you');
  });

  it('a choice is stored for THIS session and no other', async () => {
    const host = await mount();
    await choose(select(host, 'card-focus-policy'), 'none');
    expect(focusOverride(sessionStore.getFocusPolicies(), 'a')).toBe('none');
    expect(focusOverride(sessionStore.getFocusPolicies(), 'b')).toBeUndefined();
    expect(select(host, 'card-focus-policy').value).toBe('none');
    // and the other setting on the card is untouched
    expect(cardOverride(sessionStore.getPolicies(), 'a')).toBeUndefined();
  });

  it('"follow the default" is the way back, and follows the default from then on', async () => {
    const host = await mount();
    await choose(select(host, 'card-focus-policy'), 'urgent');
    await choose(select(host, 'card-focus-policy'), 'default');
    expect(focusOverride(sessionStore.getFocusPolicies(), 'a')).toBeUndefined();
    await act(async () => {
      sessionStore.setFocusPolicies(withFocusGlobal(sessionStore.getFocusPolicies(), 'none'));
    });
    expect(resolveFocusPolicy(sessionStore.getFocusPolicies(), 'a')).toBe('none');
    expect(optionsOf(select(host, 'card-focus-policy'))[0]).toBe(
      'Follow the default (Never jump, skip the queue)'
    );
  });
});
