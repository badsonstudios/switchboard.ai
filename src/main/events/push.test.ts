// The wire (P2-E14-06): what we send, and what we make of what comes back.
//
// **No network, ever.** `fetch` is injected in every test — nothing here may
// resolve a hostname, and a test that reached ntfy.sh would be a test that
// fails on a plane and spams a stranger's phone.
//
// The `WebhookPayload` contract test is the load-bearing one: a consumer writes
// code against those field names, so a rename is a breaking change and has to
// look like one in the diff.
import { describe, it, expect, vi } from 'vitest';
import {
  PUSHOVER_ENDPOINT,
  buildWebhookPayload,
  isPostableUrl,
  ntfyPriority,
  ntfyTags,
  postWebhook,
  pushoverPriority,
  scrubSecrets,
  sendNtfy,
  sendPushover,
} from './push';
import { NTFY_DEFAULT_SERVER, WEBHOOK_PAYLOAD_VERSION } from '../../shared/push';
import type { RuleActionContext } from './rules-engine';

/**
 * One recorded request. `body` is narrowed to `string` deliberately:
 * `RequestInit['body']` is the whole `BodyInit` union — Blob, ArrayBuffer,
 * FormData, a stream — and `String()` on any of those yields '[object Object]',
 * which a `JSON.parse` assertion would then blame on the wrong thing. Every
 * transport in this file sends a string — `post()`'s own `body` parameter is
 * typed `string`, so a streaming transport is a compile error before it is a
 * runtime one. The fake records the violation rather than throwing, because
 * `post()` catches (turning a throw into an ordinary `{ ok: false }` and an
 * empty `calls`); a marker string puts it in the assertion diff instead.
 */
type RecordedCall = { url: string; init: Omit<RequestInit, 'body'> & { body: string } };

/** A `fetch` that records what it was asked and answers what the test says. */
function fakeFetch(res: Partial<{ ok: boolean; status: number; body: string }> = {}) {
  const calls: RecordedCall[] = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    const req = (init ?? {}) as RequestInit;
    const body =
      typeof req.body === 'string' ? req.body : `<non-string body: ${typeof req.body}>`;
    calls.push({ url: String(url), init: { ...req, body } });
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      text: async () => res.body ?? '{"status":1}',
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function ctx(over: Partial<RuleActionContext> = {}): RuleActionContext {
  return {
    event: { id: 7, sessionId: 'live-42', kind: 'needs-permission', at: '2026-08-13T10:00:00.000Z' },
    cardId: 'card-a',
    visibility: 'hidden',
    rule: { id: 'default:push:needs-permission', event: 'needs-permission', actions: [] },
    title: 'TradingApp',
    body: 'needs permission',
    ...over,
  };
}

describe('the webhook payload — the documented contract', () => {
  it('is exactly these fields, with these names', () => {
    // Written out in full rather than field-by-field ON PURPOSE: a consumer
    // parses this object, so an ADDED field is as much a change to the contract
    // as a renamed one, and both should fail here and be looked at.
    expect(buildWebhookPayload(ctx())).toEqual({
      source: 'switchboard.ai',
      version: WEBHOOK_PAYLOAD_VERSION,
      event: 'needs-permission',
      sessionId: 'live-42',
      cardId: 'card-a',
      title: 'TradingApp',
      body: 'needs permission',
      ruleId: 'default:push:needs-permission',
      visibility: 'hidden',
      at: '2026-08-13T10:00:00.000Z',
    });
  });

  it('carries the event kind, so a consumer can tell them apart', () => {
    for (const kind of ['needs-permission', 'needs-input', 'done', 'crashed'] as const)
      expect(buildWebhookPayload(ctx({ event: { ...ctx().event, kind } })).event).toBe(kind);
  });

  it('reports an unresolved card as null rather than inventing one', () => {
    expect(buildWebhookPayload(ctx({ cardId: null })).cardId).toBeNull();
  });

  it('carries no folder, path or prompt — only what a toast would have said', () => {
    const json = JSON.stringify(buildWebhookPayload(ctx()));
    for (const forbidden of ['folder', 'cwd', 'path', 'prompt', 'transcript', 'home'])
      expect(json).not.toContain(forbidden);
  });
});

describe('sendNtfy', () => {
  it('POSTs the topic in the BODY, never in the URL', async () => {
    const f = fakeFetch();
    const r = await sendNtfy(
      { topic: 'my-secret-topic', title: 'TradingApp', message: 'needs permission', priority: 4 },
      { fetchImpl: f.impl }
    );
    expect(r).toEqual({ ok: true });
    const [call] = f.calls;
    expect(call.url).toBe(`${NTFY_DEFAULT_SERVER}/`);
    expect(call.url).not.toContain('my-secret-topic'); // the whole reason for JSON publish
    expect(JSON.parse(call.init.body)).toEqual({
      topic: 'my-secret-topic',
      title: 'TradingApp',
      message: 'needs permission',
      priority: 4,
    });
  });

  it('honours a self-hosted server, trailing slash or not', async () => {
    const f = fakeFetch();
    await sendNtfy({ server: 'https://ntfy.example.test//', topic: 't', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
    });
    expect(f.calls[0].url).toBe('https://ntfy.example.test/');
  });

  it('refuses a server that is not a URL, without asking the network', async () => {
    const f = fakeFetch();
    const r = await sendNtfy({ server: 'ntfy.example.test', topic: 't', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
    });
    expect(r.ok).toBe(false);
    // `bad-url`, not `not-configured`: a destination that cannot work is a
    // mistake to say out loud, where "nothing is set up" is a state to keep
    // quiet about. `push-actions.ts` logs one and not the other.
    expect(r.reason).toBe('bad-url');
    expect(f.calls).toHaveLength(0);
  });

  it('reports a refusal without echoing the topic', async () => {
    const f = fakeFetch({ ok: false, status: 403, body: 'topic my-secret-topic is reserved' });
    const r = await sendNtfy({ topic: 'my-secret-topic', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
      secrets: ['my-secret-topic'],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('refused');
    expect(r.detail).toContain('403');
    expect(r.detail).not.toContain('my-secret-topic');
  });

  it('a dead socket is `network`, and never a throw', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND ntfy.sh');
    }) as unknown as typeof fetch;
    const r = await sendNtfy({ topic: 't', title: 'a', message: 'b' }, { fetchImpl: impl });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
  });

  it('sends nothing at all with an empty topic', async () => {
    const f = fakeFetch();
    expect(await sendNtfy({ topic: '  ', title: 'a', message: 'b' }, { fetchImpl: f.impl })).toEqual({
      ok: false,
      reason: 'not-configured',
    });
    expect(f.calls).toHaveLength(0);
  });
});

describe('sendPushover', () => {
  it('POSTs a form to the documented endpoint', async () => {
    const f = fakeFetch({ body: '{"status":1,"request":"abc"}' });
    const r = await sendPushover(
      { token: 'app-token', user: 'user-key', title: 'TradingApp', message: 'needs permission' },
      { fetchImpl: f.impl }
    );
    expect(r).toEqual({ ok: true });
    expect(f.calls[0].url).toBe(PUSHOVER_ENDPOINT);
    const form = new URLSearchParams(f.calls[0].init.body);
    expect(form.get('token')).toBe('app-token');
    expect(form.get('user')).toBe('user-key');
    expect(form.get('message')).toBe('needs permission');
  });

  // Their API answers 200 with `status: 0` for a bad user key. Reading only the
  // HTTP code would report success and buzz nothing, forever.
  it('treats a 200 with status 0 as a refusal', async () => {
    const f = fakeFetch({ body: '{"status":0,"errors":["user identifier is invalid"]}' });
    const r = await sendPushover({ token: 't', user: 'u', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
    });
    expect(r).toMatchObject({ ok: false, reason: 'refused' });
    expect(r.detail).toContain('user identifier is invalid');
  });

  it('does not call a 2xx with an unreadable body a failure', async () => {
    const f = fakeFetch({ body: '<html>proxy said hello</html>' });
    expect(await sendPushover({ token: 't', user: 'u', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
    })).toEqual({ ok: true });
  });

  it('scrubs the token out of an error body that echoed it back', async () => {
    const f = fakeFetch({ ok: false, status: 400, body: '{"token":"app-token","errors":["bad"]}' });
    const r = await sendPushover({ token: 'app-token', user: 'user-key', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
      secrets: ['app-token', 'user-key'],
    });
    expect(r.detail).not.toContain('app-token');
    expect(r.detail).toContain('***');
  });

  it('needs BOTH keys before it will send anything', async () => {
    const f = fakeFetch();
    expect(await sendPushover({ token: 't', user: '', title: 'a', message: 'b' }, {
      fetchImpl: f.impl,
    })).toEqual({ ok: false, reason: 'not-configured' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('postWebhook', () => {
  it('POSTs the documented body as JSON', async () => {
    const f = fakeFetch({ body: '' });
    const payload = buildWebhookPayload(ctx());
    expect(await postWebhook('https://hooks.example.test/abc', payload, { fetchImpl: f.impl })).toEqual({
      ok: true,
    });
    expect(f.calls[0].init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(f.calls[0].init.body)).toEqual(payload);
  });

  it.each([
    ['a bare host', 'hooks.example.test/abc'],
    ['a file URL', 'file:///etc/passwd'],
    ['a custom scheme', 'javascript:alert(1)'],
    ['nonsense', 'not a url at all'],
  ])('refuses %s without asking the network', async (_name, url) => {
    const f = fakeFetch();
    const r = await postWebhook(url, buildWebhookPayload(ctx()), { fetchImpl: f.impl });
    expect(r).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(f.calls).toHaveLength(0);
  });

  it('keeps the URL out of the detail when the host is unreachable', async () => {
    const url = 'https://hooks.example.test/secret-path-9f3';
    const impl = (async () => {
      throw new Error(`request to ${url} failed`);
    }) as unknown as typeof fetch;
    const r = await postWebhook(url, buildWebhookPayload(ctx()), { fetchImpl: impl, secrets: [url] });
    expect(r.reason).toBe('network');
    expect(r.detail).not.toContain('secret-path-9f3');
  });
});

describe('the small decisions', () => {
  it('sends attention events at high priority and a finished turn at default', () => {
    expect(ntfyPriority('needs-permission')).toBe(4);
    expect(ntfyPriority('crashed')).toBe(4);
    expect(ntfyPriority('done')).toBe(3);
    expect(pushoverPriority('needs-input')).toBe(1);
    expect(pushoverPriority('done')).toBe(0);
  });

  // Both services reserve their top priority for "bypass do-not-disturb". A
  // calm-by-design tool does not get to override the user's night.
  it('never uses the top priority either service offers', () => {
    for (const kind of ['needs-permission', 'needs-input', 'crashed', 'done'])
      expect(ntfyPriority(kind)).toBeLessThan(5);
    for (const kind of ['needs-permission', 'needs-input', 'crashed', 'done'])
      expect(pushoverPriority(kind)).toBeLessThan(2);
  });

  it('gives each event its own icon, and an unknown one a bell', () => {
    expect(ntfyTags('crashed')).toEqual(['warning']);
    expect(ntfyTags('something-new')).toEqual(['bell']);
  });

  it('scrubs every known secret, and leaves short strings alone', () => {
    expect(scrubSecrets('token=abcd1234 user=wxyz9876', ['abcd1234', 'wxyz9876'])).toBe(
      'token=*** user=***'
    );
    // a 3-character "secret" would redact half the English language
    expect(scrubSecrets('the cat sat', ['cat'])).toBe('the cat sat');
  });

  it('knows what it is willing to POST to', () => {
    expect(isPostableUrl('https://a.test/x')).toBe(true);
    expect(isPostableUrl('http://localhost:9000/x')).toBe(true);
    expect(isPostableUrl('ftp://a.test/x')).toBe(false);
  });
});
