// @vitest-environment jsdom
// The composer's end of the context drop (P2-E11-10, §5.5).
//
// `context-drop.test.ts` pins what the offer CONTAINS and
// `ContextDropDialog.test.tsx` pins what the dialog DOES with it. Neither would
// notice the defect this file exists for: a drop handler that never runs, a
// chip that is swallowed as a file, a dialog that is never mounted, or an OK
// that injects into nothing. So this mounts the real panel and drives it with
// real events.
//
// ⚠️ THE LOAD-BEARING TEST IS "goes VERBATIM on the next Enter". Everything else
// here could pass while the block was quietly wrapped in the sibling-message
// header — which would tell the receiving agent that another SESSION sent this
// and a human relayed it, when in fact the human went and fetched it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import {
  SIBLING_SETTLE_MS,
  heldMessages,
  holdContextBlock,
  resetInboxCacheForTests,
} from '../lib/sibling-inbox';
import { SIBLING_INBOX_CAP } from '../../../shared/sibling-message';
import { CONTEXT_DND_TYPE, type ContextOffer } from '../../../shared/context-drop';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** resolves the offer call by hand, so "before it lands" is a real state */
let releaseOffer: (() => void) | null = null;
/** what main was asked to send, in order */
let submitted: string[];
/** which session ids main was asked for an offer about */
let asked: string[];
/** what `sessions.contextOffer` answers — a refusal and a null are both real */
let offerAnswer: unknown;
/** the clock `lib/sibling-inbox.ts` reads for its settle window */
let clock = 1_000_000;

const roots: Root[] = [];

const OFFER: ContextOffer = {
  from: { id: 'live-2', name: 'TradingApp' },
  coverage: 'whole',
  options: [
    { id: 'state', tokens: 120, empty: false, text: 'STATE-TEXT' },
    { id: 'package', tokens: 3100, empty: false, text: '# Context from @TradingApp\n\nPACKAGE-TEXT' },
    { id: 'excerpt', tokens: 1500, empty: false, text: 'EXCERPT-TEXT' },
  ],
};

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    pty: { input: () => {} },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      summaries: () => Promise.resolve([]),
      contextOffer: (ref: string) => {
        asked.push(ref);
        return new Promise((resolve) => {
          const fire = (): void => resolve(offerAnswer);
          // Immediate unless a test armed `releaseOffer` first, in which case it
          // holds the call open — `ModelPickerDialog.test.tsx`'s idiom.
          if (releaseOffer === null) fire();
          else releaseOffer = fire;
        });
      },
      submitPrompt: (_id: string, text: string) => {
        submitted.push(text);
        return Promise.resolve(true);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport: 'stream',
    controlsLock: null,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const zone = (host: HTMLElement): HTMLElement =>
  host.querySelector('[data-composer-dropzone]') as HTMLElement;
const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const notice = (host: HTMLElement): string =>
  host.querySelector('[data-composer-attach-notice]')?.textContent ?? '';
const dialog = (host: HTMLElement): HTMLElement | null =>
  host.querySelector('[data-testid="context-drop"]');
const blocks = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll('[data-sibling-message]')] as HTMLElement[];

/** the transfer a context chip drags under */
function chipTransfer(fromId: string): unknown {
  return {
    types: [CONTEXT_DND_TYPE],
    files: [],
    items: [],
    dropEffect: 'none',
    getData: (t: string) => (t === CONTEXT_DND_TYPE ? fromId : ''),
  };
}

async function fire(host: HTMLElement, type: string, dataTransfer: unknown): Promise<Event> {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  await act(async () => {
    zone(host).dispatchEvent(ev);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return ev;
}

/** the whole gesture: enter, over, drop */
async function dropChip(host: HTMLElement, fromId = 'live-2'): Promise<Event> {
  const dt = chipTransfer(fromId);
  await fire(host, 'dragenter', dt);
  await fire(host, 'dragover', dt);
  return fire(host, 'drop', dt);
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

/** Let a waiting block be on screen long enough to count as SEEN. */
const age = (): void => {
  clock += SIBLING_SETTLE_MS + 1;
};

async function pressEnter(host: HTMLElement): Promise<void> {
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

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(async () => {
  document.body.innerHTML = '';
  submitted = [];
  asked = [];
  offerAnswer = OFFER;
  releaseOffer = null;
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  // jsdom has no ResizeObserver, and both the scroll anchor and the composer's
  // re-measure-on-narrower install one (`FeedView.composer.test.tsx` and
  // `FeedView.attachments.test.tsx` do the same, for the same reason).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  stubBridge();
  await loadUiState();
  // The inbox is a MODULE-LEVEL store that outlives a React root by design —
  // which is what makes a held block survive a remount, and exactly what would
  // carry one test's context block into the next.
  resetInboxCacheForTests();
});

afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('a context chip dropped on the composer (P2-E11-10)', () => {
  it('asks main what that session is offering, and opens the dialog', async () => {
    const host = await mount();
    await dropChip(host);
    expect(asked).toEqual(['live-2']);
    expect(dialog(host)).not.toBeNull();
  });

  it('⚠️ injects NOTHING until a fidelity is chosen', async () => {
    const host = await mount();
    await dropChip(host);
    expect(blocks(host)).toHaveLength(0);
    expect(heldMessages('card-1')).toHaveLength(0);
    expect(submitted).toEqual([]);
    expect(boxOf(host).value).toBe('');
  });

  it('swallows the drop, so the window listener cannot also open it as a session', async () => {
    // `App.tsx` turns a drop on the window into a new session card. Without the
    // stop, one chip drop would do both things — brief the session AND ask the
    // window to open something as a session of its own.
    //
    // ASSERTED ON A REAL WINDOW LISTENER rather than on the native event's
    // `cancelBubble`, which is what the first version of this test did and why
    // it failed: React dispatches through its own root container, so a
    // synthetic `stopPropagation` does not reliably leave that flag set on the
    // native event. The flag is React's internals; the listener is the property
    // the app actually depends on. `FeedView.attachments.test.tsx` checks the
    // file drop the same way.
    const host = await mount();
    let reachedWindow = 0;
    const onWindowDrop = (): void => {
      reachedWindow++;
    };
    window.addEventListener('drop', onWindowDrop);
    try {
      const ev = await dropChip(host);
      expect(ev.defaultPrevented).toBe(true);
      expect(reachedWindow).toBe(0);
    } finally {
      window.removeEventListener('drop', onWindowDrop);
    }
  });

  it('⚠️ says CONTEXT in the drop hint, not "drop files"', async () => {
    // The overlay is painted over the exact target the manual tells the user to
    // aim a chip at, and it used to read "Drop files to attach them to your
    // prompt" — the composer's own file-drop wording, for a gesture that has
    // nothing to do with files.
    const host = await mount();
    await fire(host, 'dragenter', chipTransfer('live-2'));
    const hint = host.querySelector('[data-composer-drop-hint]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('context');
    expect(hint!.textContent).not.toContain('Drop files');
  });

  it('⚠️ ignores a SECOND chip dropped while the first offer is still on the wire', async () => {
    // Last-wins would silently discard the first drop, and a package build is a
    // real round trip, so the window is not theoretical.
    releaseOffer = () => {};
    const host = await mount();
    await dropChip(host);
    await dropChip(host);
    expect(asked).toEqual(['live-2']);

    // …and the guard releases, so the NEXT drop is served normally.
    const fire2 = releaseOffer;
    await act(async () => {
      fire2?.();
      await Promise.resolve();
    });
    releaseOffer = null;
    await dropChip(host);
    expect(asked).toEqual(['live-2', 'live-2']);
  });

  it('refuses a SELF-drop out loud, without asking main at all', async () => {
    const host = await mount();
    await dropChip(host, 'live-1'); // the composer's own session
    expect(asked).toEqual([]);
    expect(dialog(host)).toBeNull();
    expect(notice(host)).toContain('own context');
  });

  it('says so when no offer comes back, rather than opening an empty dialog', async () => {
    offerAnswer = null;
    const host = await mount();
    await dropChip(host);
    expect(dialog(host)).toBeNull();
    expect(notice(host)).toContain("couldn't be read");
  });

  it('⚠️ treats a broker REFUSAL as "no offer" — it is a truthy object', async () => {
    offerAnswer = { __ipcRefused: true, channel: 'sessions:contextOffer', reason: 'not-granted' };
    const host = await mount();
    await dropChip(host);
    expect(dialog(host)).toBeNull();
    expect(notice(host)).toContain("couldn't be read");
  });
});

describe('choosing a fidelity', () => {
  it('parks the chosen text in this card’s composer, and submits NOTHING', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-option="excerpt"]')!);
    await click(host.querySelector('[data-context-ok]')!);

    expect(dialog(host)).toBeNull();
    const held = heldMessages('card-1');
    expect(held).toHaveLength(1);
    expect(held[0].text).toBe('EXCERPT-TEXT');
    expect(submitted).toEqual([]);
  });

  it('takes the DEFAULT when no row was touched — §5.5’s Level 2', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);
    expect(heldMessages('card-1')[0].text).toContain('PACKAGE-TEXT');
  });

  it('shows it as an attributed block, marked as CONTEXT rather than as a message', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);

    const shown = blocks(host);
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute('data-sibling-kind')).toBe('context');
    expect(shown[0].textContent).toContain('Context from @TradingApp');
    // …and it says it has not gone anywhere yet.
    expect(shown[0].textContent).toContain('Not sent yet');
    // The REGION is named for what it holds, too: a group carrying only context
    // the user dragged is not "messages from other sessions", and that label is
    // all a screen-reader user gets for it.
    expect(host.querySelector('[data-sibling-messages]')?.getAttribute('aria-label')).toContain(
      'Context'
    );
  });

  it('⚠️ refuses a full card with the RIGHT reason, not "the box is full" for every failure', async () => {
    const host = await mount();
    for (let i = 0; i < SIBLING_INBOX_CAP; i++) {
      holdContextBlock('card-1', { id: 'live-2', name: 'TradingApp' }, `filler ${i}`);
    }
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);

    expect(notice(host)).toContain('already holding as much as it can');
    expect(heldMessages('card-1')).toHaveLength(SIBLING_INBOX_CAP);
  });

  it('leaves the caret in the prompt box — the gesture ends with "now press Enter"', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);
    // Without this the OK button is removed from under the focus and it lands
    // on `<body>`, one gesture short of the Enter the whole feature is for.
    expect(document.activeElement).toBe(boxOf(host));
  });

  it('tells the user where it went', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);
    expect(notice(host)).toContain('waiting in the prompt box');
  });

  it('Cancel parks nothing and leaves the box untouched', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-cancel]')!);
    expect(dialog(host)).toBeNull();
    expect(heldMessages('card-1')).toHaveLength(0);
    expect(blocks(host)).toHaveLength(0);
    expect(boxOf(host).value).toBe('');
    expect(submitted).toEqual([]);
  });
});

describe('what the user’s Enter then sends', () => {
  it('⚠️ sends the block VERBATIM — no sibling header, because no sibling sent it', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-option="state"]')!);
    await click(host.querySelector('[data-context-ok]')!);

    age(); // the composer has now been showing it long enough to count as seen
    await pressEnter(host);

    expect(submitted).toEqual(['STATE-TEXT']);
    // The header that would have been wrong:
    expect(submitted[0]).not.toContain('from another switchboard session');
    // …and it is taken off the card once it has gone.
    expect(heldMessages('card-1')).toHaveLength(0);
  });

  it('carries whatever the user typed alongside it, after the context', async () => {
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-option="state"]')!);
    await click(host.querySelector('[data-context-ok]')!);

    const box = boxOf(host);
    // Kept as the DESCRIPTOR: `PropertyDescriptor.set` is declared a METHOD in
    // lib.es5.d.ts, so pulling it into a variable is `unbound-method`. Calling
    // through it with an explicit `this` is the same write.
    const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    await act(async () => {
      valueProp.set!.call(box, 'carry on from here');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    age();
    await pressEnter(host);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe('STATE-TEXT\n\ncarry on from here');
  });

  it('an Enter pressed before the block has settled does not send it', async () => {
    // #765's rule, inherited: a block that appeared a split second before an
    // Enter the user was already pressing was not reviewed by anyone.
    const host = await mount();
    await dropChip(host);
    await click(host.querySelector('[data-context-ok]')!);
    await pressEnter(host); // no `age()`
    expect(submitted).toEqual([]);
    expect(heldMessages('card-1')).toHaveLength(1);
  });
});
