// @vitest-environment jsdom
// Pictures that arrived IN the conversation (#1240), in the blocks that show
// them: a tool's box and a prompt. `main/feed/*.test.ts` own which pictures a
// message has and what a handle is answered with; the real app
// (`e2e/feed-tool-pictures.spec.ts`) owns that a thumbnail is actually drawn.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { feedBlockRenderers } from './feed-blocks';
import { FEED_STOP_SELECTOR } from '../lib/feed-keys';
import type { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const A = 'aaaaaaaa-2222-4333-8444-555555555555';
const B = 'bbbbbbbb-2222-4333-8444-555555555555';
let root: Root;
let host: HTMLElement;
let openPicture: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;

const rendererFor = (b: FeedBlockDto) =>
  [...feedBlockRenderers].sort((x, y) => x.order - y.order).find((r) => r.matches(b))!;
async function mount(b: FeedBlockDto): Promise<void> {
  await act(async () => root.render(rendererFor(b).render(b)));
}
const tool = (name: string, category: string, pictures?: string[]): FeedBlockDto =>
  ({
    seq: 1,
    kind: 'tool',
    sidechain: false,
    tool: { name, category, summary: 'shot.png', out: '', ...(pictures ? { pictures } : {}) },
  }) as unknown as FeedBlockDto;

beforeAll(async () => {
  await initI18nForTests();
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  openPicture = vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true));
  (window as unknown as { switchboard: unknown }).switchboard = { transcripts: { openPicture } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a picture a tool returned, on the tool’s box (#1240)', () => {
  it('is a thumbnail by handle, in a box whose size is known before the picture is', async () => {
    await mount(tool('Read', 'read', [A]));
    const img = host.querySelector<HTMLImageElement>('[data-feed-pictures="1"] img')!;
    expect(img.getAttribute('src')).toBe(`sb-doc-image://feed/?id=${A}`);
    expect(img.getAttribute('width')).toBe('144');
    expect(img.getAttribute('height')).toBe('108');
    // a text alternative that says where it came from
    expect(img.getAttribute('alt')).toBe('Picture from Read');
  });

  it('is a button, named, reached by the arrow keys and not by Tab; a press opens it by handle', async () => {
    await mount(tool('Read', 'read', [A]));
    const button = host.querySelector<HTMLButtonElement>(`button[data-feed-picture="${A}"]`)!;
    expect(button.getAttribute('aria-label')).toBe('Open Picture from Read at full size');
    expect(button.getAttribute('tabindex')).toBe('-1');
    expect(button.matches(FEED_STOP_SELECTOR)).toBe(true);
    await act(async () => button.click());
    expect(openPicture).toHaveBeenCalledWith(A);
  });

  it('numbers several, and shows them on a command’s box too', async () => {
    await mount(tool('Bash', 'shell', [A, B]));
    const alts = [...host.querySelectorAll('[data-feed-pictures="2"] img')].map((i) => i.getAttribute('alt'));
    expect(alts).toEqual(['Picture 1 from Bash', 'Picture 2 from Bash']);
  });

  it('a press on a thumbnail does not fold the box it sits on', async () => {
    await mount({ ...tool('Read', 'read', [A]), tool: { ...tool('Read', 'read', [A]).tool!, detail: '{"a":1}' } });
    const expander = host.querySelector('[data-feed-expander]')!;
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-feed-picture]')!.click());
    expect(expander.getAttribute('aria-expanded')).toBe('false');
  });

  it('a thumbnail that will not load becomes the placeholder: same box, in words, and not a button', async () => {
    await mount(tool('Read', 'read', [A, B]));
    const first = host.querySelector<HTMLImageElement>(`button[data-feed-picture="${A}"] img`)!;
    await act(async () => {
      first.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector(`button[data-feed-picture="${A}"]`)).toBeNull();
    const gone = host.querySelector('[data-feed-picture-gone]')!;
    expect(gone.textContent).toContain('Picture 1 from Read');
    expect(gone.textContent).toContain('Not shown');
    expect(gone.classList.contains('feed-thumb')).toBe(true);
    // ...and the one beside it is untouched
    expect(host.querySelector(`button[data-feed-picture="${B}"] img`)).not.toBeNull();
  });

  it('a press that opens nothing (main has let the picture go) turns the thumbnail into the placeholder', async () => {
    openPicture.mockResolvedValueOnce(false);
    await mount(tool('Read', 'read', [A]));
    await act(async () => host.querySelector<HTMLButtonElement>(`button[data-feed-picture="${A}"]`)!.click());
    expect(host.querySelector(`button[data-feed-picture="${A}"]`)).toBeNull();
    expect(host.querySelector('[data-feed-picture-gone]')!.textContent).toContain('Not shown');
  });

  it('is on an edit’s box as well: every tool box shows what its result carried', async () => {
    const edit = tool('Edit', 'edit', [A]);
    await mount({ ...edit, tool: { ...edit.tool!, oldString: 'a', newString: 'b' } });
    expect(host.querySelector('[data-feed-box="edit"] [data-feed-pictures="1"]')).not.toBeNull();
  });

  it('a result with no picture has no strip', async () => {
    await mount(tool('Read', 'read'));
    expect(host.querySelector('[data-feed-pictures]')).toBeNull();
  });
});

describe('a picture attached to a prompt (#1240)', () => {
  const prompt = (pictures: string[], text?: string): FeedBlockDto =>
    ({
      seq: 2,
      kind: 'user',
      sidechain: false,
      ...(text === undefined ? {} : { text }),
      attachments: { images: pictures.length, documents: 0 },
      pictures,
    }) as unknown as FeedBlockDto;

  it('is shown under the count, which stays', async () => {
    await mount(prompt([A], 'what is this?'));
    expect(host.querySelector('[data-feed-attachments]')!.textContent).toBe('1 image attached');
    const img = host.querySelector<HTMLImageElement>('[data-feed-pictures="1"] img')!;
    expect(img.getAttribute('src')).toBe(`sb-doc-image://feed/?id=${A}`);
    expect(img.getAttribute('alt')).toBe('Attached picture');
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-feed-picture]')!.click());
    expect(openPicture).toHaveBeenCalledWith(A);
  });

  it('is shown for a prompt that was only pictures, numbered', async () => {
    await mount(prompt([A, B]));
    const alts = [...host.querySelectorAll('[data-feed-pictures="2"] img')].map((i) => i.getAttribute('alt'));
    expect(alts).toEqual(['Attached picture 1', 'Attached picture 2']);
  });
});
