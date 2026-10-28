// @vitest-environment jsdom
// Help ▸ Feature request… (#1008).
//
// What is worth pinning is the promises this dialog makes:
//
//  • nothing goes anywhere until the button is pressed, and it cannot be
//    pressed with an empty box;
//  • the TITLE is optional — that was the ticket's word, and a required title
//    is the easiest way for this to quietly become a chore;
//  • a hand-off that worked CLOSES the window and a failure keeps it with the
//    words intact, which is #896's fix inherited rather than re-derived;
//  • there is no channel picker (#1494 removed email, and a one-option choice
//    is no choice), and the sentence saying the form needs a GitHub sign-in is
//    always on screen, because a browser that is signed out is the one way this
//    control can look broken to someone who did nothing wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { FeatureRequestDialog } from './FeatureRequestDialog';
import type { FeatureRequestDraft, FeedbackResult } from '../../../shared/feedback';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onClose: vi.fn(),
  onSubmit: vi.fn<(d: FeatureRequestDraft) => Promise<FeedbackResult>>(async () => ({
    ok: true,
    channel: 'ticket',
  })),
};

async function render(open: boolean): Promise<void> {
  await act(async () => {
    root!.render(<FeatureRequestDialog open={open} {...handlers} />);
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const field = (name: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`input[data-feature-field="${name}"]`);
const area = (name: string): HTMLTextAreaElement | null =>
  host.querySelector<HTMLTextAreaElement>(`textarea[data-feature-field="${name}"]`);
const submitButton = (): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('[data-feature-submit]')!;
const resultText = (): string =>
  host.querySelector<HTMLElement>('[data-feature-result]')?.textContent ?? '';
const bodyText = (): string => host.textContent ?? '';

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    // The DESCRIPTOR, as in `ReportProblemDialog.test.tsx`: pulling `set` into
    // a variable is `unbound-method`.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const valueProp = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    valueProp?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function press(key: string): Promise<void> {
  await act(async () => {
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** fill the box and press Send */
async function send(): Promise<void> {
  await render(true);
  await type(area('details')!, 'let me pin a session');
  await click(submitButton());
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  handlers.onSubmit.mockImplementation(async () => ({ ok: true, channel: 'ticket' }));
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the feature-request dialog', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('cannot be sent with an empty box, and says why the button is dead', async () => {
    await render(true);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().title).toContain('Say what you');
    await click(submitButton());
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it('a whitespace-only box is still empty', async () => {
    await render(true);
    await type(area('details')!, '   \n  ');
    expect(submitButton().disabled).toBe(true);
  });

  it('SENDS WITHOUT A TITLE — the title is optional, as the ticket asked', async () => {
    await send();
    expect(handlers.onSubmit).toHaveBeenCalledWith({
      title: '',
      details: 'let me pin a session',
      channel: 'ticket',
    });
  });

  it('carries the title and the details', async () => {
    await render(true);
    await type(field('title')!, 'Pinning');
    await type(area('details')!, 'keep it at the top');
    await click(submitButton());
    expect(handlers.onSubmit).toHaveBeenCalledWith({
      title: 'Pinning',
      details: 'keep it at the top',
      channel: 'ticket',
    });
  });

  it('typed text survives — the field is what the state says it is', async () => {
    await render(true);
    await type(area('details')!, 'one');
    await type(field('title')!, 'two');
    expect(area('details')!.value).toBe('one');
    expect(field('title')!.value).toBe('two');
  });

  it('offers no channel to choose, and never mentions email (#1494)', async () => {
    await render(true);
    expect(host.querySelector('[data-feature-channel]')).toBeNull();
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(bodyText()).not.toMatch(/email|mail app/i);
  });

  it('says the form needs a GitHub sign-in in the browser, always', async () => {
    await render(true);
    expect(host.querySelector('[data-feature-ticket-note]')?.textContent).toContain(
      'signed in in your browser'
    );
    expect(bodyText()).not.toContain('private');
  });

  it('states what is included, always — the whole local-first promise', async () => {
    await render(true);
    expect(bodyText()).toContain('No logs, no files');
  });
});

describe('what happens when Send is pressed', () => {
  it('a hand-off that worked closes the dialog', async () => {
    // The proof is OUTSIDE this window — a GitHub form with the words in it — so a dialog left standing in front of it reads as a
    // button that did nothing (#896).
    await send();
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('a failure STAYS OPEN, says why, and keeps the words', async () => {
    handlers.onSubmit.mockImplementation(async () => ({
      ok: false,
      channel: 'ticket',
      problem: 'send-failed',
    }));
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('browser couldn');
    expect(area('details')!.value).toBe('let me pin a session');
  });

  it('an ok:false with no reason attached is still a failure', async () => {
    // The lesson the report dialog learned the hard way: reading "no problem"
    // as success told the user something had happened that had not.
    handlers.onSubmit.mockImplementation(async () => ({ ok: false, channel: 'ticket' }));
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('Nothing left your machine');
  });

  it('a caller that rejects is a failure on screen, not a stuck button', async () => {
    handlers.onSubmit.mockImplementation(() => Promise.reject(new Error('bridge gone')));
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('Nothing left your machine');
    expect(submitButton().disabled).toBe(false);
  });

  it('puts the reason BESIDE the button, announced', async () => {
    handlers.onSubmit.mockImplementation(async () => ({
      ok: false,
      channel: 'ticket',
      problem: 'send-failed',
    }));
    await send();
    const region = host.querySelector('[data-feature-result]')!.closest('[role="status"]')!;
    expect(region.parentElement).toBe(submitButton().parentElement);
    expect(region.getAttribute('aria-live')).toBe('polite');
  });
});

describe('the window itself', () => {
  it('Escape cancels', async () => {
    await render(true);
    await press('Escape');
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it('a re-open starts clean rather than showing last time’s words', async () => {
    handlers.onSubmit.mockImplementation(async () => ({
      ok: false,
      channel: 'ticket',
      problem: 'send-failed',
    }));
    await send();
    expect(resultText()).not.toBe('');
    await render(false);
    await render(true);
    expect(area('details')!.value).toBe('');
    expect(resultText()).toBe('');
  });

  it('Send is painted with the app primary colours, never a session accent', async () => {
    // `--accent` exists only inside a session card. At the root, where this
    // dialog renders, it is undefined: the button drew as a transparent box
    // with near-black text and read as disabled (#896). Inherited from
    // `ComposeDialog`, and asserted here so the inheritance cannot lapse.
    await render(true);
    await type(area('details')!, 'x');
    expect(submitButton().style.background).toBe('var(--btn-primary-bg)');
    expect(submitButton().style.color).toBe('var(--btn-primary-text)');
    expect(submitButton().getAttribute('style')).not.toMatch(/var\(--accent/);
  });
});

describe('a send still settling when the dialog is simply CANCELLED', () => {
  it('does not close a second time, which would steal focus back', async () => {
    // Cancel while a hand-off is in flight, click into a composer, and a late
    // success used to run `close()` again — whose focus restore yanks the caret
    // out of wherever you went. The guard has to bump on CLOSE, not only on
    // re-open, or this whole case is invisible to it.
    let settle: (r: FeedbackResult) => void = () => {};
    handlers.onSubmit.mockImplementation(
      () => new Promise<FeedbackResult>((res) => (settle = res))
    );
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    await render(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => {
      settle({ ok: true, channel: 'ticket' });
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});

describe('a send still settling when the dialog is closed and re-opened', () => {
  it('does not close the fresh one, nor print its error in it', async () => {
    let settle: (r: FeedbackResult) => void = () => {};
    handlers.onSubmit.mockImplementation(
      () => new Promise<FeedbackResult>((res) => (settle = res))
    );
    await send();
    await render(false);
    await render(true);
    await act(async () => {
      settle({ ok: false, channel: 'ticket', problem: 'send-failed' });
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toBe('');
    // and the fresh dialog's button is not left armed by the old send's finally
    expect(submitButton().disabled).toBe(true);
  });
});
