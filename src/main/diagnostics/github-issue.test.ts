import { describe, it, expect, vi } from 'vitest';
import { createIssue } from './github-issue';
import type { TokenSource } from '../update/token';

const TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const withToken: TokenSource[] = [{ id: 'test', resolve: () => Promise.resolve(TOKEN) }];
const noToken: TokenSource[] = [{ id: 'test', resolve: () => Promise.resolve(null) }];

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * A fetch double that really has `fetch`'s signature.
 *
 * Not cosmetic, and worth the wrapper: a stub declared `(url: string, init:
 * RequestInit)` is NOT assignable to `typeof fetch`, which takes
 * `RequestInfo | URL` and an OPTIONAL init — so the narrow version fails to
 * typecheck at every call site. Declaring the real shape here and normalising
 * inside keeps the assertions below readable.
 */
function fetchStub(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      handler(urlOf(input), init ?? {})
  );
}

/**
 * The URL a fetch call was made with.
 *
 * Spelled out rather than `String(input)` because `RequestInfo` includes
 * `Request`, which has no useful stringification — it would assert against
 * `[object Object]` and pass for the wrong reason.
 */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('createIssue — the happy path', () => {
  it('POSTs the title and body, and answers with the new issue', async () => {
    const fetchImpl = fetchStub(() =>
      Promise.resolve(res(201, { html_url: 'https://github.com/o/r/issues/7', number: 7 }))
    );
    const r = await createIssue({
      title: 'CPU pegged again',
      body: 'it happened at 3pm',
      version: '0.8.90',
      tokenSources: withToken,
      fetchImpl,
    });

    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/issues/7', number: 7 });

    const [input, init] = fetchImpl.mock.calls[0];
    expect(urlOf(input)).toBe('https://api.github.com/repos/badsonstudios/switchboard.ai/issues');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      title: 'CPU pegged again',
      body: 'it happened at 3pm',
    });
  });

  it('sends the headers GitHub requires, including a User-Agent', async () => {
    // GitHub rejects requests with no User-Agent outright, which would look
    // like a mysterious refusal rather than a missing header.
    const fetchImpl = fetchStub(() => Promise.resolve(res(201, { number: 1 })));
    await createIssue({
      title: 't',
      body: 'b',
      version: '0.8.90',
      tokenSources: withToken,
      fetchImpl,
    });
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('switchboard.ai/0.8.90');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('treats a created issue whose answer is unreadable as CREATED, not failed', async () => {
    // A 201 means it exists. Reporting failure would invite a duplicate.
    const fetchImpl = fetchStub(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: { get: () => null },
        json: () => Promise.reject(new Error('bad json')),
      } as unknown as Response)
    );
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(r.url).toBeNull();
  });
});

describe('createIssue — every refusal gets its own name', () => {
  it('says no-token when nothing local can supply one, and never calls out', async () => {
    const fetchImpl = fetchStub(() => Promise.resolve(res(201)));
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: noToken,
      fetchImpl,
    });
    expect(r.problem).toBe('no-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    // 404 is an AUTH fact here, not a missing repo: the repo is private, and
    // GitHub deliberately will not confirm a private repo exists to a token
    // that cannot see it. Calling it "refused" sent people hunting for a typo
    // in a repo name that is correct. `update/checker.ts` maps it the same way.
    [404, 'auth'],
    [422, 'refused'],
    // The documented status for a secondary rate limit, which is the one that
    // bites content-creating POSTs like this. Previously fell through to
    // "refused" and told the user nothing they could act on.
    [429, 'rate-limited'],
    [500, 'refused'],
  ])('maps HTTP %i to %s', async (status, problem) => {
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() => Promise.resolve(res(status))),
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toBe(problem);
  });

  it('distinguishes a rate limit from a bad token, though both are 403', async () => {
    // Same status, opposite advice: one is "fix your token", the other is
    // "wait". Only the header tells them apart.
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() => Promise.resolve(res(403, {}, { 'x-ratelimit-remaining': '0' }))),
    });
    expect(r.problem).toBe('rate-limited');
  });

  it('catches the SECONDARY rate limit, which leaves the remaining count alone', async () => {
    // The trap: the secondary limit is what throttles content creation, and it
    // answers 403 with `retry-after` while `x-ratelimit-remaining` is still
    // healthy. Keying only on an exhausted count told someone who filed two
    // reports in a row that their perfectly good token had expired.
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() =>
        Promise.resolve(res(403, {}, { 'retry-after': '60', 'x-ratelimit-remaining': '4999' }))
      ),
    });
    expect(r.problem).toBe('rate-limited');
  });

  it('reports a network failure rather than throwing into the caller', async () => {
    const r = await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() => Promise.reject(new Error('ENOTFOUND'))),
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('network');
  });
});

describe('createIssue — the token never leaks', () => {
  it('logs no token value on success or on refusal', async () => {
    const log = vi.fn();
    await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() => Promise.resolve(res(201, { number: 3 }))),
      log,
    });
    await createIssue({
      title: 't',
      body: 'b',
      version: '1',
      tokenSources: withToken,
      fetchImpl: fetchStub(() => Promise.resolve(res(401))),
      log,
    });

    const everything = JSON.stringify(log.mock.calls);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('ghp_');
  });
});
