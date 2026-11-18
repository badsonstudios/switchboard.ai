// @vitest-environment jsdom
// A path the AI wrote, in the block that renders it (#1611): that the answer
// from main re-decorates the reply, and what a click and Enter do.
// `lib/feed-paths.test.ts` owns what is found; `main/fs/ipc.test.ts` owns that
// a program is never run; `e2e/feed-paths.spec.ts` owns the real viewer.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { feedBlockRenderers } from './feed-blocks';
import { FeedSurfaceContext } from '../lib/feed-surface';
import type { FeedBlockDto } from '../lib/feed';
import { resetLinkPathCacheForTests } from '../lib/link-path-cache';
import { setDocumentOpener } from '../lib/document-open';
import { FEED_PATH_ATTR } from '../lib/feed-paths';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const prose = feedBlockRenderers.find((r) => r.manifest.id === 'feed-block-markdown')!;
const FOLDER = 'C:\\work\\app';
const ON_DISK: Record<string, 'file' | 'dir'> = {
  'C:\\work\\app\\.claude\\work_files\\x.md': 'file',
  'C:\\work\\app\\out\\data.csv': 'file',
  'C:\\work\\app\\tools\\setup.exe': 'file',
  'C:\\work\\app\\docs': 'dir',
};
let root: Root;
let host: HTMLElement;
let statForLinks: ReturnType<typeof vi.fn<(p: readonly string[]) => Promise<Array<'file' | 'dir' | null>>>>;
let openFromReply: ReturnType<typeof vi.fn<(p: string) => Promise<unknown>>>;
let openExternal: ReturnType<typeof vi.fn<(u: string) => Promise<boolean>>>;
let opened: string[];

async function mount(text: string, opts: { kind?: string; streaming?: boolean } = {}): Promise<void> {
  const b = { seq: 1, kind: opts.kind ?? 'assistant', text, streaming: opts.streaming ?? false } as unknown as FeedBlockDto;
  await act(async () => {
    root.render(<FeedSurfaceContext.Provider value={{ folder: FOLDER }}>{prose.render(b)}</FeedSurfaceContext.Provider>);
  });
  // the answer from main arrives off the render, and the reply re-decorates
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
const link = (abs: string): HTMLElement | null =>
  [...host.querySelectorAll<HTMLElement>(`[${FEED_PATH_ATTR}]`)].find((el) => el.getAttribute(FEED_PATH_ATTR) === abs) ??
  null;
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
  resetLinkPathCacheForTests();
  opened = [];
  setDocumentOpener((p) => opened.push(p));
  statForLinks = vi.fn(async (paths: readonly string[]) => paths.map((p) => ON_DISK[p] ?? null));
  openFromReply = vi.fn(async () => 'opened');
  openExternal = vi.fn(async () => true);
  (window as unknown as { switchboard: unknown }).switchboard = { files: { statForLinks, openFromReply, openExternal } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDocumentOpener(null);
});

describe('a path the AI wrote, in its block (#1611)', () => {
  it('becomes a link once main says it is there; what is not there stays words', async () => {
    await mount('Saved `.claude/work_files/x.md`; also wrote `notes/missing.md`.');
    expect(statForLinks).toHaveBeenCalledTimes(1);
    expect(link('C:\\work\\app\\.claude\\work_files\\x.md')).not.toBeNull();
    expect(host.querySelectorAll(`[${FEED_PATH_ATTR}]`)).toHaveLength(1);
  });

  it('a click on Markdown opens it in the document viewer, and nothing goes to main', async () => {
    await mount('See `.claude/work_files/x.md`.');
    const e = await click(link('C:\\work\\app\\.claude\\work_files\\x.md')!.querySelector('code'));
    expect(e.defaultPrevented).toBe(true);
    expect(opened).toEqual(['C:\\work\\app\\.claude\\work_files\\x.md']);
    expect(openFromReply).not.toHaveBeenCalled();
  });

  it('any other file, a folder and a program go to main’s narrow channel; main decides', async () => {
    await mount('Wrote out/data.csv, see `docs/` and `tools/setup.exe`.');
    await click(link('C:\\work\\app\\out\\data.csv'));
    await click(link('C:\\work\\app\\docs'));
    await click(link('C:\\work\\app\\tools\\setup.exe'));
    expect(openFromReply.mock.calls.map((c) => c[0])).toEqual([
      'C:\\work\\app\\out\\data.csv',
      'C:\\work\\app\\docs',
      'C:\\work\\app\\tools\\setup.exe',
    ]);
    expect(opened).toEqual([]);
  });

  it('a markdown link to a local path is ours: it does not also go the browser’s way', async () => {
    await mount('Read [the data](out/data.csv).');
    const e = await click(host.querySelector('a'));
    expect(e.defaultPrevented).toBe(true);
    expect(openFromReply).toHaveBeenCalledWith('C:\\work\\app\\out\\data.csv');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Enter on the link opens it', async () => {
    await mount('Here: `.claude/work_files/x.md`');
    const el = link('C:\\work\\app\\.claude\\work_files\\x.md')!;
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(opened).toEqual(['C:\\work\\app\\.claude\\work_files\\x.md']);
  });

  it('a path main refuses on the click (it went away) stops being a link', async () => {
    openFromReply.mockResolvedValueOnce(false);
    await mount('Wrote out/data.csv today.');
    await click(link('C:\\work\\app\\out\\data.csv'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(link('C:\\work\\app\\out\\data.csv')).toBeNull();
  });

  it('nothing in a reply still arriving, and nothing in the user’s own words', async () => {
    await mount('See `.claude/work_files/x.md`.', { streaming: true });
    expect(host.querySelectorAll(`[${FEED_PATH_ATTR}]`)).toHaveLength(0);
    await mount('See `.claude/work_files/x.md`.', { kind: 'user' });
    expect(host.querySelectorAll(`[${FEED_PATH_ATTR}]`)).toHaveLength(0);
    expect(statForLinks).not.toHaveBeenCalled();
  });
});
