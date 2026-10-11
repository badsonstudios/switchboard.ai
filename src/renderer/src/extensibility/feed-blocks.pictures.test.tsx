// @vitest-environment jsdom
// A picture in a reply, in the block that renders it (#1235): what a click
// does, and what a load and a failed load do. `lib/feed-images.test.ts` owns
// what the markup is; the real app (`e2e/feed-pictures.spec.ts`) owns that a
// picture is actually drawn.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { feedBlockRenderers } from './feed-blocks';
import { FeedSurfaceContext } from '../lib/feed-surface';
import type { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const prose = feedBlockRenderers.find((r) => r.manifest.id === 'feed-block-markdown')!;
const FOLDER = 'C:\\work\\app';
let root: Root;
let host: HTMLElement;
let openViewable: ReturnType<typeof vi.fn<(p: string) => Promise<boolean>>>;
let openExternal: ReturnType<typeof vi.fn<(u: string) => Promise<boolean>>>;

async function mount(text: string, folder: string | null = FOLDER, streaming = false): Promise<void> {
  const b = { seq: 1, kind: 'assistant', text, streaming } as unknown as FeedBlockDto;
  await act(async () => {
    root.render(<FeedSurfaceContext.Provider value={{ folder: folder ?? undefined }}>{prose.render(b)}</FeedSurfaceContext.Provider>);
  });
}
async function click(el: Element | null): Promise<MouseEvent> {
  expect(el, 'element to click').not.toBeNull();
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    el!.dispatchEvent(e);
  });
  return e;
}

beforeAll(async () => {
  await initI18nForTests();
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  openViewable = vi.fn<(p: string) => Promise<boolean>>(() => Promise.resolve(true));
  openExternal = vi.fn<(u: string) => Promise<boolean>>(() => Promise.resolve(true));
  (window as unknown as { switchboard: unknown }).switchboard = { files: { openViewable, openExternal } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a picture in a reply, in its block (#1235)', () => {
  it('is shown relative to the SESSION’S folder, which the block reads from the surface it is in', async () => {
    await mount('Here it is:\n\n![the mock-up](mocks/a.svg)');
    const img = host.querySelector('img.doc-image')!;
    expect(decodeURIComponent(img.getAttribute('src')!)).toContain('C:\\work\\app\\mocks\\a.svg');
  });

  it('with no folder known, it is a chip', async () => {
    await mount('![the mock-up](mocks/a.svg)', null);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.doc-image-chip')).not.toBeNull();
  });

  it('a click on the picture asks main to open THAT file', async () => {
    await mount('![the mock-up](mocks/a.svg)');
    await click(host.querySelector('img.doc-image'));
    expect(openViewable).toHaveBeenCalledWith('C:\\work\\app\\mocks\\a.svg');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a link to a local HTML page opens the file, and does not navigate this window', async () => {
    await mount('The page is [here](out/mock.html).');
    const e = await click(host.querySelector('a'));
    expect(openViewable).toHaveBeenCalledWith('C:\\work\\app\\out\\mock.html');
    expect(e.defaultPrevented).toBe(true);
  });

  it('⚠️ it never uses the general "open any file" route: only the one main type-checks', async () => {
    const general = vi.fn();
    (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files.openPath = general;
    await mount('![the mock-up](mocks/a.svg) and [a page](p.html)');
    await click(host.querySelector('img.doc-image'));
    await click(host.querySelector('a'));
    expect(general).not.toHaveBeenCalled();
    expect(openViewable).toHaveBeenCalledTimes(2);
  });

  it('a remote chip INSIDE a link to a local page: its own button wins, being the nearer control', async () => {
    await mount('[![far](https://x.example/p.png)](page.html)');
    await click(host.querySelector('.doc-image-chip button'));
    expect(openExternal).toHaveBeenCalledWith('https://x.example/p.png');
    expect(openViewable).not.toHaveBeenCalled();
  });

  it('a remote picture’s chip opens the ADDRESS in the browser, and nothing is opened as a file', async () => {
    await mount('![badge](https://x.example/b.png)');
    await click(host.querySelector('.doc-image-chip button'));
    expect(openExternal).toHaveBeenCalledWith('https://x.example/b.png');
    expect(openViewable).not.toHaveBeenCalled();
  });

  it('a picture that fails to load becomes a chip that says so', async () => {
    await mount('![old chart](gone.png)');
    await act(async () => {
      host.querySelector('img.doc-image')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.doc-image-chip')!.textContent).toContain('Not shown');
  });

  it('while the reply is still arriving, a picture is a chip: nothing is fetched per chunk', async () => {
    await mount('![the mock-up](mocks/a.svg)', FOLDER, true);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.doc-image-chip')).not.toBeNull();
  });
});
