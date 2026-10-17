// @vitest-environment jsdom
// The AI switch chip and its menu (#1294, screen 2). The decisions are pinned
// in `lib/ai-switch-view.test.ts`; this pins the behaviour only a mounted menu
// has: a pick asks main, a busy session is a QUESTION with Cancel focused, a
// missing AI opens Manage AIs instead of switching, and the keyboard walks it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { AiSwitchChip } from './AiSwitchChip';
import { initI18nForTests } from '../i18n/test-i18n';
import { registerSettingsOpener } from '../lib/settings-port';
import { STOP_ARM_MS } from './SessionHistoryDialog';
import type { SwitchAiNext } from '../lib/ai-switch-view';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let switched: Array<[string, boolean]>;
let answers: SwitchAiNext[];
let openedSettings: unknown[];
let unregister: () => void;

const ITEMS = [
  {
    kind: 'catalog',
    entry: { id: 'claude-code', name: 'Claude Code', icon: 'claude-code.svg' },
    providerId: 'claude-code',
    registered: true,
    detection: { installed: true, login: 'logged-in', account: 'dan@example.com', plan: 'max', probedAt: 0 },
  },
  { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true },
  {
    kind: 'catalog',
    entry: { id: 'gemini', name: 'Gemini CLI', icon: 'gemini.svg' },
    registered: false,
    detection: { installed: false, login: 'unknown', probedAt: 0 },
  },
];

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  switched = [];
  answers = [];
  openedSettings = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    ais: { list: () => Promise.resolve(ITEMS), onChanged: () => () => {} },
  };
  unregister = registerSettingsOpener((s) => openedSettings.push(s));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  unregister();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() =>
    root.render(
      <AiSwitchChip
        providerId="claude-code"
        aiName="Claude Code"
        onSwitch={(id, stopFirst) => {
          switched.push([id, stopFirst]);
          return Promise.resolve(answers.shift() ?? { kind: 'rearm' });
        }}
      />
    )
  );
  await settle();
}

const chip = (): HTMLButtonElement => host.querySelector('[data-testid="composer-ai"]')!;
const menu = (): HTMLElement | null => document.querySelector('[data-testid="ai-switch-menu"]');
const row = (key: string): HTMLButtonElement => document.querySelector(`[data-ai-row="${key}"]`)!;
async function open(): Promise<void> {
  act(() => chip().click());
  await settle();
}

describe('AiSwitchChip (#1294)', () => {
  it('the chip names the AI the card is on, with its icon', async () => {
    await mount();
    expect(chip().textContent).toBe('Claude Code');
    expect(chip().querySelector('img')?.getAttribute('src')).toBe('ai-icons/claude-code.svg');
  });

  it('the menu: every AI, the current one ticked, the missing one dimmed with "set it up…", the sentence, Manage AIs', async () => {
    await mount();
    await open();
    const text = menu()!.textContent ?? '';
    expect(row('claude-code').getAttribute('aria-checked')).toBe('true');
    expect(row('claude-code').textContent).toContain('Logged in as dan@example.com · max');
    expect(row('fake-acp').getAttribute('aria-checked')).toBe('false');
    expect(row('catalog:gemini').dataset.missing).toBe('yes');
    expect(row('catalog:gemini').textContent).toContain('Not installed — set it up…');
    expect(text).toContain('Switching hands this card to another AI. Coming back resumes where that AI left off.');
    expect(text).toContain('Manage AIs…');
  });

  it('a pick switches THIS card, and closes', async () => {
    await mount();
    await open();
    act(() => row('fake-acp').click());
    await settle();
    expect(switched).toEqual([['fake-acp', false]]);
    expect(menu()).toBeNull();
  });

  it('picking the AI it is already on switches nothing', async () => {
    await mount();
    await open();
    act(() => row('claude-code').click());
    await settle();
    expect(switched).toEqual([]);
    expect(menu()).toBeNull();
  });

  it('a busy session is a QUESTION: Cancel has the focus and changes nothing; the yes is armed late and resends with stopFirst', async () => {
    vi.useFakeTimers();
    answers = [{ kind: 'ask', busy: 'working' }];
    await mount();
    await open();
    act(() => row('fake-acp').click());
    await settle();
    const ask = document.querySelector('[data-ai-switch-confirm]')!;
    expect(ask.textContent).toContain('Switching stops the current turn. Switch anyway?');
    const cancel = document.querySelector<HTMLButtonElement>('[data-ai-switch-confirm-cancel]')!;
    const ok = document.querySelector<HTMLButtonElement>('[data-ai-switch-confirm-ok]')!;
    expect(document.activeElement).toBe(cancel);
    expect(ok.disabled).toBe(true);

    // Cancel: back to the list, nothing sent but the first ask
    act(() => cancel.click());
    expect(document.querySelector('[data-ai-switch-confirm]')).toBeNull();
    expect(switched).toEqual([['fake-acp', false]]);

    // ask again, and say yes once it is armed
    answers = [{ kind: 'ask', busy: 'working' }];
    act(() => row('fake-acp').click());
    await settle();
    act(() => {
      vi.advanceTimersByTime(STOP_ARM_MS);
    });
    const ok2 = document.querySelector<HTMLButtonElement>('[data-ai-switch-confirm-ok]')!;
    expect(ok2.disabled).toBe(false);
    act(() => ok2.click());
    await settle();
    expect(switched).toEqual([
      ['fake-acp', false],
      ['fake-acp', false],
      ['fake-acp', true],
    ]);
  });

  it('a refusal keeps the menu open and says why', async () => {
    answers = [{ kind: 'notice', key: 'aiSwitch.refusedUnavailable' }];
    await mount();
    await open();
    act(() => row('fake-acp').click());
    await settle();
    expect(menu()).not.toBeNull();
    expect(document.querySelector('[data-ai-switch-notice]')?.textContent).toBe(
      'Fake ACP is not available in this run, so the card stays where it is.'
    );
  });

  it('a missing AI, and Manage AIs…, open Settings instead of switching', async () => {
    await mount();
    await open();
    act(() => row('catalog:gemini').click());
    await settle();
    expect(switched).toEqual([]);
    expect(openedSettings).toHaveLength(1);
    await open();
    act(() => document.querySelector<HTMLButtonElement>('[data-ai-manage]')!.click());
    expect(openedSettings).toHaveLength(2);
  });

  it('the keyboard: it opens on the current AI, the arrows walk and wrap, Escape closes to the chip', async () => {
    await mount();
    await open();
    expect(document.activeElement).toBe(row('claude-code'));
    const key = (k: string): void =>
      act(() => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    key('ArrowDown');
    expect(document.activeElement).toBe(row('fake-acp'));
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement).toBe(document.querySelector('[data-ai-manage]'));
    key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('with no AI list (an older preload) it still names its AI and says the list is not available', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {};
    await mount();
    await open();
    expect(row('claude-code').getAttribute('aria-checked')).toBe('true');
    expect(menu()!.textContent).toContain('The list of AIs is not available. This card stays on Claude Code.');
  });
});
