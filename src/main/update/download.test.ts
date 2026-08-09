// The asset downloader (P2-E19-04).
//
// The first describe block is the one that matters and the reason this file
// exists: **the token must not reach the redirect host.** Everything about
// `download.ts` — the manual redirect handling, the hop loop, the URL guard —
// is in service of that, and none of it is visible from the outside except by
// inspecting the headers each hop was actually sent. So that is what these
// assert, request by request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import {
  DownloadError,
  downloadAsset,
  fetchAssetText,
  isAllowedAssetUrl,
  isTrustedAssetOrigin,
  MAX_ASSET_BYTES,
} from './download';

const API = 'https://api.github.com/repos/o/r/releases/assets/1';
const CDN = 'https://objects.githubusercontent.com/blob/abc?token=signed';

let dir: string;
let dest: string;

beforeEach(() => {
  dir = tempDir('sb-dl-');
  dest = path.join(dir, 'switchboard-Setup-9.9.9.exe');
});
// One directory per test, deleted at the end of that test (#213, #360). Every
// download here has resolved or rejected by then, so no write stream is open.
afterEach(() => {
  cleanupTempDirs();
});

/** A Response carrying `body` as a real web stream, the way fetch does. */
function bodyResponse(body: Buffer | string, headers: Record<string, string> = {}): Response {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { 'content-length': String(buf.length), ...headers },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * A fetch that answers a scripted sequence and records every call.
 *
 * Records the HEADERS, because that is the assertion.
 */
function scriptedFetch(steps: Response[]): {
  impl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
    });
    const res = steps[i++];
    if (!res) throw new Error(`no scripted response for call ${i}`);
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = { currentVersion: '0.1.0', token: 'ghp_secret' };

describe('THE rule: the token goes to the API host and nowhere else', () => {
  it('sends the credential on the first hop and STRIPS it on the redirect', async () => {
    const { impl, calls } = scriptedFetch([redirect(CDN), bodyResponse('installer-bytes')]);
    await downloadAsset({ ...base, url: API, dest, fetchImpl: impl });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(API);
    expect(calls[0].headers.authorization).toBe('Bearer ghp_secret');
    // The assertion this whole file is for.
    expect(calls[1].url).toBe(CDN);
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(fs.readFileSync(dest, 'utf8')).toBe('installer-bytes');
  });

  it('keeps the credential stripped across EVERY later hop, not just the first', async () => {
    const second = 'https://s3.example.com/final?sig=1';
    const { impl, calls } = scriptedFetch([redirect(CDN), redirect(second), bodyResponse('x')]);
    await downloadAsset({ ...base, url: API, dest, fetchImpl: impl });
    expect(calls.map((c) => c.headers.authorization)).toEqual([
      'Bearer ghp_secret',
      undefined,
      undefined,
    ]);
  });

  it('asks for the BYTES, not the metadata', async () => {
    // Without `Accept: application/octet-stream` the API answers with a JSON
    // description of the asset and the "installer" on disk is a JSON document.
    const { impl, calls } = scriptedFetch([bodyResponse('x')]);
    await downloadAsset({ ...base, url: API, dest, fetchImpl: impl });
    expect(calls[0].headers.accept).toBe('application/octet-stream');
    expect(calls[0].headers['user-agent']).toContain('switchboard.ai/');
  });

  it('refuses to FOLLOW a redirect to a non-https host', async () => {
    // A redirect is a URL the server chose. Following it to plain http would
    // fetch an executable over a channel anyone can rewrite.
    const { impl } = scriptedFetch([redirect('http://evil.example.com/x.exe')]);
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: impl })).rejects.toThrow(
      DownloadError
    );
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('refuses a relative redirect rather than guessing its base', async () => {
    const { impl } = scriptedFetch([redirect('/somewhere/else')]);
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: impl })).rejects.toThrow(
      /will not follow/
    );
  });
});

describe('the URL that carries the credential is the tightest-guarded one', () => {
  it('refuses to send a token anywhere but the API host — before making any request', async () => {
    // The failure this closes: a feed that answers with
    // `assets: [{url: "https://evil.example/x"}]` would otherwise collect a
    // live `gh` token in an Authorization header on the FIRST hop, because a
    // bare https check accepts any host. Redirects may go anywhere; the
    // credentialed request may not.
    const impl = vi.fn() as unknown as typeof fetch;
    for (const url of [
      'https://evil.example.com/x.exe',
      'https://api.github.com.evil.example.com/x.exe',
      'https://raw.githubusercontent.com/x.exe',
      'http://api.github.com/x.exe',
    ]) {
      await expect(downloadAsset({ ...base, url, dest, fetchImpl: impl })).rejects.toThrow(
        /untrusted origin/
      );
      await expect(fetchAssetText({ ...base, url, fetchImpl: impl })).rejects.toThrow(
        /untrusted origin/
      );
    }
    expect(impl).not.toHaveBeenCalled();
  });

  it('tells the two guards apart: the origin is narrow, a redirect target is not', () => {
    // `isTrustedAssetOrigin` gates the token. `isAllowedAssetUrl` gates where a
    // redirect may lead — and GitHub's storage host is a different domain whose
    // name is not ours to pin, so that one has to be broader.
    expect(isTrustedAssetOrigin('https://api.github.com/x')).toBe(true);
    expect(isTrustedAssetOrigin('https://objects.githubusercontent.com/x')).toBe(false);
    expect(isAllowedAssetUrl('https://objects.githubusercontent.com/x')).toBe(true);
    expect(isTrustedAssetOrigin('http://127.0.0.1:1/x')).toBe(false);
    expect(isTrustedAssetOrigin('http://127.0.0.1:1/x', true)).toBe(true);
    expect(isTrustedAssetOrigin('https://evil.example.com/x', true)).toBe(false);
  });
});

describe('which URLs a redirect may lead to', () => {
  it('accepts absolute https and nothing else by default', () => {
    expect(isAllowedAssetUrl('https://api.github.com/x')).toBe(true);
    expect(isAllowedAssetUrl('http://api.github.com/x')).toBe(false);
    expect(isAllowedAssetUrl('http://127.0.0.1:1/x')).toBe(false);
    expect(isAllowedAssetUrl('file:///C:/windows/system32/calc.exe')).toBe(false);
    expect(isAllowedAssetUrl('/relative/path')).toBe(false);
    expect(isAllowedAssetUrl('')).toBe(false);
    expect(isAllowedAssetUrl(null)).toBe(false);
  });

  it('allows loopback http ONLY when the dev feed override asked for it', () => {
    // The e2e suite serves a fake installer from a local stub. A packaged build
    // cannot set the override, so it can never take this branch.
    expect(isAllowedAssetUrl('http://127.0.0.1:8080/x.exe', true)).toBe(true);
    expect(isAllowedAssetUrl('http://localhost:8080/x.exe', true)).toBe(true);
    // …and the flag does not open the door to anywhere else.
    expect(isAllowedAssetUrl('http://evil.example.com/x.exe', true)).toBe(false);
    expect(isAllowedAssetUrl('http://127.0.0.1.evil.com/x.exe', true)).toBe(false);
  });
});

describe('progress, cancellation and the size ceiling', () => {
  it('reports determinate progress and ends at the full byte count', async () => {
    const bytes = Buffer.alloc(1024, 7);
    const { impl } = scriptedFetch([bodyResponse(bytes)]);
    const seen: Array<[number, number]> = [];
    const n = await downloadAsset({
      ...base,
      url: API,
      dest,
      fetchImpl: impl,
      onProgress: (r, t) => seen.push([r, t]),
    });
    expect(n).toBe(1024);
    expect(seen.at(-1)).toEqual([1024, 1024]);
    expect(fs.statSync(dest).size).toBe(1024);
  });

  it('reports total 0 — indeterminate — when the host sends no Content-Length', async () => {
    const res = new Response(new Uint8Array(Buffer.from('abcd')), { status: 200 });
    res.headers.delete('content-length');
    const { impl } = scriptedFetch([res]);
    const seen: Array<[number, number]> = [];
    await downloadAsset({
      ...base,
      url: API,
      dest,
      fetchImpl: impl,
      onProgress: (r, t) => seen.push([r, t]),
    });
    // Every chunk reports while streaming — there is no percentage to throttle
    // against — and `total` stays 0, which is what the bar reads as
    // indeterminate.
    expect(seen[0]).toEqual([4, 0]);
    // …and the final push swaps in the received count, so the bar can finish.
    expect(seen.at(-1)).toEqual([4, 4]);
  });

  it('a cancel deletes the partial file and reports a cancel, not a mystery', async () => {
    const abort = new AbortController();
    // A body that never ends: the only way to leave it is the signal.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const { impl } = scriptedFetch([new Response(stream, { status: 200 })]);
    const p = downloadAsset({ ...base, url: API, dest, fetchImpl: impl, signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled/);
    // The file must not survive — a half-installer is 60 MB of nothing.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('cancels a STALLED body — the case a Cancel button actually meets', async () => {
    // Regression, found by the e2e run: a body that delivers one chunk and then
    // goes quiet parks the counter generator on `for await`, which `pipeline`'s
    // own signal cannot reach because it does not own that stream. Cancel sat
    // there doing nothing and the dialog showed "downloading" forever.
    const abort = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        // …and never again. Only the abort ends this.
      },
    });
    const { impl } = scriptedFetch([
      new Response(stalled, { status: 200, headers: { 'content-length': '1024' } }),
    ]);
    const p = downloadAsset({ ...base, url: API, dest, fetchImpl: impl, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('refuses an asset whose declared size is past the ceiling, before writing a byte', async () => {
    const { impl } = scriptedFetch([
      bodyResponse('x', { 'content-length': String(MAX_ASSET_BYTES + 1) }),
    ]);
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'disk',
    });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('stops a body that overruns the ceiling MID-STREAM, with no size declared', async () => {
    // The declared-size check above is trivially dodged by omitting
    // Content-Length, so it is not the real defence — this is. Tested with a
    // small ceiling rather than 600 MB of generated bytes.
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (sent > MAX_ASSET_BYTES + 1024 * 1024) controller.close(); // a backstop for a broken guard
      },
    });
    const res = new Response(endless, { status: 200 });
    res.headers.delete('content-length');
    const { impl } = scriptedFetch([res]);
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'disk',
    });
    expect(fs.existsSync(dest)).toBe(false);
  }, 60_000);
});

describe('what the failures are called', () => {
  it('401/403/404 from the asset host is an AUTH failure', async () => {
    for (const status of [401, 403, 404]) {
      const { impl } = scriptedFetch([new Response(null, { status })]);
      await expect(
        downloadAsset({ ...base, url: API, dest, fetchImpl: impl })
      ).rejects.toMatchObject({ reason: 'auth' });
    }
  });

  it('any other non-2xx, and an unreachable host, are NETWORK failures', async () => {
    const { impl } = scriptedFetch([new Response(null, { status: 500 })]);
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'network',
    });

    const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(downloadAsset({ ...base, url: API, dest, fetchImpl: dead })).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('a non-https URL is refused before any request is made', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    await expect(
      downloadAsset({ ...base, url: 'http://example.com/x.exe', dest, fetchImpl: impl })
    ).rejects.toThrow(/untrusted origin/);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('the sidecar fetch rides the same rules', () => {
  it('strips the token on the redirect, exactly like the installer does', async () => {
    const { impl, calls } = scriptedFetch([
      redirect(CDN),
      bodyResponse('a'.repeat(64) + '  switchboard-Setup-9.9.9.exe\n'),
    ]);
    const text = await fetchAssetText({ ...base, url: API, fetchImpl: impl });
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(text).toContain('switchboard-Setup-9.9.9.exe');
  });

  it('REFUSES an absurd "sidecar" rather than buffering megabytes of it', async () => {
    // A sidecar is 70-odd bytes, comes from the same feed as the installer, and
    // is not itself covered by any checksum. Buffering it whole would let a
    // broken feed OOM the main process — every hosted session down, from an
    // update check.
    const { impl } = scriptedFetch([bodyResponse('x'.repeat(50_000))]);
    await expect(fetchAssetText({ ...base, url: API, fetchImpl: impl })).rejects.toThrow(
      /too large/
    );
  });

  it('refuses one that lies about its size too, by counting what actually arrives', async () => {
    const res = new Response(new Uint8Array(Buffer.from('y'.repeat(9000))), { status: 200 });
    res.headers.delete('content-length');
    const { impl } = scriptedFetch([res]);
    await expect(fetchAssetText({ ...base, url: API, fetchImpl: impl })).rejects.toThrow(/overran/);
  });
});
