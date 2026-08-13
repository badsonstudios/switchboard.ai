// @vitest-environment jsdom
// The viewer panel's done-when, asserted against the real render pipeline
// (P2-E16-02, §5.30).
//
// Monaco is stubbed. It is 4 MB of editor whose behaviour ("read-only",
// "highlighted") is Monaco's own and is asserted in e2e against the real thing;
// what this file owns is that the viewer CHOOSES the source body, hands it the
// right language and text, and gives it back the scroll position it left.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import type { FileReadResult } from '../../../shared/ipc/fs';

const sourceProps: Array<Record<string, unknown>> = [];
vi.mock('./DocumentSource', () => ({
  default: (props: Record<string, unknown>) => {
    sourceProps.push(props);
    return null;
  },
}));

import { DocumentViewer, formatBytes } from './DocumentViewer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLElement;
let root: Root | null = null;
let reads: string[] = [];
let calls: Array<{ what: string; arg: string }> = [];
let answer: (p: string) => FileReadResult;

function ok(text: string, extra: Partial<FileReadResult> = {}): FileReadResult {
  return {
    ok: true,
    path: 'x',
    text,
    size: text.length,
    truncated: false,
    encoding: 'utf-8',
    ...extra,
  } as FileReadResult;
}

/** The slice of the preload bridge this panel reaches for. */
function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    files: {
      read: (p: string) => {
        reads.push(p);
        return Promise.resolve(answer(p));
      },
      openPath: (p: string) => {
        calls.push({ what: 'openPath', arg: p });
        return Promise.resolve(true);
      },
      reveal: (p: string) => {
        calls.push({ what: 'reveal', arg: p });
        return Promise.resolve(true);
      },
      openExternal: (u: string) => {
        calls.push({ what: 'openExternal', arg: u });
        return Promise.resolve(true);
      },
    },
  };
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  reads = [];
  calls = [];
  sourceProps.length = 0;
  answer = () => ok('');
  stubBridge();
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

async function mount(path: string, colorScheme: 'light' | 'dark' = 'dark'): Promise<void> {
  await act(async () => {
    root!.render(<DocumentViewer path={path} colorScheme={colorScheme} />);
  });
  // let the read's promise settle and the decoration effect run
  await act(async () => {});
}

const q = (sel: string): HTMLElement | null => host.querySelector(sel);
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
/** Let the find debounce fire. Real timers: `act` already flushes microtasks. */
const settleFind = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
};
const click = async (el: Element | null | undefined): Promise<void> => {
  await act(async () => {
    (el as HTMLElement)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('a markdown file opens RENDERED by default', () => {
  it('renders the markdown, not its source', async () => {
    answer = () => ok('# Title\n\nSome **prose**.\n');
    await mount('/p/PROGRESS.md');
    expect(reads).toEqual(['/p/PROGRESS.md']);
    const body = q('[data-testid="doc-rendered"]');
    expect(body?.querySelector('h1')?.textContent).toBe('Title');
    expect(body?.querySelector('strong')?.textContent).toBe('prose');
    expect(q('[data-testid="doc-source"]')).toBeNull();
  });

  it('the header carries the name, the full path on hover, and the pin control', async () => {
    answer = () => ok('# T\n');
    await mount('/home/dan/sb/PROGRESS.md');
    const name = q('[data-testid="doc-name"]');
    expect(name?.textContent).toBe('PROGRESS.md');
    expect(name?.getAttribute('title')).toBe('/home/dan/sb/PROGRESS.md');
    const pin = q('.doc-pin');
    expect(pin?.getAttribute('aria-pressed')).toBe('false');
    await click(pin);
    expect(q('.doc-pin')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('Open externally and Reveal in folder go through the bridge', async () => {
    answer = () => ok('# T\n');
    await mount('/p/PROGRESS.md');
    await click(buttonByText('Open externally'));
    await click(buttonByText('Reveal in folder'));
    expect(calls).toEqual([
      { what: 'openPath', arg: '/p/PROGRESS.md' },
      { what: 'reveal', arg: '/p/PROGRESS.md' },
    ]);
  });
});

describe('the Rendered | Source toggle', () => {
  it('round-trips to source and back, keeping each mode’s scroll position', async () => {
    answer = () => ok('# Title\n\nbody\n');
    await mount('/p/PROGRESS.md');
    const body = q('[data-testid="doc-scroll"]')!;
    body.scrollTop = 420;

    await click(buttonByText('Source'));
    expect(q('[data-testid="doc-source"]')).not.toBeNull();
    expect(q('[data-testid="doc-rendered"]')).toBeNull();
    expect(sourceProps.at(-1)).toMatchObject({ text: '# Title\n\nbody\n', language: 'markdown' });

    await click(buttonByText('Rendered'));
    expect(q('[data-testid="doc-scroll"]')!.scrollTop).toBe(420);
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Title');
  });

  it('is greyed, not hidden, for a file that has no rendered form', async () => {
    answer = () => ok('export const a = 1;\n');
    await mount('/p/src/index.ts');
    expect(q('[data-testid="doc-source"]')).not.toBeNull();
    const rendered = buttonByText('Rendered')!;
    expect(rendered.disabled).toBe(true);
    expect(rendered.getAttribute('title')).toBe('Only Markdown files have a rendered view');
  });

  it('a .ts opens in source with its own language', async () => {
    answer = () => ok('export const a = 1;\n');
    await mount('/p/src/index.ts');
    expect(sourceProps.at(-1)).toMatchObject({
      language: 'typescript',
      text: 'export const a = 1;\n',
    });
  });
});

describe('files that are not shown', () => {
  it('a PDF gets the card, without pretending to render it', async () => {
    answer = () => ok('', { binary: true, size: 148_000, encoding: undefined });
    await mount('/p/spec.pdf');
    const card = q('[data-testid="doc-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('spec.pdf');
    expect(card?.textContent).toContain('PDF');
    expect(card?.textContent).toContain('145 KB');
    expect(q('[data-testid="doc-rendered"]')).toBeNull();
    expect(q('[data-testid="doc-source"]')).toBeNull();
  });

  it('a binary file the extension did not warn about gets the card too', async () => {
    // main sniffed the bytes; the extension said "text"
    answer = () => ok('', { binary: true, size: 900, encoding: undefined });
    await mount('/p/notes.txt');
    expect(q('[data-testid="doc-card"]')).not.toBeNull();
    expect(buttonByText('Open externally')).toBeDefined();
  });

  it('every refusal says something a human can act on', async () => {
    for (const [reason, copy] of [
      ['out-of-scope', 'only opens files inside'],
      ['not-found', "isn't there any more"],
      ['not-a-file', "That's a folder"],
      ['unreadable', "couldn't be read"],
    ] as const) {
      answer = () => ({ ok: false, reason }) as FileReadResult;
      await mount(`/p/${reason}.md`);
      expect(q('[data-testid="doc-refusal"]')?.textContent).toContain(copy);
    }
  });

  it('a truncated read says how much of the file it is showing', async () => {
    answer = () => ok('x'.repeat(2048), { size: 5_000_000, truncated: true });
    await mount('/p/huge.md');
    const notice = q('[data-testid="doc-truncated"]');
    expect(notice?.textContent).toContain('4.8 MB');
    expect(notice?.textContent).toContain('Open it externally');
  });

  it('a UTF-16 file says so rather than leaving the reader to guess', async () => {
    answer = () => ok('# hi\n', { encoding: 'utf-16le' });
    await mount('/p/notes.md');
    expect(q('[data-testid="doc-encoding"]')?.textContent).toContain('utf-16le');
  });
});

describe('links inside a rendered document', () => {
  it('a relative link navigates IN the viewer, and Back returns', async () => {
    answer = (p) =>
      p.endsWith('PROGRESS.md')
        ? ok('[the plan](docs/plans/00-process.md)\n')
        : ok('# The plan\n');
    await mount('/home/dan/sb/PROGRESS.md');
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(reads).toEqual([
      '/home/dan/sb/PROGRESS.md',
      '/home/dan/sb/docs/plans/00-process.md',
    ]);
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('00-process.md');

    await click(host.querySelector('.doc-nav button'));
    await act(async () => {});
    expect(reads.at(-1)).toBe('/home/dan/sb/PROGRESS.md');
  });

  it('an http link goes to the OS browser and never navigates this window', async () => {
    answer = () => ok('[docs](https://example.test/a)\n');
    await mount('/p/PROGRESS.md');
    await click(q('[data-doc-link="external"]'));
    expect(calls).toEqual([{ what: 'openExternal', arg: 'https://example.test/a' }]);
  });

  it('a link whose fragment is not a slug is ignored, not thrown on', async () => {
    // `#a%0Ab` decodes to a raw newline, which is a CSS parse error inside an
    // attribute selector — and the lookup happens in an EFFECT, where a throw
    // unmounts the tree and takes every session pane in the window with it.
    answer = (p) => (p.endsWith('a.md') ? ok('[go](./b.md#a%0Ab)\n') : ok('# B\n'));
    await mount('/p/a.md');
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('b.md');
    expect(q('[data-testid="doc-rendered"]')?.querySelector('h1')?.textContent).toBe('B');
  });

  it('a javascript: link does NOTHING AT ALL', async () => {
    answer = () => ok('[click me](javascript:alert(1))\n\n<a href="javascript:alert(2)">or me</a>\n');
    await mount('/p/PROGRESS.md');
    const blocked = [...host.querySelectorAll('[data-doc-link="blocked"]')];
    expect(blocked.length).toBeGreaterThan(0);
    for (const el of blocked) await click(el);
    expect(calls).toEqual([]);
    expect(reads).toEqual(['/p/PROGRESS.md']);
  });

  it('a remote image is a chip whose only action is the browser', async () => {
    answer = () => ok('![pixel](https://tracker.test/p.gif)\n');
    await mount('/p/PROGRESS.md');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    await click(q('.doc-image-open'));
    expect(calls).toEqual([{ what: 'openExternal', arg: 'https://tracker.test/p.gif' }]);
  });
});

describe('the rest of the v1 markdown scope', () => {
  it('shows an outline once a document has enough headings to need one', async () => {
    answer = () => ok('# A\n\n## B\n\n## C\n\ntext\n');
    await mount('/p/DESIGN.md');
    const links = [...host.querySelectorAll('.doc-outline-link')].map((b) => b.textContent);
    expect(links).toEqual(['A', 'B', 'C']);
  });

  it('shows front matter as a chip, collapsed, and not as a rule and a heading', async () => {
    answer = () => ok('---\ntitle: Hi\n---\n# Body\n');
    await mount('/p/post.md');
    const chip = q('.doc-front-chip')!;
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(q('.doc-front-body')).toBeNull();
    expect(q('[data-testid="doc-rendered"]')?.textContent).not.toContain('title: Hi');
    await click(chip);
    expect(q('.doc-front-body')?.textContent).toBe('title: Hi');
  });

  it('Ctrl+F opens a find bar scoped to this panel, and Escape closes it', async () => {
    answer = () => ok('# Feed\n\nthe feed feeds the feed\n');
    await mount('/p/PROGRESS.md');
    await act(async () => {
      q('[data-testid="document-viewer"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
      );
    });
    const input = q('.doc-find-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      // React's own value tracker swallows a plain `input.value = …` followed
      // by a dispatched event — it sees no change. The native setter is what
      // every React testing library reaches for, for exactly this reason.
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      setValue.call(input, 'feed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // the search is debounced — one pass per pause, not one per keystroke
    await settleFind();
    expect(host.querySelectorAll('mark[data-doc-match]').length).toBe(4);
    expect(q('[data-testid="doc-find-count"]')?.textContent).toBe('1 of 4');

    await act(async () => {
      q('[data-testid="document-viewer"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(q('.doc-find-input')).toBeNull();
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(0);
  });

  it('the find bar re-searches the NEW document after a link, not the old count', async () => {
    answer = (p) =>
      p.endsWith('a.md')
        ? ok('# feed\n\nfeed feed feed\n\n[go](./b.md)\n')
        : ok('# feed once\n');
    await mount('/p/a.md');
    await act(async () => {
      q('[data-testid="document-viewer"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
      );
    });
    const input = q('.doc-find-input') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      setValue.call(input, 'feed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settleFind();
    expect(q('[data-testid="doc-find-count"]')?.textContent).toBe('1 of 4');

    // `replaceChildren` destroys every mark; without the re-run the bar would
    // still read "1 of 4" over a document with nothing highlighted in it
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('b.md');
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(1);
    expect(q('[data-testid="doc-find-count"]')?.textContent).toBe('1 of 1');
  });
});

describe('formatBytes', () => {
  it('says sizes the way a human does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(148_000)).toBe('145 KB');
    expect(formatBytes(9_000)).toBe('8.8 KB');
    expect(formatBytes(5_000_000)).toBe('4.8 MB');
    expect(formatBytes(-1)).toBe('—');
  });
});
