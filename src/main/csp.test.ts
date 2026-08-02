import { describe, it, expect, vi } from 'vitest';
import type { Session } from 'electron';
import { withCspHeader, isRendererResponse, installCspHeaders } from './csp';
import { CSP_DEV, CSP_PROD, CSP_PROD_META, cspPolicy } from '../shared/csp';

describe('withCspHeader', () => {
  it('adds exactly one CSP header', () => {
    const out = withCspHeader({ 'content-type': ['text/html'] }, CSP_PROD);
    expect(out['content-security-policy']).toEqual([CSP_PROD]);
    expect(out['content-type']).toEqual(['text/html']);
  });

  it('REPLACES an existing policy rather than appending it', () => {
    // two CSP headers are intersected by the browser, so an append would apply
    // a policy nobody wrote — the static server already sets one, and this
    // listener runs on top of it
    const out = withCspHeader(
      { 'Content-Security-Policy': ["default-src 'none'"], 'content-type': ['text/html'] },
      CSP_PROD
    );
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'content-security-policy');
    expect(keys).toHaveLength(1);
    expect(out['content-security-policy']).toEqual([CSP_PROD]);
  });

  it('strips a report-only policy too', () => {
    const out = withCspHeader({ 'Content-Security-Policy-Report-Only': ["default-src 'none'"] }, CSP_PROD);
    expect(Object.keys(out).map((k) => k.toLowerCase())).toEqual(['content-security-policy']);
  });

  it('tolerates missing headers', () => {
    expect(withCspHeader(undefined, CSP_PROD)['content-security-policy']).toEqual([CSP_PROD]);
  });
});

describe('isRendererResponse', () => {
  const origin = 'http://127.0.0.1:53411';

  it('matches our own origin, path and query irrelevant', () => {
    expect(isRendererResponse(`${origin}/index.html`, origin)).toBe(true);
    expect(isRendererResponse(`${origin}/assets/index-abc.js?v=1`, origin)).toBe(true);
    expect(isRendererResponse(`${origin}/popout.html`, origin)).toBe(true);
  });

  it('rejects a different port on the same host', () => {
    expect(isRendererResponse('http://127.0.0.1:9999/index.html', origin)).toBe(false);
  });

  it('rejects anything off-origin, and never throws on junk', () => {
    expect(isRendererResponse('https://example.com/', origin)).toBe(false);
    expect(isRendererResponse('not a url', origin)).toBe(false);
  });

  it('is false before the origin is known (static server still binding)', () => {
    expect(isRendererResponse(`${origin}/index.html`, null)).toBe(false);
  });
});

describe('the policies', () => {
  it('picks dev vs prod', () => {
    expect(cspPolicy(true)).toBe(CSP_DEV);
    expect(cspPolicy(false)).toBe(CSP_PROD);
  });

  it("prod forbids inline script — that's the whole point of the item", () => {
    expect(CSP_PROD).toContain("script-src 'self'");
    expect(CSP_PROD).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(CSP_PROD).not.toContain("'unsafe-eval'");
  });

  it('dev relaxes ONLY what the Vite dev server needs', () => {
    // the react-refresh preamble is an inline <script>, and HMR is a WebSocket
    expect(CSP_DEV).toContain("script-src 'self' 'unsafe-inline'");
    expect(CSP_DEV).toContain('ws://localhost:*');
    expect(CSP_DEV).not.toContain("'unsafe-eval'");
    // and nothing else: same default-src, same object/base/form lockdown
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(CSP_DEV).toContain(directive);
      expect(CSP_PROD).toContain(directive);
    }
  });

  it('does not loosen anything the old <meta> policy forbade', () => {
    // the meta tag this item replaced was exactly these three directives; a
    // header-based CSP is only an improvement if it is not quietly weaker
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'"]) {
      expect(CSP_PROD).toContain(directive);
    }
    // no worker-src override: default-src 'self' governs the (same-origin)
    // Vite worker, exactly as before
    expect(CSP_PROD).not.toContain('worker-src');
    expect(CSP_PROD).not.toContain('blob:');
  });

  it('the meta backstop drops the directives a <meta> tag cannot carry', () => {
    // Chromium logs an error for each of these in a meta CSP, and our
    // renderer-console bridge would write it to switchboard.log every launch
    for (const ignored of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
      expect(CSP_PROD_META).not.toContain(ignored);
    }
    // ...and keeps everything else, in order
    expect(CSP_PROD.startsWith(CSP_PROD_META)).toBe(true);
    expect(CSP_PROD_META).toContain("script-src 'self'");
    expect(CSP_PROD_META).toContain("object-src 'none'");
  });
});

describe('installCspHeaders', () => {
  /** a Session stub that just captures the registered listener */
  function fakeSession() {
    let listener:
      | ((details: { url: string; responseHeaders?: Record<string, string[]> }, cb: (r: unknown) => void) => void)
      | undefined;
    const session = {
      webRequest: {
        onHeadersReceived: (fn: typeof listener) => {
          listener = fn;
        },
      },
    } as unknown as Session;
    return { session, run: () => listener! };
  }

  it('stamps the policy on our own responses', () => {
    const { session, run } = fakeSession();
    installCspHeaders(session, () => 'http://127.0.0.1:1234', false);
    const cb = vi.fn();
    run()({ url: 'http://127.0.0.1:1234/index.html', responseHeaders: { 'content-type': ['text/html'] } }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({
      responseHeaders: { 'content-type': ['text/html'], 'content-security-policy': [CSP_PROD] },
    });
  });

  it('passes anything else through untouched', () => {
    const { session, run } = fakeSession();
    installCspHeaders(session, () => 'http://127.0.0.1:1234', false);
    const cb = vi.fn();
    run()({ url: 'https://example.com/x', responseHeaders: { 'content-type': ['text/html'] } }, cb);
    // no responseHeaders key at all — Electron keeps the originals
    expect(cb).toHaveBeenCalledExactlyOnceWith({});
  });

  it('serves the dev policy in dev', () => {
    const { session, run } = fakeSession();
    installCspHeaders(session, () => 'http://localhost:5173', true);
    const cb = vi.fn();
    run()({ url: 'http://localhost:5173/' }, cb);
    expect((cb.mock.calls[0][0] as { responseHeaders: Record<string, string[]> }).responseHeaders[
      'content-security-policy'
    ]).toEqual([CSP_DEV]);
  });

  it('FAILS OPEN: a throwing origin lookup still answers the request, exactly once', () => {
    // the hard constraint — a listener that does not call back hangs every
    // response in the session, i.e. a permanently blank window
    const { session, run } = fakeSession();
    const onError = vi.fn();
    installCspHeaders(
      session,
      () => {
        throw new Error('boom');
      },
      false,
      onError
    );
    const cb = vi.fn();
    run()({ url: 'http://127.0.0.1:1234/index.html' }, cb);
    expect(cb).toHaveBeenCalledExactlyOnceWith({});
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a persistent fault ONCE, not once per response', () => {
    const { session, run } = fakeSession();
    const onError = vi.fn();
    installCspHeaders(
      session,
      () => {
        throw new Error('boom');
      },
      false,
      onError
    );
    const cb = vi.fn();
    for (let i = 0; i < 25; i++) run()({ url: `http://127.0.0.1:1234/${i}.js` }, cb);
    expect(cb).toHaveBeenCalledTimes(25);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
