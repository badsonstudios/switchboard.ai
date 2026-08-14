// @vitest-environment jsdom
// P2-E10-09: the composer's clipboard WIRING.
//
// `lib/composer-attachments.test.ts` pins the rules and
// `sessions/submit-prompt.test.ts` pins the wire shape. Neither would notice
// the defect this file exists for: a paste handler that is never attached, a
// chip that is never rendered, or a submit that drops the attachments on the
// floor — the same reason `FeedView.composer.test.tsx` renders the real panel
// instead of testing `composerSize` in isolation.
//
// So this mounts the actual contribution and drives it through real events.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** what main was asked to send, in order */
let submitted: Array<{ text: string; images?: Array<{ mediaType: string; data: string }> }>;
/** what main answers — false is "no typed-message transport / refused" */
let mainTakes = true;

const roots: Root[] = [];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    pty: { input: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      submitPrompt: (
        _id: string,
        text: string,
        images?: Array<{ mediaType: string; data: string }>
      ) => {
        if (mainTakes) submitted.push({ text, images });
        return Promise.resolve(mainTakes);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(transport: 'pty' | 'stream' = 'stream'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const chips = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-composer-attachment]')].map(
    (el) => el.getAttribute('data-composer-attachment')!
  );
const notice = (host: HTMLElement): string =>
  host.querySelector('[data-composer-attach-notice]')?.textContent ?? '';

/** a PNG of `n` bytes — the content is never decoded, only counted and encoded */
const png = (n = 4, name = 'image.png', type = 'image/png'): File =>
  new File([new Uint8Array(n)], name, { type });

/**
 * Paste, the way a browser does it.
 *
 * jsdom's `DataTransfer` cannot be built with files in it, so the clipboard is
 * a plain object hung off the event — which is exactly the surface React reads
 * (`'clipboardData' in event ? event.clipboardData : window.clipboardData`)
 * and exactly the surface the handler consumes.
 */
async function paste(
  host: HTMLElement,
  { files = [] as File[], text = '' }: { files?: File[]; text?: string }
): Promise<Event> {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { files, getData: (t: string) => (t === 'text/plain' ? text : '') },
  });
  await act(async () => {
    boxOf(host).dispatchEvent(ev);
  });
  // the read is async (File -> ArrayBuffer -> base64); let it settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return ev;
}

/** type into the CONTROLLED textarea, through the setter React's tracker patched */
async function type(host: HTMLElement, text: string): Promise<void> {
  const box = boxOf(host);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send(host: HTMLElement): Promise<void> {
  await act(async () => {
    boxOf(host).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  mainTakes = true;
  // jsdom has no ResizeObserver, and both the scroll anchor and the composer's
  // re-measure-on-narrower install one (`FeedView.composer.test.tsx` does the
  // same for the same reason)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
  stubBridge();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('pasting a bitmap', () => {
  it('shows a removable chip for it', async () => {
    const host = await mount();
    expect(chips(host)).toEqual([]);

    await paste(host, { files: [png()] });

    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0]).toMatch(/^pasted-\d{8}-\d{6}\.png$/);

    const remove = host.querySelector<HTMLButtonElement>(
      '[data-composer-attachment] button'
    )!;
    await act(async () => remove.click());
    expect(chips(host)).toEqual([]);
  });

  it('suppresses the default paste when there is nothing to insert', async () => {
    const host = await mount();
    const ev = await paste(host, { files: [png()] });
    expect(ev.defaultPrevented).toBe(true);
  });

  // The clause the item is explicit about: a clipboard with BOTH keeps both.
  it('lets the text paste run when the clipboard also carries text', async () => {
    const host = await mount();
    const ev = await paste(host, { files: [png()], text: 'from a spreadsheet' });

    expect(ev.defaultPrevented).toBe(false); // the browser inserts the text itself
    expect(chips(host)).toHaveLength(1); // ...and the image still attached
  });

  it('an image with nothing typed still enables the send button', async () => {
    const host = await mount();
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.title === 'Send to the session'
    )!;
    expect(button.disabled).toBe(true);

    await paste(host, { files: [png()] });

    expect(button.disabled).toBe(false);
  });
});

// THE REGRESSION THAT WOULD BE INVISIBLE: this feature's whole risk is that it
// breaks the paste that already worked, for everyone, every day.
describe('pasting plain text is completely unaffected', () => {
  it('does not preventDefault, attach anything, or say anything', async () => {
    const host = await mount();

    const ev = await paste(host, { text: 'just some words' });

    expect(ev.defaultPrevented).toBe(false);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toBe('');
    expect(host.querySelector('[role="group"]')).toBeNull(); // no strip at all
  });
});

describe('submitting', () => {
  it('sends the image blocks alongside the text, then clears', async () => {
    const host = await mount();
    await paste(host, { files: [png()] });
    await type(host, 'what is this?');

    await send(host);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].text).toBe('what is this?');
    expect(submitted[0].images).toEqual([{ mediaType: 'image/png', data: 'AAAAAA==' }]);
    expect(chips(host)).toEqual([]);
    expect(boxOf(host).value).toBe('');
  });

  // A refused send must not eat the draft: a pasted screenshot cannot be got
  // back from the clipboard a minute later.
  it('keeps the draft AND the image when main refuses', async () => {
    mainTakes = false;
    const host = await mount();
    await paste(host, { files: [png()] });
    await type(host, 'what is this?');

    await send(host);

    expect(chips(host)).toHaveLength(1);
    expect(boxOf(host).value).toBe('what is this?');
    expect(notice(host)).toContain("wasn't sent");
  });
});

describe('a Terminal-mode session says so instead of pretending', () => {
  it('refuses the attachment and explains why', async () => {
    const host = await mount('pty');

    const ev = await paste(host, { files: [png()] });

    expect(ev.defaultPrevented).toBe(true);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Direct mode');
  });

  it('still leaves a plain-text paste alone', async () => {
    const host = await mount('pty');
    const ev = await paste(host, { text: 'words' });
    expect(ev.defaultPrevented).toBe(false);
    expect(notice(host)).toBe('');
  });

  // The image is the part this session cannot take. The WORDS on the same
  // clipboard are still the user's, and swallowing them too would make a
  // Terminal-mode session worse at ordinary pasting than it was before.
  it('still lets the text half of a text+image clipboard through', async () => {
    const host = await mount('pty');

    const ev = await paste(host, { files: [png()], text: 'from a spreadsheet' });

    expect(ev.defaultPrevented).toBe(false);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Direct mode');
  });
});

describe('a paste that produces nothing says why', () => {
  it('names the escape hatch for an unsupported type', async () => {
    const host = await mount();

    await paste(host, { files: [png(8, 'scan.tiff', 'image/tiff')] });

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('full file path');
  });
});
