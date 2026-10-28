// @vitest-environment jsdom
// The per-session setting on the session's own card (#1168).
//
// It used to be a ticked list on the left list's right-click menu. The owner
// chose one short session menu for both placements, and it moved to the
// card's "…" menu. The claims: the row shows the choice in force, a choice
// writes the same book the old menu wrote, and "follow the default" is a way
// back that stores nothing. The "On submit" row beside it is gone (#1485).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { CardPolicyRows } from './CardPolicyRows';
import { sessionStore } from '../store/session-store';
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
  sessionStore.setFocusPolicies(DEFAULT_FOCUS_BOOK);
  sessionStore.setSessions([]);
});

describe('"On submit" is gone (issue 1485)', () => {
  it('the card offers no "On submit" choice: sending a prompt never moves a card', async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="card-policy"]')).toBeNull();
    expect(host.textContent).not.toContain('On submit');
    expect(host.querySelectorAll('select')).toHaveLength(1);
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
