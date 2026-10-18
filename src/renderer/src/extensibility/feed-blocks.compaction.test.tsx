// @vitest-environment jsdom
// #1259 — where a conversation was compacted, drawn as a divider.
//
// Through the REAL registry, like the notice suite beside it: the block could
// carry a perfect mark and still reach the screen as an empty markdown block
// if the contribution were not registered. The derivation halves are pinned in
// `main/feed/blocks.test.ts` (transcript) and `main/feed/stream-feed.test.ts`
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
