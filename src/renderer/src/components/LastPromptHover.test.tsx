// @vitest-environment jsdom
// Hover a session to see its last prompt (#631).
//
// What it promises: any element that names a card gets the popup after a short
// rest, it is asked for lazily (a pointer passing over asks nothing), it never
// takes a click, it goes away on the first thing you do, and a session that is
// not running says nothing rather than something false.
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
import {
  LAST_PROMPT_ATTR,
  LAST_PROMPT_DELAY_MS,
  LAST_PROMPT_WATCH_MS,
  LastPromptHover,
} from './LastPromptHover';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let calls: string[];
let answer: unknown;

function surface(cardId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(LAST_PROMPT_ATTR, cardId);
  const inner = document.createElement('span');
  inner.textContent = cardId;
  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
}

function fire(type: string, target: EventTarget, init: Record<string, unknown> = {}): void {
  const e = new MouseEvent(type, { bubbles: true, ...init });
  for (const [k, v] of Object.entries(init)) {
    if (!(k in MouseEvent.prototype)) Object.defineProperty(e, k, { value: v });
  }
  act(() => void target.dispatchEvent(e));
}

async function rest(ms = LAST_PROMPT_DELAY_MS + 10): Promise<void> {
  await act(async () => void vi.advanceTimersByTime(ms));
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
}

const popup = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="last-prompt-hover"]');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.useFakeTimers();
  calls = [];
  answer = { text: 'now add the tests', cut: false, attachmentOnly: false };
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      lastPrompt: (liveId: string) => {
        calls.push(liveId);
        return Promise.resolve(answer);
      },
    },
  };
  sessionStore.setSessions([
    { id: 'c1', title: 'api', folder: '/p/api', liveId: 'live-1' },
    { id: 'c2', title: 'web', folder: '/p/web', liveId: 'live-2' },
    { id: 'c3', title: 'stopped', folder: '/p/old' },
  ] as Parameters<typeof sessionStore.setSessions>[0]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<LastPromptHover />));
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  vi.useRealTimers();
  sessionStore.setSessions([]);
});

describe('hovering a session (issue 631)', () => {
  it('shows its last prompt after a short rest, asked for that session’s LIVE id', async () => {
    const el = surface('c1');
    fire('pointerover', el.firstElementChild!);
    expect(popup()).toBeNull(); // not at once
    await rest();
    expect(calls).toEqual(['live-1']);
    expect(popup()!.textContent).toContain('Last prompt');
    expect(popup()!.querySelector('[data-last-prompt-text]')!.textContent).toBe('now add the tests');
    // a hint for a pointer: it claims no role it has not wired
    expect(popup()!.getAttribute('aria-hidden')).toBe('true');
  });

  it('is LAZY: a pointer that only passes over asks for nothing', async () => {
    const a = surface('c1');
    const b = surface('c2');
    fire('pointerover', a);
    await rest(LAST_PROMPT_DELAY_MS - 100);
    fire('pointerover', b);
    await rest(LAST_PROMPT_DELAY_MS - 100);
    fire('pointerover', document.body);
    await rest();
    expect(calls).toEqual([]);
    expect(popup()).toBeNull();
  });

  it('moving within the same session does not restart the wait or ask twice', async () => {
    const el = surface('c1');
    fire('pointerover', el);
    await rest(LAST_PROMPT_DELAY_MS - 100);
    fire('pointerover', el.firstElementChild!);
    await rest(150);
    expect(calls).toEqual(['live-1']);
  });

  it('never takes a click: the popup lets the pointer through', async () => {
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()!.style.pointerEvents).toBe('none');
  });

  it('a message another session sent is headed with who sent it', async () => {
    answer = { text: 'the endpoint moved', cut: false, attachmentOnly: false, from: 'api' };
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()!.querySelector('[data-last-prompt-heading]')!.textContent).toBe(
      'Last message, from api'
    );
  });

  it('goes away when the session’s element is removed while it is up (the session closed)', async () => {
    const el = surface('c1');
    fire('pointerover', el);
    await rest();
    expect(popup()).not.toBeNull();
    el.remove();
    await rest(LAST_PROMPT_WATCH_MS + 10);
    expect(popup()).toBeNull();
  });

  it('goes away when the element MOVES under a still pointer (the list reordered)', async () => {
    const el = surface('c1');
    let top = 10;
    el.getBoundingClientRect = () =>
      ({ left: 0, top, bottom: top + 20, right: 100, width: 100, height: 20 }) as DOMRect;
    fire('pointerover', el);
    await rest();
    expect(popup()).not.toBeNull();
    await rest(LAST_PROMPT_WATCH_MS * 2);
    expect(popup()).not.toBeNull(); // still where it was: stays
    top = 60;
    await rest(LAST_PROMPT_WATCH_MS + 10);
    expect(popup()).toBeNull();
  });

  it('not on a control inside the session that has a tooltip of its own', async () => {
    const el = surface('c1');
    const closeButton = document.createElement('button');
    closeButton.title = 'Close session';
    el.appendChild(closeButton);
    fire('pointerover', closeButton);
    await rest();
    expect(calls).toEqual([]);
    expect(popup()).toBeNull();
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'scroll', 'dragstart'])('goes away on %s', async (type) => {
    const el = surface('c1');
    fire('pointerover', el);
    await rest();
    expect(popup()).not.toBeNull();
    fire(type, el);
    expect(popup()).toBeNull();
  });

  it('goes away when the pointer leaves for somewhere that is not a session', async () => {
    fire('pointerover', surface('c1'));
    await rest();
    fire('pointerover', document.body);
    expect(popup()).toBeNull();
  });

  it('a late answer for a session the pointer has left is shown to nobody', async () => {
    let release: (v: unknown) => void = () => undefined;
    (window as unknown as { switchboard: { transcripts: { lastPrompt: unknown } } }).switchboard.transcripts.lastPrompt =
      () => new Promise((r) => (release = r));
    fire('pointerover', surface('c1'));
    await rest();
    fire('pointerover', document.body);
    await act(async () => release({ text: 'too late', cut: false, attachmentOnly: false }));
    await rest(10);
    expect(popup()).toBeNull();
  });
});

describe('when there is nothing to say', () => {
  it('a running session that has not been asked anything: "No prompts yet"', async () => {
    answer = { text: null, cut: false, attachmentOnly: false };
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()!.querySelector('[data-last-prompt-text]')!.textContent).toBe('No prompts yet');
  });

  it('a prompt that was only an attachment says that', async () => {
    answer = { text: null, cut: false, attachmentOnly: true };
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()!.querySelector('[data-last-prompt-text]')!.textContent).toBe(
      'An attachment, with no text'
    );
  });

  it('⚠️ a session that is NOT running says nothing: "No prompts yet" would be false for one with a history', async () => {
    fire('pointerover', surface('c3'));
    await rest();
    expect(calls).toEqual([]);
    expect(popup()).toBeNull();
  });

  it('a cut prompt ends in an ellipsis', async () => {
    answer = { text: 'a very long prompt', cut: true, attachmentOnly: false };
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()!.querySelector('[data-last-prompt-text]')!.textContent).toBe('a very long prompt…');
  });

  it('no answer, "cannot say", a refusal, a rejection, or no channel at all: nothing, and nothing thrown', async () => {
    for (const none of [undefined, null, { ok: false, reason: 'capability', message: 'no' }]) {
      answer = none;
      fire('pointerover', surface('c1'));
      await rest();
      expect(popup()).toBeNull();
      fire('pointerover', document.body);
    }
    const rejected = Promise.reject(new Error('bridge exploded'));
    rejected.catch(() => undefined); // handled here too, so the runner does not flag it
    answer = rejected;
    fire('pointerover', surface('c1'));
    await rest();
    expect(popup()).toBeNull();
    fire('pointerover', document.body);

    (window as unknown as { switchboard: unknown }).switchboard = { transcripts: {} };
    fire('pointerover', surface('c2'));
    await rest();
    expect(popup()).toBeNull();
  });

  it('a finger has no hover: a touch does not raise it', async () => {
    fire('pointerover', surface('c1'), { pointerType: 'touch' });
    await rest();
    expect(calls).toEqual([]);
  });
});
