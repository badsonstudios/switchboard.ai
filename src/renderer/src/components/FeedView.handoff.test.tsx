// @vitest-environment jsdom
// The handoff bar knows which transport it is on (#261).
//
// The rule itself has been right since #153's follow-up: `terminalHandoff`
// returns null for a stream session, because every branch of that bar routes
// the user to a Terminal a stream session does not have. It was DEAD CODE.
// The `feed` panel contribution rendered `<FeedView>` with eleven props and no
// `transport`, so the prop was permanently `undefined` and the guard never
// once ran — while the sibling Terminal panel read `ctx.transport` correctly
// and said "No terminal for this session". Two surfaces in one window
// contradicting each other, which is what Dan hit dogfooding Direct mode.
//
// So this renders through the PANEL CONTRIBUTION and asserts off the DOM, in
// the pattern #174 and #196 established. That is the whole point of the file:
// `terminal-handoff.test.ts` already asserts the rule directly and would stay
// green with the prop cut — asserting a rule in a pure function has now failed
// TWICE to catch a render site that never calls it (#208 was the same shape in
// a pop-out). The test has to bite where the props are actually written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import en from '../i18n/locales/en.json';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** The slice of the preload bridge FeedView and its composer reach for. */
function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

/** the context a card hands its panels — only transport and status vary here */
function ctx(over: Partial<PanelContext>): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
    ...over,
  };
}

const roots: Root[] = [];

/** render the Session panel for one card and hand back its host element */
async function mountFeed(over: Partial<PanelContext>): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx(over)));
  });
  return host;
}

const bar = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-handoff]');

/** the bar's only affordance — a dead button is the user-visible half of #261 */
const openTerminalButton = (host: HTMLElement): HTMLElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Open Terminal');

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  // jsdom has no ResizeObserver and the scroll-anchoring effect installs one
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  if (!i18next.isInitialized) {
    await i18next
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  }
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

// `issue 261`, not `#261`: the lint rule that bans raw hex colours reads a
// three-digit `#nnn` in a string literal as one (the same reason #196's file
// spells it out).
describe('the Session panel threads transport through to the handoff bar (issue 261)', () => {
  // The reported bug, end to end through the contribution: Direct mode, the
  // CLI is holding a decision we were never handed, and there is no terminal.
  it('a Direct session waiting on a permission shows NO bar and NO dead button', async () => {
    const host = await mountFeed({ transport: 'stream', status: 'needs-permission' });
    expect(bar(host)).toBeNull();
    expect(openTerminalButton(host)).toBeUndefined();
  });

  it('a Direct session waiting on an ANSWER is silent too', async () => {
    const host = await mountFeed({ transport: 'stream', status: 'needs-input' });
    expect(bar(host)).toBeNull();
    expect(openTerminalButton(host)).toBeUndefined();
  });

  // The other half, and the reason this file cannot just assert "never shows".
  // A fix that silenced the bar everywhere would satisfy the two tests above
  // and delete a working feature.
  it('a Terminal session is UNCHANGED — the bar and its button are still there', async () => {
    const host = await mountFeed({ transport: 'pty', status: 'needs-permission' });
    expect(bar(host)?.getAttribute('data-handoff')).toBe('permission');
    expect(host.textContent).toContain('Claude is asking permission in the terminal');
    expect(openTerminalButton(host)).toBeDefined();
  });

  it('a Terminal session waiting on an answer still gets the input bar', async () => {
    const host = await mountFeed({ transport: 'pty', status: 'needs-input' });
    expect(bar(host)?.getAttribute('data-handoff')).toBe('input');
    expect(host.textContent).toContain('Claude is waiting for your answer');
  });

  // A card mounts before its live record lands, so `ctx.transport` is briefly
  // absent on a perfectly ordinary PTY session. Silencing that gap would trade
  // this bug for a quieter one.
  it('an unknown transport keeps the bar — the boot gap is not a Direct session', async () => {
    const host = await mountFeed({ transport: undefined, status: 'needs-permission' });
    expect(bar(host)?.getAttribute('data-handoff')).toBe('permission');
    expect(openTerminalButton(host)).toBeDefined();
  });

  // The `startingLong` branch, and the reason it is asserted HERE and not in
  // an e2e (#339). Nothing can hold a session in `starting` past the bar's 8s
  // grace period any more — transport-ready was fixed — so `stream.spec.ts`'s
  // restarted-Direct test was asserting the absence of this bar against a
  // session that had started a second in. It passed with the transport guard
  // deleted. The branch is still real in production (a start-up TUI dialog only
  // the Terminal can render), so it has to bite somewhere, and the render site
  // is where the last two bugs of this shape lived.
  it('a Direct session stuck STARTING is silent, while a Terminal one gets the start-up bar', async () => {
    // The 8s timer is armed by an effect at mount, so the clock has to be fake
    // before the mount or there is a real timer nothing can advance.
    vi.useFakeTimers();
    try {
      const stream = await mountFeed({ transport: 'stream', status: 'starting' });
      const pty = await mountFeed({ transport: 'pty', status: 'starting' });
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });

      expect(bar(stream)).toBeNull();
      expect(openTerminalButton(stream)).toBeUndefined();
      // …and the same wait on a session that DOES have a terminal produces the
      // bar, so the silence above is the transport and not a dead branch.
      expect(pty.textContent).toContain('Claude is showing a start-up dialog');
      expect(bar(pty)?.getAttribute('data-handoff')).toBe('input');
      expect(openTerminalButton(pty)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // And the held-approval rule still outranks everything, on both transports:
  // that decision was DELEGATED to us and the approval bar is rendering it.
  it('a HELD approval still suppresses the bar on either transport', async () => {
    for (const transport of ['pty', 'stream'] as const) {
      const host = await mountFeed({
        transport,
        status: 'needs-permission',
        approval: { requestId: 'r1', tool: 'Write', input: {} },
        onDecide: () => {},
      });
      expect(bar(host), `${transport} with a held approval`).toBeNull();
    }
  });
});
