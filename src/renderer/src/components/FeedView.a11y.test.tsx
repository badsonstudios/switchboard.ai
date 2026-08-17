// @vitest-environment jsdom
// The conversation landmark NAMES its session (#196).
//
// #174 made the feed's scroller a `role="region"` with a name — and gave every
// card the same one, "Conversation". With four cards on screen that is four
// identical entries in a screen reader's landmark list, which is the same
// failure as no name at all: the user can enumerate the regions and still not
// know which session they are about to read.
//
// This renders through the PANEL CONTRIBUTION rather than through FeedView
// directly, and asserts off the DOM, in the pattern #174 established. The
// contribution is the load-bearing half: the shipped bug was a name that never
// varied, and a test that hands FeedView a `title` prop itself would stay green
// with the thread from `PanelContext` cut.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** The slice of the preload bridge FeedView reaches for while mounting. */
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

/** the context a card hands its panels, with only the title varying */
function ctx(title?: string): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title,
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
  };
}

const roots: Root[] = [];

/** render the Session panel for one card and hand back its labelled region */
async function mountFeed(title?: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx(title)));
  });
  const region = host.querySelector<HTMLElement>('[data-feed-region]');
  if (!region) throw new Error('no feed region rendered');
  return region;
}

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
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the conversation landmark names its session (issue 196)', () => {
  it('is a region whose name carries the session title', async () => {
    const region = await mountFeed('acme-web');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Conversation — acme-web');
  });

  it('gives two visible cards two DIFFERENT landmark names — the bug itself', async () => {
    const a = await mountFeed('acme-web');
    const b = await mountFeed('propane-mon');
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-feed-region]'),
      (el) => el.getAttribute('aria-label')
    );
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(a.getAttribute('aria-label')).toContain('acme-web');
    expect(b.getAttribute('aria-label')).toContain('propane-mon');
  });

  it('follows a rename', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const draw = async (title: string): Promise<void> => {
      await act(async () => {
        root.render(feedPanel.render(ctx(title)));
      });
    };
    await draw('before');
    const region = host.querySelector<HTMLElement>('[data-feed-region]')!;
    expect(region.getAttribute('aria-label')).toBe('Conversation — before');
    await draw('after');
    expect(region.getAttribute('aria-label')).toBe('Conversation — after');
  });

  // Two ways to have no name: a host that never supplies one, and an empty
  // title — no longer committable since #294, but a workspace written before it
  // can still carry one. Announcing "Conversation — undefined", or nothing at
  // all, would both be worse than the generic.
  for (const [name, title] of [['absent', undefined], ['an empty string', '']] as const) {
    it(`falls back to the bare name when the title is ${name}`, async () => {
      const region = await mountFeed(title);
      expect(region.getAttribute('aria-label')).toBe('Conversation');
    });
  }
});
