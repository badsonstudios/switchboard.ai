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
//  • the sentence that says who the ticket channel is for is on screen when
//    that channel is chosen, because the repo is private and this is the one
//    control in the app that can look broken to someone who did nothing wrong.
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
    channel: 'email',
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
const channel = (c: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`[data-feature-channel="${c}"]`)!;
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
async function send(c: 'email' | 'ticket' = 'email'): Promise<void> {
  await render(true);
  await type(area('details')!, 'let me pin a session');
  if (c !== 'email') await click(channel(c));
  await click(submitButton());
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  handlers.onSubmit.mockImplementation(async () => ({ ok: true, channel: 'email' }));
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
      channel: 'email',
    });
  });

  it('carries the title, the details and the chosen channel', async () => {
    await render(true);
    await type(field('title')!, 'Pinning');
    await type(area('details')!, 'keep it at the top');
    await click(channel('ticket'));
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

  it('defaults to email, which is the channel anyone can use', async () => {
    // The ticket path needs access to a PRIVATE repo. Defaulting to it would
    // put the one broken-looking option in front of everybody who is not the
    // owner.
    await render(true);
    expect(channel('email').checked).toBe(true);
    expect(channel('ticket').checked).toBe(false);
  });

  it('says who the ticket channel is for, but only when it is chosen', async () => {
    await render(true);
    expect(bodyText()).not.toContain('issue tracker is private');
    await click(channel('ticket'));
    expect(bodyText()).toContain('issue tracker is private');
  });

  it('states what is included, always — the whole local-first promise', async () => {
    await render(true);
    expect(bodyText()).toContain('No logs, no files');
  });
});

describe('what happens when Send is pressed', () => {
  it('a hand-off that worked closes the dialog', async () => {
    // The proof is OUTSIDE this window — a mail client or a GitHub form with
    // the words in it — so a dialog left standing in front of it reads as a
    // button that did nothing (#896).
    await send();
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('a failure STAYS OPEN, says why, and keeps the words', async () => {
    handlers.onSubmit.mockImplementation(async () => ({
      ok: false,
      channel: 'email',
      problem: 'send-failed',
    }));
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('try the other option');
    expect(area('details')!.value).toBe('let me pin a session');
  });

  it('an ok:false with no reason attached is still a failure', async () => {
    // The lesson the report dialog learned the hard way: reading "no problem"
    // as success told the user something had happened that had not.
    handlers.onSubmit.mockImplementation(async () => ({ ok: false, channel: 'ticket' }));
    await send('ticket');
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
      channel: 'email',
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
      channel: 'email',
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
      settle({ ok: false, channel: 'email', problem: 'send-failed' });
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toBe('');
    // and the fresh dialog's button is not left armed by the old send's finally
    expect(submitButton().disabled).toBe(true);
  });
});
