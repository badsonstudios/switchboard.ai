// Help ▸ Feature request…'s one channel (#1008).
//
// NOTHING REAL IS OPENED HERE. `openExternal` is a mock and the assertions are
// about the STRING it was handed — which is the only honest way to test this:
// the repo in that URL exists, and a test that let a browser near it would file
// tickets on somebody's tracker.
import { describe, it, expect, vi } from 'vitest';
import { registerFeatureRequestIpc, sanitizeDraft } from './feature-request-ipc';
import type { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import type { FeedbackResult } from '../../shared/feedback';
import { REPORT_EMAIL_TO, REPORT_REPO } from '../../shared/diagnostics';

/** captures what `registerFeatureRequestIpc` registers so a test can call it */
function harness(opts: { openFails?: boolean } = {}) {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  const broker = {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcBroker;

  // Captured as a const and asserted on as a const: reading a mock back off the
  // object it lives on is an unbound method reference.
  const openExternal = vi.fn<(url: string) => Promise<void>>(() =>
    opts.openFails ? Promise.reject(new Error('no handler for scheme')) : Promise.resolve()
  );
  const warn = vi.fn();
  const info = vi.fn();
  const log = { debug: vi.fn(), info, warn, error: vi.fn(), child: vi.fn() } as unknown as Logger;

  registerFeatureRequestIpc({ broker, log, sh: { openExternal } });
  return {
    openExternal,
    warn,
    info,
    send: (draft: unknown) =>
      handlers.get('feedback:featureRequest')?.(null, draft) as Promise<FeedbackResult>,
    registered: [...handlers.keys()],
  };
}

const ask = { title: 'Pin a session', details: 'Keep it at the top of the rail.' };

describe('the channel it registers', () => {
  it('is exactly one, and it is the tagged name', () => {
    expect(harness().registered).toEqual(['feedback:featureRequest']);
  });
});

describe('the guard', () => {
  it('refuses a request with nothing in it, and opens nothing', async () => {
    const h = harness();
    const r = await h.send({ title: 'x', details: '   ', channel: 'email' });
    expect(r).toEqual({ ok: false, channel: 'email', problem: 'empty-details' });
    expect(h.openExternal).not.toHaveBeenCalled();
  });
});

describe('the email channel', () => {
  it('hands the OS a mailto pre-addressed to the owner and pre-filled', async () => {
    const h = harness();
    const r = await h.send({ ...ask, channel: 'email' });
    expect(r.ok).toBe(true);
    const url = h.openExternal.mock.calls[0][0];
    expect(url.startsWith(`mailto:${REPORT_EMAIL_TO.join(',')}?`)).toBe(true);
    expect(url).toContain(encodeURIComponent('[switchboard feature] Pin a session'));
    expect(url).toContain(encodeURIComponent('top of the rail'));
  });
});

describe('the ticket channel', () => {
  it("hands the OS GitHub's new-issue FORM, prefilled — never the API", async () => {
    const h = harness();
    const r = await h.send({ ...ask, channel: 'ticket' });
    expect(r).toEqual({ ok: true, channel: 'ticket' });
    const url = h.openExternal.mock.calls[0][0];
    expect(url.startsWith(`https://github.com/${REPORT_REPO}/issues/new?`)).toBe(true);
    // The whole local-first argument in one assertion: this opens a page, it
    // does not create anything. A POST would go to api.github.com.
    expect(url).not.toContain('api.github.com');
  });
});

describe('when the OS will not take it', () => {
  it('is a FAILURE the dialog can show, not a swallowed shrug', async () => {
    // `openExternal` rejects when nothing is registered for the scheme — a
    // machine with no mail client is the everyday case. The dialog closes on
    // success, so calling this success would close the window over words that
    // went nowhere. That is exactly the defect #896 fixed for the report path.
    const h = harness({ openFails: true });
    const r = await h.send({ ...ask, channel: 'email' });
    expect(r).toEqual({ ok: false, channel: 'email', problem: 'send-failed' });
    expect(h.warn).toHaveBeenCalled();
  });

  it('never rejects — a help surface must not become an unhandled rejection', async () => {
    const h = harness({ openFails: true });
    await expect(h.send({ ...ask, channel: 'ticket' })).resolves.toMatchObject({ ok: false });
  });
});

describe('what reaches the log', () => {
  it('records the channel and the size, never the words', async () => {
    const h = harness();
    await h.send({ title: 'Secret plan', details: 'A very private idea.', channel: 'email' });
    const fields = JSON.stringify(h.info.mock.calls);
    expect(fields).toContain('email');
    expect(fields).not.toContain('Secret plan');
    expect(fields).not.toContain('very private idea');
  });
});

describe('sanitizeDraft — whatever crossed the wire', () => {
  it('defaults an unknown channel to email rather than the private tracker', () => {
    // Failing CLOSED in the useful direction: email always works for whoever is
    // running the app, the ticket path needs access to a private repo.
    expect(sanitizeDraft({ details: 'x', channel: 'wat' }).channel).toBe('email');
    expect(sanitizeDraft({ details: 'x', channel: 'ticket' }).channel).toBe('ticket');
  });

  it('survives junk, null and the wrong types without throwing', () => {
    expect(sanitizeDraft(null)).toEqual({ title: '', details: '', channel: 'email' });
    expect(sanitizeDraft({ title: 7, details: [], channel: 3 })).toEqual({
      title: '',
      details: '',
      channel: 'email',
    });
  });

  it('trims the title but leaves the details as typed', () => {
    const d = sanitizeDraft({ title: '  pin  ', details: '  line\n\n  more  ', channel: 'email' });
    expect(d.title).toBe('pin');
    // The body is the user's own formatting — trimming inside it would reflow
    // somebody's bullet list on the way out.
    expect(d.details).toBe('  line\n\n  more  ');
  });
});
