// @vitest-environment jsdom
// The `/` popup says why it is empty, and names skills the AI will not load
// (#1328).
//
// WHAT WAS WRONG, as the owner met it: in a project whose skills were loose
// `.md` files (which Claude Code ignores), typing `/alpaca` showed NOTHING —
// the popup only opened when at least one row matched, so "no such command"
// and "the app is broken" looked the same.
//
// Mounted through the REAL panel contribution (the #174/#196 rule), with the
// same bridge stub as `FeedView.completion-a11y.test.tsx`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import type { MisplacedSkills, SlashCommand } from '../../../shared/slash-commands';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'compact', description: 'Summarize and restart', source: 'builtin' },
];

const LOOSE: MisplacedSkills[] = [
  { scope: 'project', shownDir: '.claude/skills', files: ['alpaca-trading.md', 'issue-tracker.md'] },
];

const roots: Root[] = [];
const submitPrompt = vi.fn(() => Promise.resolve(true));

function stubBridge(hints: MisplacedSkills[] | 'missing' | 'rejects'): void {
  const sessions: Record<string, unknown> = {
    slashCommands: () => Promise.resolve(COMMANDS),
    summaries: () => Promise.resolve([]),
    resolveMentions: (_id: string, text: string) => Promise.resolve({ ok: true, prompt: text }),
    submitPrompt,
  };
  // 'missing' is an older preload with no such method: the popup must not care
  if (hints === 'rejects') sessions.slashHints = () => Promise.reject(new Error('gone'));
  else if (hints !== 'missing') sessions.slashHints = () => Promise.resolve(hints);
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { blocks: () => Promise.resolve([]), onBlock: () => () => {}, onReset: () => () => {} },
    pty: { input: () => {} },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions,
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-t',
    cardId: 'card-t',
    title: 'Trading',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport: 'stream',
    controlsLock: null,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const noticeOf = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-slash-notice]');
const listOf = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-completion-list]');

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function type(host: HTMLElement, text: string): Promise<void> {
  const box = boxOf(host);
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function press(host: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    boxOf(host).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitPrompt.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
  await loadUiState();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the slash popup says why it is empty (#1328)', () => {
  it('a `/` that matches nothing shows "No commands match", not nothing', async () => {
    stubBridge([]);
    const host = await mount();
    await type(host, '/alpaca');
    expect(listOf(host)).toBeNull(); // no options: there are none
    expect(noticeOf(host)?.textContent).toContain('No commands match “/alpaca”');
    expect(noticeOf(host)?.querySelector('[data-slash-misplaced]')).toBeNull();
  });

  it('names the skills folder whose loose files Claude Code ignores, and the layout it needs', async () => {
    stubBridge(LOOSE);
    const host = await mount();
    await type(host, '/alpaca');
    const line = noticeOf(host)!.querySelector<HTMLElement>('[data-slash-misplaced="project"]')!;
    expect(line.textContent).toBe(
      'Claude Code ignores loose .md files in .claude/skills (2 here). A skill must be .claude/skills/<name>/SKILL.md.'
    );
    // which files, for the person who hovers to find out
    expect(line.title).toBe('Not loaded: alpaca-trading.md, issue-tracker.md');
  });

  it('with matches on screen, the hint sits under the list and the list still works', async () => {
    stubBridge(LOOSE);
    const host = await mount();
    await type(host, '/c');
    expect(listOf(host)?.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(noticeOf(host)?.querySelector('[data-slash-no-match]')).toBeNull();
    expect(noticeOf(host)?.querySelector('[data-slash-misplaced]')).not.toBeNull();
    // the notice is NOT inside the listbox: a listbox may only hold options
    expect(listOf(host)!.contains(noticeOf(host))).toBe(false);
  });

  it('matches and nothing misplaced: no notice at all', async () => {
    stubBridge([]);
    const host = await mount();
    await type(host, '/c');
    expect(listOf(host)).not.toBeNull();
    expect(noticeOf(host)).toBeNull();
  });

  it('Escape closes the notice; Enter still sends the command to the CLI', async () => {
    stubBridge([]);
    const host = await mount();
    await type(host, '/alpaca');
    await press(host, 'Escape');
    expect(noticeOf(host)).toBeNull();

    await type(host, '/alpaca-trading');
    expect(noticeOf(host)).not.toBeNull();
    await press(host, 'Enter');
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an older preload without the method', 'missing' as const],
    ['a hint read that fails', 'rejects' as const],
  ])('%s costs only the hint', async (_what, hints) => {
    stubBridge(hints);
    const host = await mount();
    await type(host, '/c');
    expect(listOf(host)?.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(noticeOf(host)).toBeNull();
  });
});
