// @vitest-environment jsdom
// Help ▸ Report a problem… (#815).
//
// What is worth pinning here is not the layout — it is the promises the dialog
// makes:
//
//  • a stored credential is NEVER rendered, and the typed one leaves component
//    state the moment it is handed over;
//  • it does not ask for a token it does not need (a machine where `gh` is
//    already signed in is never shown the field);
//  • it never implies the zip was attached, because GitHub's API cannot attach
//    one — the sentence saying so is always on screen;
//  • nothing is sent until the button is pressed, and it cannot be pressed
//    without a subject.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { ReportProblemDialog } from './ReportProblemDialog';
import type {
  ReportDraft,
  ReportResult,
  ReportStatus,
  ReportWriteResult,
} from '../../../shared/diagnostics';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const ok = (over: Partial<ReportResult> = {}): ReportResult => ({
  ok: true,
  destination: 'github',
  url: null,
  number: null,
  bundle: { ok: true, path: 'C:\\tmp\\bundle.zip', bytes: 10, skipped: [] },
  ...over,
});

const handlers = {
  onClose: vi.fn(),
  // The signature is declared as a type argument rather than as named
  // parameters the body ignores — same information, no unused bindings.
  onSubmit: vi.fn<(d: ReportDraft) => Promise<ReportResult>>(async () => ok()),
  onSetToken: vi.fn<(v: string) => Promise<ReportWriteResult>>(async () => ({
    status: status(),
    ok: true,
  })),
  onOpenIssue: vi.fn<(url: string) => void>(),
};

function status(over: Partial<ReportStatus> = {}): ReportStatus {
  return { canFileIssue: false, storeAvailable: true, tokenStored: false, ...over };
}

async function render(open: boolean, st: ReportStatus | null = status()): Promise<void> {
  await act(async () => {
    root!.render(<ReportProblemDialog open={open} status={st} {...handlers} />);
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const field = (name: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`[data-report-field="${name}"]`);
const area = (name: string): HTMLTextAreaElement | null =>
  host.querySelector<HTMLTextAreaElement>(`textarea[data-report-field="${name}"]`);
const destination = (d: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`[data-report-destination="${d}"]`);
const resultText = (): string =>
  host.querySelector<HTMLElement>('[data-report-result]')?.textContent ?? '';
const submitButton = (): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('[data-report-submit]')!;

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    // The DESCRIPTOR, as in settings/PushSection.test.tsx: pulling `set` into a
    // variable is `unbound-method`.
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

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  handlers.onSubmit.mockImplementation(async () => ok());
  handlers.onSetToken.mockImplementation(async () => ({ status: status(), ok: true }));
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

describe('the report dialog', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('cannot be sent without a subject', async () => {
    await render(true);
    expect(submitButton().disabled).toBe(true);
    await click(submitButton());
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it('sends the subject, the description and the chosen destination', async () => {
    await render(true);
    await type(field('subject')!, 'CPU pegged again');
    await type(area('description')!, 'the fans spun up and it froze');
    await click(destination('email')!);
    await click(submitButton());

    expect(handlers.onSubmit).toHaveBeenCalledWith({
      subject: 'CPU pegged again',
      description: 'the fans spun up and it froze',
      destination: 'email',
    });
  });

  it('always says the zip is not attached', async () => {
    // The one sentence this feature cannot afford to drop: the API physically
    // cannot attach a file, and a dialog that implied otherwise would lose the
    // evidence it exists to move.
    await render(true);
    expect(dialog()?.textContent).toContain('only accepts attachments through its website');
  });
});

describe('the credential', () => {
  it('offers to store one when the machine has none', async () => {
    await render(true, status({ canFileIssue: false, storeAvailable: true }));
    expect(field('token')).not.toBeNull();
  });

  it('does NOT ask for a token when one is already available', async () => {
    // `gh auth token` already answers on this machine. Asking anyway would be
    // demanding setup for something that needs none.
    await render(true, status({ canFileIssue: true }));
    expect(field('token')).toBeNull();
  });

  it('says a machine cannot keep secrets, and offers no field it could not honour', async () => {
    await render(true, status({ canFileIssue: false, storeAvailable: false }));
    expect(field('token')).toBeNull();
    expect(dialog()?.textContent).toContain('cannot store secrets');
  });

  it('hands the token over and does not keep it on screen', async () => {
    await render(true, status({ canFileIssue: false, storeAvailable: true }));
    await type(field('token')!, TOKEN);
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save token')!;
    await click(save);

    expect(handlers.onSetToken).toHaveBeenCalledWith(TOKEN);
    expect(field('token')?.value ?? '').toBe('');
    expect(dialog()?.textContent).not.toContain(TOKEN);
  });

  it('KEEPS the token and says so when the store refused it', async () => {
    // Clearing the field regardless would show an empty box, which reads as
    // "saved", for a machine that kept nothing.
    handlers.onSetToken.mockImplementation(async () => ({ status: status(), ok: false }));
    await render(true, status({ canFileIssue: false, storeAvailable: true }));
    await type(field('token')!, TOKEN);
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save token')!;
    await click(save);

    expect(field('token')?.value).toBe(TOKEN);
    expect(host.querySelector('[data-report-token-refused]')).not.toBeNull();
  });

  it('says it is still checking rather than rendering an empty panel', async () => {
    // `null` is "we have not asked yet" — NOT "there is no credential", and
    // certainly not "this machine cannot keep secrets".
    await render(true, null);
    expect(dialog()?.textContent).toContain('Checking this machine');
    expect(dialog()?.textContent).not.toContain('cannot store secrets');
  });

  it('shows no credential controls at all for the other destinations', async () => {
    await render(true, status({ canFileIssue: false, storeAvailable: true }));
    await click(destination('zip')!);
    expect(field('token')).toBeNull();
  });
});

describe('what happens when Send report is pressed', () => {
  // The owner pressed Send and the dialog stayed open with nothing visibly
  // changed — so it read as a dead button. A send that WORKED now closes the
  // dialog; only a failure keeps it, with the reason beside the button.
  async function send(dest?: string): Promise<void> {
    await render(true);
    await type(field('subject')!, 's');
    if (dest) await click(destination(dest)!);
    await click(submitButton());
  }

  it('a filed issue closes the dialog and opens the issue in the browser', async () => {
    handlers.onSubmit.mockImplementation(async () => ok({ number: 42, url: 'https://x/42' }));
    await send();
    expect(handlers.onOpenIssue).toHaveBeenCalledWith('https://x/42');
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-report-result]')).toBeNull();
  });

  it('an email or a plain zip closes the dialog too, and opens nothing else', async () => {
    handlers.onSubmit.mockImplementation(async () => ok({ destination: 'email' }));
    await send('email');
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    handlers.onSubmit.mockImplementation(async () => ok({ destination: 'zip' }));
    await send('zip');
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    expect(handlers.onOpenIssue).not.toHaveBeenCalled();
  });

  it('a refusal STAYS OPEN and says why, in its own words', async () => {
    handlers.onSubmit.mockImplementation(async () =>
      ok({ ok: false, problem: 'no-token', destination: 'github' })
    );
    await send();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('No GitHub sign-in was found');
    // the user's words survive, so switching destination is one click
    expect(field('subject')?.value).toBe('s');
  });

  it('puts the reason BESIDE the button, not at the foot of the form', async () => {
    // At the foot of a scrolling form it was off screen in a short window,
    // which is how a failed send came to look like a button that did nothing.
    handlers.onSubmit.mockImplementation(async () =>
      ok({ ok: false, problem: 'network', destination: 'github' })
    );
    await send();
    const region = host.querySelector('[data-report-result]')!.closest('[role="status"]')!;
    expect(region.parentElement).toBe(submitButton().parentElement);
    expect(region.getAttribute('aria-live')).toBe('polite');
    // the fail-open promise, on screen: the evidence is still on disk
    expect(resultText()).toContain('zip is still ready');
  });

  it('never calls a zip that could not be written "ready"', async () => {
    // main reports this as ok:false with NO problem attached — which used to
    // fall through to the success sentence
    handlers.onSubmit.mockImplementation(async () =>
      ok({
        ok: false,
        destination: 'zip',
        bundle: { ok: false, path: null, bytes: 0, skipped: [] },
      })
    );
    await send('zip');
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('could not be written');
    expect(resultText()).not.toContain('ready');
  });
});

describe('a send still in flight when the dialog is closed and re-opened', () => {
  // The dialog stays MOUNTED while closed, so without a guard the old send's
  // settlement lands in the fresh dialog: closing it, printing an old error,
  // or clearing `busy` under a second send — re-arming the button and letting a
  // third press file a duplicate issue.
  function deferred(): { promise: Promise<ReportResult>; resolve: (r: ReportResult) => void } {
    let resolve!: (r: ReportResult) => void;
    const promise = new Promise<ReportResult>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('an old SUCCESS does not close the re-opened dialog', async () => {
    const first = deferred();
    handlers.onSubmit.mockImplementationOnce(() => first.promise);
    await render(true);
    await type(field('subject')!, 'first');
    await click(submitButton());
    await render(false);
    await render(true);
    await type(field('subject')!, 'second');

    await act(async () => first.resolve(ok({ url: 'https://x/1' })));

    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(field('subject')?.value).toBe('second');
    // the issue it filed is real, so it may still open
    expect(handlers.onOpenIssue).toHaveBeenCalledWith('https://x/1');
  });

  it('an old FAILURE neither shows its error nor re-arms a second send', async () => {
    const first = deferred();
    const second = deferred();
    handlers.onSubmit
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await render(true);
    await type(field('subject')!, 'first');
    await click(submitButton());
    await render(false);
    await render(true);
    await type(field('subject')!, 'second');
    await click(submitButton()); // the second send is now in flight
    expect(submitButton().disabled).toBe(true);

    await act(async () => first.resolve(ok({ ok: false, problem: 'network' })));

    expect(host.querySelector('[data-report-result]')).toBeNull();
    expect(submitButton().disabled).toBe(true); // still busy with the SECOND send
    expect(handlers.onSubmit).toHaveBeenCalledTimes(2);
  });

  it('a caller that rejects is a failure on screen, not a stuck button', async () => {
    handlers.onSubmit.mockImplementation(async () => {
      throw new Error('bridge gone');
    });
    await render(true);
    await type(field('subject')!, 's');
    await click(submitButton());
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(resultText()).toContain('could not collect a report');
    expect(submitButton().disabled).toBe(false);
  });
});

describe('the Send report button', () => {
  it('is painted with the app primary colours, never a session accent', async () => {
    // `--accent` exists only inside a session card. At the root, where this
    // dialog renders, it is undefined: the button drew as a transparent box
    // with near-black text and read as disabled.
    await render(true);
    await type(field('subject')!, 's');
    expect(submitButton().style.background).toBe('var(--btn-primary-bg)');
    expect(submitButton().style.color).toBe('var(--btn-primary-text)');
    expect(submitButton().getAttribute('style')).not.toMatch(/var\(--accent/);
  });

  it('says why it is dead while there is no subject', async () => {
    await render(true);
    expect(submitButton().title).toBe('Give it a subject first — even a few words.');
    await type(field('subject')!, 's');
    expect(submitButton().title).toBe('');
  });
});
