// @vitest-environment jsdom
// #1529: the composer's `/` and `@` popup highlights its TOP row in the render
// that first shows a new completion.
//
// The highlight (`selected`) and the "the user moved it" flag (`navigated`)
// were reset in an EFFECT keyed on the completion, which is one render late:
// the first commit after a keystroke still carried the old index. Arrow down
// the list, type one more letter, press Enter or Tab quickly — and on a loaded
// machine that key could land in the gap and accept the row that was
// highlighted for the OLD word instead of the new top match. The History
// dialog lost picks to the same gap (issue 1320).
//
// Under `act` the gap is closed before any key can be pressed, so what is
// pinned here is the state of EVERY commit, caught as it is made: a Profiler's
// `onRender` runs in the commit, after the DOM has been written — the moment a
// key could arrive. Mounted through the real panel contribution, with the same
// harness `FeedView.mention.test.tsx` uses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, Profiler } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import { resetHandoffWaitsForTests } from '../lib/handoff-switch';
import type { SessionSummary } from '../../../shared/sessions';
import type { SlashCommand } from '../../../shared/slash-commands';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const OWN_ID = 'live-b';

// Case-insensitive substring, prefix matches first, then alphabetical (the
// rules in `shared/mention-token.ts` and `shared/slash-commands.ts`).
const SESSIONS: SessionSummary[] = [
  { id: 'live-a', name: 'TradingApp', folder: '/p/trading', providerId: 'claude-code', status: 'working', exited: false },
  { id: 'live-c', name: 'Trackpad', folder: '/p/trackpad', providerId: 'claude-code', status: 'done', exited: false },
  { id: 'live-d', name: 'BrainHarbor', folder: '/p/brain', providerId: 'claude-code', status: 'idle', exited: false },
  { id: OWN_ID, name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'working', exited: false },
];

const COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
  { name: 'config', description: 'Open the config', source: 'builtin' },
];

let submitted: string[];
const roots: Root[] = [];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { blocks: () => Promise.resolve([]), onBlock: () => () => {}, onReset: () => () => {} },
    pty: { input: () => {} },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve(COMMANDS),
      summaries: () => Promise.resolve(SESSIONS),
      resolveMentions: (_id: string, text: string) => Promise.resolve({ ok: true, prompt: text }),
      resolveMentionsWithHandoff: (_id: string, text: string) => Promise.resolve({ ok: true, prompt: text }),
      cancelHandoff: () => Promise.resolve(true),
      submitPrompt: (_id: string, text: string) => {
        submitted.push(text);
        return Promise.resolve(true);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

let host: HTMLElement;
/** for each commit: the popup's rows, and which of them is highlighted */
let commits: Array<{ rows: string[]; selected: number[] }>;

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-completion-row]')];
const labels = (): string[] =>
  rows().map((r) => r.querySelector<HTMLElement>('[data-completion-label]')?.textContent ?? '');
const boxOf = (): HTMLTextAreaElement => host.querySelector('textarea')!;

const record = (): void => {
  commits.push({
    rows: labels(),
    selected: rows().flatMap((r, i) => (r.getAttribute('aria-selected') === 'true' ? [i] : [])),
  });
};

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: OWN_ID,
    cardId: 'card-b',
    title: 'Beta',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport: 'stream',
    controlsLock: null,
    setView: () => {},
  };
  commits = [];
  await act(async () => {
    root.render(
      <Profiler id="composer" onRender={record}>
        {feedPanel.render(ctx)}
      </Profiler>
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Type into the CONTROLLED textarea, through the setter React's tracker patched. */
async function type(text: string): Promise<void> {
  const box = boxOf();
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function press(key: string): Promise<void> {
  await act(async () => {
    boxOf().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

/** Move the caret the way a click or arrow-in-text does: the composer syncs it on keyup. */
async function caretTo(pos: number): Promise<void> {
  const box = boxOf();
  await act(async () => {
    box.setSelectionRange(pos, pos);
    box.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  });
  await flush();
}

/** every commit that shows the popup highlights exactly its top row */
const everyCommitAtTheTop = (): void => {
  expect(commits.length).toBeGreaterThan(0);
  for (const c of commits) if (c.rows.length > 0) expect(c.selected, JSON.stringify(commits)).toEqual([0]);
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  resetHandoffWaitsForTests();
  // jsdom has no layout, so no `scrollIntoView`, which the popup calls to keep
  // the highlighted row in view. Put back after.
  Element.prototype.scrollIntoView = (): void => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
  stubBridge();
  await loadUiState();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a new completion is highlighted at its top IN THE RENDER THAT SHOWS IT (#1529)', () => {
  it('slash: typing past an arrowed-to row — the first commit of the shorter list is on its top row', async () => {
    await mount();
    await type('/c');
    expect(labels()).toEqual(['/clear', '/compact', '/config']);
    await press('ArrowDown');
    await press('ArrowDown');
    expect(rows()[2].getAttribute('aria-selected')).toBe('true');
    commits = [];
    // '/co' leaves compact and config; the old index (2) is past the end, and
    // the clamp alone would have highlighted the LAST row, /config
    await type('/co');
    expect(commits[0]).toEqual({ rows: ['/compact', '/config'], selected: [0] });
    everyCommitAtTheTop();
    await press('Tab');
    expect(boxOf().value).toBe('/compact ');
  });

  it('mention: typing a word that keeps the same rows starts at the top, not on the arrowed-to one', async () => {
    await mount();
    await type('@Tr');
    expect(labels()).toEqual(['@Trackpad', '@TradingApp']);
    await press('ArrowDown');
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    commits = [];
    // the index (1) is still IN RANGE here — the other half of the bug: no
    // clamp would have caught it, and Enter would have taken TradingApp
    await type('@T');
    expect(commits[0]).toEqual({ rows: ['@Trackpad', '@TradingApp'], selected: [0] });
    everyCommitAtTheTop();
    await press('Enter');
    expect(boxOf().value).toBe('@Trackpad ');
    expect(submitted).toEqual([]);
  });

  it('a caret moved into a different @word starts that word at the top too', async () => {
    await mount();
    await type('@Tr x @');
    expect(labels()).toEqual(['@BrainHarbor', '@Trackpad', '@TradingApp']);
    await press('ArrowDown');
    await press('ArrowDown');
    expect(rows()[2].getAttribute('aria-selected')).toBe('true');
    commits = [];
    await caretTo('@Tr'.length);
    expect(commits[0]).toEqual({ rows: ['@Trackpad', '@TradingApp'], selected: [0] });
    everyCommitAtTheTop();
  });
});
