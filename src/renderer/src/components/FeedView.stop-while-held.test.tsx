// @vitest-environment jsdom
// Stop stays offered while a request is held (#1340).
//
// A held approval or question pins the card at `needs-permission` (#1258), and
// Stop used to render only in `working` -- so a turn with a bar up could not be
// stopped from the UI at all. The CLI handles exactly that interrupt correctly
// (measured, #1268): it takes the request back and ends the turn. Rendered
// through the PANEL CONTRIBUTION, as `FeedView.ai-controls.test.tsx` is (whose
// harness this copies), so the threading from the card to the composer is what
// is under test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { ENGINE_CONTROLS, type SessionControlsWire } from '../../../shared/engine-controls';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let answer: SessionControlsWire | null;
let interrupts: string[];
let submitted: string[];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    pty: { input: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      submitPrompt: (_id: string, text: string) => {
        submitted.push(text);
        return Promise.resolve(true);
      },
      interrupt: (id: string) => {
        interrupts.push(id);
        return Promise.resolve(true);
      },
      controls: () => Promise.resolve(answer),
      // live answers, so a chip that is NOT drawn is not drawn because its AI
      // lacks it, rather than because nobody answered
      effort: () =>
        Promise.resolve({ ok: true, response: { effort: 'medium', levels: ['low', 'medium'], model: null } }),
      contextUsage: () =>
        Promise.resolve({
          ok: true,
          response: { percentage: 40, totalTokens: 40, maxTokens: 100, autoCompactAt: null },
        }),
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

function ctx(over: Partial<PanelContext>): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    status: 'working',
    controlsLock: null,
    transport: 'stream',
    model: 'gpt-6-luna',
    setView: () => {},
    ...over,
  };
}

const roots: Root[] = [];

async function mountFeed(over: Partial<PanelContext> = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx(over)));
  });
  // …and once more, for `sessions:controls` to answer
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

const stop = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('button[data-unavailable="interrupt"]') ??
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '■') ??
  null;


beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  interrupts = [];
  submitted = [];
  answer = null;
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

const HELD = { requestId: 'stream:live-1:req-1', tool: 'Write', input: { file_path: 'C:/p/x.txt' } };

describe('Stop while a request is held (issue 1340)', () => {
  it('an approval bar up: Stop is there, enabled, and interrupts', async () => {
    answer = { ai: 'Claude Code', has: [...ENGINE_CONTROLS] };
    const host = await mountFeed({ status: 'needs-permission', approval: HELD, onDecide: () => {} });
    const s = stop(host);
    expect(s).not.toBeNull();
    expect(s!.disabled).toBe(false);
    await act(async () => {
      s!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(interrupts).toEqual(['live-1']);
  });

  it('a question up (needs-input): Stop is there too', async () => {
    answer = { ai: 'Claude Code', has: [...ENGINE_CONTROLS] };
    const question = {
      requestId: 'stream:live-1:q-1',
      tool: 'AskUserQuestion',
      input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
    };
    const host = await mountFeed({ status: 'needs-input', approval: question, onDecide: () => {} });
    expect(stop(host)).not.toBeNull();
  });

  // the grouped prompt shows the request instead of this card (P2-E9-11), so
  // `approval` is null on purpose -- the request is still held
  it('the request is in the grouped prompt, not on the card: Stop is still there', async () => {
    answer = { ai: 'Claude Code', has: [...ENGINE_CONTROLS] };
    const host = await mountFeed({ status: 'needs-permission', approval: null, approvalBatched: true });
    expect(stop(host)).not.toBeNull();
  });

  it('waiting with nothing held, or finished: no Stop', async () => {
    answer = { ai: 'Claude Code', has: [...ENGINE_CONTROLS] };
    for (const status of ['needs-permission', 'done', 'idle'] as const) {
      document.body.innerHTML = '';
      const host = await mountFeed({ status, approval: null });
      expect(stop(host), status).toBeNull();
    }
  });

  it('an AI without interrupt: Stop is shown greyed, as it is while working', async () => {
    answer = { ai: 'Reduced (test)', has: ['approvals'] };
    const host = await mountFeed({ status: 'needs-permission', approval: HELD, onDecide: () => {} });
    expect(stop(host)!.disabled).toBe(true);
  });
});
