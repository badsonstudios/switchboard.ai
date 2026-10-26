// @vitest-environment jsdom
// #716: what one keystroke, and one streamed chunk, cost the prompt box in
// RENDERS — the structural half of the typing-lag fix, pinned without a clock.
//
// Measured in the real app (four busy sessions, 4x CPU throttle): every
// `FeedView` render — one per streamed chunk, in every busy card, open or
// hidden — rendered that card's whole `Composer` and its context meter with it,
// ~64 composer renders a second with nothing in any of them changing; and every
// character typed rendered the composer TWICE (the change, then the key-up
// writing the same caret again) and the meter once. Script on the main thread
// fell by about a quarter with those gone.
//
// HOW IT COUNTS, two ways. The context meter is swapped for a counter: the
// composer draws it on every render that reaches its children (a stream session
// with a live id, as below). The real meter is memoised too and would hide
// exactly the renders this file is about. And the composer's own body is
// counted through a hook only it calls, because the key-up's extra render was
// the kind a child count cannot see — React ran the whole composer again, found
// nothing changed, and skipped the children.
//
// No timing budget anywhere: "typing must take under N ms" is a flake with a
// countdown on it (`FeedView.composer.test.tsx` says the same).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const counted = vi.hoisted(() => ({ meter: 0, body: 0 }));
// ...and every time the composer's own function body runs, which a meter count
// cannot see: a render that changes nothing re-runs the whole body and then
// skips its children, the meter included. `useSendInFlight` is called by the
// composer and by nothing else.
vi.mock('../lib/sibling-inbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sibling-inbox')>();
  return {
    ...actual,
    useSendInFlight: (...args: Parameters<typeof actual.useSendInFlight>) => {
      counted.body += 1;
      return actual.useSendInFlight(...args);
    },
  };
});
vi.mock('./ContextMeter', () => ({
  ContextMeter: (): null => {
    counted.meter += 1;
    return null;
  },
}));

let push: ((p: { sessionId: string; block: FeedBlockDto }) => void) | null = null;

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: (cb: (p: { sessionId: string; block: FeedBlockDto }) => void) => {
        push = cb;
        return () => {
          push = null;
        };
      },
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;
let root: Root | null = null;
let host: HTMLElement;

function context(over: Partial<PanelContext> = {}): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    controlsLock: null,
    // the meter (our counter) is drawn only for a session whose model can be switched
    transport: 'stream',
    status: 'working',
    setView: () => {},
    ...over,
  };
}

async function render(ctx: PanelContext): Promise<void> {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(feedPanel.render(ctx));
  });
}

const box = (): HTMLTextAreaElement => host.querySelector('textarea')!;

/** one key, the way a browser delivers it: the edit, then the key-up */
async function typeKey(ch: string): Promise<void> {
  const el = box();
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(el, el.value + ch);
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  });
}

/** a reply growing, chunk by chunk — what a busy session sends its card */
async function stream(chunks: number): Promise<void> {
  for (let i = 1; i <= chunks; i += 1) {
    await act(async () => {
      push?.({
        sessionId: 'live-1',
        // a reply growing (one block, upserted) and, every third chunk, a new one
        block: {
          seq: Math.ceil(i / 3),
          kind: 'assistant',
          text: `reply ${Math.ceil(i / 3)}: ${'word '.repeat(i)}`,
          sidechain: false,
        },
      });
    });
  }
}

beforeAll(() => {
  // the block renderers are contributions: without them the feed draws empty
  // boxes, and "the chunks landed" below would be asserted of nothing
  registerBuiltinContributions(rendererRegistry);
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
  stubBridge();
  // jsdom has none; the feed's scroll anchor and the composer both install one
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await loadUiState(); // an empty draft blob per test: every one mounts card-1
  counted.meter = 0;
  counted.body = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  push = null;
  vi.unstubAllGlobals();
});

describe('the prompt box, in renders (#716)', () => {
  it('a streamed chunk renders the conversation and NOT the prompt box', async () => {
    await render(context());
    expect(counted.meter).toBeGreaterThan(0); // the counter is wired: the box drew it
    const before = counted.meter;
    await stream(12);
    // the chunks did land — the feed shows the reply as it grew
    expect(host.textContent).toContain('reply 4: word word word');
    expect(counted.meter).toBe(before);
  });

  it('one character typed renders the prompt box ONCE — the key-up does not render it again', async () => {
    await render(context());
    const before = counted.meter;
    const ran = counted.body;
    for (const ch of 'hello') await typeKey(ch);
    expect(box().value).toBe('hello');
    expect(counted.meter - before).toBe(5);
    expect(counted.body - ran).toBe(5);
  });

  it('a caret moved without typing is still followed — the key-up records it', async () => {
    await render(context());
    for (const ch of 'abc') await typeKey(ch);
    const before = counted.meter;
    const el = box();
    // ArrowLeft: the caret moves, the text does not — only the key-up can tell
    await act(async () => {
      el.setSelectionRange(1, 1);
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(counted.meter - before).toBe(1);
  });

  it("the card's fresh callbacks do not render it, and a click reaches the NEWEST one", async () => {
    const first = vi.fn();
    await render(context({ onSetAutonomy: first }));
    const before = counted.meter;
    const second = vi.fn();
    // the card re-renders and hands down a new arrow function, as it does on
    // every render of its own; nothing the box shows has changed
    await render(context({ onSetAutonomy: second }));
    expect(counted.meter).toBe(before);
    // the mode chip opens its menu (#1462); picking a mode is the callback
    await act(async () => {
      (host.querySelector('[data-testid="composer-autonomy"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (host.querySelector('[data-autonomy-row="plan"]') as HTMLButtonElement).click();
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('plan');
    expect(first).not.toHaveBeenCalled();
  });

  it('a prop the box DOES show still renders it', async () => {
    await render(context({ status: 'working' }));
    const before = counted.meter;
    await render(context({ status: 'idle' }));
    expect(counted.meter).toBe(before + 1);
  });
});
