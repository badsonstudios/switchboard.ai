// @vitest-environment jsdom
// Controls one AI lacks GREY OUT, with a reason (E40 item 04, #1287; design
// record §5 screen 3).
//
// The composer asks main which controls this session's AI declared
// (`sessions:controls`) and greys out every one it lacks — disabled, still in
// its place, saying "Not available with <AI>." Rendered through the PANEL
// CONTRIBUTION, like `FeedView.session-controls.test.tsx`, so the threading
// from the card to the composer is what is under test, not a prop handed in.
//
// The AI that lacks things is a test-only one: Claude declares every control,
// so with only Claude installed nothing here can be seen in the app. The rule
// is the same in both directions — whichever AI is missing what — because a
// control is simply a name a session does or does not have.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { ENGINE_CONTROLS, type EngineControl, type SessionControlsWire } from '../../../shared/engine-controls';
import type { CatalogEntry } from '../../../shared/ais';
import { resetAisStoreForTests } from '../lib/ais-store';
import en from '../../../shared/i18n/locales/en.json';

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

const byId = (host: HTMLElement, id: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const stop = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('button[data-unavailable="interrupt"]') ??
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '■') ??
  null;

const reduced = (has: EngineControl[]): SessionControlsWire => ({ ai: 'Reduced (test)', has });
const REASON = 'Not available with Reduced (test).';

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

describe('a control the AI lacks greys out, with a reason (issue 1287)', () => {
  it('an AI with only approvals and interrupt: mode, model, Compact and Clear are greyed and say why', async () => {
    answer = reduced(['approvals', 'interrupt']);
    const host = await mountFeed();

    for (const [id, name] of [
      ['composer-autonomy', 'modes'],
      ['composer-model', 'models'],
      ['composer-compact', 'slashCommands'],
      ['composer-clear', 'slashCommands'],
    ] as const) {
      const b = byId(host, id);
      expect(b, id).not.toBeNull();
      expect(b!.disabled, id).toBe(true);
      expect(b!.getAttribute('data-unavailable'), id).toBe(name);
      // the reason a mouse user SEES sits on the wrapper: a disabled button
      // is not hit-tested, so its own title never shows
      expect(b!.parentElement!.getAttribute('title'), id).toBe(REASON);
    }
    // …and the one it HAS works as it always did
    const s = stop(host)!;
    expect(s.disabled).toBe(false);
    expect(s.hasAttribute('data-unavailable')).toBe(false);
  });

  it('a greyed control does nothing when clicked', async () => {
    answer = reduced(['approvals']);
    const host = await mountFeed();
    const s = stop(host)!;
    expect(s.disabled).toBe(true);
    expect(s.getAttribute('data-unavailable')).toBe('interrupt');
    expect(s.parentElement!.getAttribute('title')).toBe(REASON);
    await act(async () => {
      s.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(interrupts).toEqual([]);
  });

  it('the effort chip and the context meter draw nothing for an AI without them', async () => {
    answer = reduced(['approvals', 'interrupt', 'models', 'modes', 'slashCommands']);
    const host = await mountFeed();
    expect(host.querySelector('[data-testid="composer-effort"]')).toBeNull();
    expect(host.querySelector('[data-testid="composer-context"]')).toBeNull();
    // the ones it has are live
    expect(byId(host, 'composer-model')!.disabled).toBe(false);
    expect(byId(host, 'composer-autonomy')!.disabled).toBe(false);
  });

  it('an AI with every control (Claude) greys nothing out, and adds no wrapper', async () => {
    answer = { ai: 'Claude Code', has: [...ENGINE_CONTROLS] };
    const host = await mountFeed();
    expect(host.querySelector('[data-unavailable]')).toBeNull();
    expect(host.querySelector('[data-unavailable-reason]')).toBeNull();
    expect(byId(host, 'composer-autonomy')!.disabled).toBe(false);
    expect(byId(host, 'composer-model')!.disabled).toBe(false);
    expect(stop(host)!.disabled).toBe(false);
    // …and the two chips that draw nothing without their control are drawn
    expect(host.querySelector('[data-testid="composer-effort"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="composer-context"]')).not.toBeNull();
  });

  it('a session main cannot answer for greys NOTHING out (fail-open, the direction that changes nothing)', async () => {
    answer = null;
    const host = await mountFeed();
    expect(host.querySelector('[data-unavailable]')).toBeNull();
    expect(byId(host, 'composer-autonomy')!.disabled).toBe(false);
  });

  it('an older preload with no `controls` channel greys nothing out either', async () => {
    const sessions = (window as unknown as { switchboard: { sessions: Record<string, unknown> } }).switchboard
      .sessions;
    delete sessions.controls;
    const host = await mountFeed();
    expect(host.querySelector('[data-unavailable]')).toBeNull();
  });
});

// #1316: the words that named Claude for every AI. Stop's title and the
// working strip say the session's AI by name — the catalog's, then the
// provider's own off `sessions:controls` — and the mode chip's tooltip adds
// the Claude Code half only on Claude.
describe("the composer names the session's AI, not Claude (issue 1316)", () => {
  const ALL = [...ENGINE_CONTROLS];
  const claudeEntry: CatalogEntry = {
    id: 'claude-code',
    name: 'Claude Code',
    maker: 'Anthropic',
    description: '',
    engine: 'native',
    install: { kind: 'link', url: 'https://example.invalid' },
    detectCommand: 'claude',
    runsLocalModels: false,
    providerId: 'claude-code',
  };
  const strip = (host: HTMLElement): string =>
    [...host.querySelectorAll('div')].map((d) => d.textContent ?? '').find((s) => / is working$|^Working$/.test(s)) ?? '';

  afterEach(() => resetAisStoreForTests());

  it("another AI's Stop says its name, and the strip does too", async () => {
    resetAisStoreForTests({
      items: [{ kind: 'provider', entry: { id: 'reduced', name: 'Reduced (test)' }, providerId: 'reduced', registered: true }],
      defaultId: 'claude-code',
    });
    answer = { ai: 'Reduced (test)', has: ALL };
    const host = await mountFeed({ providerId: 'reduced' });
    expect(stop(host)!.getAttribute('title')).toBe('Stop Reduced (test) — interrupts the current turn');
    expect(strip(host)).toBe('Reduced (test) is working');
    expect(host.textContent).not.toMatch(/Claude/);
  });

  it("Claude's Stop names Claude Code, from the catalog", async () => {
    resetAisStoreForTests({ items: [{ kind: 'catalog', entry: claudeEntry, providerId: 'claude-code', registered: true }], defaultId: 'claude-code' });
    answer = { ai: 'Claude Code', has: ALL };
    const host = await mountFeed({ providerId: 'claude-code' });
    expect(stop(host)!.getAttribute('title')).toBe('Stop Claude Code — interrupts the current turn');
    expect(strip(host)).toBe('Claude Code is working');
  });

  it("Stop falls back to the provider's own name when the list has no entry", async () => {
    answer = { ai: 'Reduced (test)', has: ALL };
    const host = await mountFeed({ providerId: 'reduced' });
    expect(stop(host)!.getAttribute('title')).toBe('Stop Reduced (test) — interrupts the current turn');
  });

  it('nobody knows which AI: the unnamed words, never a guess', async () => {
    answer = null;
    const host = await mountFeed();
    expect(stop(host)!.getAttribute('title')).toBe(en.feedView.stopUnnamed);
    expect(strip(host)).toBe(en.feedView.workingStripUnnamed);
  });

  it('the mode chip tells Claude about Claude Code, and nobody else', async () => {
    answer = { ai: 'Reduced (test)', has: ALL };
    const other = await mountFeed({ providerId: 'reduced' });
    expect(byId(other, 'composer-autonomy')!.getAttribute('title')).not.toMatch(/claude/i);
    document.body.innerHTML = '';
    answer = { ai: 'Claude Code', has: ALL };
    const claude = await mountFeed({ providerId: 'claude-code' });
    expect(byId(claude, 'composer-autonomy')!.getAttribute('title')).toContain(en.autonomy.claude.session);
  });
});
