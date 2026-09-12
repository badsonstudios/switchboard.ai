// @vitest-environment jsdom
// P2-E11-05: a sibling's message in the COMPOSER — the done-when's first line.
//
// "A send from A appears in B's composer as an attributed block AND DOES NOT
// SUBMIT. Assert the non-submission directly — this is the safety property, and
// a test that only checks the text arrived would pass on a version that
// auto-sends."
//
// So every test that shows a message also counts what reached the two ways a
// composer can send — `sessions.submitPrompt` and `pty.input` — and demands
// zero until a key is pressed. Mounted through the real panel contribution, for
// the reason `FeedView.attachments.test.tsx` gives: a wiring defect (a block
// never rendered, an Enter that drops the message) is invisible to the store's
// own tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import {
  SIBLING_SETTLE_MS,
  heldMessages,
  receiveSiblingMessage,
  resetInboxCacheForTests,
} from '../lib/sibling-inbox';
import { resetAttachmentDrafts } from '../lib/composer-attachment-draft';
import type { TransportKind } from '../../../shared/transport';
import { markerRef, type SiblingMessage } from '../../../shared/sibling-message';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** everything that reached main's typed-message route */
let submitted: string[];
/** what rode along as attachments, per submit */
let submittedAttachments: number[];
/** everything that reached the terminal route */
let ptyWrites: string[];
let mainTakes = true;
/** when set, `submitPrompt` stays pending until this is called — an in-flight send */
let release: (() => void) | null = null;
let holdSubmits = false;
/** the clock `lib/sibling-inbox.ts` reads for its settle window */
let clock = 1_000_000;
const roots: Root[] = [];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { blocks: () => Promise.resolve([]), onBlock: () => () => {}, onReset: () => () => {} },
    pty: { input: (_id: string, data: string) => ptyWrites.push(data) },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      submitPrompt: (_id: string, text: string, attachments?: unknown[]) => {
        const settle = (): boolean => {
          if (mainTakes) {
            submitted.push(text);
            submittedAttachments.push(attachments?.length ?? 0);
          }
          return mainTakes;
        };
        if (!holdSubmits) return Promise.resolve(settle());
        return new Promise<boolean>((resolve) => {
          release = () => resolve(settle());
        });
      },
    },
  };
}

/** Let a waiting message be on screen long enough to count as SEEN. */
const age = (): void => {
  clock += SIBLING_SETTLE_MS + 1;
};

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

/**
 * Really unmount the composer, the way a view-tab switch does.
 *
 * `mount()` leaves its root on `roots` for `afterEach`, so calling it twice
 * gives TWO live composers for one card — which is not a remount, and is not
 * the state a test about surviving an unmount is claiming to be in (it also
 * keeps `listeners` non-empty, so the card still reads as shown).
 */
async function unmountAll(): Promise<void> {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
}

async function mount(transport: TransportKind = 'stream'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-b',
    cardId: 'card-b',
    title: 'Beta',
    visible: true,
    dockEpoch: 0,
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

let n = 0;
const message = (text = 'the regulator is the fault — check it'): SiblingMessage => ({
  deliveryId: `d${n++}`,
  cardId: 'card-b',
  from: { id: 'live-a', name: 'Alpha' },
  text,
  at: '2026-09-10T08:00:00.000Z',
});

/** deliver, the way App.tsx does on a `sessions:siblingMessage` push */
async function arrive(m: SiblingMessage): Promise<ReturnType<typeof receiveSiblingMessage>> {
  let ack: ReturnType<typeof receiveSiblingMessage> = null;
  await act(async () => {
    ack = receiveSiblingMessage(m);
  });
  return ack;
}

const blocks = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-sibling-message]')];
const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;

async function type(host: HTMLElement, text: string): Promise<void> {
  const box = boxOf(host);
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(host: HTMLElement): Promise<void> {
  await act(async () => {
    boxOf(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** long enough for anything a stray timer would do — the PTY route's delayed CR is 75 ms */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  submittedAttachments = [];
  ptyWrites = [];
  mainTakes = true;
  holdSubmits = false;
  release = null;
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
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
  await loadUiState();
  resetInboxCacheForTests();
  resetAttachmentDrafts();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a message from another session', () => {
  it('appears in the composer as an ATTRIBUTED block — and NOTHING IS SUBMITTED', async () => {
    const host = await mount();
    await arrive(message());
    const [b] = blocks(host);
    expect(b).toBeDefined();
    expect(b.textContent).toContain('From @Alpha');
    expect(b.textContent).toContain('the regulator is the fault — check it');
    expect(b.textContent).toMatch(/Not sent yet/);
    await settle();
    // THE SAFETY PROPERTY, asserted directly: neither route a composer can
    // send through was touched.
    expect(submitted).toEqual([]);
    expect(ptyWrites).toEqual([]);
  });

  it('does not submit in TERMINAL mode either — the PTY route is the other door', async () => {
    const host = await mount('pty');
    await arrive(message());
    expect(blocks(host)).toHaveLength(1);
    await settle();
    expect(submitted).toEqual([]);
    expect(ptyWrites).toEqual([]);
  });

  it('does not touch what the user was typing', async () => {
    const host = await mount();
    await type(host, 'half a thought');
    await arrive(message());
    expect(boxOf(host).value).toBe('half a thought');
  });

  it('acknowledges SHOWN while this composer is mounted', async () => {
    await mount();
    expect(await arrive(message())).toEqual({ placed: true, shown: true });
  });

  it('a message to a card whose composer is NOT mounted still lands, says not shown, and appears on mount', async () => {
    expect(await arrive(message('waiting for you'))).toEqual({ placed: true, shown: false });
    const host = await mount();
    expect(blocks(host).map((b) => b.textContent)).toEqual([expect.stringContaining('waiting for you')]);
    await settle();
    expect(submitted).toEqual([]);
  });
});

describe('the user’s Enter is the keypress §5.4 requires', () => {
  it('sends the message in its attribution header, and the block goes', async () => {
    const host = await mount();
    const m = message('check it');
    await arrive(m);
    age();
    await pressEnter(host);
    const ref = markerRef(m.deliveryId);
    expect(submitted).toEqual([
      `[Message ${ref} from another switchboard session, "Alpha" (session id live-a). The user reviewed it and sent it on to you. ` +
        `It ends at the matching "End of message ${ref}" line.]\n` +
        'check it\n' +
        `[End of message ${ref} from "Alpha".]`,
    ]);
    expect(blocks(host)).toEqual([]);
    expect(heldMessages('card-b')).toEqual([]);
  });

  it('sends it AHEAD of what the user typed, as one prompt', async () => {
    const host = await mount();
    const m = message('check it');
    await arrive(m);
    age();
    await type(host, 'and then tell Alpha');
    await pressEnter(host);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatch(/^\[Message \w+ from another switchboard session, "Alpha"/);
    expect(
      submitted[0].endsWith(`[End of message ${markerRef(m.deliveryId)} from "Alpha".]\n\nand then tell Alpha`)
    ).toBe(true);
  });

  it('two waiting messages go together, oldest first', async () => {
    const host = await mount();
    await arrive(message('first'));
    await arrive(message('second'));
    age();
    await pressEnter(host);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].indexOf('first')).toBeLessThan(submitted[0].indexOf('second'));
  });

  it('in Terminal mode it goes the terminal route, as the user’s own prompt would', async () => {
    mainTakes = false; // a PTY session: main has no typed-message route
    const host = await mount('pty');
    await arrive(message('check it'));
    age();
    await pressEnter(host);
    await settle();
    expect(ptyWrites.join('')).toContain('check it');
    expect(ptyWrites.join('')).toContain('The user reviewed it');
  });
});

describe('an Enter that was not about the message does not send it (#765 review)', () => {
  it('a message that landed a split second before the user’s OWN Enter stays held', async () => {
    // The header would say "the user reviewed it". Nobody did — the keypress
    // was already on its way for the prompt the user was typing.
    const host = await mount();
    await type(host, 'my own prompt');
    await arrive(message('arrived just now'));
    await pressEnter(host);
    expect(submitted).toEqual(['my own prompt']);
    expect(blocks(host).map((b) => b.textContent)).toEqual([expect.stringContaining('arrived just now')]);
    // …and once it has been on screen, the next Enter sends it.
    age();
    await pressEnter(host);
    expect(submitted[1]).toContain('arrived just now');
  });

  it('a message that waited while the composer was NOT mounted is not "settled" on return (round 2)', async () => {
    // It arrived while the card was on its Terminal tab, and has been waiting
    // far longer than the settle window — but the user has not SEEN it until
    // the composer comes back, so an Enter pressed at once must not send it.
    await arrive(message('waited unseen'));
    age();
    age();
    const host = await mount();
    await type(host, 'my prompt');
    await pressEnter(host);
    expect(submitted).toEqual(['my prompt']);
    expect(blocks(host)).toHaveLength(1);
  });

  it('the Send button is not lit by a message the user has not had time to see', async () => {
    const host = await mount();
    await arrive(message('fresh'));
    const sendBtn = (): HTMLButtonElement | null =>
      host.querySelector<HTMLButtonElement>('button[title="Send to the session"]');
    expect(sendBtn()?.disabled ?? true).toBe(true);
    age();
    // the composer re-renders itself once the block has settled
    await act(async () => {
      await new Promise((r) => setTimeout(r, SIBLING_SETTLE_MS + 50));
    });
    expect(sendBtn()?.disabled).toBe(false);
  });

  it('a SLASH COMMAND goes alone and the messages stay held', async () => {
    // Folded in after a forwarded message, `/compact` would stop being a
    // command at all — the prompt would no longer start with `/`.
    const host = await mount();
    await arrive(message('please wait'));
    age();
    await type(host, '/compact');
    await pressEnter(host);
    expect(submitted).toEqual(['/compact']);
    expect(blocks(host)).toHaveLength(1);
  });
});

describe('the attachments path (#765 review: nothing pinned it)', () => {
  /** a PNG pasted the way a browser does it — see `FeedView.attachments.test.tsx` */
  async function pastePng(host: HTMLElement): Promise<void> {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    const file = new File([new Uint8Array(4)], 'image.png', { type: 'image/png' });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [file], getData: () => '' } });
    await act(async () => {
      boxOf(host).dispatchEvent(ev);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('a REFUSED send keeps the messages on screen with everything else', async () => {
    mainTakes = false;
    const host = await mount();
    await arrive(message('keep me'));
    age();
    await pastePng(host);
    await pressEnter(host);
    expect(submitted).toEqual([]);
    expect(blocks(host).map((b) => b.textContent)).toEqual([expect.stringContaining('keep me')]);
  });

  it('a send that goes forwards the message WITH the attachment, then takes it off', async () => {
    const host = await mount();
    await arrive(message('look at this too'));
    age();
    await pastePng(host);
    await pressEnter(host);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('look at this too');
    expect(submittedAttachments).toEqual([1]);
    expect(blocks(host)).toEqual([]);
  });

  it('a message that arrives WHILE the send is in flight is not swept away with it', async () => {
    holdSubmits = true;
    const host = await mount();
    await arrive(message('sent one'));
    age();
    await pastePng(host);
    await pressEnter(host);
    await arrive(message('arrived mid-send'));
    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('sent one');
    expect(submitted[0]).not.toContain('arrived mid-send');
    expect(blocks(host).map((b) => b.textContent)).toEqual([expect.stringContaining('arrived mid-send')]);
  });

  describe('a SECOND Enter while that send is in flight (#774)', () => {
    // With attachments the box is deliberately not cleared until main says the
    // send went — a refused send must not silently eat a pasted screenshot. So
    // the second Enter lands on a composer still showing everything the first
    // one sent. That cost a duplicate PROMPT before P2-E11-05; it now also
    // forwards the sibling's message a second time, each copy under a header
    // saying the user reviewed and sent it.

    it('sends once, and forwards the message once', async () => {
      holdSubmits = true;
      const host = await mount();
      await arrive(message('forward me once'));
      age();
      await pastePng(host);

      await pressEnter(host);
      await pressEnter(host);
      await pressEnter(host);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(submitted).toHaveLength(1);
      expect(submittedAttachments).toEqual([1]);
      // the marker ref appears once, so the message went as one forwarded
      // block and not as two
      expect(submitted[0].match(/forward me once/g)).toHaveLength(1);
      expect(blocks(host)).toEqual([]);
    });

    it('greys Send while the send is out, rather than offering a press that does nothing', async () => {
      holdSubmits = true;
      const host = await mount();
      await arrive(message('waiting'));
      age();
      await pastePng(host);
      const send = (): HTMLButtonElement =>
        host.querySelector<HTMLButtonElement>('button[title="Send to the session"]')!;
      expect(send().disabled).toBe(false);

      await pressEnter(host);
      expect(send().disabled).toBe(true);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });
    });

    it('opens the box again after a REFUSED send, so the user can retry', async () => {
      // The guard must not be able to wedge the composer shut: a refused send
      // leaves everything on screen precisely so it can be sent again.
      holdSubmits = true;
      mainTakes = false;
      const host = await mount();
      await arrive(message('still here'));
      age();
      await pastePng(host);
      await pressEnter(host);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(submitted).toEqual([]);

      // ...and now it takes it
      mainTakes = true;
      holdSubmits = false;
      await pressEnter(host);
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toContain('still here');
    });

    it('⚠️ survives the composer being UNMOUNTED and remounted mid-flight', async () => {
      // THE REVIEW'S FINDING, and the first version of this guard failed it.
      // The composer unmounts on a view-tab switch or a collapse, while BOTH
      // things the guard protects outlive it: the attachments come back from
      // their own module-level stash, and the held messages live in the inbox.
      // A guard kept in component state therefore came back a fresh `false`
      // with the same payload on screen — and the next Enter sent all of it
      // again. That is the duplicate this item exists to stop, reached through
      // the fix for it, so the flag is keyed by CARD and outlives the view.
      holdSubmits = true;
      const host = await mount();
      await arrive(message('exactly once'));
      age();
      await pastePng(host);
      await pressEnter(host);

      // flip away and back — the composer really goes, then a new one for the
      // same card comes up with the attachments restored from their module
      // stash and the message still held
      await unmountAll();
      const host2 = await mount();
      age();
      await pressEnter(host2);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(submitted).toHaveLength(1);
      expect(submitted[0].match(/exactly once/g)).toHaveLength(1);
    });

    it('the remounted composer greys Send, then un-greys when the send lands', async () => {
      // The other half: the release closure belongs to the component that
      // started the send, which by then is gone — so the flag has to be
      // OBSERVED, or the new composer comes back greyed for ever.
      //
      // A REFUSED send, and NO timer wait, deliberately. Both matter: a refusal
      // leaves the attachment on screen so the button is sendable the instant
      // the flag clears, and waiting on the settle tick would re-render the
      // composer for an unrelated reason — which is exactly how the first
      // version of this test passed against a release that notified nobody.
      holdSubmits = true;
      mainTakes = false;
      const host = await mount();
      await arrive(message('watch the button'));
      age();
      await pastePng(host);
      await pressEnter(host);

      await unmountAll();
      const host2 = await mount();
      const send = (): HTMLButtonElement =>
        host2.querySelector<HTMLButtonElement>('button[title="Send to the session"]')!;
      expect(send().disabled).toBe(true);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(send().disabled).toBe(false);
    });

    it('blocks a plain-text Enter too, so the held message cannot go twice', async () => {
      // The guard is above the branch split on purpose. If it only covered the
      // attachments path, clearing the strip mid-flight would drop the next
      // Enter into the text path — where the same held messages are still on
      // the card, and would be forwarded again.
      holdSubmits = true;
      const host = await mount();
      await arrive(message('only once please'));
      age();
      await pastePng(host);
      await pressEnter(host);

      // the user pulls the attachment off while the send is out
      const remove = host.querySelector<HTMLButtonElement>('button[title^="Remove"]');
      if (remove) await act(async () => remove.click());
      await type(host, 'never mind');
      await pressEnter(host);

      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toContain('only once please');
      expect(submitted[0]).not.toContain('never mind');
    });
  });
});

describe('dismissing', () => {
  it('removes the block WITHOUT sending anything', async () => {
    const host = await mount();
    const m = message();
    await arrive(m);
    const dismiss = host.querySelector<HTMLButtonElement>(`[data-sibling-dismiss="${m.deliveryId}"]`)!;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss the message from Alpha');
    await act(async () => dismiss.click());
    expect(blocks(host)).toEqual([]);
    await settle();
    expect(submitted).toEqual([]);
    expect(ptyWrites).toEqual([]);
  });

  it('a dismissed message is not sent by the next Enter', async () => {
    const host = await mount();
    const m = message('ignore me');
    await arrive(m);
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-sibling-dismiss="${m.deliveryId}"]`)!.click());
    await type(host, 'my own prompt');
    await pressEnter(host);
    expect(submitted).toEqual(['my own prompt']);
  });
});

it('a composer with nothing waiting renders no block at all', async () => {
  const host = await mount();
  expect(host.querySelector('[data-sibling-messages]')).toBeNull();
});
