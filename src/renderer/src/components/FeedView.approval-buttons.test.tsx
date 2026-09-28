// @vitest-environment jsdom
// The approval bar's BUTTONS — E22's two additions to §5.16's ladder.
//
// Named for the bar rather than for one item, because both things it covers are
// the same hazard in the same row: `Deny with feedback` (P2-E22-02, #973) and
// `Approve all in this file` (P2-E22-03, #974). It was
// `FeedView.deny-feedback.test.tsx` until the second one arrived.
//
// WHAT THIS FILE IS REALLY GUARDING is a dropped argument. `decidePermission`
// has accepted a `reason` since the stream transport landed, and main has always
// sent it as the denial `message` — the feature was missing because every
// renderer signature between the button and the bridge was typed
// `(requestId, decision)` and the text had nowhere to be put. That is a failure
// no main-side test can see and no type error can catch once the signatures are
// widened: they will happily accept a `reason` that nothing passes.
//
// So every assertion here is on what reached `onDecide`, which is the last hop
// before the bridge. `stream-permissions.test.ts` picks it up from there and
// asserts the outbound payload.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { MAX_DENIAL_REASON_CHARS } from '../../../shared/ipc/permissions';

const { FeedView } = await import('./FeedView');

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** what reached the last hop before the bridge */
type Decision = [string, boolean | undefined, unknown, string | undefined];

let root: Root | null = null;
let decisions: Decision[] = [];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
  };
}

async function mountHeld(
  requestId = 'r1',
  tool = 'Bash',
  input: Record<string, unknown> = { command: 'rm -rf build' },
  // `undefined` is a REAL case and the default is deliberately not a stub: an
  // absent `onAllowFile` is what a host that cannot grant looks like, and #974's
  // button has to be absent rather than dead for it.
  onAllowFile?: (filePath: string) => void
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FeedView
        sessionId="live-1"
        cardId="card-1"
        visible
        controlsLock={null}
        approval={{ requestId, tool, input }}
        onDecide={(decision, allowAll, updatedInput, reason) =>
          decisions.push([decision, allowAll, updatedInput, reason])
        }
        onAllowFile={onAllowFile}
      />
    );
  });
  return host;
}

/** re-render the SAME mounted bar with a different held request */
async function swapTo(requestId: string): Promise<void> {
  await act(async () => {
    root!.render(
      <FeedView
        sessionId="live-1"
        cardId="card-1"
        visible
        controlsLock={null}
        approval={{ requestId, tool: 'Bash', input: { command: 'curl example.com' } }}
        onDecide={(decision, allowAll, updatedInput, reason) =>
          decisions.push([decision, allowAll, updatedInput, reason])
        }
      />
    );
  });
}

const trigger = (h: HTMLElement): HTMLButtonElement =>
  h.querySelector('[data-approval-deny-feedback]') as HTMLButtonElement;
const field = (h: HTMLElement): HTMLTextAreaElement | null =>
  h.querySelector('[data-deny-feedback-input]');

async function open(host: HTMLElement): Promise<HTMLTextAreaElement> {
  // FOCUS, THEN CLICK. A real browser focuses a button on mousedown and jsdom
  // does not, so `.click()` alone leaves `document.activeElement` on `body` —
  // which would make the focus-restore assertion below test jsdom rather than
  // the component. Keyboard activation takes this same path for real.
  await act(async () => {
    trigger(host).focus();
    trigger(host).click();
  });
  const f = field(host);
  if (!f) throw new Error('the objection field did not open');
  return f;
}

async function type(f: HTMLTextAreaElement, text: string): Promise<void> {
  // React tracks the last value it wrote on the DOM node; setting `.value`
  // directly leaves that tracker in step and the change event is swallowed.
  //
  // Kept as the DESCRIPTOR: `PropertyDescriptor.set` is declared a METHOD, so
  // pulling it into a variable is `unbound-method` (#255 T4). Same write.
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(f, text);
    f.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(f: HTMLTextAreaElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    f.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  decisions = [];
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the objection field (P2-E22-02, #973)', () => {
  it('is closed until asked for, so an ordinary approval is unchanged', async () => {
    const host = await mountHeld();
    expect(trigger(host)).not.toBeNull();
    expect(field(host)).toBeNull();
  });

  it('focus lands in the FIELD, not on the button that opened it', async () => {
    const host = await mountHeld();
    const f = await open(host);
    expect(document.activeElement).toBe(f);
  });

  it('Enter sends the typed objection as the denial reason', async () => {
    const host = await mountHeld();
    const f = await open(host);
    await type(f, 'that deletes the build I am about to ship');
    await key(f, { key: 'Enter' });

    expect(decisions).toEqual([
      ['deny', false, undefined, 'that deletes the build I am about to ship'],
    ]);
  });

  it('Shift+Enter does NOT send — it is how a paragraph break is typed', async () => {
    const host = await mountHeld();
    const f = await open(host);
    await type(f, 'because');
    await key(f, { key: 'Enter', shiftKey: true });

    expect(decisions).toEqual([]);
    expect(field(host)).not.toBeNull();
  });

  it('Esc cancels: nothing is answered and the request stays held', async () => {
    const host = await mountHeld();
    const f = await open(host);
    await type(f, 'changed my mind');
    await key(f, { key: 'Escape' });

    expect(decisions).toEqual([]);
    expect(field(host)).toBeNull();
    // the bar is still asking
    expect(host.textContent).toContain('Allow Bash?');
  });

  it('the Send button sends the same thing the Enter key does', async () => {
    const host = await mountHeld();
    const f = await open(host);
    await type(f, 'wrong directory');
    await act(async () =>
      (host.querySelector('[data-deny-feedback-send]') as HTMLButtonElement).click()
    );

    expect(decisions).toEqual([['deny', false, undefined, 'wrong directory']]);
  });

  it('caps the field at the number main clamps to, so nothing is cut silently', async () => {
    const host = await mountHeld();
    const f = await open(host);
    expect(f.maxLength).toBe(MAX_DENIAL_REASON_CHARS);
  });

  it('a bare Deny still sends no reason at all', async () => {
    const host = await mountHeld();
    const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[];
    const deny = buttons.find((b) => b.textContent === 'Deny');
    await act(async () => deny!.click());

    expect(decisions).toEqual([['deny', undefined, undefined, undefined]]);
  });

  // THE ONE THAT WOULD BE A REAL BUG. Consecutive holds reuse this component —
  // props change, nothing remounts — so an objection typed for one request must
  // not still be on screen under the next one's heading, where Enter would
  // attribute it to the user about a call they have not read.
  it('closes when the NEXT request arrives, carrying nothing over', async () => {
    const host = await mountHeld('r1');
    const f = await open(host);
    await type(f, 'about the FIRST request');

    await swapTo('r2');
    expect(field(host)).toBeNull();

    // and reopening it is empty
    const again = await open(host);
    expect(again.value).toBe('');
  });

  // The swap above is the NORMAL close. This is the abnormal one: a decision can
  // land on nothing — main answers `false` for a request it no longer holds and
  // no `permissionResolved` follows — and then the request never changes. An
  // open field with the previous objection still in it, Send still armed, over a
  // question that is not going anywhere.
  it('closes on send, without waiting for a request that may never swap', async () => {
    const host = await mountHeld('r1');
    const f = await open(host);
    await type(f, 'no');
    await key(f, { key: 'Enter' });

    expect(decisions).toHaveLength(1);
    expect(field(host)).toBeNull();
  });

  it('restores focus to the button it was opened from when cancelled', async () => {
    const host = await mountHeld();
    const f = await open(host);
    await key(f, { key: 'Escape' });
    // …rather than dropping it on `document.body`, which leaves a keyboard user
    // mid-answer Tabbing from the top of the document
    expect(document.activeElement).toBe(trigger(host));
  });
});

// ── P2-E22-03 (#974): the ladder's middle rung ──────────────────────────────
//
// This block asserts the WIRING, for the reason this whole file exists: the
// button is drawn from a shared rule (`shared/tool-paths`) that main also
// matches against, so a card that offered a path the router would not recognise
// would grant nothing and say nothing about it.
describe('Approve all in this file (P2-E22-03, #974)', () => {
  const allowFileBtn = (h: HTMLElement): HTMLButtonElement | null =>
    h.querySelector('[data-approval-allow-file]');

  it('is offered for a call that names a file, and hands over THAT path', async () => {
    const granted: string[] = [];
    const host = await mountHeld('r1', 'Write', { file_path: 'C:/p/a.ts', content: 'x' }, (p) =>
      granted.push(p)
    );
    const btn = allowFileBtn(host);
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(granted).toEqual(['C:/p/a.ts']);
  });

  it('reads NotebookEdit\u2019s own key, which is not file_path', async () => {
    const granted: string[] = [];
    const host = await mountHeld(
      'r1',
      'NotebookEdit',
      { notebook_path: '/p/n.ipynb', new_source: 'x' },
      (p) => granted.push(p)
    );
    await act(async () => allowFileBtn(host)!.click());
    expect(granted).toEqual(['/p/n.ipynb']);
  });

  // A `Bash` call has nothing to scope a grant to. Absent rather than disabled:
  // a greyed button advertises something the app has deliberately refused.
  it('is not drawn for a call that touches no file', async () => {
    const host = await mountHeld('r1', 'Bash', { command: 'rm -rf build' }, () => {});
    expect(allowFileBtn(host)).toBeNull();
  });

  it('is not drawn for a QUESTION, which no standing grant answers (#563)', async () => {
    const host = await mountHeld(
      'r1',
      'AskUserQuestion',
      { file_path: '/p/a.ts', questions: 'malformed' },
      () => {}
    );
    expect(allowFileBtn(host)).toBeNull();
  });

  // #261's lesson, and the one this file was extended for: without the prop the
  // button is ABSENT and the card still works, so a forgotten thread is silent.
  it('is not drawn when the host cannot grant', async () => {
    const host = await mountHeld('r1', 'Write', { file_path: '/p/a.ts' }, undefined);
    expect(allowFileBtn(host)).toBeNull();
  });
});
