// P2-E19-03's done-when, second half: "the 404-means-auth case is
// distinguished from 'no releases' (unit-tested)" — plus the fail-open
// contract that nothing in the update path throws.
//
// Every test here injects its own `fetch`. No test in this file makes a
// network call, and none of them reaches for a real token.
import { describe, it, expect, vi } from 'vitest';
import { checkForUpdate, pickLatest, statusReason, RELEASES_ENDPOINT } from './checker';
import type { TokenSource } from './token';

const token: TokenSource[] = [{ id: 'test', resolve: async () => 'ghp_test' }];
const noToken: TokenSource[] = [{ id: 'test', resolve: async () => null }];

/** A `fetch` that answers once with this status and body. */
function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  })) as unknown as typeof fetch;
}

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    name: tag,
    body: `notes for ${tag}`,
    html_url: `https://github.com/badsonstudios/switchboard.ai/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-08-05T10:00:00Z',
    ...extra,
  };
}

describe('checkForUpdate — the private-repo 404 trap (§E19 decision 5)', () => {
  it('reports 404 as AUTH, never as up to date', async () => {
    // THE test this whole module exists for. ClaudeMon's checker read this
    // exact response as "no releases, you are up to date" and would have said
    // so forever on a private repo.
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(404, { message: 'Not Found' }),
      tokenSources: token,
    });
    expect(r.state).toBe('failed');
    expect(r.reason).toBe('auth');
    expect(r.ok).toBe(false);
    expect(r.state).not.toBe('up-to-date');
  });

  it('reports 200 with an EMPTY list as up to date — the case 404 is not', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, []),
      tokenSources: token,
    });
    expect(r.state).toBe('up-to-date');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.latestVersion).toBeUndefined();
  });

  it('asks the LIST endpoint, which is what makes those two answers differ', () => {
    // /releases/latest answers 404 for BOTH cases; the list endpoint does not.
    expect(RELEASES_ENDPOINT).toContain('/releases?');
    expect(RELEASES_ENDPOINT).not.toContain('/releases/latest');
    expect(RELEASES_ENDPOINT.startsWith('https://api.github.com/')).toBe(true);
  });
});

describe('statusReason', () => {
  const h = (headers: Record<string, string> = {}) => ({
    get: (n: string) => headers[n.toLowerCase()] ?? null,
  });

  it('maps the auth family together', () => {
    for (const status of [401, 403, 404]) {
      expect(statusReason({ status, headers: h() })).toBe('auth');
    }
  });

  it('tells an exhausted rate limit apart from a bad token', () => {
    expect(statusReason({ status: 403, headers: h({ 'x-ratelimit-remaining': '0' }) })).toBe(
      'rate-limit'
    );
    expect(statusReason({ status: 429, headers: h() })).toBe('rate-limit');
    expect(statusReason({ status: 403, headers: h({ 'x-ratelimit-remaining': '58' }) })).toBe(
      'auth'
    );
  });

  it('calls anything else a bad response', () => {
    expect(statusReason({ status: 500, headers: h() })).toBe('bad-response');
  });
});

describe('checkForUpdate — the happy path', () => {
  it('offers a newer release with its notes and page', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, [release('v0.2.0')]),
      tokenSources: token,
    });
    expect(r.state).toBe('available');
    expect(r.latestVersion).toBe('0.2.0'); // normalized: no `v`
    expect(r.notes).toBe('notes for v0.2.0');
    expect(r.url).toContain('/releases/tag/v0.2.0');
    expect(r.publishedAt).toBe('2026-08-05T10:00:00Z');
  });

  it('says up to date when the newest release IS the running build', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.2.0',
      fetchImpl: respond(200, [release('v0.2.0'), release('v0.1.0')]),
      tokenSources: token,
    });
    expect(r.state).toBe('up-to-date');
    expect(r.latestVersion).toBe('0.2.0');
  });

  it('sends the token as a bearer, with the headers GitHub requires', async () => {
    const f = respond(200, []);
    await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: f, tokenSources: token });
    const init = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.authorization).toBe('Bearer ghp_test');
    expect(init.headers.accept).toBe('application/vnd.github+json');
    // GitHub rejects a request with no User-Agent outright
    expect(init.headers['user-agent']).toContain('switchboard.ai/');
  });

  it('never sends an Authorization header when the token step is skipped', async () => {
    const f = respond(200, []);
    await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: f,
      endpoint: 'http://127.0.0.1:9/stub',
      skipToken: true,
    });
    const init = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.authorization).toBeUndefined();
  });
});

describe('checkForUpdate — fail-open, always a record', () => {
  it('with NO token: disabled, one debug line, and nothing on the network', async () => {
    const f = vi.fn();
    const log = vi.fn();
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: f as unknown as typeof fetch,
      tokenSources: noToken,
      log,
    });
    expect(r.state).toBe('disabled');
    expect(r.reason).toBe('no-token');
    expect(f).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a throwing fetch (offline, DNS, TLS) becomes a network failure', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch,
      tokenSources: token,
    });
    expect(r.state).toBe('failed');
    expect(r.reason).toBe('network');
  });

  it('unparseable JSON is a bad response, not a throw', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as unknown as typeof fetch;
    const r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: f, tokenSources: token });
    expect(r.state).toBe('failed');
    expect(r.reason).toBe('bad-response');
  });

  it('the deadline covers the BODY, not just the headers', async () => {
    // A feed that answers 200 and then stalls the body used to leave this
    // promise pending forever — and because the service caches its in-flight
    // promise, every later check (manual ones included) would join it and
    // never resolve. Update checks would stop working for the life of the
    // process, silently.
    vi.useFakeTimers();
    try {
      const f = vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () =>
          new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(new Error('aborted')));
          }),
      })) as unknown as typeof fetch;
      const pending = checkForUpdate({
        currentVersion: '0.1.0',
        fetchImpl: f,
        tokenSources: token,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pending;
      expect(r.state).toBe('failed');
      expect(r.reason).toBe('bad-response');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 200 that is not a list is a bad response', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, { message: 'surprise' }),
      tokenSources: token,
    });
    expect(r.state).toBe('failed');
    expect(r.reason).toBe('bad-response');
  });

  it('a throwing token source is simply a source with no token', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, []),
      tokenSources: [
        {
          id: 'boom',
          resolve: () => {
            throw new Error('credential store exploded');
          },
        },
      ],
    });
    expect(r.state).toBe('disabled');
    expect(r.reason).toBe('no-token');
  });

  it('stamps every result with the version it compared against', async () => {
    for (const f of [respond(404, {}), respond(200, []), respond(200, [release('v9.9.9')])]) {
      const r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: f, tokenSources: token });
      expect(r.currentVersion).toBe('0.1.0');
      expect(Number.isFinite(Date.parse(r.checkedAt))).toBe(true);
    }
  });
});

describe('pickLatest', () => {
  it('takes the highest VERSION, not the first one listed', () => {
    // GitHub orders by creation date, so a re-published older release would
    // otherwise be offered as an upgrade.
    const best = pickLatest([release('v0.1.0'), release('v0.3.0'), release('v0.2.0')]);
    expect(best?.tag_name).toBe('v0.3.0');
  });

  it('ignores drafts — §E19 keeps drafts as the staging mechanism', () => {
    const best = pickLatest([release('v0.1.0'), release('v9.9.9', { draft: true })]);
    expect(best?.tag_name).toBe('v0.1.0');
  });

  it('ignores pre-releases', () => {
    const best = pickLatest([release('v0.1.0'), release('v2.0.0', { prerelease: true })]);
    expect(best?.tag_name).toBe('v0.1.0');
  });

  it('skips tags it cannot read, and says how many', () => {
    const log = vi.fn();
    const best = pickLatest([release('nightly'), release('v0.2.0'), release('latest')], log);
    expect(best?.tag_name).toBe('v0.2.0');
    expect(log).toHaveBeenCalledWith(expect.any(String), { skipped: 2 });
  });

  it('is null when nothing is eligible', () => {
    expect(pickLatest([])).toBeNull();
    expect(pickLatest([release('v1.0.0', { draft: true })])).toBeNull();
    expect(pickLatest([{ tag_name: 42 }, null as unknown as Record<string, unknown>])).toBeNull();
  });
});

describe('the installer asset (E19-04)', () => {
  const assets = [
    {
      name: 'switchboard-Setup-0.2.0.exe',
      url: 'https://api.github.com/repos/o/r/releases/assets/1',
      browser_download_url: 'https://github.com/o/r/releases/download/v0.2.0/switchboard-Setup-0.2.0.exe',
      size: 123456,
    },
    {
      name: 'switchboard-Setup-0.2.0.exe.sha256',
      url: 'https://api.github.com/repos/o/r/releases/assets/2',
      size: 78,
    },
  ];

  it('carries the API asset URLs — NOT the browser ones', async () => {
    // On a private repo the browser_download_url is a login page. The API URL
    // with `Accept: application/octet-stream` is the documented way to the
    // bytes, and it is the one thing E19-04 needs out of this response.
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, [release('v0.2.0', { assets })]),
      tokenSources: token,
      platform: 'win32',
    });
    expect(r.download).toEqual({
      name: 'switchboard-Setup-0.2.0.exe',
      url: 'https://api.github.com/repos/o/r/releases/assets/1',
      checksumUrl: 'https://api.github.com/repos/o/r/releases/assets/2',
      size: 123456,
    });
  });

  it('a release with no verifiable installer is still an OFFER — just a browser one', async () => {
    // E19-03's behaviour, preserved: the release page is always the fallback.
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, [release('v0.2.0', { assets: [assets[0]] })]),
      tokenSources: token,
      platform: 'win32',
    });
    expect(r.state).toBe('available');
    expect(r.download).toBeUndefined();
    expect(r.url).toContain('/releases/tag/v0.2.0');
  });

  it('offers no installer on a platform we do not package for', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: respond(200, [release('v0.2.0', { assets })]),
      tokenSources: token,
      platform: 'linux',
    });
    expect(r.state).toBe('available');
    expect(r.download).toBeUndefined();
  });

  it('an up-to-date answer carries no installer at all', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.2.0',
      fetchImpl: respond(200, [release('v0.2.0', { assets })]),
      tokenSources: token,
      platform: 'win32',
    });
    expect(r.state).toBe('up-to-date');
    expect(r.download).toBeUndefined();
  });
});
