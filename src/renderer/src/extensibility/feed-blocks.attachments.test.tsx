// @vitest-environment jsdom
// #491 — the marker on a prompt that carried files.
//
// Rendered through the REAL registry, the way `feed-blocks.a11y.test.tsx` does,
// because the defect this guards is a whole-pipeline one: a block that carries
// the counts and a renderer that never looks at them reads identically to the
// bug. The derivation half is pinned in `main/feed/blocks.test.ts`; this half
// is "the user can see it".
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

function draw(over: Partial<FeedBlockDto>): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, { seq: 1, kind: 'user', sidechain: false, ...over }));
  });
  return host;
}

const marker = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-feed-attachments]');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('a prompt that carried files says so', () => {
  it('names the number of pictures, and pluralises', () => {
    expect(marker(draw({ text: 'what is this?', attachments: { images: 1, documents: 0 } }))?.textContent)
      .toBe('1 image attached');
    expect(marker(draw({ text: 'what is this?', attachments: { images: 3, documents: 0 } }))?.textContent)
      .toBe('3 images attached');
  });

  it('names documents as files, since a PDF and a .md are both "a file" here', () => {
    expect(marker(draw({ text: 'read this', attachments: { images: 0, documents: 1 } }))?.textContent)
      .toBe('1 file attached');
    expect(marker(draw({ text: 'read these', attachments: { images: 0, documents: 2 } }))?.textContent)
      .toBe('2 files attached');
  });

  it('says both when a turn carried both', () => {
    const el = marker(draw({ text: 'compare', attachments: { images: 2, documents: 1 } }));
    expect(el?.textContent).toBe('2 images and 1 file attached');
    expect(el?.getAttribute('data-feed-attachments')).toBe('3');
  });

  // Both halves SINGULAR is the one combination where a copy-paste slip in the
  // `both` message — the images clause pasted twice — reads as correct English
  // and is still wrong.
  it('pluralises each half of "both" independently', () => {
    expect(marker(draw({ text: 'compare', attachments: { images: 1, documents: 1 } }))?.textContent)
      .toBe('1 image and 1 file attached');
    expect(marker(draw({ text: 'compare', attachments: { images: 1, documents: 4 } }))?.textContent)
      .toBe('1 image and 4 files attached');
  });

  it('keeps the prompt itself, unchanged, alongside it', () => {
    const host = draw({ text: 'what is this?', attachments: { images: 1, documents: 0 } });
    expect(host.textContent).toContain('what is this?');
  });

  // THE DONE-WHEN'S OTHER HALF: nothing attached must render exactly as before.
  it('says nothing at all when nothing was attached', () => {
    const host = draw({ text: 'just words' });
    expect(marker(host)).toBeNull();
    expect(host.textContent).toBe('just words');
  });

  // Defensive, because the block crosses an IPC boundary from a process reading
  // untrusted output: a zeroed pair is not a claim worth painting.
  it('says nothing for a zeroed pair', () => {
    expect(marker(draw({ text: 'x', attachments: { images: 0, documents: 0 } }))).toBeNull();
  });

  // "Look at this", nothing typed. The pill is the ONLY trace of the turn.
  it('a picture sent with nothing typed still gets a visible pill', () => {
    const host = draw({ attachments: { images: 1, documents: 0 } });
    expect(marker(host)?.textContent).toBe('1 image attached');
    // and no blank line pretending to be words
    expect(host.textContent).toBe('1 image attached');
  });

  // A long prompt collapses to one header row (#174). A marker that collapsed
  // with it would hide the very evidence the block exists to keep.
  it('stays visible on a prompt long enough to collapse', () => {
    const host = draw({ text: 'x'.repeat(900), attachments: { images: 1, documents: 0 } });
    expect(host.querySelector('[aria-expanded="false"]')).not.toBeNull();
    expect(marker(host)?.textContent).toBe('1 image attached');
  });
});
