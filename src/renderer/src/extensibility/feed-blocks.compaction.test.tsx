// @vitest-environment jsdom
// #1259 — where a conversation was compacted, drawn as a divider.
//
// Through the REAL registry, like the notice suite beside it: the block could
// carry a perfect mark and still reach the screen as an empty markdown block
// if the contribution were not registered. The derivation halves are pinned in
// `main/providers/claude-transcript.test.ts` (transcript) and `main/feed/stream-feed.test.ts`
// (stream); the words in `lib/compaction-view.test.ts`.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock, resolveFeedBlock } from './feed-render';
import { FeedBlockDto, blockVisible, showsTimelineDot } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

const block = (compaction: FeedBlockDto['compaction']): FeedBlockDto => ({
  seq: 1,
  kind: 'compaction',
  sidechain: false,
  ...(compaction ? { compaction } : {}),
});

function draw(b: FeedBlockDto): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('the compaction divider (#1259)', () => {
  it('is claimed by its own renderer, not the markdown fallback', () => {
    expect(resolveFeedBlock(registry, block({})).id).toBe('feed-block-compaction');
  });

  it('says what happened, how much, and who asked, as a separator', () => {
    const host = draw(block({ trigger: 'manual', preTokens: 32516, postTokens: 4760 }));
    const sep = host.querySelector('[role="separator"]') as HTMLElement;
    expect(sep.getAttribute('aria-label')).toBe('Conversation compacted — 33k → 4.8k tokens (you asked)');
    expect(sep.textContent).toBe('Conversation compacted — 33k → 4.8k tokens (you asked)');
    // the hover says what it MEANS
    expect(sep.getAttribute('title')).toMatch(/only as a summary/);
    expect(host.querySelector('[data-compaction-divider]')?.getAttribute('data-trigger')).toBe('manual');
  });

  it('a mark with nothing on it still draws (fail-open)', () => {
    const host = draw(block(undefined));
    expect(host.querySelector('[role="separator"]')?.textContent).toBe('Conversation compacted');
    expect(host.querySelector('[data-compaction-divider]')?.getAttribute('data-trigger')).toBe('unknown');
  });

  it('is shown at every verbosity, with no timeline dot', () => {
    for (const v of ['quiet', 'normal', 'firehose'] as const) expect(blockVisible(block({}), v)).toBe(true);
    expect(showsTimelineDot('compaction')).toBe(false);
  });

  it("a SUBAGENT's compaction is not the session's divider: firehose only", () => {
    const sub = { ...block({ trigger: 'auto' }), sidechain: true };
    expect(blockVisible(sub, 'quiet')).toBe(false);
    expect(blockVisible(sub, 'normal')).toBe(false);
    expect(blockVisible(sub, 'firehose')).toBe(true);
  });
});

// #1374: the CLI's own summary, on request. Main keeps the text and the mark
// carries only a handle; the divider asks for it when the button is pressed.
describe('"Show summary" on the compaction divider (#1374)', () => {
  type Bridge = { transcripts: { compactionSummary: (id: string) => Promise<unknown> } };
  const asked: string[] = [];
  const bridge = (answer: (id: string) => Promise<unknown>): void => {
    asked.length = 0;
    (window as unknown as { switchboard: Bridge }).switchboard = {
      transcripts: {
        compactionSummary: (id: string) => {
          asked.push(id);
          return answer(id);
        },
      },
    };
  };
  const button = (host: HTMLElement): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>('[data-compaction-divider] button');
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('is not offered when main kept no summary for this divider', () => {
    bridge(() => Promise.resolve({ ok: false }));
    const host = draw(block({ trigger: 'manual' }));
    expect(button(host)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is collapsed by default and asks main for nothing until pressed', () => {
    bridge(() => Promise.resolve({ ok: true, text: 'unused' }));
    const host = draw(block({ trigger: 'auto', summaryId: 'h-1' }));
    expect(button(host)?.textContent).toBe('Show summary');
    expect(button(host)?.getAttribute('aria-expanded')).toBe('false');
    // a feed expander like the rest (#174): the arrow keys reach it, Tab does not
    expect(button(host)?.hasAttribute('data-feed-expander')).toBe(true);
    expect(button(host)?.getAttribute('tabindex')).toBe('-1');
    expect(button(host)?.getAttribute('title')).toMatch(/word for word/);
    expect(host.querySelector('[data-compaction-summary]')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('shows the CLI text verbatim under the rule, by the handle, and hides it again', async () => {
    const TEXT = 'This session is being continued from a previous conversation.\n\n1. Primary Request:\n   keep   spacing';
    bridge(() => Promise.resolve({ ok: true, text: TEXT }));
    const host = draw(block({ trigger: 'manual', summaryId: 'h-2' }));
    act(() => {
      button(host)!.click();
    });
    await flush();
    expect(asked).toEqual(['h-2']);
    const btn = button(host)!;
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.textContent).toBe('Hide summary');
    const region = host.querySelector('[data-compaction-summary]') as HTMLElement;
    expect(region.getAttribute('role')).toBe('region');
    expect(btn.getAttribute('aria-controls')).toBe(region.id);
    expect(host.querySelector('[data-compaction-summary-text]')?.textContent).toBe(TEXT);
    act(() => {
      button(host)!.click();
    });
    expect(host.querySelector('[data-compaction-summary]')).toBeNull();
    expect(button(host)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('says "no longer available" when main no longer holds it, or the call fails', async () => {
    for (const answer of [() => Promise.resolve({ ok: false }), () => Promise.reject(new Error('gone'))]) {
      document.body.innerHTML = '';
      bridge(answer);
      const host = draw(block({ summaryId: 'h-3' }));
      act(() => {
        button(host)!.click();
      });
      await flush();
      expect(host.querySelector('[data-compaction-summary-gone]')?.textContent).toMatch(/no longer available/);
      expect(host.querySelector('[data-compaction-summary-text]')).toBeNull();
    }
  });
});
