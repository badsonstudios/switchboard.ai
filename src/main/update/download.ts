// Fetching a release asset (P2-E19-04, plan §E19).
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
//
// **The token goes to the API host and to nowhere else.**
//
// A private repo's asset is fetched from `api.github.com/…/releases/assets/<id>`
// with `Accept: application/octet-stream`, and GitHub answers **302** with a
// pre-signed URL on a completely different host (`objects.githubusercontent.com`
// today, an S3 bucket underneath). That URL carries its own credentials in the
// query string; it needs nothing from us. Forwarding `Authorization` there
// hands a live GitHub token to a storage host on every download — and, less
// theoretically, several object stores REJECT a request that carries both their
// signature and an `Authorization` header, so doing it is both a leak and a bug.
//
// `fetch` follows redirects with the original headers attached. So this does
// not let it: `redirect: 'manual'`, read `location` ourselves, validate it, and
// re-issue the request with the credentials stripped. That is the whole reason
// this is a hand-written function rather than three lines of `fetch`.
//
// Everything else here is the ordinary fail-open contract: a typed error, never
// a half-written file left behind, and a cancel that actually stops the socket.
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { UpdateInstallFailure } from '../../shared/update';

/** How long the asset host gets to answer the *headers*. The body has no
 *  deadline of its own — a 100 MB installer on a slow line is not a failure —
 *  but a host that accepts the connection and then says nothing is. */
const HEADER_TIMEOUT_MS = 30_000;

/** Redirect hops we will follow. GitHub uses exactly one; three is slack. */
const MAX_HOPS = 3;

/**
 * A ceiling on what we will write to the user's disk.
 *
 * The installer is ~120 MB. This is not a tuning knob — it is the answer to
 * "what if the feed answers with an infinite body", which is a thing a
 * compromised or simply broken feed can do, and filling the system drive is a
 * worse outcome than a failed update.
 */
export const MAX_ASSET_BYTES = 600 * 1024 * 1024;

/** The failure carried out of here. Typed, so the caller never parses a message. */
export class DownloadError extends Error {
  constructor(
    readonly reason: UpdateInstallFailure,
    message: string
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  url: string;
  /** written to `dest`; a partial file is deleted on every failure path */
  dest: string;
  /** sent to the FIRST host only. Omit for a feed that wants no credentials. */
  token?: string | null;
  /** the app's version, for the User-Agent GitHub requires */
  currentVersion: string;
  /** bytes so far / bytes expected (0 when the host did not say) */
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Allow `http://127.0.0.1` and `http://localhost`.
   *
   * Set ONLY when the dev/test feed override is active in a non-packaged build
   * (`service.ts`'s `FEED_ENV`). A packaged app can never set it, so the
   * shipped binary is absolute-https-only for anything it downloads and runs —
   * which is the item's own requirement.
   */
  allowLoopback?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Is this a URL we are willing to fetch bytes from and later EXECUTE?
 *
 * Absolute https, no exceptions — except the loopback seam above, which exists
 * so the e2e suite can serve a fake installer from a local stub instead of
 * publishing a release to test against. Relative URLs are refused outright
 * rather than resolved: a `location` header we have to guess the base of is a
 * redirect we do not understand well enough to follow with an executable at
 * the other end.
 */
export function isAllowedAssetUrl(url: unknown, allowLoopback = false): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'https:') return true;
  return allowLoopback && isLoopback(u);
}

/** The host GitHub serves private release assets from. */
export const ASSET_API_HOST = 'api.github.com';

/**
 * May this URL be sent the TOKEN?
 *
 * Stricter than `isAllowedAssetUrl` on purpose, and the distinction is the
 * point: a redirect may lead to any https host (GitHub's storage layer is a
 * different domain and its name is not ours to pin), but the request that
 * carries a credential may only ever go to the API host itself.
 *
 * Without this, `isAllowedAssetUrl` alone would let a feed that answered with
 * `assets: [{url: "https://evil.example/x"}]` collect a live `gh` token in an
 * `Authorization` header — the credential URL would be the least-guarded one in
 * the feature, which is backwards. The URL that gets a secret gets the tightest
 * check.
 *
 * The loopback escape hatch is the same dev/test seam as everywhere else, and a
 * packaged build cannot open it. It is also belt-and-braces there: the feed
 * override sets `skipToken`, so there is no token to send in the first place.
 */
export function isTrustedAssetOrigin(url: unknown, allowLoopback = false): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'https:') return u.hostname.toLowerCase() === ASSET_API_HOST;
  return allowLoopback && isLoopback(u);
}

function parse(url: unknown): URL | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url); // throws for every relative form
  } catch {
    return null;
  }
}

function isLoopback(u: URL): boolean {
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/**
 * Fetch `url` to `dest`. Resolves with the byte count; throws `DownloadError`.
 *
 * The caller owns `dest`'s directory and owns deleting the file on a later
 * failure (a checksum mismatch, say). This function only guarantees it leaves
 * nothing behind when IT fails.
 */
export async function downloadAsset(opts: DownloadOptions): Promise<number> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new DownloadError('network', 'no fetch implementation available');
  }
  if (!isTrustedAssetOrigin(opts.url, opts.allowLoopback)) {
    throw new DownloadError('network', 'refusing to fetch an asset from an untrusted origin');
  }

  const res = await resolve(opts, doFetch);
  const total = contentLength(res);
  if (total > MAX_ASSET_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new DownloadError('disk', `asset is larger than the ${MAX_ASSET_BYTES}-byte ceiling`);
  }
  if (!res.body) throw new DownloadError('network', 'the asset host sent no body');

  await fs.promises.mkdir(path.dirname(opts.dest), { recursive: true });
  let received = 0;
  let lastReported = -1;
  // `Readable.fromWeb` on the fetch body, piped through a counter, into the
  // file. `pipeline` is what makes the cleanup honest: it destroys BOTH ends on
  // any failure, so an aborted download does not leave a write stream holding
  // the file open — which on Windows would make the unlink below fail with
  // EBUSY and strand a half-installer in temp until the next startup sweep.
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  // Belt and braces with the signal wiring in `resolve`. `pipeline`'s own signal
  // destroys the streams IT owns, and `source` is not one of them — it is
  // iterated by hand inside the counter below. A generator parked on `for await`
  // over a stalled body is not reachable any other way.
  const onAbort = (): void => {
    source.destroy(new Error('cancelled'));
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const counter = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > MAX_ASSET_BYTES) {
        throw new DownloadError('disk', 'the asset overran the size ceiling mid-stream');
      }
      // Throttled by whole percent (and by every chunk when the size is
      // unknown): a 120 MB download is ~2000 chunks, and 2000 IPC pushes to
      // move one progress bar is noise the renderer has to schedule around.
      const pct = total > 0 ? Math.floor((received / total) * 100) : -1;
      if (total <= 0 || pct !== lastReported) {
        lastReported = pct;
        opts.onProgress?.(received, total);
      }
      yield buf;
    }
  };

  try {
    await pipeline(counter(), fs.createWriteStream(opts.dest), { signal: opts.signal });
  } catch (err) {
    await unlinkQuietly(opts.dest);
    if (opts.signal?.aborted) throw new DownloadError('network', 'cancelled');
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(writeFailure(err), `the download did not complete: ${String(err)}`);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  // One last push so a consumer that only ever saw 0% sees 100% — the throttle
  // above can swallow the final chunk when it lands inside the same percent.
  opts.onProgress?.(received, total || received);
  return received;
}

/**
 * Follow the asset redirect BY HAND, dropping the credentials at the first hop.
 *
 * The returned Response is the one holding the bytes.
 */
async function resolve(opts: DownloadOptions, doFetch: typeof fetch): Promise<Response> {
  let url = opts.url;
  // The token rides the FIRST request only. Every hop after this one gets
  // `undefined` — see the header of this file for why that is the point.
  let token: string | null | undefined = opts.token;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const headers: Record<string, string> = {
      // The header that turns the API's JSON description of an asset into the
      // asset itself. Without it GitHub answers with metadata and the
      // "installer" you save is a JSON document.
      accept: 'application/octet-stream',
      'user-agent': `switchboard.ai/${opts.currentVersion}`,
    };
    if (token) headers.authorization = `Bearer ${token}`;

    // Headers only. The body deadline is deliberately absent (see the constant).
    const abort = new AbortController();
    // NOT removed once the headers land, and that is the fix for a real bug:
    // a cancel arrives while the BODY is streaming, which is the whole point of
    // a cancel button on a 120 MB download. Unhooking this after the response
    // resolved left the outer signal wired to nothing, so a stalled body ignored
    // Cancel entirely and the dialog sat on "downloading" forever. `{ once }`
    // plus a per-call controller means the leftover listeners from earlier hops
    // only ever abort controllers that are already finished with.
    opts.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const timer = setTimeout(() => abort.abort(), HEADER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, { headers, redirect: 'manual', signal: abort.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw new DownloadError('network', 'cancelled');
      throw new DownloadError('network', `could not reach the asset host: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      // Cancel the redirect's (empty) body so the socket is not held open while
      // we make the next request.
      void res.body?.cancel().catch(() => {});
      if (!isAllowedAssetUrl(location, opts.allowLoopback)) {
        throw new DownloadError(
          'network',
          'the asset host redirected somewhere this will not follow'
        );
      }
      url = location as string;
      token = undefined; // ← the whole point of the file
      continue;
    }

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      void res.body?.cancel().catch(() => {});
      throw new DownloadError('auth', `the asset host refused the request (${res.status})`);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new DownloadError('network', `the asset host answered ${res.status}`);
    }
    return res;
  }
  throw new DownloadError('network', 'too many redirects');
}

/**
 * Fetch a small text asset (the `.sha256` sidecar) through the same rules.
 *
 * **Read incrementally against a hard cap, never `res.text()`.** The sidecar
 * comes from the same feed as the installer and is not itself covered by any
 * checksum, so it gets the same treatment the installer does: a body with no
 * ceiling would let a broken or hostile feed OOM the main process, and taking
 * every hosted session down with an update check is the precise opposite of
 * fail-open. A real sidecar is 70-odd bytes.
 */
export async function fetchAssetText(
  opts: Omit<DownloadOptions, 'dest' | 'onProgress'>,
  maxBytes = 4096
): Promise<string> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new DownloadError('network', 'no fetch implementation available');
  }
  if (!isTrustedAssetOrigin(opts.url, opts.allowLoopback)) {
    throw new DownloadError('network', 'refusing to fetch an asset from an untrusted origin');
  }
  const res = await resolve({ ...opts, dest: '' }, doFetch);
  if (contentLength(res) > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new DownloadError('network', 'that is not a checksum sidecar — it is far too large');
  }
  const reader = res.body?.getReader();
  if (!reader) throw new DownloadError('network', 'the asset host sent no sidecar body');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // A host that omitted Content-Length and then kept talking. Stop
        // reading, drop the socket, and say what it was rather than what it
        // claimed to be.
        await reader.cancel().catch(() => {});
        throw new DownloadError('network', 'the sidecar body overran its ceiling');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    if (opts.signal?.aborted) throw new DownloadError('network', 'cancelled');
    throw new DownloadError('network', `the sidecar did not arrive: ${String(err)}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function contentLength(res: Response): number {
  const raw = res.headers.get('content-length');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** ENOSPC/EACCES/EPERM are the user's disk, not the network. Worth telling apart:
 *  "the download failed" and "your disk is full" want different reactions. */
function writeFailure(err: unknown): UpdateInstallFailure {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
    ? 'disk'
    : 'network';
}

export async function unlinkQuietly(file: string): Promise<void> {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    /* the startup sweep is the backstop; a locked temp file is not an error */
  }
}
